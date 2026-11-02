// The objects of the SDK, in camelCase, and the JSON of the API they come from.

export type Actor = { type: "user" | "api_key" | "agent" | "system"; id: string }

export type PhoneState = "connecting" | "connected" | "reconnecting" | "closed"

export type CallState = "dialing" | "ringing" | "active" | "ended"

// answered_elsewhere is the SDK's own: another page or server of the company answered the incoming call.
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

export type MicrophoneTestOptions = AudioOptions & {
  /** Plays the voice as the other party hears it: the telephone band and the G.711 codec of a call. */
  phoneQuality?: boolean
}

/** The microphone test of phone.testMicrophone(): its devices and volumes change live, like a call's. */
export type MicrophoneTest = {
  readonly input: string | MediaStream
  readonly output: string | null
  readonly inputVolume: number
  readonly outputVolume: number
  readonly phoneQuality: boolean
  stop(): void
  setInput(device: string | MediaStream): Promise<void>
  setOutput(deviceId: string): Promise<void>
  setInputVolume(volume: number): void
  setOutputVolume(volume: number): void
  setPhoneQuality(enabled: boolean): void
  /** Peak levels, 0 to 1, of the microphone and of what plays back. */
  levels(): { input: number; output: number }
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

// The API objects pushed on the event stream and returned by the REST routes.
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
  transcript?: Partial<Record<Track, string>>
}

/**
 * A change to an attribute of a record, learned from what was said on a call: applied to the record, or suggested for
 * someone to accept, as the company chose. `recordId` is null while the record is still to make, `newRecord` naming
 * it; `value` is one item of a list attribute; `quote` the words that say it.
 */
export type Enrichment = {
  id: string
  callId: string
  object: string
  attribute: string
  recordId: string | null
  newRecord?: string
  /** The name of the record, or of the record to make. */
  recordTitle: string
  value: unknown
  previous: unknown
  quote: string
  status: "applied" | "suggested" | "dismissed"
}

export type ApiEnrichment = {
  id: string
  call_id: string
  object: string
  attribute: string
  record_id: string | null
  new_record?: string
  record_title: string
  value: unknown
  previous: unknown
  quote: string
  status: Enrichment["status"]
}

export function enrichmentFrom(data: ApiEnrichment): Enrichment {
  return {
    id: data.id,
    callId: data.call_id,
    object: data.object,
    attribute: data.attribute,
    recordId: data.record_id,
    newRecord: data.new_record,
    recordTitle: data.record_title,
    value: data.value,
    previous: data.previous,
    quote: data.quote,
    status: data.status,
  }
}

/** A track of a call: remote is the other party, local is you. */
export type Track = "remote" | "local"

// The SMS events of the stream never reach an ephemeral key.
export type StreamEvent =
  | { type: "ready"; data: { lines: ApiLine[]; calls: ApiCall[] } }
  | { type: "line.state"; data: ApiLine }
  | { type: "call.incoming"; data: ApiCall }
  | { type: "call.state"; data: ApiCall }
  | { type: "call.transcript"; data: { call_id: string; track: Track; text: string } }
  | { type: "call.enrichment"; data: ApiEnrichment }

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
