/**
 * Connect-in-context auto-expose, server side.
 *
 * Connecting a personal connector from inside a workspace shares it with that
 * workspace in the same request: a `connector_grant` to the workspace, with the
 * connector's sensitivity stamped at the member's effective clearance (the same
 * default `POST /api/connector-instances/:id/grants` applies). Doing this in the
 * connect request, instead of in a browser effect after the OAuth redirect and
 * a list refetch, is what makes it reliable: a closed tab, a desktop OAuth
 * return, or a second account of the same provider no longer leaves the
 * connector personal-only.
 *
 * Rules:
 *   - Only the workspace the connect came from. A connector connected in
 *     workspace A never reaches workspace B (the exposure boundary in
 *     docs/architecture/integrations/mcp.md -> "Workspace connector scoping").
 *   - Idempotent. An already-shared connector is left untouched, sensitivity
 *     included, so a reconnect never resets a tier the member adjusted.
 *   - Workspace-owned instances are skipped (they are workspace-visible by
 *     ownership and cannot carry a grant).
 *   - Never fails the connect. The credential is already stored; a miss here is
 *     logged and the member can still use the Expose control.
 *
 * Spec: docs/architecture/integrations/mcp.md -> "Auto-expose on connect".
 *
 * [COMP:api/connector-auto-expose]
 */

import type { Request, RequestHandler, Response } from 'express'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import {
  effectiveReadClearance,
  getWorkspaceMembershipWithClearanceSystem,
} from '../db/workspace-store.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export type AutoExposeDeps = {
  grantStore: Pick<ConnectorGrantStore, 'create' | 'listGrantedWorkspaceIdsForInstanceSystem'>
  instanceStore: Pick<ConnectorInstanceStore, 'get' | 'update'>
  getMembership?: typeof getWorkspaceMembershipWithClearanceSystem
}

export type AutoExposeOutcome =
  | 'exposed'
  | 'already_exposed'
  | 'no_workspace'
  | 'not_member'
  | 'not_personal'
  | 'failed'

/**
 * The workspace a connect came from: `?workspaceId=` (app-web's `authFetch`
 * stamps it on every connector POST made inside `/w/<id>/`, and the OAuth
 * callbacks forward the id their `state` carried), else a body `workspaceId`.
 */
export function connectWorkspaceId(req: Pick<Request, 'query' | 'body'>): string | null {
  const fromQuery = req.query?.workspaceId
  const fromBody = (req.body as { workspaceId?: unknown } | null | undefined)?.workspaceId
  const value = typeof fromQuery === 'string' ? fromQuery : fromBody
  return typeof value === 'string' && UUID_RE.test(value) ? value : null
}

/** The instance a successful connect response names, if any. */
function connectedInstanceId(payload: unknown): string | null {
  if (!payload || typeof payload !== 'object') return null
  const body = payload as { ok?: unknown; connectorInstanceId?: unknown; connector?: { connectorInstanceId?: unknown } }
  if (body.ok === false) return null
  const id = body.connectorInstanceId ?? body.connector?.connectorInstanceId
  return typeof id === 'string' && UUID_RE.test(id) ? id : null
}

/**
 * Router-level hook: every successful POST under the connector router whose
 * response names a `connectorInstanceId` (store-credentials, the desktop
 * exchange, OAuth callbacks, custom MCP, IMAP, directory add, instance
 * connect) shares that instance with the originating workspace before the
 * response is sent, so the client sees it already shared. Mounted first in
 * BOTH connector routers (open `routes/connectors.ts`, closed
 * `api-platform/src/routes/connectors.ts`), so a new connect route is covered
 * without wiring. `/disconnect` is excluded: taking a connector offline must
 * never re-share one the member stopped sharing.
 */
export function autoExposeOnConnectMiddleware(deps: AutoExposeDeps | null): RequestHandler {
  return (req, res, next) => {
    if (!deps || req.method !== 'POST' || /\/disconnect\/?$/.test(req.path)) return next()
    const userId = (req as Request & { userId?: string }).userId
    const workspaceId = connectWorkspaceId(req)
    if (!userId || !workspaceId) return next()
    const send = res.json.bind(res)
    res.json = ((payload: unknown) => {
      const connectorInstanceId = res.statusCode < 300 ? connectedInstanceId(payload) : null
      if (!connectorInstanceId) return send(payload)
      void autoExposeOnConnect(deps, { userId, workspaceId, connectorInstanceId })
        .finally(() => send(payload))
      return res
    }) as Response['json']
    next()
  }
}

export async function autoExposeOnConnect(
  deps: AutoExposeDeps,
  input: { userId: string; workspaceId: string | null; connectorInstanceId: string },
): Promise<AutoExposeOutcome> {
  const { userId, workspaceId, connectorInstanceId } = input
  if (!workspaceId) return 'no_workspace'
  try {
    const instance = await deps.instanceStore.get(userId, connectorInstanceId)
    if (!instance || instance.scope !== 'user' || instance.userId !== userId) return 'not_personal'

    const getMembership = deps.getMembership ?? getWorkspaceMembershipWithClearanceSystem
    const membership = await getMembership(userId, workspaceId)
    if (!membership) return 'not_member'

    const shared = await deps.grantStore.listGrantedWorkspaceIdsForInstanceSystem(connectorInstanceId)
    if (shared.includes(workspaceId)) return 'already_exposed'

    await deps.grantStore.create({
      actingUserId: userId,
      connectorInstanceId,
      targetType: 'workspace',
      targetId: workspaceId,
    })
    await deps.instanceStore.update(userId, connectorInstanceId, {
      sensitivity: effectiveReadClearance(membership.role, membership.clearance, 'confidential'),
    })
    return 'exposed'
  } catch (error) {
    console.warn(
      `[connectors] auto-expose of ${connectorInstanceId} to workspace ${workspaceId} failed:`,
      error instanceof Error ? error.message : String(error),
    )
    return 'failed'
  }
}
