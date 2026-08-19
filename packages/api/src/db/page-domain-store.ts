/**
 * Page domains + slugs store (migration 324) — BYO custom domains fronting
 * published pages, with domain-scoped slug history.
 *
 * Management ops run through `queryWithRLS` (workspace-member policies);
 * anonymous site resolution (`resolveSitePath`, `listCurrentSlugs`) reads
 * **system-side** like link-token resolution, with every request re-deriving
 * the publish gate via the EXPOSURE WALK (migration 341): the target's
 * nearest ancestor-or-self that is exposed on the domain (default page or a
 * current alias) AND passes the gate — live `published` grant + still
 * `clearance='public'` + workspace `external_sharing_enabled`. A domain is
 * an address, never an access path; a domain with no default page (unbound)
 * 404s at `/` while aliased mini-roots still serve. Spec:
 * docs/architecture/features/custom-domains.md + platform-subdomains.md.
 *
 * [COMP:doc/page-domains]
 */

import { getAppPool, query, queryWithRLS, rollbackAndRelease } from './client.js'
import type { PublishRole } from './page-grant-store.js'

export type PageDomainStatus = 'pending_dns' | 'live' | 'error'
export type PageDomainProvider = 'manual' | 'vercel' | 'platform'

export type PageDomain = {
  id: string
  workspaceId: string
  /** The domain's DEFAULT page (serves at `/`). Null = connected but unbound —
   *  the domain 404s at `/` while aliased mini-roots can still serve. */
  pageId: string | null
  hostname: string
  status: PageDomainStatus
  provider: PageDomainProvider
  /** Bare label (`acme`) for `provider='platform'` rows; null for BYO rows. */
  subdomainLabel: string | null
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
  /** What an anonymous visitor may do — the ANCHOR's published grant role
   *  (`comment` cascades to every page served under it). */
  role: PublishRole
  indexable: boolean
  /** The ANCHOR page gating this target (the domain's default page or an
   *  aliased mini-root); absent when the target IS its own anchor. */
  rootPageId?: string
}

export type SitePathResolution =
  | { kind: 'page'; domain: PageDomain; target: SiteTarget; canonicalPath: string }
  | { kind: 'redirect'; location: string }
  | null

/** One workspace domain as seen from a page's Share dialog: the page's alias
 *  on it, whether the page is the default, and whether it can serve there. */
export type PageDomainContext = {
  domain: PageDomain
  /** This page IS the domain's default page (serves at `/`). */
  isDefault: boolean
  /** The queried page's current alias on this domain, if any. */
  currentSlug: string | null
  /** The page resolves on this domain today (under a gated anchor). */
  servable: boolean
}

export type SetSlugResult =
  | { ok: true; slug: string; previousSlug: string | null }
  | { ok: false; reason: 'domain_not_found' | 'not_servable' | 'slug_taken' | 'root_has_no_slug' }

export type CreatePageDomainInput = {
  userId: string
  workspaceId: string
  hostname: string
  /** BYO only — platform subdomains are created via `claimSubdomain`. */
  provider: 'manual' | 'vercel'
}

export type ClaimSubdomainInput = {
  userId: string
  workspaceId: string
  hostname: string
  label: string
}

export type ClaimSubdomainError = { error: 'hostname_taken' | 'workspace_has_subdomain' }

export type PageDomainStore = {
  createDomain(input: CreatePageDomainInput): Promise<PageDomain | { error: 'hostname_taken' }>
  getDomain(userId: string, domainId: string): Promise<PageDomain | null>
  /** Count of BYO domains (manual/vercel) for the workspace cap — excludes the
   *  platform subdomain, which is capped separately (one per workspace). */
  countDomainsForWorkspace(userId: string, workspaceId: string): Promise<number>
  /** Every domain in the workspace (platform row first), with each root
   *  page's name — the Settings → Domains list. */
  listDomainsForWorkspace(
    userId: string,
    workspaceId: string,
  ): Promise<Array<PageDomain & { pageName: string | null }>>
  // ── Platform subdomains (docs/architecture/features/platform-subdomains.md) ──
  /** The workspace's single platform subdomain, if claimed. */
  getPlatformSubdomain(userId: string, workspaceId: string): Promise<PageDomain | null>
  /** Global (cross-workspace) hostname uniqueness check; reads system-side. */
  isHostnameTaken(hostname: string): Promise<boolean>
  /** Claim `<label>.<apex>` for a workspace, bound to a published root page. */
  claimSubdomain(input: ClaimSubdomainInput): Promise<PageDomain | ClaimSubdomainError>
  /** Rename a platform row (hard-swap hostname + label). Null if not found. */
  renameSubdomain(input: {
    userId: string
    domainId: string
    hostname: string
    label: string
  }): Promise<PageDomain | { error: 'hostname_taken' } | null>
  /** Delete the workspace's platform subdomain (cascades slugs). */
  releaseSubdomain(userId: string, domainId: string): Promise<PageDomain | null>
  updateDomainStatus(
    userId: string,
    domainId: string,
    update: { status: PageDomainStatus; verificationError: string | null },
  ): Promise<PageDomain | null>
  deleteDomain(userId: string, domainId: string): Promise<PageDomain | null>
  /** Set/clear a domain's default page (what serves at `/`). Enforces the
   *  page belongs to the domain's workspace. Null clears (domain unbound). */
  setDefaultPage(
    userId: string,
    domainId: string,
    pageId: string | null,
  ): Promise<PageDomain | { error: 'page_not_in_workspace' } | null>
  /** Unbind this page as the default (`/`) page on every domain pointing at
   *  it. Called on unpublish — the domain stays connected but returns to
   *  unbound (404 at `/`), so a stale home-page pointer can never survive a
   *  page that no longer serves. Returns how many domains were unbound. */
  clearDefaultPageForPage(userId: string, pageId: string): Promise<number>
  /** Every workspace domain as seen from this page (Share-dialog select). */
  listDomainContextForPage(userId: string, pageId: string): Promise<PageDomainContext[]>
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
  ${prefix}subdomain_label     AS "subdomainLabel",
  ${prefix}verification_error AS "verificationError",
  ${prefix}last_checked_at    AS "lastCheckedAt",
  ${prefix}created_by         AS "createdBy",
  ${prefix}created_at         AS "createdAt",
  ${prefix}updated_at         AS "updatedAt"`

const DOMAIN_COLUMNS = domainColumns()

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The publish gate for one target on one domain — the EXPOSURE WALK.
 *
 *  A domain's exposure set = its default page + every page holding a CURRENT
 *  alias on it. The target serves iff walking UP from it (self included) hits
 *  an exposed page that passes the full gate: live `published` grant + still
 *  `clearance='public'` + workspace `external_sharing_enabled`. The NEAREST
 *  gated hit is the anchor (`rootPageId`) — an aliased child inside the
 *  default page's subtree is still gated by the default root (children are
 *  not individually published), while a cross-tree alias gates on itself.
 *  Mirrors `resolveLinkPage`'s gate columns; adds the per-domain scoping. */
const RESOLVE_TARGET_SQL = `
  WITH RECURSIVE chain AS (
    SELECT id, nest_parent_id, 0 AS depth FROM saved_views WHERE id = $2
    UNION ALL
    SELECT sv.id, sv.nest_parent_id, c.depth + 1
      FROM saved_views sv JOIN chain c ON sv.id = c.nest_parent_id
  ),
  exposed AS (
    SELECT page_id FROM page_domains WHERE id = $1 AND page_id IS NOT NULL
    UNION
    SELECT page_id FROM page_slugs WHERE domain_id = $1 AND is_current
  ),
  anchor AS (
    SELECT c.id, c.depth, pg.indexable, pg.role, r.workspace_id
      FROM chain c
      JOIN exposed e ON e.page_id = c.id
      JOIN page_grants pg ON pg.page_id = c.id
       AND pg.principal_type = 'published'
       AND pg.revoked_at IS NULL
       AND (pg.expires_at IS NULL OR pg.expires_at > now())
      JOIN saved_views r ON r.id = c.id AND r.clearance = 'public'
      JOIN workspaces w ON w.id = r.workspace_id AND w.external_sharing_enabled = true
     ORDER BY c.depth ASC
     LIMIT 1
  )
  SELECT t.id           AS "pageId",
         t.workspace_id AS "workspaceId",
         t.name         AS title,
         t.icon         AS icon,
         t.full_width   AS "fullWidth",
         CASE WHEN a.role IN ('comment', 'edit', 'full') THEN 'comment' ELSE 'view' END AS role,
         a.indexable    AS indexable,
         a.id           AS "rootPageId"
    FROM anchor a
    JOIN saved_views t ON t.id = $2 AND t.workspace_id = a.workspace_id
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

  async function resolveGatedTarget(domainId: string, pageId: string): Promise<SiteTarget | null> {
    const result = await query<SiteTarget & { rootPageId: string }>(RESOLVE_TARGET_SQL, [
      domainId,
      pageId,
    ])
    const row = result.rows[0]
    if (!row) return null
    if (row.rootPageId === row.pageId) return { ...row, rootPageId: undefined }
    return row
  }

  return {
    async createDomain({ userId, workspaceId, hostname, provider }) {
      try {
        const result = await queryWithRLS<PageDomain>(
          userId,
          `INSERT INTO page_domains (workspace_id, hostname, provider, created_by)
           VALUES ($1, $2, $3, $4)
           RETURNING ${DOMAIN_COLUMNS}`,
          [workspaceId, hostname, provider, userId],
        )
        return result.rows[0]
      } catch (err) {
        if ((err as { code?: string }).code === '23505') return { error: 'hostname_taken' }
        throw err
      }
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
        `SELECT count(*)::text AS count FROM page_domains
          WHERE workspace_id = $1 AND provider <> 'platform'`,
        [workspaceId],
      )
      return Number(result.rows[0]?.count ?? 0)
    },

    async listDomainsForWorkspace(userId, workspaceId) {
      const result = await queryWithRLS<PageDomain & { pageName: string | null }>(
        userId,
        `SELECT ${domainColumns('pd.')}, sv.name AS "pageName"
           FROM page_domains pd
           LEFT JOIN saved_views sv ON sv.id = pd.page_id
          WHERE pd.workspace_id = $1
          ORDER BY (pd.provider = 'platform') DESC, pd.created_at ASC`,
        [workspaceId],
      )
      return result.rows
    },

    async getPlatformSubdomain(userId, workspaceId) {
      const result = await queryWithRLS<PageDomain>(
        userId,
        `SELECT ${DOMAIN_COLUMNS} FROM page_domains
          WHERE workspace_id = $1 AND provider = 'platform' LIMIT 1`,
        [workspaceId],
      )
      return result.rows[0] ?? null
    },

    async isHostnameTaken(hostname) {
      // System-side: labels/hostnames are globally unique across workspaces, so
      // RLS (which hides other workspaces' rows) would give a false "available".
      const result = await query<{ one: number }>(
        `SELECT 1 AS one FROM page_domains WHERE hostname = $1 LIMIT 1`,
        [hostname],
      )
      return result.rows.length > 0
    },

    async claimSubdomain({ userId, workspaceId, hostname, label }) {
      try {
        const result = await queryWithRLS<PageDomain>(
          userId,
          `INSERT INTO page_domains
             (workspace_id, hostname, provider, status, subdomain_label, created_by)
           VALUES ($1, $2, 'platform', 'live', $3, $4)
           RETURNING ${DOMAIN_COLUMNS}`,
          [workspaceId, hostname, label, userId],
        )
        return result.rows[0]
      } catch (err) {
        const e = err as { code?: string; constraint?: string }
        if (e.code === '23505') {
          return e.constraint === 'page_domains_one_platform_per_workspace'
            ? { error: 'workspace_has_subdomain' }
            : { error: 'hostname_taken' }
        }
        throw err
      }
    },

    async renameSubdomain({ userId, domainId, hostname, label }) {
      try {
        const result = await queryWithRLS<PageDomain>(
          userId,
          `UPDATE page_domains
              SET hostname = $2, subdomain_label = $3
            WHERE id = $1 AND provider = 'platform'
            RETURNING ${DOMAIN_COLUMNS}`,
          [domainId, hostname, label],
        )
        return result.rows[0] ?? null
      } catch (err) {
        if ((err as { code?: string }).code === '23505') return { error: 'hostname_taken' }
        throw err
      }
    },

    async releaseSubdomain(userId, domainId) {
      const result = await queryWithRLS<PageDomain>(
        userId,
        `DELETE FROM page_domains
          WHERE id = $1 AND provider = 'platform' RETURNING ${DOMAIN_COLUMNS}`,
        [domainId],
      )
      return result.rows[0] ?? null
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

    async setDefaultPage(userId, domainId, pageId) {
      if (pageId === null) {
        const cleared = await queryWithRLS<PageDomain>(
          userId,
          `UPDATE page_domains SET page_id = NULL WHERE id = $1 RETURNING ${DOMAIN_COLUMNS}`,
          [domainId],
        )
        return cleared.rows[0] ?? null
      }
      // Same-workspace enforcement lives in the UPDATE itself: the page must
      // exist in the domain's workspace or no row updates.
      const result = await queryWithRLS<PageDomain>(
        userId,
        `UPDATE page_domains pd SET page_id = $2
          WHERE pd.id = $1
            AND EXISTS (
              SELECT 1 FROM saved_views sv
               WHERE sv.id = $2 AND sv.workspace_id = pd.workspace_id
            )
          RETURNING ${DOMAIN_COLUMNS}`,
        [domainId, pageId],
      )
      if (result.rows[0]) return result.rows[0]
      // Distinguish "domain invisible/missing" from "page not in workspace".
      const domain = await queryWithRLS<{ id: string }>(
        userId,
        `SELECT id FROM page_domains WHERE id = $1`,
        [domainId],
      )
      return domain.rows[0] ? { error: 'page_not_in_workspace' } : null
    },

    async clearDefaultPageForPage(userId, pageId) {
      // RLS (page_domains_workspace_member) scopes this to the caller's
      // workspaces, so any member who can unpublish the page can unbind it.
      const r = await queryWithRLS<{ id: string }>(
        userId,
        `UPDATE page_domains SET page_id = NULL WHERE page_id = $1 RETURNING id`,
        [pageId],
      )
      return r.rows.length
    },

    async listDomainContextForPage(userId, pageId) {
      // Every workspace domain + this page's alias/default state on each.
      // `servable` runs the same exposure walk as anonymous serving so the
      // Share dialog can say "will serve" truthfully before an alias exists.
      type Row = PageDomain & { currentSlug: string | null }
      const result = await queryWithRLS<Row>(
        userId,
        `SELECT ${domainColumns('pd.')}, ps.slug AS "currentSlug"
           FROM page_domains pd
           JOIN saved_views sv ON sv.id = $1 AND sv.workspace_id = pd.workspace_id
           LEFT JOIN LATERAL (
             SELECT slug FROM page_slugs
              WHERE domain_id = pd.id AND page_id = $1 AND is_current
              LIMIT 1
           ) ps ON true
          ORDER BY (pd.provider = 'platform') DESC, pd.created_at ASC`,
        [pageId],
      )
      return Promise.all(
        result.rows.map(async ({ currentSlug, ...domain }) => ({
          domain,
          isDefault: domain.pageId === pageId,
          currentSlug,
          servable: (await resolveGatedTarget(domain.id, pageId)) !== null,
        })),
      )
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

        const domain = await client.query<{ pageId: string | null }>(
          `SELECT page_id AS "pageId" FROM page_domains WHERE id = $1 FOR UPDATE`,
          [domainId],
        )
        if (domain.rows.length === 0) return { ok: false, reason: 'domain_not_found' }
        const defaultPageId = domain.rows[0].pageId
        if (defaultPageId === pageId) return { ok: false, reason: 'root_has_no_slug' }

        // Mini-root gate: an alias is allowed when the page already serves on
        // this domain (descendant of a gated anchor — the exposure walk), OR
        // when the page is itself published+public (the alias then makes it a
        // new mini-root). An unpublished cross-tree page gets no address —
        // a domain adds an address, never an access path.
        const servable = await resolveGatedTarget(domainId, pageId)
        if (!servable) {
          const selfPublished = await client.query(
            `SELECT 1
               FROM page_grants pg
               JOIN saved_views sv ON sv.id = pg.page_id AND sv.clearance = 'public'
              WHERE pg.page_id = $1
                AND pg.principal_type = 'published'
                AND pg.revoked_at IS NULL
                AND (pg.expires_at IS NULL OR pg.expires_at > now())
              LIMIT 1`,
            [pageId],
          )
          if (selfPublished.rows.length === 0) return { ok: false, reason: 'not_servable' }
        }

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
      const targetId = pageId ?? domain.pageId
      if (!targetId) return null // unbound domain, no target
      const target = await resolveGatedTarget(domain.id, targetId)
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

      // `/` — the domain's default page. Unbound (no default) = 404: the
      // domain is connected but not serving a home yet.
      if (segments.length === 0) {
        if (!domain.pageId) return null
        const target = await resolveGatedTarget(domain.id, domain.pageId)
        return target ? { kind: 'page', domain, target, canonicalPath: '/' } : null
      }

      // `/p/<pageId>` — id fallback; 301 to the slug when one exists. The
      // publish gate runs BEFORE any redirect: a dead site (unpublished /
      // clearance raised / switch off) serves nothing, not even redirects.
      if (segments.length === 2 && segments[0] === 'p' && UUID_RE.test(segments[1])) {
        const pageId = segments[1].toLowerCase()
        const target = await resolveGatedTarget(domain.id, pageId)
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
      const target = await resolveGatedTarget(domain.id, hit.pageId)
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
