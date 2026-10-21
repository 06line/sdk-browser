import { PhoneError } from "./errors.js"

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
