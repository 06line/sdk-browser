import { PhoneError } from "./errors.js"
import type { StreamEvent } from "./types.js"

// api calls the REST API with the ephemeral key, and turns its errors into PhoneError.
export async function api<T>(baseUrl: string, key: string, path: string, body?: unknown, method?: string): Promise<T> {
  let response: Response

  try {
    response = await fetch(baseUrl + path, {
      method: method ?? (body === undefined ? "GET" : "POST"),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch (error) {
    throw new PhoneError("internal", `06 Line is unreachable: ${String(error)}`)
  }

  const json = response.status === 204 ? null : await response.json().catch(() => null)
  if (response.ok) return json as T

  const error = json?.error ?? {}

  throw new PhoneError(error.code ?? "internal", error.message ?? `HTTP ${response.status}`, {
    requestId: json?.request_id ?? response.headers.get("Request-Id") ?? undefined,
    param: error.param,
  })
}

/**
 * openStream reads GET /v1/events until it ends or signal aborts it. EventSource cannot send the ephemeral key in a
 * header, so the stream is read with fetch.
 */
export async function openStream(
  baseUrl: string,
  key: string,
  signal: AbortSignal,
  onEvent: (event: StreamEvent) => void
): Promise<void> {
  let response: Response

  try {
    response = await fetch(baseUrl + "/v1/events", { headers: { Authorization: `Bearer ${key}` }, signal })
  } catch (error) {
    throw new PhoneError("internal", `06 Line is unreachable: ${String(error)}`)
  }

  if (!response.ok || !response.body) {
    const json = await response.json().catch(() => null)
    throw new PhoneError(json?.error?.code ?? "internal", json?.error?.message ?? `HTTP ${response.status}`)
  }

  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader()
  let buffer = ""

  for (;;) {
    const { value, done } = await reader.read()
    if (done) return

    buffer += value
    let end: number
    while ((end = buffer.indexOf("\n\n")) >= 0) {
      const event = parse(buffer.slice(0, end))
      buffer = buffer.slice(end + 2)
      if (event) onEvent(event)
    }
  }
}

// parse reads one event: its name and its JSON data. A ping, a comment only, is nothing.
function parse(block: string): StreamEvent | undefined {
  let type = ""
  let data = ""
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) type = line.slice(7)
    else if (line.startsWith("data: ")) data += line.slice(6)
  }

  if (!type || !data) return undefined

  return { type, data: JSON.parse(data) } as StreamEvent
}
