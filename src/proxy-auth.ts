export const PROXY_KEY_HEADER = "x-phi-proxy-key"

function bytes(text: string): Uint8Array {
  return new TextEncoder().encode(text)
}

function equalSecret(a: string, b: string): boolean {
  const x = bytes(a)
  const y = bytes(b)
  const n = Math.max(x.length, y.length)
  let diff = x.length ^ y.length
  for (let i = 0; i < n; i++) diff |= (x[i] ?? 0) ^ (y[i] ?? 0)
  return diff === 0
}

export function proxyAuthorized(headers: Headers, secret: string | undefined): boolean {
  const expected = secret?.trim()
  if (!expected) return false
  const given = headers.get(PROXY_KEY_HEADER)?.trim()
  if (!given) return false
  return equalSecret(given, expected)
}
