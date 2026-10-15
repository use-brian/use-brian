/**
 * Operational route selection (D38, D39, A11): pure.
 *
 * A workflow binds its intended route (a native browser profile or connector
 * instance, with the account it acts as) and explicitly permitted
 * alternatives. When a route is lost, only an available, permitted route for
 * the SAME account may continue; nonlocal routes rank first for always-on
 * work. An uncertain effect is reconciled, never retried. Nothing here
 * creates or enables a backend or account.
 *
 * Spec: docs/architecture/features/approval-review.md → "Operational route recovery"
 */
import { BrowserBackendError } from '../sandbox/types.js'

export type OperationalRoute = {
  kind: 'browser_profile' | 'connector_instance'
  id: string
  /** The account this route acts as, declared by a human and checked against native identity. */
  accountKey: string
  /** Derived from the native row: `local` needs a member's machine; `remote`/`connector` are always-on. */
  locality: 'local' | 'remote' | 'connector'
  /** When set, the operations this route is permitted for. */
  operations?: string[]
}

export type RouteProbe = { available: boolean; accountKey?: string | null }

export type RouteSelection =
  | { kind: 'selected'; route: OperationalRoute; fallback: boolean }
  | { kind: 'done' }
  | { kind: 'blocked'; blocker: 'reconcile_before_retry' | 'no_route_binding' | 'no_authorized_alternative' | 'account_mismatch' }

export function selectOperationalRoute(input: {
  intended: OperationalRoute | null
  alternatives: ReadonlyArray<OperationalRoute>
  /** The route that was just lost (fenced: never reselected in this decision). */
  lostRouteId?: string | null
  probes: ReadonlyMap<string, RouteProbe>
  /** State of the effect the lost route was performing. */
  effect: 'none' | 'uncertain' | 'completed'
  operation?: string | null
}): RouteSelection {
  if (input.effect === 'uncertain') return { kind: 'blocked', blocker: 'reconcile_before_retry' }
  if (input.effect === 'completed') return { kind: 'done' }
  if (!input.intended) return { kind: 'blocked', blocker: 'no_route_binding' }
  const account = input.intended.accountKey.trim().toLowerCase()
  const declared = [input.intended, ...input.alternatives]
  let accountMismatch = false
  const candidates: Array<{ route: OperationalRoute; rank: number }> = []
  declared.forEach((route, index) => {
    if (route.id === input.lostRouteId) return
    if (route.accountKey.trim().toLowerCase() !== account) return
    if (input.operation && route.operations && !route.operations.includes(input.operation)) return
    const probe = input.probes.get(route.id)
    if (!probe?.available) return
    if (probe.accountKey && probe.accountKey.trim().toLowerCase() !== account) { accountMismatch = true; return }
    candidates.push({ route, rank: (route.locality === 'local' ? 1000 : 0) + index })
  })
  candidates.sort((a, b) => a.rank - b.rank)
  const best = candidates[0]
  if (!best) return { kind: 'blocked', blocker: accountMismatch ? 'account_mismatch' : 'no_authorized_alternative' }
  return { kind: 'selected', route: best.route, fallback: best.route.id !== input.intended.id }
}

/** A local relay loss (extension gone, disconnected, evicted). */
export function isLocalRouteLoss(error: unknown): boolean {
  return error instanceof BrowserBackendError ? error.code === 'no_extension' : (error as { code?: unknown } | null)?.code === 'no_extension'
}
