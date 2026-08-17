/**
 * Local browsing backend (§4.15): drives the user's real Chrome through the
 * browser extension, via the single-instance relay. This module only speaks
 * the relay-command port — the WebSocket, pairing, and CDP mechanics live in
 * the relay service and the extension. Spec: computer-use.md §4.
 *
 * The extension is a governed backend, not an agent: each method here maps
 * 1:1 to one `command{op,args}` envelope the extension executes discretely.
 */
import { STALE_EXTENSION_REMEDY } from '@use-brian/shared'
import {
  BrowserBackendError,
  BROWSER_BACKEND_ERROR_CODES,
  BrowserCaptureResultSchema,
  BrowserNavigateResultSchema,
  BrowserSnapshotSchema,
  BrowserTabCloseResultSchema,
  BrowserTabListResultSchema,
  BrowserTabSelectionResultSchema,
  TakeoverFrameSchema,
  BrowserUrlResultSchema,
  NO_EXTENSION_MESSAGE,
  NO_EXTENSION_REMEDY,
  type BrowserBackendErrorCode,
  type BrowserCallContext,
  type BrowserProvider,
  type RelayCommandTransport,
  type TakeoverInputEvent,
} from './types.js'

/**
 * Derived, never re-typed. A second hand-written copy of this list is how
 * `no_browser_permission` got flattened to `backend_error` — see
 * `BROWSER_BACKEND_ERROR_CODES`.
 */
const KNOWN_ERROR_CODES: ReadonlySet<string> = new Set(BROWSER_BACKEND_ERROR_CODES)

function toBackendError(error: string, code?: string, staleBuild?: boolean): BrowserBackendError {
  const known = code && KNOWN_ERROR_CODES.has(code) ? (code as BrowserBackendErrorCode) : 'backend_error'
  // Appended, never substituted, and only on a failure that actually happened.
  // The model still reports what broke; this adds the one thing the user can
  // do about it. Same shape as the `no_extension` remedy below, for the same
  // reason: replacing the cause with the remedy loses the cause.
  const withRemedy = (message: string): string =>
    staleBuild ? `${message.trim()} ${STALE_EXTENSION_REMEDY}`.trim() : message
  if (known === 'no_extension') {
    // Keep the relay's cause and APPEND the remedy, rather than substituting
    // one for the other. The relay reports three different situations under
    // this code — never connected, disconnected, evicted by a newer pairing —
    // and flattening them made an eviction storm byte-identical to a missing
    // install in the logs, while telling users whose extension was open to go
    // install it.
    const cause = error.trim()
    return new BrowserBackendError(
      cause ? `${cause} ${NO_EXTENSION_REMEDY}` : NO_EXTENSION_MESSAGE,
      'no_extension',
    )
  }
  return new BrowserBackendError(withRemedy(error), known)
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
    if (!ctx.profileId) {
      throw new BrowserBackendError(
        'My Browser requires a browser profile. Choose or create a profile, pair that profile to the browser extension, then retry.',
        'profile_required',
      )
    }
    const res = await deps.transport.send({
      userId: ctx.userId,
      browserProfileId: ctx.profileId,
      op,
      args,
    })
    if (!res.ok) throw toBackendError(res.error, res.code, res.staleBuild)
    return res.data
  }

  return {
    kind: 'local',
    async navigate(ctx, url) {
      return BrowserNavigateResultSchema.parse(await send(ctx, 'navigate', { url }))
    },
    async snapshot(ctx, options) {
      return BrowserSnapshotSchema.parse(await send(ctx, 'snapshot', { mode: options?.mode ?? 'interactive' }))
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
    async openTab(ctx, url) {
      return BrowserTabSelectionResultSchema.parse(await send(ctx, 'openTab', { url }))
    },
    async listTabs(ctx) {
      return BrowserTabListResultSchema.parse(await send(ctx, 'listTabs'))
    },
    async switchTab(ctx, tabId) {
      return BrowserTabSelectionResultSchema.parse(await send(ctx, 'switchTab', { tabId }))
    },
    async closeTab(ctx, tabId) {
      return BrowserTabCloseResultSchema.parse(await send(ctx, 'closeTab', { tabId }))
    },
    async captureState(ctx, site) {
      return BrowserCaptureResultSchema.parse(await send(ctx, 'captureState', { site }))
    },
    async nextTakeoverFrame(ctx) {
      return TakeoverFrameSchema.parse(await send(ctx, 'captureFrame'))
    },
    async sendTakeoverInput(ctx, event: TakeoverInputEvent) {
      await send(ctx, 'takeoverInput', { event })
    },
    async stop(ctx) {
      await send(ctx, 'stop')
    },
  }
}
