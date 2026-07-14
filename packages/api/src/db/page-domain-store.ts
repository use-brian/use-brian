/**
 * Page domains + slugs store (migration 324) — BYO custom domains fronting
 * published pages, with domain-scoped slug history.
 *
 * Management ops run through `queryWithRLS` (workspace-member policies);
 * anonymous site resolution (`resolveSitePath`, `listCurrentSlugs`) reads
 * **system-side** like link-token resolution, with every request re-deriving
 * the publish gate on the DOMAIN ROOT: live `published` grant + root still
 * `clearance='public'` + workspace `external_sharing_enabled` — a domain is
 * an address, never an access path. Spec:
 * docs/architecture/features/custom-domains.md.
 *
 * [COMP:doc/page-domains]
 */

import { getAppPool, query, queryWithRLS, rollbackAndRelease } from './client.js'

export type PageDomainStatus = 'pending_dns' | 'live' | 'error'
export type PageDomainProvider = 'manual' | 'vercel'

export type PageDomain = {
  id: string
  workspaceId: string
  pageId: string
  hostname: string
  status: PageDomainStatus
  provider: PageDomainProvider
  verificationError: string | null
  lastCheckedAt: string | null
  createdBy: string
  createdAt: string
  updatedAt: string
}

/** A page resolved for anonymous serving on a custom domain. */
export type SiteTarget = {
  pageId: string
  workspaceId: string
  title: string
  icon: string | null
  fullWidth: boolean
  role: 'view'
  indexable: boolean
  /** The domain's root page id; absent when the target IS the root. */
  rootPageId?: string
}

export type SitePathResolution =
  | { kind: 'page'; domain: PageDomain; target: SiteTarget; canonicalPath: string }
  | { kind: 'redirect'; location: string }
  | null

/** A domain visible from a page: the domain plus where this page sits under it. */
export type SiteContextRow = {
  domain: PageDomain
  /** 0 when the queried page is the domain root itself. */
  depth: number
  /** The queried page's current slug on this domain, if any. */
  currentSlug: string | null
}

export type SetSlugResult =
  | { ok: true; slug: string; previousSlug: string | null }
  | { ok: false; reason: 'domain_not_found' | 'not_in_subtree' | 'slug_taken' | 'root_has_no_slug' }

export type CreatePageDomainInput = {
  userId: string
  workspaceId: string
  pageId: string
  hostname: string
  provider: PageDomainProvider
}

export type PageDomainStore = {
  createDomain(input: CreatePageDomainInput): Promise<PageDomain | { error: 'hostname_taken' }>
  listDomainsForPage(userId: string, pageId: string): Promise<PageDomain[]>
  getDomain(userId: string, domainId: string): Promise<PageDomain | null>
  countDomainsForWorkspace(userId: string, workspaceId: string): Promise<number>
  updateDomainStatus(
    userId: string,
    domainId: string,
    update: { status: PageDomainStatus; verificationError: string | null },
  ): Promise<PageDomain | null>
  deleteDomain(userId: string, domainId: string): Promise<PageDomain | null>
  /** Domains on this page or any ancestor, nearest first, with this page's current slug on each. */
  getSiteContext(userId: string, pageId: string): Promise<SiteContextRow[]>
  /** Every slug on the domain (current + historical) — suggestion dedupe input. */
  listSlugs(userId: string, domainId: string): Promise<string[]>
  /** Who holds `slug` on the domain, if anyone. RLS-scoped (editor UI). */
  getSlugHolder(
    userId: string,
    domainId: string,
    slug: string,
  ): Promise<{ pageId: string; isCurrent: boolean } | null>
  /** Set/replace a page's current slug on a domain (history-preserving swap). */
  setSlug(input: {
    userId: string
    domainId: string
    pageId: string
    slug: string
  }): Promise<SetSlugResult>
  /** Anonymous: hostname + path → renderable target / redirect / null. */
  resolveSitePath(hostname: string, path: string | null): Promise<SitePathResolution>
  /** Anonymous: gate a specific page id under a host (media/stream routes —
   *  no slug canonicalization). Null pageId targets the domain root. */
  resolveSitePage(
    hostname: string,
    pageId: string | null,
  ): Promise<{ domain: PageDomain; target: SiteTarget } | null>
  /** Anonymous: current slugs for a set of pages on a domain (link generation). */
  listCurrentSlugs(domainId: string, pageIds: string[]): Promise<Map<string, string>>
}

const domainColumns = (prefix = '') => `
  ${prefix}id,
  ${prefix}workspace_id       AS "workspaceId",
  ${prefix}page_id            AS "pageId",
  ${prefix}hostname,
  ${prefix}status,
  ${prefix}provider,
  ${prefix}verification_error AS "verificationError",
  ${prefix}last_checked_at    AS "lastCheckedAt",
  ${prefix}created_by         AS "createdBy",
  ${prefix}created_at         AS "createdAt",
  ${prefix}updated_at         AS "updatedAt"`

const DOMAIN_COLUMNS = domainColumns()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The publish gate + containment for one target under one domain root.
 *  Mirrors `resolveLinkPage` (page-grant-store): the ROOT carries every gate
 *  (live `published` grant + root still public + workspace switch); the
 *  target only has to be a descendant of it. */
const RESOLVE_TARGET_SQL = `
  WITH RECURSIVE chain AS (
    SELECT id, nest_parent_id FROM saved_views WHERE id = $2
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
         pg.indexable   AS indexable,
         r.id           AS "rootPageId"
    FROM page_grants pg
    JOIN saved_views r ON r.id = pg.page_id
    JOIN workspaces  w ON w.id = r.workspace_id
    JOIN saved_views t ON t.id = $2 AND t.workspace_id = r.workspace_id
   WHERE pg.principal_type = 'published'
     AND pg.revoked_at IS NULL
     AND (pg.expires_at IS NULL OR pg.expires_at > now())
     AND r.id = $1
     AND r.clearance = 'public'
     AND w.external_sharing_enabled = true
     AND r.id IN (SELECT id FROM chain)
   LIMIT 1`

export function createDbPageDomainStore(): PageDomainStore {
  async function listCurrentSlugsInner(
    domainId: string,
    pageIds: string[],
  ): Promise<Map<string, string>> {
    if (pageIds.length === 0) return new Map()
    const result = await query<{ pageId: string; slug: string }>(
      `SELECT page_id AS "pageId", slug FROM page_slugs
        WHERE domain_id = $1 AND is_current AND page_id = ANY($2::uuid[])`,
      [domainId, pageIds],
    )
    return new Map(result.rows.map((r) => [r.pageId, r.slug]))
  }

  async function resolveGatedTarget(rootPageId: string, pageId: string): Promise<SiteTarget | null> {
    const result = await query<SiteTarget & { rootPageId: string }>(RESOLVE_TARGET_SQL, [
      rootPageId,
      pageId,
    ])
    const row = result.rows[0]
    if (!row) return null
    if (row.rootPageId === row.pageId) return { ...row, rootPageId: undefined }
    return row
  }

  return {
    async createDomain({ userId, workspaceId, pageId, hostname, provider }) {
      try {
        const result = await queryWithRLS<PageDomain>(
          userId,
          `INSERT INTO page_domains (workspace_id, page_id, hostname, provider, created_by)
           VALUES ($1, $2, $3, $4, $5)
           RETURNING ${DOMAIN_COLUMNS}`,
          [workspaceId, pageId, hostname, provider, userId],
        )
        return result.rows[0]
      } catch (err) {
        if ((err as { code?: string }).code === '23505') return { error: 'hostname_taken' }
        throw err
      }
    },

    async listDomainsForPage(userId, pageId) {
      const result = await queryWithRLS<PageDomain>(
        userId,
        `SELECT ${DOMAIN_COLUMNS} FROM page_domains WHERE page_id = $1 ORDER BY created_at ASC`,
        [pageId],
      )
      return result.rows
    },

    async getDomain(userId, domainId) {
      const result = await queryWithRLS<PageDomain>(
        userId,
        `SELECT ${DOMAIN_COLUMNS} FROM page_domains WHERE id = $1`,
        [domainId],
      )
      return result.rows[0] ?? null
    },

    async countDomainsForWorkspace(userId, workspaceId) {
      const result = await queryWithRLS<{ count: string }>(
        userId,
        `SELECT count(*)::text AS count FROM page_domains WHERE workspace_id = $1`,
        [workspaceId],
      )
      return Number(result.rows[0]?.count ?? 0)
    },

    async updateDomainStatus(userId, domainId, { status, verificationError }) {
      const result = await queryWithRLS<PageDomain>(
        userId,
        `UPDATE page_domains
            SET status = $2, verification_error = $3, last_checked_at = now()
          WHERE id = $1
          RETURNING ${DOMAIN_COLUMNS}`,
        [domainId, status, verificationError],
      )
      return result.rows[0] ?? null
    },

    async deleteDomain(userId, domainId) {
      const result = await queryWithRLS<PageDomain>(
        userId,
        `DELETE FROM page_domains WHERE id = $1 RETURNING ${DOMAIN_COLUMNS}`,
        [domainId],
      )
      return result.rows[0] ?? null
    },

    async getSiteContext(userId, pageId) {
      type Row = PageDomain & { depth: number; currentSlug: string | null }
      const result = await queryWithRLS<Row>(
        userId,
        `WITH RECURSIVE chain AS (
           SELECT id, nest_parent_id, 0 AS depth FROM saved_views WHERE id = $1
           UNION ALL
           SELECT sv.id, sv.nest_parent_id, c.depth + 1
             FROM saved_views sv JOIN chain c ON sv.id = c.nest_parent_id
         )
         SELECT ${domainColumns('pd.')}, c.depth AS depth, ps.slug AS "currentSlug"
           FROM page_domains pd
           JOIN chain c ON pd.page_id = c.id
           LEFT JOIN LATERAL (
             SELECT slug FROM page_slugs
              WHERE domain_id = pd.id AND page_id = $1 AND is_current
              LIMIT 1
           ) ps ON true
          ORDER BY c.depth ASC, pd.created_at ASC`,
        [pageId],
      )
      return result.rows.map(({ depth, currentSlug, ...domain }) => ({
        domain,
        depth,
        currentSlug,
      }))
    },

    async listSlugs(userId, domainId) {
      const result = await queryWithRLS<{ slug: string }>(
        userId,
        `SELECT slug FROM page_slugs WHERE domain_id = $1`,
        [domainId],
      )
      return result.rows.map((r) => r.slug)
    },

    async getSlugHolder(userId, domainId, slug) {
      const result = await queryWithRLS<{ pageId: string; isCurrent: boolean }>(
        userId,
        `SELECT page_id AS "pageId", is_current AS "isCurrent"
           FROM page_slugs WHERE domain_id = $1 AND slug = $2`,
        [domainId, slug],
      )
      return result.rows[0] ?? null
    },

    async setSlug({ userId, domainId, pageId, slug }) {
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(`SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`)

        const domain = await client.query<{ pageId: string }>(
          `SELECT page_id AS "pageId" FROM page_domains WHERE id = $1 FOR UPDATE`,
          [domainId],
        )
        const rootPageId = domain.rows[0]?.pageId
        if (!rootPageId) return { ok: false, reason: 'domain_not_found' }
        if (rootPageId === pageId) return { ok: false, reason: 'root_has_no_slug' }

        // Containment: the page must live under the domain's root.
        const contained = await client.query(
          `WITH RECURSIVE chain AS (
             SELECT id, nest_parent_id FROM saved_views WHERE id = $1
             UNION ALL
             SELECT sv.id, sv.nest_parent_id
               FROM saved_views sv JOIN chain c ON sv.id = c.nest_parent_id
           )
           SELECT 1 FROM chain WHERE id = $2 LIMIT 1`,
          [pageId, rootPageId],
        )
        if (contained.rows.length === 0) return { ok: false, reason: 'not_in_subtree' }

        const holder = await client.query<{ id: string; pageId: string; isCurrent: boolean }>(
          `SELECT id, page_id AS "pageId", is_current AS "isCurrent"
             FROM page_slugs WHERE domain_id = $1 AND slug = $2 FOR UPDATE`,
          [domainId, slug],
        )
        const existing = holder.rows[0]
        if (existing && existing.pageId !== pageId) return { ok: false, reason: 'slug_taken' }
        if (existing && existing.isCurrent) {
          await client.query('COMMIT')
          return { ok: true, slug, previousSlug: null }
        }

        const demoted = await client.query<{ slug: string }>(
          `UPDATE page_slugs SET is_current = false
            WHERE domain_id = $1 AND page_id = $2 AND is_current
            RETURNING slug`,
          [domainId, pageId],
        )
        if (existing) {
          // Re-claiming one of this page's own historical slugs.
          await client.query(`UPDATE page_slugs SET is_current = true WHERE id = $1`, [
            existing.id,
          ])
        } else {
          await client.query(
            `INSERT INTO page_slugs (domain_id, page_id, slug, created_by)
             VALUES ($1, $2, $3, $4)`,
            [domainId, pageId, slug, userId],
          )
        }
        await client.query('COMMIT')
        return { ok: true, slug, previousSlug: demoted.rows[0]?.slug ?? null }
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async resolveSitePage(hostname, pageId) {
      const domainResult = await query<PageDomain>(
        `SELECT ${DOMAIN_COLUMNS} FROM page_domains WHERE hostname = $1`,
        [hostname],
      )
      const domain = domainResult.rows[0]
      if (!domain) return null
      const target = await resolveGatedTarget(domain.pageId, pageId ?? domain.pageId)
      return target ? { domain, target } : null
    },

    async resolveSitePath(hostname, path) {
      const domainResult = await query<PageDomain>(
        `SELECT ${DOMAIN_COLUMNS} FROM page_domains WHERE hostname = $1`,
        [hostname],
      )
      const domain = domainResult.rows[0]
      if (!domain) return null

      const segments = (path ?? '').split('/').filter(Boolean)

      // `/` — the root page.
      if (segments.length === 0) {
        const target = await resolveGatedTarget(domain.pageId, domain.pageId)
        return target ? { kind: 'page', domain, target, canonicalPath: '/' } : null
      }

      // `/p/<pageId>` — id fallback; 301 to the slug when one exists. The
      // publish gate runs BEFORE any redirect: a dead site (unpublished /
      // clearance raised / switch off) serves nothing, not even redirects.
      if (segments.length === 2 && segments[0] === 'p' && UUID_RE.test(segments[1])) {
        const pageId = segments[1].toLowerCase()
        const target = await resolveGatedTarget(domain.pageId, pageId)
        if (!target) return null
        if (pageId === domain.pageId) return { kind: 'redirect', location: '/' }
        const slugs = await listCurrentSlugsInner(domain.id, [pageId])
        const slug = slugs.get(pageId)
        if (slug) return { kind: 'redirect', location: `/${slug}` }
        return { kind: 'page', domain, target, canonicalPath: `/p/${pageId}` }
      }

      // `/<slug>` — flat slugs only; anything deeper is a 404 (v1).
      if (segments.length !== 1) return null
      const slugRow = await query<{ pageId: string; isCurrent: boolean }>(
        `SELECT page_id AS "pageId", is_current AS "isCurrent"
           FROM page_slugs WHERE domain_id = $1 AND slug = $2`,
        [domain.id, segments[0]],
      )
      const hit = slugRow.rows[0]
      if (!hit) return null
      // Same rule: gate first, redirect second.
      const target = await resolveGatedTarget(domain.pageId, hit.pageId)
      if (!target) return null
      if (!hit.isCurrent) {
        if (hit.pageId === domain.pageId) return { kind: 'redirect', location: '/' }
        const current = await listCurrentSlugsInner(domain.id, [hit.pageId])
        const currentSlug = current.get(hit.pageId)
        return currentSlug ? { kind: 'redirect', location: `/${currentSlug}` } : null
      }
      return { kind: 'page', domain, target, canonicalPath: `/${segments[0]}` }
    },

    async listCurrentSlugs(domainId, pageIds) {
      return listCurrentSlugsInner(domainId, pageIds)
    },
  }
}
