// PhoneError is what every rejected promise and every error event of the SDK carries. code is one of the API error
// codes, or one of the browser codes below.
export class PhoneError extends Error {
  readonly code: string
  readonly requestId?: string
  readonly param?: string

  constructor(code: string, message: string, extra: { requestId?: string; param?: string } = {}) {
    super(message)
    this.name = "PhoneError"
    this.code = code
    this.requestId = extra.requestId
    this.param = extra.param
  }
}

export const browserErrors = {
  microphoneDenied: () => new PhoneError("microphone_denied", "microphone access was refused"),
  microphoneNotFound: () => new PhoneError("microphone_not_found", "no microphone, or the chosen one is unplugged"),
  audioUnavailable: () => new PhoneError("audio_unavailable", "this page cannot use Web Audio (serve it over HTTPS)"),
  userGestureRequired: () =>
    new PhoneError("user_gesture_required", "call() and answer() must run from a user action, such as a click"),
  notSupported: () => new PhoneError("not_supported", "this browser cannot choose the speaker"),
  ephemeralKeyFailed: (cause: unknown) =>
    new PhoneError("ephemeral_key_failed", `getEphemeralKey failed: ${String(cause)}`),
  connectionLost: () => new PhoneError("connection_lost", "the WebRTC session could not be restored for 2 minutes"),
}
