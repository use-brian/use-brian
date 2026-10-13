/**
 * Configured-route recovery with fake readiness probes and an in-memory
 * event sink (A11). The selection rule itself is the core contract; this
 * covers binding to native identities, fencing, recording and blockers.
 */
import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/client.js', () => ({ getPool: vi.fn(), queryWithRLS: vi.fn(), query: vi.fn() }))
const { recoverOperationalRoute, resolveBindingRoutes } = await import('../route-recovery.js')
type Ports = import('../route-recovery.js').RouteRecoveryPorts
type RouteRef = import('../../db/approval-review-store.js').RouteRef

const WS = '00000000-0000-4000-8000-0000000000aa'
const WF = '00000000-0000-4000-8000-0000000000bb'
const LOCAL = '00000000-0000-4000-8000-000000000001'
const REMOTE = '00000000-0000-4000-8000-000000000002'
const CONN = '00000000-0000-4000-8000-000000000003'
const OTHER = '00000000-0000-4000-8000-000000000004'
const account = 'ops@fictional.example'

function ports(probe: Record<string, { available: boolean; accountKey?: string }>, bindingRoutes: RouteRef[] | null) {
  const events: Array<Record<string, unknown>> = []
  const resolved = vi.fn(async () => {})
  const p: Ports = {
    loadBinding: async () => bindingRoutes && { id: 'b', workspaceId: WS, workflowId: WF, intended: bindingRoutes[0], alternatives: bindingRoutes.slice(1), createdByUserId: null, revision: 1, updatedAt: new Date() },
    probe: vi.fn(async (r: RouteRef) => probe[r.id] ?? { available: false }),
    recordEvent: async (row) => { events.push(row); return { ...row, id: `e${events.length}`, createdAt: new Date(), resolvedAt: null } },
    resolveBlockers: resolved,
    notify: vi.fn(),
  }
  return { p, events, resolved }
}
const route = (id: string, locality: RouteRef['locality'], over: Partial<RouteRef> = {}): RouteRef =>
  ({ kind: locality === 'connector' ? 'connector_instance' : 'browser_profile', id, accountKey: account, locality, ...over })

describe('[COMP:api/operational-route-recovery] configured-route recovery', () => {
  it('binds only actual native identities, derives locality, and checks connector accounts', () => {
    const native = new Map([
      [LOCAL, { kind: 'browser_profile' as const, id: LOCAL, defaultBackend: 'local' as const }],
      [REMOTE, { kind: 'browser_profile' as const, id: REMOTE, defaultBackend: 'cloud' as const }],
      [CONN, { kind: 'connector_instance' as const, id: CONN, connectedEmail: 'OPS@fictional.example', connected: true }],
    ])
    const ok = resolveBindingRoutes([
      { kind: 'browser_profile', id: LOCAL, accountKey: account },
      { kind: 'browser_profile', id: REMOTE, accountKey: account },
      { kind: 'connector_instance', id: CONN, accountKey: account, operations: ['send'] },
    ], native)
    expect(ok).toMatchObject({ ok: true, routes: [{ locality: 'local' }, { locality: 'remote' }, { locality: 'connector', operations: ['send'] }] })
    expect(resolveBindingRoutes([{ kind: 'browser_profile', id: OTHER, accountKey: account }], native)).toMatchObject({ ok: false, reason: 'unknown_route' })
    expect(resolveBindingRoutes([{ kind: 'connector_instance', id: LOCAL, accountKey: account }], native)).toMatchObject({ ok: false, reason: 'unknown_route' })
    expect(resolveBindingRoutes([{ kind: 'browser_profile', id: LOCAL, accountKey: account }, { kind: 'browser_profile', id: REMOTE, accountKey: 'other@fictional.example' }], native))
      .toMatchObject({ ok: false, reason: 'mixed_accounts' })
    expect(resolveBindingRoutes([{ kind: 'connector_instance', id: CONN, accountKey: 'other@fictional.example' }], native)).toMatchObject({ ok: false, reason: 'account_mismatch' })
  })

  it('local loss before the effect fences that path and continues on a sufficient admitted route', async () => {
    const { p, events, resolved } = ports({ [LOCAL]: { available: true }, [REMOTE]: { available: true } }, [route(LOCAL, 'local'), route(REMOTE, 'remote')])
    const r = await recoverOperationalRoute(p, { workspaceId: WS, workflowId: WF, workflowRunId: 'run', lostRouteId: LOCAL, effect: 'none' })
    expect(r.selection).toMatchObject({ kind: 'selected', route: { id: REMOTE }, fallback: true })
    expect(p.probe).not.toHaveBeenCalledWith(expect.objectContaining({ id: LOCAL }))
    expect(events[0]).toMatchObject({ outcome: 'selected', lostRoute: { id: LOCAL }, selectedRoute: { id: REMOTE }, blocker: null })
    expect(resolved).toHaveBeenCalled()
  })

  it('an uncertain send reconciles before any retry; no route is probed', async () => {
    const { p, events } = ports({ [REMOTE]: { available: true } }, [route(LOCAL, 'local'), route(REMOTE, 'remote')])
    const r = await recoverOperationalRoute(p, { workspaceId: WS, workflowId: WF, lostRouteId: LOCAL, effect: 'uncertain' })
    expect(r.selection).toEqual({ kind: 'blocked', blocker: 'reconcile_before_retry' })
    expect(p.probe).not.toHaveBeenCalled()
    expect(events[0]).toMatchObject({ outcome: 'blocked', blocker: 'reconcile_before_retry' })
  })

  it('a wrong account or no available alternative retains the work as a blocker', async () => {
    const wrong = ports({ [REMOTE]: { available: true, accountKey: 'intruder@fictional.example' } }, [route(LOCAL, 'local'), route(REMOTE, 'remote')])
    expect((await recoverOperationalRoute(wrong.p, { workspaceId: WS, workflowId: WF, lostRouteId: LOCAL, effect: 'none' })).selection)
      .toEqual({ kind: 'blocked', blocker: 'account_mismatch' })
    const down = ports({}, [route(LOCAL, 'local'), route(REMOTE, 'remote')])
    expect((await recoverOperationalRoute(down.p, { workspaceId: WS, workflowId: WF, lostRouteId: LOCAL, effect: 'none' })).selection)
      .toEqual({ kind: 'blocked', blocker: 'no_authorized_alternative' })
    const unbound = ports({}, null)
    expect((await recoverOperationalRoute(unbound.p, { workspaceId: WS, workflowId: WF, effect: 'none' })).selection)
      .toEqual({ kind: 'blocked', blocker: 'no_route_binding' })
    expect(down.resolved).not.toHaveBeenCalled()
  })

  it('a completed effect needs no route and records nothing', async () => {
    const { p, events } = ports({}, [route(LOCAL, 'local')])
    expect((await recoverOperationalRoute(p, { workspaceId: WS, workflowId: WF, lostRouteId: LOCAL, effect: 'completed' })).selection).toEqual({ kind: 'done' })
    expect(events).toHaveLength(0)
  })
})
