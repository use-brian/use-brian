/**
 * Operational route bindings and recovery (D38, D39, A11).
 *
 * A workflow's intended route and permitted alternatives are bound to ACTUAL
 * native identities: each route must resolve to a browser profile or
 * connector instance in the workspace; locality comes from that row
 * (`default_backend`, or connector = always-on), and a connector's connected
 * account must equal the declared account. Recovery fences the lost route,
 * probes the rest through injected readiness probes, selects only a
 * same-account permitted route, records the decision, and surfaces a blocker
 * in Chat when nothing qualifies. Nothing here creates or enables an account,
 * a backend or a credential.
 *
 * Spec: docs/architecture/features/approval-review.md → "Operational route recovery"
 *
 * [COMP:api/operational-route-recovery]
 */
import { z } from 'zod'
import { selectOperationalRoute, type OperationalRoute, type RouteProbe, type RouteSelection } from '@use-brian/core'
import { getPool, queryWithRLS } from '../db/client.js'
import {
  getRouteBindingForViewer,
  getRouteBindingSystem,
  insertRouteEvent,
  resolveRouteBlockers,
  upsertRouteBinding,
  type RouteBinding,
  type RouteEvent,
  type RouteRef,
} from '../db/approval-review-store.js'
import { notifyWorkspaceChange } from '../brain-stream/notify.js'
import { appendApprovalReviewAudit, workspaceRole, type ReviewActor } from './common.js'
import { ApprovalReviewError } from './errors.js'

const routeInput = z.object({
  kind: z.enum(['browser_profile', 'connector_instance']),
  id: z.string().uuid(),
  accountKey: z.string().trim().min(1).max(256),
  operations: z.array(z.string().regex(/^[a-zA-Z][a-zA-Z0-9_.:-]{0,63}$/)).max(20).optional(),
}).strict()
export const routeBindingInputSchema = z.object({
  intended: routeInput,
  alternatives: z.array(routeInput).max(10).default([]),
  expectedRevision: z.number().int().min(1).nullable().optional(),
}).strict()

/** A native identity row as read from the workspace. */
export type NativeRouteRow =
  | { kind: 'browser_profile'; id: string; defaultBackend: 'local' | 'cloud' }
  | { kind: 'connector_instance'; id: string; connectedEmail: string | null; connected: boolean }

/**
 * Resolve declared routes against native rows. Unknown ids, duplicates and
 * a connector whose connected account differs from the declared account are
 * refused; locality is derived, never declared.
 */
export function resolveBindingRoutes(
  declared: ReadonlyArray<z.infer<typeof routeInput>>,
  native: ReadonlyMap<string, NativeRouteRow>,
): { ok: true; routes: RouteRef[] } | { ok: false; reason: 'unknown_route' | 'duplicate_route' | 'account_mismatch' | 'mixed_accounts'; routeId: string } {
  const seen = new Set<string>()
  const routes: RouteRef[] = []
  const account = declared[0]?.accountKey.trim().toLowerCase()
  for (const d of declared) {
    if (seen.has(d.id)) return { ok: false, reason: 'duplicate_route', routeId: d.id }
    seen.add(d.id)
    const row = native.get(d.id)
    if (!row || row.kind !== d.kind) return { ok: false, reason: 'unknown_route', routeId: d.id }
    if (d.accountKey.trim().toLowerCase() !== account) return { ok: false, reason: 'mixed_accounts', routeId: d.id }
    if (row.kind === 'connector_instance' && row.connectedEmail && row.connectedEmail.trim().toLowerCase() !== account) {
      return { ok: false, reason: 'account_mismatch', routeId: d.id }
    }
    routes.push({
      kind: d.kind, id: d.id, accountKey: d.accountKey.trim(),
      locality: row.kind === 'connector_instance' ? 'connector' : row.defaultBackend === 'local' ? 'local' : 'remote',
      ...(d.operations ? { operations: d.operations } : {}),
    })
  }
  return { ok: true, routes }
}

async function nativeRows(userId: string, workspaceId: string, ids: string[]): Promise<Map<string, NativeRouteRow>> {
  const out = new Map<string, NativeRouteRow>()
  const profiles = await queryWithRLS<{ id: string; default_backend: 'local' | 'cloud' }>(userId,
    'SELECT id, default_backend FROM browser_profiles WHERE workspace_id = $1 AND id = ANY($2::uuid[])', [workspaceId, ids])
  for (const p of profiles.rows) out.set(p.id, { kind: 'browser_profile', id: p.id, defaultBackend: p.default_backend })
  const connectors = await getPool().query<{ id: string; connected_email: string | null; connected: boolean }>(
    `SELECT id, connected_email, connected FROM connector_instance
     WHERE id = ANY($2::uuid[]) AND ((scope = 'workspace' AND workspace_id = $1) OR (scope = 'user' AND user_id = $3))`,
    [workspaceId, ids, userId])
  for (const c of connectors.rows) out.set(c.id, { kind: 'connector_instance', id: c.id, connectedEmail: c.connected_email, connected: c.connected })
  return out
}

export async function setRouteBinding(actor: ReviewActor, workspaceId: string, workflowId: string, raw: unknown): Promise<RouteBinding> {
  if (!actor.human || actor.origin === 'mcp') throw new ApprovalReviewError('human_intent_required', 403, 'Only a person can bind a workflow to an account or profile.')
  const parsed = routeBindingInputSchema.safeParse(raw)
  if (!parsed.success) throw new ApprovalReviewError('invalid_input', 400, parsed.error.issues.map((i) => i.message).join('; '))
  const role = await workspaceRole(actor.userId, workspaceId)
  const wf = (await queryWithRLS<{ created_by: string }>(actor.userId, 'SELECT created_by FROM workflows WHERE id = $1 AND workspace_id = $2', [workflowId, workspaceId])).rows[0]
  if (!role || !wf) throw new ApprovalReviewError('not_found', 404, 'Not found')
  if (role !== 'owner' && role !== 'admin' && wf.created_by !== actor.userId) throw new ApprovalReviewError('binding_not_yours', 403, 'Only the workflow owner or a workspace admin can bind its account or profile.')
  const declared = [parsed.data.intended, ...parsed.data.alternatives]
  const resolved = resolveBindingRoutes(declared, await nativeRows(actor.userId, workspaceId, declared.map((d) => d.id)))
  if (!resolved.ok) throw new ApprovalReviewError(resolved.reason, 422, `Route ${resolved.routeId} cannot be bound (${resolved.reason}).`)
  const [intended, ...alternatives] = resolved.routes
  const binding = await upsertRouteBinding({ workspaceId, workflowId, intended, alternatives, userId: actor.userId, expectedRevision: parsed.data.expectedRevision ?? null })
  if (!binding) throw new ApprovalReviewError('stale_revision', 409, 'This binding changed. Refresh and try again.')
  await appendApprovalReviewAudit(workspaceId, actor.userId, 'operational_route.binding_updated', workflowId, { revision: binding.revision, routes: resolved.routes.map((r) => ({ kind: r.kind, id: r.id, locality: r.locality })) })
  notifyWorkspaceChange(workspaceId, 'workflow', 'update', workflowId)
  return binding
}

export async function getRouteBinding(actor: ReviewActor, workspaceId: string, workflowId: string): Promise<RouteBinding | null> {
  if (!await workspaceRole(actor.userId, workspaceId)) throw new ApprovalReviewError('not_found', 404, 'Not found')
  const b = await getRouteBindingForViewer(actor.userId, workflowId)
  return b && b.workspaceId === workspaceId ? b : null
}

export type RouteRecoveryPorts = {
  loadBinding(workflowId: string): Promise<RouteBinding | null>
  /** Readiness probe for one route; must not start any effect. */
  probe(route: RouteRef): Promise<RouteProbe>
  recordEvent(row: Omit<RouteEvent, 'id' | 'createdAt' | 'resolvedAt'>): Promise<RouteEvent>
  resolveBlockers(workspaceId: string, workflowId: string): Promise<void>
  notify(workspaceId: string, id: string): void
}

/** Native readiness: a cloud profile or a connected connector is ready; a local profile needs its relay. */
export function nativeRouteProbe(isLocalRelayLive: (profileId: string) => Promise<boolean>) {
  return async (route: RouteRef): Promise<RouteProbe> => {
    if (route.kind === 'connector_instance') {
      const c = (await getPool().query<{ connected: boolean; connected_email: string | null }>(
        'SELECT connected, connected_email FROM connector_instance WHERE id = $1', [route.id])).rows[0]
      return { available: c?.connected === true, accountKey: c?.connected_email ?? null }
    }
    const p = (await getPool().query<{ default_backend: string }>('SELECT default_backend FROM browser_profiles WHERE id = $1', [route.id])).rows[0]
    if (!p) return { available: false }
    return { available: p.default_backend === 'local' ? await isLocalRelayLive(route.id) : true }
  }
}

export function dbRouteRecoveryPorts(probe: RouteRecoveryPorts['probe']): RouteRecoveryPorts {
  return {
    loadBinding: (workflowId) => getRouteBindingSystem(workflowId),
    probe,
    recordEvent: insertRouteEvent,
    resolveBlockers: resolveRouteBlockers,
    notify: (ws, id) => notifyWorkspaceChange(ws, 'approval', 'update', id),
  }
}

export async function recoverOperationalRoute(ports: RouteRecoveryPorts, params: {
  workspaceId: string
  workflowId: string
  workflowRunId?: string | null
  lostRouteId?: string | null
  effect: 'none' | 'uncertain' | 'completed'
  operation?: string | null
}): Promise<{ selection: RouteSelection; event: RouteEvent | null }> {
  const binding = await ports.loadBinding(params.workflowId)
  const intended = binding && binding.workspaceId === params.workspaceId ? binding.intended as OperationalRoute : null
  const alternatives = (binding?.alternatives ?? []) as OperationalRoute[]
  const probes = new Map<string, RouteProbe>()
  if (params.effect === 'none' && intended) {
    for (const route of [intended, ...alternatives]) {
      if (route.id === params.lostRouteId) continue
      probes.set(route.id, await ports.probe(route).catch(() => ({ available: false })))
    }
  }
  const selection = selectOperationalRoute({ intended, alternatives, lostRouteId: params.lostRouteId, probes, effect: params.effect, operation: params.operation })
  if (selection.kind === 'done') return { selection, event: null }
  const lost = [intended, ...alternatives].find((r) => r?.id === params.lostRouteId) ?? null
  const event = await ports.recordEvent({
    workspaceId: params.workspaceId, workflowId: params.workflowId, workflowRunId: params.workflowRunId ?? null,
    lostRoute: lost, outcome: selection.kind === 'selected' ? 'selected' : 'blocked',
    selectedRoute: selection.kind === 'selected' ? selection.route : null,
    blocker: selection.kind === 'blocked' ? selection.blocker : null,
  })
  if (selection.kind === 'selected') await ports.resolveBlockers(params.workspaceId, params.workflowId)
  ports.notify(params.workspaceId, event.id)
  return { selection, event }
}
