import type { RelayCommandResult, RelayCommandTransport } from '@sidanclaw/core'

/**
 * The api-side half of the local-browser path (computer-use.md §4): a
 * `RelayCommandTransport` that POSTs one command to the browser-relay's
 * `/internal/browser/command` and returns its `RelayCommandResult` verbatim.
 * Configured by BROWSER_RELAY_URL + BROWSER_RELAY_SECRET; unset (open-core
 * default) → boot passes a null transport and the local backend reports
 * `not_configured`.
 */

/** Command timeout: the relay itself answers within ~30 s (P1.4); add headroom. */
const RELAY_HTTP_TIMEOUT_MS = 35_000

export function createRelayCommandTransport(opts: {
  relayUrl: string
  relaySecret: string
  fetchImpl?: typeof fetch
}): RelayCommandTransport {
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = opts.relayUrl.replace(/\/$/, '')
  return {
    async send(params): Promise<RelayCommandResult> {
      try {
        const res = await fetchImpl(`${base}/internal/browser/command`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-relay-secret': opts.relaySecret,
          },
          body: JSON.stringify({ userId: params.userId, op: params.op, args: params.args ?? {} }),
          signal: AbortSignal.timeout(RELAY_HTTP_TIMEOUT_MS),
        })
        if (!res.ok) {
          return {
            ok: false,
            error: `The browser relay answered ${res.status}.`,
            code: 'backend_error',
          }
        }
        const body = (await res.json()) as RelayCommandResult
        if (typeof body !== 'object' || body === null || typeof (body as { ok?: unknown }).ok !== 'boolean') {
          return { ok: false, error: 'The browser relay returned a malformed response.', code: 'backend_error' }
        }
        return body
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError'
        return {
          ok: false,
          error: timedOut
            ? 'The browser relay did not answer in time.'
            : `Could not reach the browser relay: ${err instanceof Error ? err.message : String(err)}`,
          code: timedOut ? 'timeout' : 'backend_error',
        }
      }
    },
  }
}

/** Whether the user currently has a paired extension connection at the relay. */
export async function relayExtensionConnected(opts: {
  relayUrl: string
  relaySecret: string
  userId: string
  fetchImpl?: typeof fetch
}): Promise<boolean> {
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(
      `${opts.relayUrl.replace(/\/$/, '')}/internal/browser/status/${encodeURIComponent(opts.userId)}`,
      {
        headers: { 'x-relay-secret': opts.relaySecret },
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (!res.ok) return false
    const body = (await res.json()) as { connected?: boolean }
    return body.connected === true
  } catch {
    return false
  }
}
