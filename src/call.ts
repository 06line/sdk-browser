import { Emitter } from "./emitter.js"
import { toPhoneError } from "./errors.js"
import { clamp, type Sound } from "./sound.js"
import type { ApiCall, AudioOptions, CallState, EndReason, Track } from "./types.js"

type CallEvents = {
  state: (state: CallState) => void
  ended: (reason: EndReason) => void
  level: (levels: { input: number; output: number }) => void
  transcript: (track: Track, text: string) => void
}

/**
 * What a call needs from its phone: the REST routes, with the key and the sessions of the phone, and the memory of the
 * devices.
 * @internal
 */
export type CallHost = {
  answer(call: Call, options: AudioOptions): Promise<void>
  hangup(call: Call): Promise<void>
  remember(call: Call): void
}

/**
 * The audio a call runs with, once the phone has opened it.
 * @internal
 */
export type CallAudio = {
  input: string | MediaStream
  output: string | null
  inputVolume: number
  outputVolume: number
}

/** One call: its state from the API, its controls, and its audio settings, which can change while it runs. */
export class Call extends Emitter<CallEvents> {
  readonly id: string
  readonly lineId: string
  readonly direction: "outbound" | "inbound"
  readonly from: string
  readonly to: string
  readonly startedAt: Date

  state: CallState
  endReason: EndReason | null = null
  answeredAt: Date | null = null
  muted = false
  input: string | MediaStream = "default"
  output: string | null = null
  inputVolume = 1
  outputVolume = 1
  /** What was said on each track so far, when the account transcribes its calls live. */
  transcript: Record<Track, string> = { remote: "", local: "" }

  private levelTimer?: ReturnType<typeof setInterval>
  // Whether the sound of the phone is this call's: only then does its end release the microphone.
  private hasAudio = false

  /** @internal */
  constructor(
    data: ApiCall,
    private readonly host: CallHost,
    private readonly sound: Sound
  ) {
    super()
    this.id = data.id
    this.lineId = data.line_id
    this.direction = data.direction
    this.from = data.from
    this.to = data.to
    this.startedAt = new Date(data.started_at)
    this.state = data.state
    this.output = sound.canChooseOutput ? "default" : null
  }

  answer(options: AudioOptions = {}): Promise<void> {
    return this.host.answer(this, options)
  }

  hangup(): Promise<void> {
    return this.host.hangup(this)
  }

  mute(muted = true) {
    this.muted = muted
    this.sound.mute(muted)
  }

  async setInput(device: string | MediaStream) {
    try {
      await this.sound.setInput(device)
    } catch (error) {
      throw toPhoneError(error)
    }

    this.input = device
    this.host.remember(this)
  }

  async setOutput(deviceId: string) {
    try {
      await this.sound.setOutput(deviceId)
    } catch (error) {
      throw toPhoneError(error)
    }

    this.output = deviceId
    this.host.remember(this)
  }

  setInputVolume(volume: number) {
    this.inputVolume = clamp(volume)
    this.sound.setInputVolume(volume)
    this.host.remember(this)
  }

  setOutputVolume(volume: number) {
    this.outputVolume = clamp(volume)
    this.sound.setOutputVolume(volume)
    this.host.remember(this)
  }

  /**
   * Adds the words heard on a track, from call.transcript.
   * @internal
   */
  hear(track: Track, text: string) {
    this.transcript = { ...this.transcript, [track]: this.transcript[track] + text }
    this.emit("transcript", track, text)
  }

  /**
   * Takes the audio the phone opened for this call, before it starts.
   * @internal
   */
  attach(audio: CallAudio) {
    if (this.endReason) return

    this.hasAudio = true
    this.input = audio.input
    this.output = audio.output
    this.inputVolume = audio.inputVolume
    this.outputVolume = audio.outputVolume
    this.muted = false
    this.levelTimer ??= setInterval(() => this.emit("level", this.sound.levels()), 50)
  }

  /**
   * Gives the sound back when answering failed: the call goes on ringing, or has ended.
   * @internal
   */
  detach() {
    if (!this.hasAudio) return

    this.hasAudio = false
    clearInterval(this.levelTimer)
    this.levelTimer = undefined
    this.sound.releaseInput()
  }

  /**
   * Takes the state the API reports.
   * @internal
   */
  update(data: ApiCall) {
    if (this.endReason) return

    // Every page rings; when another one answers, the call is over for this phone.
    if (this.direction === "inbound" && data.state === "active" && !this.hasAudio) {
      this.end("answered_elsewhere")

      return
    }

    if (data.answered_at) this.answeredAt = new Date(data.answered_at)
    if (data.transcript) this.transcript = { remote: "", local: "", ...data.transcript }

    if (data.state !== this.state) {
      this.state = data.state
      this.emit("state", data.state)
    }

    if (data.state === "ended") this.end(data.end_reason ?? "hangup")
  }

  /**
   * Ends the call here, once: the state event, then the microphone is released, then the ended event.
   * @internal
   */
  end(reason: EndReason) {
    if (this.endReason) return

    if (this.state !== "ended") {
      this.state = "ended"
      this.emit("state", "ended")
    }

    this.endReason = reason
    clearInterval(this.levelTimer)
    if (this.hasAudio) this.sound.releaseInput()
    this.emit("ended", reason)
  }
}
