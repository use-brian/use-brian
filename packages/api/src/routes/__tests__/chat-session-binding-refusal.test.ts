import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/**
 * A pre-turn refusal that writes NO state must still leave a trace.
 *
 * The session-binding gate in `chat.ts` refuses a send after the SSE headers
 * are flushed but before any session, message, lease or turn exists. Its only
 * output was one `event: error` frame — and an autoSend doc build renders that
 * nowhere (the dock stays collapsed). On 2026-09-01 a doc dock that had resumed
 * a `channel_type='notification'` row therefore refused every re-addressed send
 * for ~50 minutes while leaving NOTHING behind: no session row, no
 * `session_messages`, no `turn_events`, no `analytics_events`, no log line. The
 * incident was reconstructible only by subtracting the route's header overhead
 * from Cloud Run's `responseSize` to recover a 74-byte SSE body.
 *
 * So the rule these tests hold: every refusal in that block emits a
 * `chat_setup_error` at `stage: 'session_binding'`, and carries a `code` the
 * client can branch on rather than a bare human sentence.
 *
 * A source scan, not an HTTP round trip: the defect is a MISSING call, and a
 * mock-injected `analytics` stub proves only the paths a test remembers to
 * drive. Same stance as `admin-drift-allbuiltins-grep.test.ts`.
 *
 * [COMP:api/chat-route]
 */
const CHAT_TS = fileURLToPath(new URL('../chat.ts', import.meta.url))
const source = readFileSync(CHAT_TS, 'utf8')

/**
 * The refusal block: from the cross-assistant verdict down to the first thing
 * that actually starts the turn. Everything that ends the stream in here is a
 * pre-turn refusal.
 */
function sessionBindingBlock(): string {
  const start = source.indexOf('const verdict = crossAssistantSendPolicy({')
  const end = source.indexOf('const turnScope = await resolveTurnScopeSystem({')
  expect(start).toBeGreaterThan(-1)
  expect(end).toBeGreaterThan(start)
  return source.slice(start, end)
}

describe('[COMP:api/chat-route] session-binding refusals are observable', () => {
  it('logs every refusal that ends the stream in the binding block', () => {
    const block = sessionBindingBlock()
    const refusals = block.match(/sendEvent\('error'/g) ?? []
    // clearance refused · cross-assistant mismatch · per-user access denied
    expect(refusals).toHaveLength(3)

    // Each one is answered by a log call. `logSendRefusal` covers the two
    // policy verdicts; the access gate logs inline.
    const logged =
      (block.match(/logSendRefusal\(/g) ?? []).length - 1 + // minus its definition
      (block.match(/eventName: 'chat_setup_error'/g) ?? []).length
    expect(logged).toBeGreaterThanOrEqual(refusals.length)
  })

  it('stamps the refusals with the session_binding stage', () => {
    expect(sessionBindingBlock()).toContain("stage: sanitize('session_binding')")
  })

  it('gives each refusal a machine-readable code', () => {
    const block = sessionBindingBlock()
    for (const code of [
      'assistant_clearance_exceeds_room',
      'session_assistant_mismatch',
      'session_access_denied',
    ]) {
      expect(block).toContain(`code: '${code}'`)
    }
  })

  it('records what the refused session actually was', () => {
    // The 2026-09-01 investigation needed exactly these: the row's surface is
    // what decides `isDocSurface`, and without it a refusal says only "some
    // session was wrong" — which is where that outage hid.
    const block = sessionBindingBlock()
    expect(block).toContain('session_channel_type')
    expect(block).toContain('session_app_origin')
  })
})
