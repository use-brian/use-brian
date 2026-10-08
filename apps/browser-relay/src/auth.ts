import { timingSafeEqual } from 'node:crypto'

/**
 * Constant-time X-Relay-Secret check for the internal command API.
 * Fails closed: an empty/unset expected secret matches nothing (the
 * discord-connector pattern).
 */
export function relaySecretMatches(provided: unknown, expected: string): boolean {
  if (typeof provided !== 'string' || expected.length === 0) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** Only deployment configuration chooses the destination; never follow redirects with a credential. */
export function createBrowserAuthorityClient(apiUrl: string | undefined, fetchImpl = fetch) {
  return async (token: string): Promise<boolean> => {
    if (!apiUrl) return false
    try {
      const url = new URL('/api/browser-extension/authority', apiUrl)
      if (url.username || url.password || (url.protocol !== 'https:'
        && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)))) return false
      const response = await fetchImpl(url, { method: 'POST',
        headers: { Authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.timeout(5_000) })
      return response.status === 204
    } catch { return false }
  }
}
