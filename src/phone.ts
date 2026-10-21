import { api } from "./api.js"
import { Call, type CallHost } from "./call.js"
import { Emitter } from "./emitter.js"
import { browserErrors, PhoneError } from "./errors.js"
import { Sound } from "./sound.js"
import {
  type ApiCall,
  type AudioOptions,
  type CallOptions,
  type EphemeralKey,
  type Line,
  lineFrom,
  type PhoneOptions,
  type PhoneState,
  type SessionEvent,
} from "./types.js"

type PhoneEvents = {
  state: (state: PhoneState) => void
  incoming: (call: Call) => void
  line: (line: Line) => void
  error: (error: PhoneError) => void
}

const storageKey = "06line:audio"
// A key is refreshed this long before it expires.
const refreshBefore = 60_000
// A session that cannot be restored for this long is given up, with connection_lost.
const giveUpAfter = 120_000

/** Phone holds the WebRTC session of the page, its lines, and its calls, one at a time. */
export class Phone extends Emitter<PhoneEvents> implements CallHost {
  state: PhoneState = "closed"
  lines: Line[] = []
  calls: Call[] = []

  private readonly sound = new Sound()
  private readonly baseUrl: string
  private key?: EphemeralKey
  private keyTimer?: ReturnType<typeof setTimeout>
  private pc?: RTCPeerConnection
  private sessionId?: string
  private lostSince?: number
  private retryTimer?: ReturnType<typeof setTimeout>
  private wanted = false

  constructor(private readonly options: PhoneOptions) {
    super()
    this.baseUrl = (options.baseUrl ?? "https://api.06line.com").replace(/\/$/, "")
    this.sound.onMicrophoneLost = () => {
      this.current()?.mute(true)
      this.emit("error", browserErrors.microphoneNotFound())
    }

    if (options.autoConnect ?? true) void this.connect().catch((error) => this.emit("error", toPhoneError(error)))
  }

  get canChooseOutput(): boolean {
    return this.sound.canChooseOutput
  }

  /** Opens the WebRTC session, and keeps it open until disconnect(). */
  async connect(): Promise<void> {
    this.wanted = true
    if (this.state === "connected" || this.state === "connecting") return

    this.setState(this.lostSince === undefined ? "connecting" : "reconnecting")

    try {
      await this.refreshKey()
      await this.openSession()
    } catch (error) {
      this.sessionLost()
      throw toPhoneError(error)
    }
  }

  /** Closes the session; the call in progress is hung up. */
  async disconnect(): Promise<void> {
    this.wanted = false
    clearTimeout(this.keyTimer)
    clearTimeout(this.retryTimer)

    const call = this.current()
    if (call) await this.hangup(call).catch(() => {})

    const id = this.sessionId
    this.closeSession()
    if (id && this.key) {
      await api(this.baseUrl, this.key.ephemeral_key, `/v1/webrtc/sessions/${id}`, undefined, "DELETE").catch(() => {})
    }
    this.setState("closed")
  }

  async devices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
    const devices = await navigator.mediaDevices.enumerateDevices()

    return {
      inputs: devices.filter((d) => d.kind === "audioinput"),
      outputs: this.canChooseOutput ? devices.filter((d) => d.kind === "audiooutput") : [],
    }
  }

  testMicrophone(options: AudioOptions = {}): Promise<{ stop(): void }> {
    return this.sound.test({ ...this.remembered(), ...options }).catch((error) => {
      throw toPhoneError(error)
    })
  }

  /** Places a call from a user action. Resolves as soon as the call exists, before it rings. */
  async call(options: CallOptions): Promise<Call> {
    requireGesture()
    const lineId = options.lineId ?? (this.lines.length === 1 ? this.lines[0].id : undefined)
    if (!lineId) throw new PhoneError("invalid_request", "lineId is required when the phone has several lines", { param: "lineId" })

    const audio = { ...this.remembered(), ...options }
    await this.prepareAudio()

    const data = await this.request<ApiCall>("/v1/calls", {
      line_id: lineId,
      to: options.to,
      session_id: await this.session(),
      client_ref: options.clientRef,
    })

    const call = this.track(data)
    await this.applyAudio(call, audio)

    return call
  }

  // CallHost

  async answer(call: Call, options: AudioOptions): Promise<void> {
    requireGesture()
    const audio = { ...this.remembered(), ...options }
    await this.prepareAudio()
    await this.applyAudio(call, audio)

    try {
      const data = await this.request<ApiCall>(`/v1/calls/${call.id}/answer`, { session_id: await this.session() })
      call.update(data)
    } catch (error) {
      this.sound.releaseInput()
      throw error
    }
  }

  async hangup(call: Call): Promise<void> {
    const data = await this.request<ApiCall>(`/v1/calls/${call.id}/hangup`, {})
    call.update(data)
  }

  private async prepareAudio() {
    try {
      await this.sound.start()
    } catch {
      throw browserErrors.userGestureRequired()
    }
  }

  private async applyAudio(call: Call, audio: AudioOptions) {
    try {
      await call.configure(audio)
    } catch (error) {
      await this.hangup(call).catch(() => {})
      throw toPhoneError(error)
    }

    this.remember(call)
  }

  private current(): Call | undefined {
    return this.calls.find((call) => call.state !== "ended")
  }

  /** The Call of the API object, created the first time it is seen. */
  private track(data: ApiCall): Call {
    let call = this.calls.find((c) => c.id === data.id)
    if (!call) {
      call = new Call(data, this, this.sound)
      this.calls.push(call)
      call.on("ended", () => {
        this.calls = this.calls.filter((c) => c !== call)
      })
    }

    call.update(data)

    return call
  }

  private onEvent(event: SessionEvent) {
    switch (event.type) {
      case "session.ready":
        this.lines = event.data.lines.map(lineFrom)
        break
      case "line.state": {
        const line = lineFrom(event.data)
        this.lines = this.lines.some((l) => l.id === line.id)
          ? this.lines.map((l) => (l.id === line.id ? line : l))
          : [...this.lines, line]
        this.emit("line", line)
        break
      }
      case "call.incoming":
        if (!this.calls.some((c) => c.id === event.data.id)) this.emit("incoming", this.track(event.data))
        break
      case "call.state":
        this.track(event.data)
        break
    }
  }

  // The WebRTC session.

  private async session(): Promise<string> {
    if (this.state !== "connected" || !this.sessionId) throw new PhoneError("line_offline", "the phone is not connected")

    return this.sessionId
  }

  private async openSession() {
    const key = this.key!
    const pc = new RTCPeerConnection({ iceServers: key.ice_servers })
    this.pc = pc

    pc.addTransceiver(this.sound.track(), { direction: "sendrecv" })
    pc.ontrack = (event) => this.sound.setRemote(event.streams[0] ?? new MediaStream([event.track]))

    const channel = pc.createDataChannel("06line")
    const ready = new Promise<void>((resolve) => {
      channel.onmessage = (message) => {
        const event = JSON.parse(message.data) as SessionEvent
        this.onEvent(event)
        if (event.type === "session.ready") resolve()
      }
    })

    pc.onconnectionstatechange = () => {
      if (pc !== this.pc) return
      if (pc.connectionState === "failed" || pc.connectionState === "closed") this.sessionLost()
    }

    await pc.setLocalDescription(await pc.createOffer())
    await iceGathered(pc)

    const session = await this.request<{ id: string; sdp: string }>("/v1/webrtc/sessions", { sdp: pc.localDescription!.sdp })
    this.sessionId = session.id
    await pc.setRemoteDescription({ type: "answer", sdp: session.sdp })
    await ready

    this.lostSince = undefined
    this.setState("connected")
  }

  private closeSession() {
    const pc = this.pc
    this.pc = undefined
    this.sessionId = undefined
    pc?.close()
  }

  /** The session died: its call is over; a new one opens with a growing wait, for up to 2 minutes. */
  private sessionLost() {
    this.closeSession()
    this.current()?.end("line_offline")
    if (!this.wanted) return

    this.lostSince ??= Date.now()
    if (Date.now() - this.lostSince > giveUpAfter) {
      this.wanted = false
      this.lostSince = undefined
      this.setState("closed")
      this.emit("error", browserErrors.connectionLost())

      return
    }

    this.setState("reconnecting")
    clearTimeout(this.retryTimer)
    const elapsed = Date.now() - this.lostSince
    this.retryTimer = setTimeout(() => {
      this.state = "reconnecting"
      void this.openSessionAgain()
    }, Math.min(1000 + elapsed / 4, 10_000))
  }

  private async openSessionAgain() {
    try {
      await this.refreshKey()
      await this.openSession()
    } catch {
      this.sessionLost()
    }
  }

  // The ephemeral key.

  private async refreshKey() {
    if (this.key && new Date(this.key.expires_at).getTime() - Date.now() > refreshBefore) return

    try {
      this.key = await this.options.getEphemeralKey()
      if (!this.key?.ephemeral_key) throw new Error("no ephemeral_key in the answer")
    } catch (error) {
      throw error instanceof PhoneError ? error : browserErrors.ephemeralKeyFailed(error)
    }

    clearTimeout(this.keyTimer)
    const wait = Math.max(new Date(this.key.expires_at).getTime() - Date.now() - refreshBefore, 5_000)
    this.keyTimer = setTimeout(() => void this.refreshKey().catch((error) => this.emit("error", toPhoneError(error))), wait)
  }

  private request<T>(path: string, body: unknown): Promise<T> {
    return api<T>(this.baseUrl, this.key!.ephemeral_key, path, body)
  }

  private setState(state: PhoneState) {
    if (state === this.state) return

    this.state = state
    this.emit("state", state)
  }

  // Remembered devices and volumes.

  private remembered(): AudioOptions {
    if (this.options.rememberDevices === false) return {}

    try {
      return JSON.parse(localStorage.getItem(storageKey) ?? "{}") as AudioOptions
    } catch {
      return {}
    }
  }

  private remember(call: Call) {
    if (this.options.rememberDevices === false) return

    try {
      const audio: AudioOptions = { inputVolume: call.inputVolume, outputVolume: call.outputVolume }
      if (typeof call.input === "string") audio.input = call.input
      if (call.output) audio.output = call.output
      localStorage.setItem(storageKey, JSON.stringify(audio))
    } catch {
      // Private browsing or blocked storage: the defaults stay.
    }
  }
}

/** Creates the phone of the page: one WebRTC session, one call at a time. */
export function createPhone(options: PhoneOptions): Phone {
  return new Phone(options)
}

function iceGathered(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === "complete") return Promise.resolve()

  return new Promise((resolve) => {
    const done = () => pc.iceGatheringState === "complete" && resolve()
    pc.addEventListener("icegatheringstatechange", done)
    // A host that never finishes gathering (an unreachable STUN server) should not hold the phone forever.
    setTimeout(resolve, 3_000)
  })
}

// Browsers allow the microphone and sound only during a user action.
function requireGesture() {
  const activation = (navigator as Navigator & { userActivation?: { isActive: boolean } }).userActivation
  if (activation && !activation.isActive) throw browserErrors.userGestureRequired()
}

function toPhoneError(error: unknown): PhoneError {
  return error instanceof PhoneError ? error : new PhoneError("internal", String(error))
}
