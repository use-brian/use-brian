/**
 * Page-access resolver seam (the anti-drift boundary).
 *
 * One resolver maps a `(ShareActor, pageId?) → effective role`. Phase 1
 * implements the `link` branch (anonymous share token). The `user`,
 * `workspace`, `group`, and `service` branches are stubs for later phases
 * (the Share tab + doc-sync's clearance gate will call this same
 * resolver so the two enforcement surfaces never drift).
 *
 * IMPORTANT: a `link` actor is snapshot/public-route-only in Phase 1 — it
 * never reaches doc-sync (which only ever passes `user` / `service`).
 *
 * [COMP:doc/page-grants]
 */

import type { GrantRole, PageGrantStore } from './page-grant-store.js'

export type ShareActor =
  | { kind: 'link'; rawToken: string }
  | { kind: 'user'; userId: string }
  | { kind: 'service' }

export type ResolvedAccess = {
  role: GrantRole
  pageId: string
  workspaceId: string
} | null

export type PageAccessResolver = {
  resolve(actor: ShareActor, pageId?: string): Promise<ResolvedAccess>
}

export function createPageAccessResolver(deps: {
  pageGrantStore: PageGrantStore
}): PageAccessResolver {
  return {
    async resolve(actor, pageId) {
      switch (actor.kind) {
        case 'link': {
          const link = await deps.pageGrantStore.resolveLinkToken(actor.rawToken)
          if (!link) return null
          // A token is bound to its page: a link for page A must not open B.
          if (pageId && link.pageId !== pageId) return null
          return { role: link.role, pageId: link.pageId, workspaceId: link.workspaceId }
        }
        case 'user':
        case 'service':
          // Phase 3 — the authenticated Share-tab principals + doc-sync
          // service reads resolve through the existing membership/clearance
          // path. Not part of the Phase 1 anonymous link slice.
          return null
      }
    },
  }
}
