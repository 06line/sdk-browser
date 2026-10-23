// The objects of the SDK, in camelCase, and the JSON of the API they come from.

export type Actor = { type: "user" | "api_key" | "agent" | "system"; id: string }

export type PhoneState = "connecting" | "connected" | "reconnecting" | "closed"

export type CallState = "dialing" | "ringing" | "active" | "ended"

// answered_elsewhere is the SDK's own: another session of the company answered the incoming call.
export type EndReason =
  | "hangup"
  | "remote_hangup"
  | "no_answer"
  | "busy"
  | "line_offline"
  | "failed"
  | "answered_elsewhere"

export type Line = {
  id: string
  phoneNumber: string
  status: "active" | "suspended"
  online: boolean
  signal?: number
  network?: "2g" | "3g" | "4g"
}

/** The JSON of POST /v1/ephemeral-keys, as your server returns it. */
export type EphemeralKey = {
  ephemeral_key: string
  expires_at: string
  company_id: string
  line_id?: string
  ice_servers: RTCIceServer[]
}

export type AudioOptions = {
  /** Microphone deviceId from phone.devices(), or your own MediaStream. */
  input?: string | MediaStream
  /** Speaker deviceId from phone.devices(); only where phone.canChooseOutput is true. */
  output?: string
  /** Microphone gain, 0 (silent) to 2 (+6 dB). */
  inputVolume?: number
  /** Playback volume of the other party, 0 to 2. */
  outputVolume?: number
}

/** The microphone test of phone.testMicrophone(): its devices and volumes change live, like a call's. */
export type MicrophoneTest = {
  stop(): void
  setInput(device: string | MediaStream): Promise<void>
  setOutput(deviceId: string): Promise<void>
  setInputVolume(volume: number): void
  setOutputVolume(volume: number): void
}

export type CallOptions = AudioOptions & {
  to: string
  lineId?: string
  clientRef?: string
}

export type PhoneOptions = {
  getEphemeralKey: () => Promise<EphemeralKey>
  baseUrl?: string
  autoConnect?: boolean
  rememberDevices?: boolean
}

// The API objects pushed on the data channel and returned by the REST routes.
export type ApiLine = {
  id: string
  phone_number: string
  status: "active" | "suspended"
  online: boolean
  signal?: number
  network?: "2g" | "3g" | "4g"
}

export type ApiCall = {
  id: string
  line_id: string
  direction: "outbound" | "inbound"
  from: string
  to: string
  state: CallState
  end_reason?: EndReason
  client_ref?: string
  created_by: Actor
  started_at: string
  answered_at?: string
  ended_at?: string
  duration_s?: number
}

export type SessionEvent =
  | { type: "session.ready"; data: { lines: ApiLine[] } }
  | { type: "line.state"; data: ApiLine }
  | { type: "call.incoming"; data: ApiCall }
  | { type: "call.state"; data: ApiCall }

export function lineFrom(line: ApiLine): Line {
  return {
    id: line.id,
    phoneNumber: line.phone_number,
    status: line.status,
    online: line.online,
    signal: line.signal,
    network: line.network,
  }
}
