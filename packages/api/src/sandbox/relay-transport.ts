import { z } from 'zod'
import type { ProtectedFillService } from '@use-brian/core'
import type {
  LocalBrowserControlMode,
  RelayCommandResult,
  RelayCommandTransport,
} from '@use-brian/core'

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
  protectedFill?: ProtectedFillService | null
  /** Server-owned profile policy, resolved afresh for every command. */
  resolveLocalControlMode?: (browserProfileId: string) => Promise<LocalBrowserControlMode>
}): RelayCommandTransport {
  const fetchImpl = opts.fetchImpl ?? fetch
  const base = opts.relayUrl.replace(/\/$/, '')
  const denied = (): RelayCommandResult => ({ ok: false, error: 'Protected fill unavailable', code: 'protected_fill_denied' })
  const fillSchema = z.object({
    workspaceId: z.string().min(1), sessionId: z.string().min(1), taskId: z.string().min(1),
    browserProfileId: z.string().min(1), destinationOrigin: z.string().min(1),
    items: z.array(z.object({ referenceId: z.string(), ref: z.string() }).strict()).min(1).max(20),
  }).strict()
  return {
    async send(params): Promise<RelayCommandResult> {
      const identity = { userId: params.userId, browserProfileId: params.browserProfileId }
      const protectedOp = params.op === 'browserFillReference'
      const safetyStop = params.op === 'stop'
      const stopFailed = (): RelayCommandResult => ({ ok: false, error: 'Browser Stop could not be confirmed.', code: 'backend_error' })
      const epoch = opts.protectedFill?.epoch(identity)
      const blocked = () => opts.protectedFill?.isLocked(identity) || opts.protectedFill?.epoch(identity) !== epoch
      if (protectedOp) {
        try {
          const parsed = fillSchema.parse(params.args)
          if (!opts.protectedFill || parsed.browserProfileId !== params.browserProfileId) return denied()
          const { items, ...scope } = parsed
          await opts.protectedFill.reserve({ ...scope, userId: params.userId }, items)
        } catch { return denied() }
      } else if (params.op !== 'stop' && blocked()) return denied()
      let controlMode: LocalBrowserControlMode
      try {
        controlMode = !safetyStop && opts.resolveLocalControlMode
          ? await opts.resolveLocalControlMode(params.browserProfileId)
          : 'task_tabs'
      } catch {
        if (protectedOp || blocked()) return denied()
        return {
          ok: false,
          error: 'Could not read the Browser profile local-control policy.',
          code: 'backend_error',
        }
      }
      try {
        if (!protectedOp && params.op !== 'stop' && blocked()) return denied()
        const res = await fetchImpl(`${base}/internal/browser/${params.taskId ? 'task-command' : 'command'}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-relay-secret': opts.relaySecret,
          },
          body: JSON.stringify({
            userId: params.userId,
            browserProfileId: params.browserProfileId,
            ...(params.taskId ? { taskId: params.taskId } : {}),
            controlMode,
            op: params.op,
            args: params.args ?? {},
          }),
          signal: AbortSignal.timeout(protectedOp ? 125_000 : RELAY_HTTP_TIMEOUT_MS),
        })
        if (params.taskId && res.status === 404) return { ok: false, code: 'not_configured', error: 'Task-scoped browser control requires an updated browser relay. Update the relay before retrying.' }
        if (protectedOp && !res.ok) return denied()
        if (!protectedOp && !safetyStop && blocked()) return denied()
        if (!res.ok) {
          if (safetyStop) return stopFailed()
          return {
            ok: false,
            error: `The browser relay answered ${res.status}.`,
            code: 'backend_error',
          }
        }
        const body = (await res.json()) as RelayCommandResult
        if (safetyStop) {
          const result = z.object({ ok: z.literal(true), data: z.object({ stopped: z.literal(true) }).strict() }).strict().safeParse(body)
          if (result.success) return result.data
          // Preserve only known transport/terminal classifications, never raw content.
          if (body?.ok === false && ['stopped', 'tab_closed', 'no_extension', 'no_active_browser', 'timeout', 'not_configured'].includes(body.code ?? '')) {
            return { ok: false, error: 'Browser Stop could not be confirmed.', code: body.code }
          }
          return stopFailed()
        }
        if (protectedOp) {
          const result = z.object({ ok: z.literal(true), data: z.object({
            status: z.literal('filled'), filledCount: z.number().int().min(1).max(20),
            requiresHumanCompletion: z.literal(true),
          }).strict() }).strict().safeParse(body)
          if (!result.success || result.data.data.filledCount !== (params.args?.items as unknown[])?.length) return denied()
          return result.data
        }
        if (blocked()) return denied()
        if (typeof body !== 'object' || body === null || typeof (body as { ok?: unknown }).ok !== 'boolean') {
          return { ok: false, error: 'The browser relay returned a malformed response.', code: 'backend_error' }
        }
        return body
      } catch (err) {
        if (safetyStop) return err instanceof Error && err.name === 'TimeoutError'
          ? { ok: false, error: 'Browser Stop could not be confirmed.', code: 'timeout' }
          : stopFailed()
        if (protectedOp || blocked()) return denied()
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
  capabilities: { protectedFillV1: boolean }
  extensionOrigin: string | null
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
  browserProfileId?: string
  workspaceId?: string
  fetchImpl?: typeof fetch
}): Promise<RelayExtensionStatus | null> {
  const fetchImpl = opts.fetchImpl ?? fetch
  try {
    const query = new URLSearchParams()
    if (opts.browserProfileId) query.set('browserProfileId', opts.browserProfileId)
    if (opts.workspaceId) query.set('workspaceId', opts.workspaceId)
    const res = await fetchImpl(
      `${opts.relayUrl.replace(/\/$/, '')}/internal/browser/status/${encodeURIComponent(opts.userId)}${query.size > 0 ? `?${query}` : ''}`,
      {
        headers: { 'x-relay-secret': opts.relaySecret },
        signal: AbortSignal.timeout(5_000),
      },
    )
    if (!res.ok) return null
    const body = (await res.json()) as {
      connected?: unknown
      extensionOrigin?: unknown
      capabilities?: { protectedFillV1?: unknown } | null
      terminalEvent?: unknown
      build?: unknown
      staleBuild?: unknown
    }
    if (typeof body.connected !== 'boolean') return null
    const terminalEvent = body.terminalEvent
    return {
      connected: body.connected,
      capabilities: { protectedFillV1: body.capabilities?.protectedFillV1 === true },
      extensionOrigin: typeof body.extensionOrigin === 'string' ? body.extensionOrigin : null,
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

/** Absence/false/old relay metadata never means protocol support. */
export function supportsProtectedFill(status: RelayExtensionStatus | null, origins: ReadonlySet<string>): boolean {
  return Boolean(status?.connected && status.capabilities.protectedFillV1 === true &&
    status.extensionOrigin && origins.has(status.extensionOrigin))
}
