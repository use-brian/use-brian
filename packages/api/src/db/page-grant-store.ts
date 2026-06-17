/**
 * Page grants store (migration 249) — the access spine for doc page
 * sharing. A grant is a `(principal, role)` row on a page; Phase 1 only
 * writes the `link` principal (an anonymous "anyone with the link" token).
 *
 * Token handling: a high-entropy raw token is returned to the creator
 * exactly once; only its SHA-256 hash is persisted in `principal_ref`.
 * `resolveLinkToken` hashes the presented token and looks up a live grant
 * **system-side** (the anonymous viewer is not a workspace member), gated
 * on the page being currently `clearance='public'` and the workspace's
 * `external_sharing_enabled` switch — so raising a page's clearance or
 * flipping the switch instantly stops public access.
 *
 * Management ops (`createLinkGrant`, `listGrants`, `revokeGrant`) run
 * through `queryWithRLS`, so the `page_grants_workspace_member` RLS policy
 * enforces that the caller is a member of the page's workspace. The route
 * layer additionally restricts creation to the page creator / workspace
 * owner-admin.
 *
 * [COMP:doc/page-grants]
 */

import { createHash, randomBytes } from 'node:crypto'
import { query, queryWithRLS } from './client.js'

export type GrantRole = 'view' | 'comment' | 'edit' | 'full'

export type PageGrant = {
  id: string
  pageId: string
  principalType: 'user' | 'workspace' | 'group' | 'link' | 'published'
  role: GrantRole
  label: string | null
  indexable: boolean
  createdBy: string
  expiresAt: string | null
  revokedAt: string | null
  createdAt: string
}

/** Resolved live link grant joined with its (currently public) page. */
export type ResolvedLink = {
  pageId: string
  workspaceId: string
  title: string
  icon: string | null
  fullWidth: boolean
  role: GrantRole
  indexable: boolean
  /** For a sub-page resolved through a token's root (`resolveLinkPage`): the
   *  token's own page id. Drives the token-scoped breadcrumb + SSE root
   *  subscription. Absent when the resolved page IS the granted page. */
  rootPageId?: string
}

export type CreateLinkGrantInput = {
  userId: string
  pageId: string
  role?: GrantRole
  label?: string | null
  indexable?: boolean
  expiresAt?: Date | null
}

export type IdentityPrincipalType = 'user' | 'group' | 'workspace'

/** A non-link (identity) grant hydrated with a display label for the Share tab. */
export type DetailedGrant = PageGrant & {
  principalRef: string | null
  principalLabel: string | null
}

export type PageGrantStore = {
  createLinkGrant(input: CreateLinkGrantInput): Promise<{ grant: PageGrant; token: string }>
  listGrants(userId: string, pageId: string): Promise<PageGrant[]>
  /** user/group/workspace grants on a page, hydrated with a display label. */
  listIdentityGrants(userId: string, pageId: string): Promise<DetailedGrant[]>
  /** Upsert a user/group/workspace grant at a role (one active grant per principal). */
  upsertIdentityGrant(input: {
    userId: string
    pageId: string
    principalType: IdentityPrincipalType
    principalRef: string
    role: GrantRole
  }): Promise<PageGrant>
  updateGrantRole(userId: string, grantId: string, role: GrantRole): Promise<boolean>
  revokeGrant(userId: string, grantId: string): Promise<boolean>
  resolveLinkToken(rawToken: string): Promise<ResolvedLink | null>
  /** Anonymous: resolve a DESCENDANT of a token-shared root through that token
   *  (subtree cascade — see doc.md "Subtree share"). Same root gates as
   *  `resolveLinkToken`; the target only has to sit under the root. */
  resolveLinkPage(rawToken: string, pageId: string): Promise<ResolvedLink | null>
  /** Owner-side: is this page published to the web, and is it indexable? */
  getPublishState(userId: string, pageId: string): Promise<{ published: boolean; indexable: boolean }>
  /** Publish (idempotent): ensure exactly one active `published` grant for the page. */
  publishPage(input: { userId: string; pageId: string; indexable: boolean }): Promise<void>
  /** Unpublish: revoke the page's active `published` grant(s). */
  unpublishPage(userId: string, pageId: string): Promise<boolean>
  /** Anonymous: resolve a page published to the web by its id (no token). The
   *  page id is part of the universal public URL; access requires a live
   *  `published` grant on the page or an ancestor that is itself still
   *  `clearance='public'`, + the workspace switch (subtree cascade). */
  resolvePublishedPage(pageId: string): Promise<ResolvedLink | null>
}

const GRANT_SELECT = `
  id,
  page_id        AS "pageId",
  principal_type AS "principalType",
  role,
  label,
  indexable,
  created_by     AS "createdBy",
  expires_at     AS "expiresAt",
  revoked_at     AS "revokedAt",
  created_at     AS "createdAt"
`

type GrantRow = {
  id: string
  pageId: string
  principalType: PageGrant['principalType']
  role: GrantRole
  label: string | null
  indexable: boolean
  createdBy: string
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
}

function rowToGrant(row: GrantRow): PageGrant {
  return {
    id: row.id,
    pageId: row.pageId,
    principalType: row.principalType,
    role: row.role,
    label: row.label,
    indexable: row.indexable,
    createdBy: row.createdBy,
    expiresAt: row.expiresAt ? row.expiresAt.toISOString() : null,
    revokedAt: row.revokedAt ? row.revokedAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
  }
}

/** SHA-256 hex of a raw share token — what we persist + look up by. */
export function hashShareToken(rawToken: string): string {
  return createHash('sha256').update(rawToken).digest('hex')
}

/** 32 bytes of entropy, URL-safe. The raw value is shown to the creator once. */
function mintShareToken(): string {
  return randomBytes(32).toString('base64url')
}

export function createDbPageGrantStore(): PageGrantStore {
  return {
    async createLinkGrant({ userId, pageId, role = 'view', label = null, indexable = false, expiresAt = null }) {
      const token = mintShareToken()
      const tokenHash = hashShareToken(token)
      // queryWithRLS → the page_grants_workspace_member policy's WITH CHECK
      // rejects the INSERT unless `userId` is a member of the page's
      // workspace. The route enforces the tighter creator/owner-admin gate.
      const result = await queryWithRLS<GrantRow>(
        userId,
        `INSERT INTO page_grants
           (page_id, principal_type, principal_ref, role, label, indexable, created_by, expires_at)
         VALUES ($1, 'link', $2, $3, $4, $5, $6, $7)
         RETURNING ${GRANT_SELECT}`,
        [pageId, tokenHash, role, label, indexable, userId, expiresAt],
      )
      return { grant: rowToGrant(result.rows[0]), token }
    },

    async listGrants(userId, pageId) {
      const result = await queryWithRLS<GrantRow>(
        userId,
        `SELECT ${GRANT_SELECT} FROM page_grants
          WHERE page_id = $1 AND revoked_at IS NULL
          ORDER BY created_at DESC`,
        [pageId],
      )
      return result.rows.map(rowToGrant)
    },

    async listIdentityGrants(userId, pageId) {
      // Only user/group/workspace principals — link grants have a token-hash
      // principal_ref (not a uuid), and live in the "Anyone with link" tab.
      const result = await queryWithRLS<
        GrantRow & {
          principalRef: string | null
          userName: string | null
          userEmail: string | null
          groupName: string | null
        }
      >(
        userId,
        `SELECT pg.id, pg.page_id AS "pageId", pg.principal_type AS "principalType",
                pg.principal_ref AS "principalRef", pg.role, pg.label, pg.indexable,
                pg.created_by AS "createdBy", pg.expires_at AS "expiresAt",
                pg.revoked_at AS "revokedAt", pg.created_at AS "createdAt",
                u.name AS "userName", u.email AS "userEmail", g.name AS "groupName"
           FROM page_grants pg
           LEFT JOIN users u ON pg.principal_type = 'user' AND u.id = pg.principal_ref::uuid
           LEFT JOIN workspace_groups g ON pg.principal_type = 'group' AND g.id = pg.principal_ref::uuid
          WHERE pg.page_id = $1
            AND pg.principal_type IN ('user','group','workspace')
            AND pg.revoked_at IS NULL
          ORDER BY pg.created_at DESC`,
        [pageId],
      )
      return result.rows.map((row) => ({
        ...rowToGrant(row),
        principalRef: row.principalRef,
        principalLabel:
          row.principalType === 'user'
            ? (row.userName ?? row.userEmail ?? null)
            : row.principalType === 'group'
              ? (row.groupName ?? null)
              : 'Everyone in the workspace',
      }))
    },

    async upsertIdentityGrant({ userId, pageId, principalType, principalRef, role }) {
      // One active grant per (page, principal): update in place if present,
      // else insert. queryWithRLS gates membership; the route gates manager.
      const upd = await queryWithRLS<GrantRow>(
        userId,
        `UPDATE page_grants SET role = $4
           WHERE page_id = $1 AND principal_type = $2 AND principal_ref = $3 AND revoked_at IS NULL
           RETURNING ${GRANT_SELECT}`,
        [pageId, principalType, principalRef, role],
      )
      if (upd.rows[0]) return rowToGrant(upd.rows[0])
      const ins = await queryWithRLS<GrantRow>(
        userId,
        `INSERT INTO page_grants (page_id, principal_type, principal_ref, role, created_by)
         VALUES ($1, $2, $3, $4, $5)
         RETURNING ${GRANT_SELECT}`,
        [pageId, principalType, principalRef, role, userId],
      )
      return rowToGrant(ins.rows[0])
    },

    async updateGrantRole(userId, grantId, role) {
      const r = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE page_grants SET role = $2 WHERE id = $1 AND revoked_at IS NULL RETURNING id`,
        [grantId, role],
      )
      return r.rows.length > 0
    },

    async revokeGrant(userId, grantId) {
      const result = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE page_grants SET revoked_at = now()
          WHERE id = $1 AND revoked_at IS NULL
          RETURNING id`,
        [grantId],
      )
      return result.rows.length > 0
    },

    async resolveLinkToken(rawToken) {
      if (!rawToken) return null
      const tokenHash = hashShareToken(rawToken)
      // System-side read (anonymous viewer is not a member). The WHERE
      // clause is the gate: live + unexpired link grant AND the page is
      // currently public AND the workspace allows external sharing.
      const result = await query<{
        pageId: string
        workspaceId: string
        title: string
        icon: string | null
        fullWidth: boolean
        role: GrantRole
        indexable: boolean
      }>(
        `SELECT sv.id           AS "pageId",
                sv.workspace_id  AS "workspaceId",
                sv.name          AS title,
                sv.icon          AS icon,
                sv.full_width    AS "fullWidth",
                pg.role          AS role,
                pg.indexable     AS indexable
           FROM page_grants pg
           JOIN saved_views sv ON sv.id = pg.page_id
           JOIN workspaces  w  ON w.id  = sv.workspace_id
          WHERE pg.principal_type = 'link'
            AND pg.principal_ref  = $1
            AND pg.revoked_at IS NULL
            AND (pg.expires_at IS NULL OR pg.expires_at > now())
            AND sv.clearance = 'public'
            AND w.external_sharing_enabled = true
          LIMIT 1`,
        [tokenHash],
      )
      const row = result.rows[0]
      return row ?? null
    },

    async resolveLinkPage(rawToken, pageId) {
      if (!rawToken || !pageId) return null
      const tokenHash = hashShareToken(rawToken)
      // Subtree cascade for token links: the ROOT carries every gate (live
      // grant + root still public + workspace switch — identical to
      // resolveLinkToken); the target only has to be a descendant of it
      // (`nest_parent_id` walk UP from the target). The target's own
      // clearance is deliberately NOT checked — sharing a page shares
      // everything nested under it (doc.md "Subtree share").
      const result = await query<ResolvedLink & { rootPageId: string }>(
        `WITH RECURSIVE chain AS (
           SELECT id, nest_parent_id FROM saved_views WHERE id = $2
           UNION ALL
           SELECT sv.id, sv.nest_parent_id
             FROM saved_views sv JOIN chain c ON sv.id = c.nest_parent_id
         )
         SELECT t.id            AS "pageId",
                t.workspace_id  AS "workspaceId",
                t.name          AS title,
                t.icon          AS icon,
                t.full_width    AS "fullWidth",
                pg.role         AS role,
                pg.indexable    AS indexable,
                r.id            AS "rootPageId"
           FROM page_grants pg
           JOIN saved_views r ON r.id = pg.page_id
           JOIN workspaces  w ON w.id = r.workspace_id
           JOIN saved_views t ON t.id = $2 AND t.workspace_id = r.workspace_id
          WHERE pg.principal_type = 'link'
            AND pg.principal_ref  = $1
            AND pg.revoked_at IS NULL
            AND (pg.expires_at IS NULL OR pg.expires_at > now())
            AND r.clearance = 'public'
            AND w.external_sharing_enabled = true
            AND r.id IN (SELECT id FROM chain)
          LIMIT 1`,
        [tokenHash, pageId],
      )
      const row = result.rows[0]
      if (!row) return null
      // The root view is the plain token resolution; don't tag a rootPageId.
      if (row.rootPageId === row.pageId) return { ...row, rootPageId: undefined }
      return row
    },

    async getPublishState(userId, pageId) {
      const r = await queryWithRLS<{ indexable: boolean }>(
        userId,
        `SELECT indexable FROM page_grants
          WHERE page_id = $1 AND principal_type = 'published' AND revoked_at IS NULL
          ORDER BY created_at DESC LIMIT 1`,
        [pageId],
      )
      return { published: r.rows.length > 0, indexable: r.rows[0]?.indexable ?? false }
    },

    async publishPage({ userId, pageId, indexable }) {
      // One active published grant per page: update in place if present, else
      // insert. principal_ref = pageId (the page is its own principal). The
      // route declassifies the page to `clearance='public'` first.
      const upd = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE page_grants SET indexable = $2
           WHERE page_id = $1 AND principal_type = 'published' AND revoked_at IS NULL
           RETURNING id`,
        [pageId, indexable],
      )
      if (upd.rows[0]) return
      await queryWithRLS(
        userId,
        // $1 (uuid page_id) and $2 (text principal_ref) are separate params —
        // reusing one placeholder across two column types makes pg fail to
        // deduce the type ("inconsistent types deduced for parameter").
        `INSERT INTO page_grants (page_id, principal_type, principal_ref, role, indexable, created_by)
         VALUES ($1, 'published', $2, 'view', $3, $4)`,
        [pageId, pageId, indexable, userId],
      )
    },

    async unpublishPage(userId, pageId) {
      const r = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE page_grants SET revoked_at = now()
           WHERE page_id = $1 AND principal_type = 'published' AND revoked_at IS NULL
           RETURNING id`,
        [pageId],
      )
      return r.rows.length > 0
    },

    async resolvePublishedPage(pageId) {
      if (!pageId) return null
      // System-side read (anonymous viewer). Publishing cascades down the page
      // tree (Notion model): the target resolves if a live `published` grant
      // exists on the target OR any ANCESTOR (walking `nest_parent_id`) whose
      // own clearance is still `'public'`. The clearance gate sits on the
      // GRANTED node, not the target — sharing a page shares everything nested
      // under it, regardless of each descendant's clearance (doc.md "Subtree
      // share"). Unpublishing the ancestor / raising the published root's
      // clearance / flipping the workspace switch all cut the whole subtree
      // immediately; no descendant clearance is ever mutated.
      const result = await query<ResolvedLink>(
        `WITH RECURSIVE chain AS (
           SELECT id, nest_parent_id FROM saved_views WHERE id = $1
           UNION ALL
           SELECT sv.id, sv.nest_parent_id
             FROM saved_views sv JOIN chain c ON sv.id = c.nest_parent_id
         )
         SELECT t.id           AS "pageId",
                t.workspace_id AS "workspaceId",
                t.name         AS title,
                t.icon         AS icon,
                t.full_width   AS "fullWidth",
                'view'::text   AS role,
                COALESCE(bool_or(pg.indexable), false) AS indexable
           FROM saved_views t
           JOIN workspaces  w ON w.id = t.workspace_id
           LEFT JOIN page_grants pg
                  ON pg.principal_type = 'published'
                 AND pg.revoked_at IS NULL
                 AND (pg.expires_at IS NULL OR pg.expires_at > now())
                 AND pg.page_id IN (SELECT id FROM chain)
                 AND EXISTS (SELECT 1 FROM saved_views g
                              WHERE g.id = pg.page_id AND g.clearance = 'public')
          WHERE t.id = $1
            AND w.external_sharing_enabled = true
          GROUP BY t.id, t.workspace_id, t.name, t.icon, t.full_width
         HAVING bool_or(pg.id IS NOT NULL)`,
        [pageId],
      )
      return result.rows[0] ?? null
    },
  }
}

export type PublicBreadcrumbCrumb = { pageId: string; title: string; icon: string | null }

/**
 * The ancestor breadcrumb (root → current) for a published page, system-side.
 * Walks `nest_parent_id` up from the page to the TOPMOST ancestor (or the page
 * itself) that carries a live `published` grant AND is itself still
 * `clearance='public'` — that page is the publicly-addressable subtree root,
 * and every crumb below it resolves at `/share/p/<id>` by subtree inheritance
 * (descendant clearance never cuts the chain — doc.md "Subtree share").
 * Returns `[]` for a page that is NOT inside any published subtree (e.g. a
 * link-token-only page), so the caller renders a plain title with no broken
 * ancestor links.
 */
export async function getPublicBreadcrumb(pageId: string): Promise<PublicBreadcrumbCrumb[]> {
  if (!pageId) return []
  const chain = await fetchAncestorChain(pageId)
  // The breadcrumb root is the TOPMOST live published root in the chain
  // (everything from there down is accessible via `/share/p/<id>`).
  let topPublished = -1
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].published && chain[i].clearance === 'public') topPublished = i
  }
  if (topPublished < 0) return [] // not inside any published subtree → no chain
  const crumbs = chain
    .slice(0, topPublished + 1)
    .map((r) => ({ pageId: r.id, title: r.name, icon: r.icon }))
  crumbs.reverse() // root → current
  return crumbs
}

/**
 * The token-scoped breadcrumb (root → current) for a sub-page viewed through
 * a link token (`/share/<token>/p/<pageId>`): the chain from the token's
 * granted root down to the page. The caller has already resolved access via
 * `resolveLinkPage` — this only shapes the chain. Returns `[]` when the root
 * isn't in the page's ancestry (defensive; resolution should preclude it).
 */
export async function getLinkBreadcrumb(
  pageId: string,
  rootPageId: string,
): Promise<PublicBreadcrumbCrumb[]> {
  if (!pageId || !rootPageId) return []
  const chain = await fetchAncestorChain(pageId)
  const rootIdx = chain.findIndex((r) => r.id === rootPageId)
  if (rootIdx < 0) return []
  const crumbs = chain.slice(0, rootIdx + 1).map((r) => ({ pageId: r.id, title: r.name, icon: r.icon }))
  crumbs.reverse() // root → current
  return crumbs
}

/** Ancestor chain (current → root order) with each node's live-publish flag. */
async function fetchAncestorChain(pageId: string): Promise<
  { id: string; name: string; icon: string | null; clearance: string; depth: number; published: boolean }[]
> {
  const res = await query<{
    id: string
    name: string
    icon: string | null
    clearance: string
    depth: number
    published: boolean
  }>(
    `WITH RECURSIVE chain AS (
       SELECT id, name, icon, nest_parent_id, clearance, 0 AS depth
         FROM saved_views WHERE id = $1
       UNION ALL
       SELECT sv.id, sv.name, sv.icon, sv.nest_parent_id, sv.clearance, c.depth + 1
         FROM saved_views sv JOIN chain c ON sv.id = c.nest_parent_id
     )
     SELECT id, name, icon, clearance, depth,
            EXISTS(
              SELECT 1 FROM page_grants pg
               WHERE pg.page_id = chain.id
                 AND pg.principal_type = 'published'
                 AND pg.revoked_at IS NULL
                 AND (pg.expires_at IS NULL OR pg.expires_at > now())
            ) AS published
       FROM chain
      ORDER BY depth ASC`,
    [pageId],
  )
  return res.rows
}
