import { api } from "./api.js"
import { Call, type CallAudio, type CallHost } from "./call.js"
import { Emitter } from "./emitter.js"
import { browserErrors, PhoneError, toPhoneError } from "./errors.js"
import { clamp, Sound } from "./sound.js"
import {
  type ApiCall,
  type AudioOptions,
  type CallOptions,
  type EphemeralKey,
  type Line,
  lineFrom,
  type MicrophoneTest,
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
// A session that answers its offer but never sends session.ready is a failed one.
const readyWithin = 10_000

/** Phone holds the WebRTC session of the page, its lines, and its calls, one at a time. */
export class Phone extends Emitter<PhoneEvents> {
  state: PhoneState = "closed"
  lines: Line[] = []
  calls: Call[] = []

  private readonly sound = new Sound()
  private readonly baseUrl: string
  private readonly host: CallHost = {
    answer: (call, options) => this.answerCall(call, options),
    hangup: (call) => this.hangupCall(call),
  }
  private key?: EphemeralKey
  private keyTimer?: ReturnType<typeof setTimeout>
  private pc?: RTCPeerConnection
  private sessionId?: string
  private lostSince?: number
  private retryTimer?: ReturnType<typeof setTimeout>
  private opening?: Promise<void>
  private wanted = false

  /** @internal */
  constructor(private readonly options: PhoneOptions) {
    super()
    this.baseUrl = (options.baseUrl ?? "https://api.06line.com").replace(/\/$/, "")
    this.sound.onMicrophoneLost = () => {
      this.current()?.mute(true)
      this.emit("error", browserErrors.microphoneNotFound())
    }

    // Back online after a network loss: retry now rather than at the end of the wait.
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => {
        if (this.wanted && this.state === "reconnecting") void this.open().catch(() => this.sessionLost())
      })
    }

    if (options.autoConnect ?? true) void this.connect().catch((error) => this.emit("error", toPhoneError(error)))
  }

  /** Whether the browser can send the sound to a chosen speaker (it has HTMLMediaElement.setSinkId). */
  get canChooseOutput(): boolean {
    return this.sound.canChooseOutput
  }

  /** Opens the WebRTC session, and keeps it open until disconnect(). */
  async connect(): Promise<void> {
    this.wanted = true
    if (this.state === "connected") return
    if (this.state === "closed") this.setState("connecting")

    try {
      await this.open()
    } catch (error) {
      this.sessionLost()
      throw toPhoneError(error)
    }
  }

  /** Closes the session; the call in progress is hung up. */
  async disconnect(): Promise<void> {
    this.wanted = false
    this.lostSince = undefined
    clearTimeout(this.keyTimer)
    clearTimeout(this.retryTimer)

    const call = this.current()
    if (call) await this.hangupCall(call).catch(() => {})
    this.endAll("hangup")

    const id = this.sessionId
    this.closeSession()
    if (id && this.key) {
      await api(this.baseUrl, this.key.ephemeral_key, `/v1/webrtc/sessions/${id}`, undefined, "DELETE").catch(() => {})
    }
    this.setState("closed")
  }

  async devices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
    if (!navigator.mediaDevices?.enumerateDevices) throw browserErrors.audioUnavailable()

    let devices: MediaDeviceInfo[]
    try {
      devices = await navigator.mediaDevices.enumerateDevices()
    } catch (error) {
      throw toPhoneError(error)
    }

    return {
      inputs: devices.filter((d) => d.kind === "audioinput"),
      outputs: this.canChooseOutput ? devices.filter((d) => d.kind === "audiooutput") : [],
    }
  }

  /**
   * Plays the microphone back 1.5 s later, so the voice is not drowned by the sound of speaking; call it from a user
   * action. Its devices and volumes change live, like a call's.
   */
  async testMicrophone(options: AudioOptions = {}): Promise<MicrophoneTest> {
    requireGesture()

    try {
      const test = await this.withDevices(options, (audio) => this.sound.test(audio))

      return {
        stop: test.stop,
        setInput: (device) => test.setInput(device).catch((error) => Promise.reject(toPhoneError(error))),
        setOutput: (deviceId) => test.setOutput(deviceId).catch((error) => Promise.reject(toPhoneError(error))),
        setInputVolume: test.setInputVolume,
        setOutputVolume: test.setOutputVolume,
      }
    } catch (error) {
      throw toPhoneError(error)
    }
  }

  /**
   * Places a call from a user action. The microphone opens first: if it fails, no call is placed. Resolves as soon as
   * the call exists, before it rings.
   */
  async call(options: CallOptions): Promise<Call> {
    requireGesture()
    const sessionId = this.session()
    const lineId = this.lineFor(options.lineId)

    await this.prepareAudio()
    const audio = await this.openAudio(options)

    let data: ApiCall
    try {
      data = await this.request<ApiCall>("/v1/calls", {
        line_id: lineId,
        to: options.to,
        session_id: sessionId,
        client_ref: options.clientRef,
      })
    } catch (error) {
      this.sound.releaseInput()
      throw error
    }

    return this.track(data, audio)
  }

  // The CallHost of the calls.

  private async answerCall(call: Call, options: AudioOptions): Promise<void> {
    requireGesture()
    const sessionId = this.session()

    await this.prepareAudio()
    const audio = await this.openAudio(options)
    call.attach(audio)
    this.remember(call)

    try {
      // The answer resolves with the call still ringing; call.state turns it active.
      call.update(await this.request<ApiCall>(`/v1/calls/${call.id}/answer`, { session_id: sessionId }))
    } catch (error) {
      call.detach()
      throw error
    }
  }

  private async hangupCall(call: Call): Promise<void> {
    call.update(await this.request<ApiCall>(`/v1/calls/${call.id}/hangup`, {}))
  }

  // Audio.

  private async prepareAudio() {
    try {
      await this.sound.start()
    } catch (error) {
      throw toPhoneError(error)
    }
  }

  /** Opens the microphone and the speaker of a call, and says what it runs with. */
  private openAudio(options: AudioOptions): Promise<CallAudio> {
    return this.withDevices(options, async (audio) => {
      await this.sound.open(audio)

      return {
        input: audio.input,
        output: this.canChooseOutput ? (audio.output ?? "default") : null,
        inputVolume: audio.inputVolume,
        outputVolume: audio.outputVolume,
      }
    })
  }

  /**
   * Runs with the given devices, else the remembered ones, else the system defaults. A remembered device that is gone
   * is forgotten, and the defaults are used instead.
   */
  private async withDevices<T>(
    options: AudioOptions,
    run: (audio: { input: string | MediaStream; output?: string; inputVolume: number; outputVolume: number }) => Promise<T>
  ): Promise<T> {
    const remembered = this.remembered()
    const audio = (devices: AudioOptions) => {
      const merged = { ...devices, ...options }

      return {
        input: merged.input ?? "default",
        output: this.canChooseOutput ? merged.output : undefined,
        inputVolume: clamp(merged.inputVolume ?? 1),
        outputVolume: clamp(merged.outputVolume ?? 1),
      }
    }

    try {
      return await run(audio(remembered))
    } catch (error) {
      const code = error instanceof PhoneError ? error.code : ""
      const staleInput = code === "microphone_not_found" && options.input === undefined && remembered.input !== undefined
      const staleOutput = code === "speaker_not_found" && options.output === undefined && remembered.output !== undefined
      if (!staleInput && !staleOutput) throw error

      this.forgetDevices()

      return run(audio({ inputVolume: remembered.inputVolume, outputVolume: remembered.outputVolume }))
    }
  }

  private current(): Call | undefined {
    return this.calls.find((call) => call.state !== "ended")
  }

  /** The Call of the API object, created the first time it is seen; audio is what call() opened for it. */
  private track(data: ApiCall, audio?: CallAudio): Call {
    let call = this.calls.find((c) => c.id === data.id)
    if (!call) {
      const created = new Call(data, this.host, this.sound)
      created.on("ended", () => {
        this.calls = this.calls.filter((c) => c !== created)
      })
      this.calls.push(created)
      call = created
    }

    if (audio) {
      call.attach(audio)
      this.remember(call)
    }
    call.update(data)

    return call
  }

  private endAll(reason: "hangup" | "line_offline") {
    for (const call of [...this.calls]) call.end(reason)
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
        // Only calls this phone knows: a call another session took ends here as answered_elsewhere.
        if (this.calls.some((c) => c.id === event.data.id)) this.track(event.data)
        break
    }
  }

  // The WebRTC session.

  private session(): string {
    if (this.state !== "connected" || !this.sessionId) throw browserErrors.notConnected()

    return this.sessionId
  }

  private lineFor(lineId: string | undefined): string {
    if (lineId) return lineId
    if (this.lines.length === 1) return this.lines[0].id

    throw new PhoneError(
      "invalid_request",
      this.lines.length === 0 ? "this phone has no line: its ephemeral key gives access to none" : "lineId is required: this phone has several lines",
      { param: "lineId" }
    )
  }

  /** Opens a session, once at a time: connect(), the retry timer and the online event share it. */
  private open(): Promise<void> {
    clearTimeout(this.retryTimer)
    this.opening ??= (async () => {
      try {
        await this.refreshKey()
        await this.openSession()
      } finally {
        this.opening = undefined
      }
    })()

    return this.opening
  }

  private async openSession() {
    this.closeSession()

    const key = this.key!
    const pc = new RTCPeerConnection({ iceServers: key.ice_servers })
    this.pc = pc

    pc.addTransceiver(this.sound.track(), { direction: "sendrecv" })
    pc.ontrack = (event) => this.sound.setRemote(event.streams[0] ?? new MediaStream([event.track]))

    const channel = pc.createDataChannel("06line")
    const ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new PhoneError("internal", "the session never became ready")), readyWithin)
      channel.onmessage = (message) => {
        const event = JSON.parse(message.data) as SessionEvent
        this.onEvent(event)
        if (event.type === "session.ready") {
          clearTimeout(timer)
          resolve()
        }
      }
    })

    // ICE failed, or the data channel closed: the session is gone, a new one opens.
    const lost = () => {
      if (pc === this.pc && this.state === "connected") this.sessionLost()
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === "failed" || pc.connectionState === "closed") lost()
    }
    channel.onclose = lost

    await pc.setLocalDescription(await pc.createOffer())
    await iceGathered(pc)

    const session = await this.request<{ id: string; sdp: string }>("/v1/webrtc/sessions", { sdp: pc.localDescription!.sdp })
    this.sessionId = session.id
    await pc.setRemoteDescription({ type: "answer", sdp: session.sdp })
    await ready

    const reconnected = this.lostSince !== undefined
    this.lostSince = undefined
    this.setState("connected")
    if (reconnected) await this.syncCalls()
  }

  /**
   * After a new session: the API hung up the call of the lost one, and this phone missed its events. The calls take
   * the state the API has now.
   */
  private async syncCalls() {
    for (const call of [...this.calls]) {
      try {
        call.update(await this.request<ApiCall>(`/v1/calls/${call.id}`))
      } catch {
        call.end("line_offline")
      }
    }
  }

  private closeSession() {
    const pc = this.pc
    this.pc = undefined
    this.sessionId = undefined
    pc?.close()
  }

  /**
   * The session died. Its calls stay as they are until a new session tells their real state (the API hangs up a call
   * whose session is lost); a new one opens with a growing wait, for up to 2 minutes, then the calls end line_offline.
   */
  private sessionLost() {
    this.closeSession()
    if (!this.wanted) return

    this.lostSince ??= Date.now()
    if (Date.now() - this.lostSince > giveUpAfter) {
      this.wanted = false
      this.lostSince = undefined
      clearTimeout(this.keyTimer)
      this.endAll("line_offline")
      this.setState("closed")
      this.emit("error", browserErrors.connectionLost())

      return
    }

    this.setState("reconnecting")
    clearTimeout(this.retryTimer)
    const elapsed = Date.now() - this.lostSince
    this.retryTimer = setTimeout(() => void this.open().catch(() => this.sessionLost()), Math.min(1000 + elapsed / 4, 10_000))
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
    this.keyTimer = setTimeout(() => {
      if (this.wanted) void this.refreshKey().catch((error) => this.emit("error", toPhoneError(error)))
    }, wait)
  }

  private request<T>(path: string, body?: unknown): Promise<T> {
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

    const audio: AudioOptions = { inputVolume: call.inputVolume, outputVolume: call.outputVolume }
    if (typeof call.input === "string") audio.input = call.input
    if (call.output) audio.output = call.output
    this.store(audio)
  }

  private forgetDevices() {
    const { inputVolume, outputVolume } = this.remembered()
    this.store({ inputVolume, outputVolume })
  }

  private store(audio: AudioOptions) {
    try {
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
