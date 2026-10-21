// The messages 06 Line pushes on the `06line` data channel of a WebRTC session, as api/openapi.yaml and the calls
// guide describe them. The softphone of this package is built on them.

export type Actor = { type: "user" | "api_key" | "agent" | "system"; id: string }

export type Line = {
  id: string
  phone_number: string
  status: "active" | "suspended"
  online: boolean
  signal?: number
  network?: "2g" | "3g" | "4g"
}

export type Call = {
  id: string
  line_id: string
  direction: "outbound" | "inbound"
  from: string
  to: string
  state: "dialing" | "ringing" | "active" | "ended"
  end_reason?: "hangup" | "remote_hangup" | "no_answer" | "busy" | "failed" | "line_offline"
  client_ref?: string
  created_by: Actor
  started_at: string
  answered_at?: string
  ended_at?: string
  duration_s?: number
}

export type SessionEvent =
  | { type: "session.ready"; data: { lines: Line[] } }
  | { type: "line.state"; data: Line }
  | { type: "call.incoming"; data: Call }
  | { type: "call.state"; data: Call }
