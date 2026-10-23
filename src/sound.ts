import { browserErrors, PhoneError } from "./errors.js"

const canChooseOutput = typeof HTMLMediaElement !== "undefined" && "setSinkId" in HTMLMediaElement.prototype

/**
 * Sound is the sound of the phone, one call at a time.
 *
 * Sent: microphone → input gain → soft limiter → mute → the one track of the WebRTC session. The track never changes,
 * so switching microphones or muting needs no renegotiation.
 *
 * Received: the track of the session → output gain → an audio element, which can play on a chosen speaker. The raw
 * stream also sits in a silent element: Chrome only feeds a remote WebRTC stream to Web Audio when an element holds it.
 */
export class Sound {
  readonly canChooseOutput = canChooseOutput

  private ctx?: AudioContext
  private sent?: MediaStreamAudioDestinationNode
  private inputGain?: GainNode
  private muteGain?: GainNode
  private inputMeter?: AnalyserNode
  private source?: MediaStreamAudioSourceNode
  private microphone?: MediaStream
  private ownsMicrophone = false

  private outputGain?: GainNode
  private outputMeter?: AnalyserNode
  private remote?: MediaStreamAudioSourceNode
  private readonly holder = typeof document !== "undefined" ? document.createElement("audio") : undefined
  private readonly speaker = typeof document !== "undefined" ? document.createElement("audio") : undefined

  /** Called when the microphone in use goes away (unplugged, revoked). */
  onMicrophoneLost?: () => void

  /** The track to send on the WebRTC session: silence until a microphone is set. */
  track(): MediaStreamTrack {
    return this.graph().sent.stream.getAudioTracks()[0]
  }

  async setInput(input: string | MediaStream | undefined): Promise<void> {
    const { ctx, inputGain } = this.graph()
    const stream = input instanceof MediaStream ? input : await microphone(input)

    this.releaseInput()
    this.microphone = stream
    this.ownsMicrophone = !(input instanceof MediaStream)
    this.source = ctx.createMediaStreamSource(stream)
    this.source.connect(inputGain)

    for (const track of stream.getAudioTracks()) {
      track.onended = () => this.onMicrophoneLost?.()
    }
  }

  /** Stops the microphone the SDK opened, so the browser stops showing it in use. */
  releaseInput() {
    this.source?.disconnect()
    if (this.ownsMicrophone) this.microphone?.getTracks().forEach((track) => track.stop())
    this.source = this.microphone = undefined
  }

  setInputVolume(volume: number) {
    this.graph().inputGain.gain.value = clamp(volume)
  }

  mute(muted: boolean) {
    this.graph().muteGain.gain.value = muted ? 0 : 1
  }

  /** Plays what the session receives. */
  setRemote(stream: MediaStream) {
    const { ctx, outputGain } = this.graph()

    this.remote?.disconnect()
    if (this.holder) {
      this.holder.muted = true
      this.holder.srcObject = stream
      void this.holder.play().catch(() => {})
    }

    this.remote = ctx.createMediaStreamSource(stream)
    this.remote.connect(outputGain)
  }

  async setOutput(deviceId: string | undefined) {
    if (deviceId === undefined) return
    if (!this.canChooseOutput || !this.speaker) throw browserErrors.notSupported()

    await sink(this.speaker, deviceId)
  }

  setOutputVolume(volume: number) {
    this.graph().outputGain.gain.value = clamp(volume)
  }

  /** Starts the sound: browsers allow it only during a user action, so call() and answer() call this first. */
  async start() {
    const { ctx } = this.graph()

    try {
      await ctx.resume()
      await this.speaker?.play()
    } catch (error) {
      throw playError(error)
    }
  }

  /** Opens the audio of a call: speaker, microphone, volumes, unmuted. */
  async open(audio: { input: string | MediaStream; output?: string; inputVolume: number; outputVolume: number }) {
    await this.setOutput(audio.output)
    await this.setInput(audio.input)
    this.setInputVolume(audio.inputVolume)
    this.setOutputVolume(audio.outputVolume)
    this.mute(false)
  }

  /** Peak levels, 0 to 1, of what is sent and what is heard. */
  levels(): { input: number; output: number } {
    const { inputMeter, outputMeter } = this.graph()

    return { input: peak(inputMeter), output: peak(outputMeter) }
  }

  /**
   * Plays a microphone back 1.5 s later through the same gain and limiter as a call. Its devices and volumes change
   * live, like a call's.
   */
  async test(options: { input: string | MediaStream; output?: string; inputVolume: number; outputVolume: number }) {
    const ctx = this.graph().ctx
    const element = document.createElement("audio")
    const destination = ctx.createMediaStreamDestination()

    const gain = ctx.createGain()
    gain.gain.value = clamp(options.inputVolume)
    const delay = ctx.createDelay(2)
    delay.delayTime.value = 1.5
    const volume = ctx.createGain()
    volume.gain.value = clamp(options.outputVolume)
    gain.connect(limiter(ctx)).connect(delay).connect(volume).connect(destination)
    element.srcObject = destination.stream

    let input: { stream: MediaStream; source: MediaStreamAudioSourceNode; owned: boolean } | undefined
    const release = () => {
      input?.source.disconnect()
      if (input?.owned) input.stream.getTracks().forEach((track) => track.stop())
    }
    const setInput = async (device: string | MediaStream) => {
      const stream = device instanceof MediaStream ? device : await microphone(device)
      release()
      input = { stream, source: ctx.createMediaStreamSource(stream), owned: !(device instanceof MediaStream) }
      input.source.connect(gain)
    }
    const setOutput = async (deviceId: string) => {
      if (!this.canChooseOutput) throw browserErrors.notSupported()
      await sink(element, deviceId)
    }
    const stop = () => {
      element.pause()
      release()
    }

    try {
      await setInput(options.input)
      if (options.output !== undefined) await setOutput(options.output)

      try {
        await ctx.resume()
        await element.play()
      } catch (error) {
        throw playError(error)
      }
    } catch (error) {
      // The microphone is already open: close it, or the browser keeps showing it in use.
      stop()
      throw error
    }

    return {
      stop,
      setInput,
      setOutput,
      setInputVolume: (value: number) => void (gain.gain.value = clamp(value)),
      setOutputVolume: (value: number) => void (volume.gain.value = clamp(value)),
    }
  }

  private graph() {
    if (!this.ctx) {
      if (typeof AudioContext === "undefined") throw browserErrors.audioUnavailable()

      const ctx = new AudioContext()
      this.ctx = ctx
      this.sent = ctx.createMediaStreamDestination()
      this.inputGain = ctx.createGain()
      this.muteGain = ctx.createGain()
      this.inputMeter = ctx.createAnalyser()
      this.inputGain.connect(limiter(ctx)).connect(this.muteGain)
      this.muteGain.connect(this.sent)
      this.muteGain.connect(this.inputMeter)

      this.outputGain = ctx.createGain()
      this.outputMeter = ctx.createAnalyser()
      const playback = ctx.createMediaStreamDestination()
      this.outputGain.connect(playback)
      this.outputGain.connect(this.outputMeter)
      if (this.speaker) this.speaker.srcObject = playback.stream
    }

    return {
      ctx: this.ctx,
      sent: this.sent!,
      inputGain: this.inputGain!,
      muteGain: this.muteGain!,
      inputMeter: this.inputMeter!,
      outputGain: this.outputGain!,
      outputMeter: this.outputMeter!,
    }
  }
}

// The soft limiter rounds the peaks of a loud microphone instead of letting the G.711 codec clip them.
function limiter(ctx: AudioContext): DynamicsCompressorNode {
  const node = ctx.createDynamicsCompressor()
  node.threshold.value = -6
  node.knee.value = 6
  node.ratio.value = 12
  node.attack.value = 0.003
  node.release.value = 0.1

  return node
}

// sink sends an element to a speaker, with the speaker errors as PhoneError.
async function sink(element: HTMLAudioElement, deviceId: string) {
  try {
    await (element as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId)
  } catch (error) {
    const name = (error as DOMException).name
    if (name === "NotFoundError" || name === "NotAllowedError" || name === "AbortError") throw browserErrors.speakerNotFound()

    throw new PhoneError("speaker_not_found", String(error))
  }
}

// playError tells a sound the browser blocked for lack of a user action from any other failure.
function playError(error: unknown): PhoneError {
  if (error instanceof PhoneError) return error
  if ((error as DOMException)?.name === "NotAllowedError") return browserErrors.userGestureRequired()

  return new PhoneError("audio_unavailable", String(error))
}

async function microphone(deviceId: string | undefined): Promise<MediaStream> {
  if (!navigator.mediaDevices?.getUserMedia) throw browserErrors.audioUnavailable()

  try {
    return await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId && deviceId !== "default" ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: true,
        noiseSuppression: true,
        // The input gain is the only volume control: the browser's own one would fight it.
        autoGainControl: false,
      },
    })
  } catch (error) {
    const name = (error as DOMException).name
    if (name === "NotAllowedError" || name === "SecurityError") throw browserErrors.microphoneDenied()
    if (name === "NotFoundError" || name === "OverconstrainedError") throw browserErrors.microphoneNotFound()

    throw new PhoneError("microphone_not_found", String(error))
  }
}

function peak(meter: AnalyserNode): number {
  const samples = new Float32Array(meter.fftSize)
  meter.getFloatTimeDomainData(samples)

  let max = 0
  for (const sample of samples) max = Math.max(max, Math.abs(sample))

  return Math.min(max, 1)
}

/** clamp keeps a volume between 0 and 2; anything that is not a number is 1. */
export function clamp(volume: number): number {
  return Number.isFinite(volume) ? Math.max(0, Math.min(2, volume)) : 1
}
