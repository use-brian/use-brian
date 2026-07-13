/**
 * Local browsing backend (§4.15): drives the user's real Chrome through the
 * browser extension, via the single-instance relay. This module only speaks
 * the relay-command port — the WebSocket, pairing, and CDP mechanics live in
 * the relay service and the extension. Spec: computer-use.md §4.
 *
 * The extension is a governed backend, not an agent: each method here maps
 * 1:1 to one `command{op,args}` envelope the extension executes discretely.
 */
import {
  BrowserBackendError,
  BrowserNavigateResultSchema,
  BrowserSnapshotSchema,
  BrowserUrlResultSchema,
  NO_EXTENSION_MESSAGE,
  type BrowserBackendErrorCode,
  type BrowserCallContext,
  type BrowserProvider,
  type RelayCommandTransport,
} from './types.js'

const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set([
  'no_extension',
  'not_configured',
  'timeout',
  'stopped',
  'tab_closed',
  'stale_ref',
  'backend_error',
])

function toBackendError(error: string, code?: string): BrowserBackendError {
  const known = code && KNOWN_ERROR_CODES.has(code) ? (code as BrowserBackendErrorCode) : 'backend_error'
  if (known === 'no_extension') return new BrowserBackendError(NO_EXTENSION_MESSAGE, 'no_extension')
  return new BrowserBackendError(error, known)
}

export function createLocalBrowserProvider(deps: {
  /** Null when no relay is configured (open-core boot without the platform relay). */
  transport: RelayCommandTransport | null
}): BrowserProvider {
  async function send(ctx: BrowserCallContext, op: string, args?: Record<string, unknown>): Promise<unknown> {
    if (!deps.transport) {
      throw new BrowserBackendError(
        'Local browsing is not configured on this deployment (no extension relay).',
        'not_configured',
      )
    }
    const res = await deps.transport.send({ userId: ctx.userId, op, args })
    if (!res.ok) throw toBackendError(res.error, res.code)
    return res.data
  }

  return {
    kind: 'local',
    async navigate(ctx, url) {
      return BrowserNavigateResultSchema.parse(await send(ctx, 'navigate', { url }))
    },
    async snapshot(ctx) {
      return BrowserSnapshotSchema.parse(await send(ctx, 'snapshot'))
    },
    async click(ctx, ref) {
      await send(ctx, 'click', { ref })
    },
    async type(ctx, ref, text) {
      await send(ctx, 'type', { ref, text })
    },
    async currentUrl(ctx) {
      return BrowserUrlResultSchema.parse(await send(ctx, 'currentUrl'))
    },
    async stop(ctx) {
      await send(ctx, 'stop')
    },
  }
}
