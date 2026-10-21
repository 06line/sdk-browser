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

    await (this.speaker as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(deviceId)
  }

  setOutputVolume(volume: number) {
    this.graph().outputGain.gain.value = clamp(volume)
  }

  /** Starts the sound: browsers allow it only during a user action, so call() and answer() call this first. */
  async start() {
    const { ctx } = this.graph()

    await ctx.resume()
    await this.speaker?.play()
  }

  /** Peak levels, 0 to 1, of what is sent and what is heard. */
  levels(): { input: number; output: number } {
    const { inputMeter, outputMeter } = this.graph()

    return { input: peak(inputMeter), output: peak(outputMeter) }
  }

  /** Plays a microphone back 0.5 s later through the same gain and limiter as a call. */
  async test(options: { input?: string | MediaStream; output?: string; inputVolume?: number; outputVolume?: number }) {
    const ctx = this.graph().ctx
    const stream = options.input instanceof MediaStream ? options.input : await microphone(options.input)
    const element = document.createElement("audio")
    const destination = ctx.createMediaStreamDestination()

    const gain = ctx.createGain()
    gain.gain.value = clamp(options.inputVolume ?? 1)
    const delay = ctx.createDelay(1)
    delay.delayTime.value = 0.5
    const volume = ctx.createGain()
    volume.gain.value = clamp(options.outputVolume ?? 1)

    const source = ctx.createMediaStreamSource(stream)
    source.connect(gain).connect(limiter(ctx)).connect(delay).connect(volume).connect(destination)
    element.srcObject = destination.stream

    if (options.output !== undefined) {
      if (!this.canChooseOutput) throw browserErrors.notSupported()
      await (element as HTMLAudioElement & { setSinkId(id: string): Promise<void> }).setSinkId(options.output)
    }

    await ctx.resume()
    await element.play()

    return {
      stop: () => {
        element.pause()
        source.disconnect()
        if (!(options.input instanceof MediaStream)) stream.getTracks().forEach((track) => track.stop())
      },
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

function clamp(volume: number): number {
  return Math.max(0, Math.min(2, volume))
}
