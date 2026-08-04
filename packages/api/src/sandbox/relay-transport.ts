import type { RelayCommandResult, RelayCommandTransport } from '@use-brian/core'

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

export type RelayExtensionStatus = {
  connected: boolean
  terminalEvent: 'stopped' | 'tab_closed' | null
  /** Source fingerprint the connected extension reported; null when it reported none. */
  build: string | null
  /** The relay's verdict on that fingerprint. False when nothing is connected. */
  staleBuild: boolean
}

/** Null means the relay status itself was unavailable; never infer disconnect from it. */
export async function relayExtensionStatus(opts: {
  relayUrl: string
  relaySecret: string
  userId: string
  fetchImpl?: typeof fetch
}): Promise<RelayExtensionStatus | null> {
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const res = await fetchImpl(
      `${opts.relayUrl.replace(/\/$/, '')}/internal/browser/status/${encodeURIComponent(opts.userId)}`,
      {
        headers: { 'x-relay-secret': opts.relaySecret },
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (!res.ok) return null
    const body = (await res.json()) as {
      connected?: unknown
      terminalEvent?: unknown
      build?: unknown
      staleBuild?: unknown
    }
    if (typeof body.connected !== 'boolean') return null
    const terminalEvent = body.terminalEvent
    return {
      connected: body.connected,
      terminalEvent: terminalEvent === 'stopped' || terminalEvent === 'tab_closed' ? terminalEvent : null,
      // Absent from a relay that predates build reporting. Read as "nothing to
      // say", never as "up to date" — a missing field is not a verdict.
      build: typeof body.build === 'string' ? body.build : null,
      staleBuild: body.staleBuild === true,
    }
  } catch {
    return null
  }
}
