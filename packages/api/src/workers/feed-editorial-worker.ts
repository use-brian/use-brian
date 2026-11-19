/** Shared leased editorial worker; no edition-specific store or process. [COMP:feed/draft-review] */
import { claimFeedRun, failFeedRun, renewFeedLease, type FeedEditorialKind, type FeedEditorialRun } from '../db/feed-editorial-runs-store.js'
import { FeedCollaborationError } from '../db/feed-collaboration-store.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { GoogleRequestNotDispatchedError } from '@use-brian/agent-runtime/providers/google-auth.js'

// Provider exceptions can contain request bodies, image bytes or credentials.
// Emit only known runtime names/codes, including bounded nested fetch causes.
const TRANSPORT_CODES = new Set([
  'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'ENOTFOUND', 'EAI_AGAIN',
  'ENETUNREACH', 'EHOSTUNREACH', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET', 'UND_ERR_ABORTED',
])
const DATABASE_CODES = new Set(['08000', '08003', '08006', '22P02', '23502', '23503', '23505', '23514', '40001', '40P01', '42501', '53300', '57014', '57P01'])
const ERROR_NAMES = new Set(['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AggregateError', 'AbortError', 'TimeoutError', 'GoogleRequestNotDispatchedError'])
function safeFailureDetails(error: unknown) {
  const pending: unknown[] = [error]; const seen = new Set<object>(); const causeCodes: string[] = []
  let errorName = 'UnknownError'
  for (let inspected = 0; pending.length && inspected < 8; inspected++) {
    const current = pending.shift()
    if (!current || typeof current !== 'object' || seen.has(current)) continue
    seen.add(current)
    const detail = current as { name?: unknown; code?: unknown; cause?: unknown; errors?: unknown }
    if (current === error && typeof detail.name === 'string' && ERROR_NAMES.has(detail.name)) errorName = detail.name
    if (typeof detail.code === 'string' && (TRANSPORT_CODES.has(detail.code) || DATABASE_CODES.has(detail.code)) && !causeCodes.includes(detail.code)) causeCodes.push(detail.code)
    if (detail.cause) pending.push(detail.cause)
    if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 4))
  }
  return { errorName, causeCodes }
}

export function createFeedEditorialWorker(options: {
  handlers: Partial<Record<FeedEditorialKind, (run: FeedEditorialRun, signal: AbortSignal) => Promise<void>>>;
  intervalMs?: number;
}) {
  let timer: ReturnType<typeof setInterval> | null = null; let busy = false; let controller: AbortController | null = null
  async function tick() {
    if (busy) return
    busy = true; let run: FeedEditorialRun | null = null; let renewal: ReturnType<typeof setInterval> | null = null
    try {
      run = await claimFeedRun(Object.keys(options.handlers) as FeedEditorialKind[]); if (!run) return
      const active = run; controller = new AbortController(); const abort = controller
      renewal = setInterval(() => { void renewFeedLease(active).then(alive => { if (!alive) abort.abort() }).catch(() => abort.abort()) }, 20_000)
      await options.handlers[run.kind]!(run, controller.signal)
    } catch (error) {
      const details = safeFailureDetails(error)
      // A generic socket code could also come from the database. Only classify
      // generation transport when fetch/Undici evidence identifies that lane.
      const providerTransportFailure = details.causeCodes.some(code => code.startsWith('UND_ERR_'))
        || (error instanceof TypeError && error.message === 'fetch failed' && details.causeCodes.some(code => TRANSPORT_CODES.has(code)))
      const providerRequestNotDispatched = error instanceof GoogleRequestNotDispatchedError
      const category = error instanceof FeedCollaborationError ? error.code
        : providerRequestNotDispatched ? 'provider_request_not_dispatched'
        : providerTransportFailure && run?.dispatchedPart === 'generation' && ['image_generation', 'text_generation'].includes(run.kind)
          ? 'generation_transport_failed' : 'editorial_run_failed'
      console.error('[feed-editorial] run failed', {
        runId: run?.id, workspaceId: run?.workspaceId, assistantId: run?.assistantId,
        sessionId: run?.sessionId, kind: run?.kind, ...details,
      })
      if (run) await (providerRequestNotDispatched
        ? failFeedRun(run, category, { providerRequest: 'not_dispatched' })
        : failFeedRun(run, category)).catch(() => undefined)
    } finally {
      if (renewal) clearInterval(renewal)
      if (run) notifyWorkspaceChange(run.workspaceId, 'session', 'update', run.sessionId)
      busy = false; controller = null
    }
  }
  return {
    tick,
    start() { if (timer) return; timer = setInterval(() => { void tick() }, options.intervalMs ?? 1_000) },
    stop() { if (timer) clearInterval(timer); timer = null; controller?.abort() },
  }
}
