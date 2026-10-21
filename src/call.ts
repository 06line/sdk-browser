import { Emitter } from "./emitter.js"
import type { Sound } from "./sound.js"
import type { ApiCall, AudioOptions, CallState, EndReason } from "./types.js"

type CallEvents = {
  state: (state: CallState) => void
  ended: (reason: EndReason) => void
  level: (levels: { input: number; output: number }) => void
}

// What a call needs from its phone: the REST routes, with the session of the phone.
export type CallHost = {
  answer(call: Call, options: AudioOptions): Promise<void>
  hangup(call: Call): Promise<void>
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

  private levelTimer?: ReturnType<typeof setInterval>

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
    await this.sound.setInput(device)
    this.input = device
  }

  async setOutput(deviceId: string) {
    await this.sound.setOutput(deviceId)
    this.output = deviceId
  }

  setInputVolume(volume: number) {
    this.inputVolume = volume
    this.sound.setInputVolume(volume)
  }

  setOutputVolume(volume: number) {
    this.outputVolume = volume
    this.sound.setOutputVolume(volume)
  }

  /** Applies the audio options of call() or answer(); the phone calls it before the call starts. */
  async configure(options: AudioOptions) {
    if (options.output !== undefined) await this.setOutput(options.output)
    await this.setInput(options.input ?? "default")
    this.setInputVolume(options.inputVolume ?? 1)
    this.setOutputVolume(options.outputVolume ?? 1)
    this.mute(false)

    this.levelTimer ??= setInterval(() => this.emit("level", this.sound.levels()), 50)
  }

  /** Takes the state the API reports. */
  update(data: ApiCall) {
    if (this.state === "ended") return

    if (data.answered_at) this.answeredAt = new Date(data.answered_at)

    if (data.state !== this.state) {
      this.state = data.state
      this.emit("state", data.state)
    }

    if (data.state === "ended") this.end(data.end_reason ?? "hangup")
  }

  /** Ends the call here, once, and releases the microphone. */
  end(reason: EndReason) {
    if (this.endReason) return

    if (this.state !== "ended") {
      this.state = "ended"
      this.emit("state", "ended")
    }

    this.endReason = reason
    clearInterval(this.levelTimer)
    this.sound.releaseInput()
    this.emit("ended", reason)
  }
}
