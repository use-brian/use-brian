/**
 * Brand primitive store — `workspace_brands` + `workspace_brand_versions`
 * (migration 413).
 *
 * Implements the `BrandStore` port declared in
 * `packages/core/src/brand/types.ts`. Every read and write runs on the app
 * pool under RLS, scoped to the acting user, so a member of one workspace
 * cannot reach another's brand even with a valid uuid.
 *
 * ## The one invariant this file exists to hold
 *
 * `approve()` is the ONLY path that writes `workspace_brand_versions`, and
 * there is no update or delete path for that table anywhere in this module.
 * An approved version is a fact about what a workspace signed off on and
 * when; rewriting one would make the record's history unfalsifiable. A
 * change is a new version.
 *
 * Approval is also atomic: insert the version, repoint `active_version_id`,
 * clear the draft, and flip `status` all inside one transaction. A partial
 * approval would leave a workspace with a version nothing points at, or an
 * active pointer to a version whose draft is still sitting there looking
 * unapproved.
 *
 * Spec: docs/architecture/features/brand.md
 * Plan: docs/plans/brand-primitive.md §4 / D4
 *
 * [COMP:brand/store]
 */

import { randomUUID } from 'node:crypto'
import {
  BrandRecordSchema,
  emptyBrandRecord,
  type BrandRecord,
} from '@use-brian/shared'
import type {
  BrandApproval,
  BrandCreateInput,
  BrandDetail,
  BrandRef,
  BrandStore,
  BrandSummary,
  BrandVersion,
  BrandVersionSummary,
  BrandSensitivity,
  BrandStatus,
} from '@use-brian/core'
import { getAppPool, queryWithRLS, rollbackAndRelease } from './client.js'
import { publishBrandLifecycle } from '../brand-event-fanout.js'

type BrandRow = {
  id: string
  workspace_id: string
  slug: string
  name: string
  is_default: boolean
  status: string
  active_version_id: string | null
  draft: unknown
  sensitivity: string
  created_by: string | null
  created_at: Date
  updated_at: Date
  active_version: number | null
  active_record: unknown
}

type VersionRow = {
  id: string
  brand_id: string
  version: number
  record: unknown
  approved_by: string | null
  approved_at: Date
}

/**
 * Every brand read joins the active version so the caller gets the approved
 * record without a second round trip — the L1 digest builder runs on every
 * turn, and a second query per turn for a single JSONB body is pure waste.
 */
const BRAND_SELECT = `
  b.id, b.workspace_id, b.slug, b.name, b.is_default, b.status,
  b.active_version_id, b.draft, b.sensitivity, b.created_by,
  b.created_at, b.updated_at,
  v.version AS active_version,
  v.record  AS active_record
`

const BRAND_FROM = `
  FROM workspace_brands b
  LEFT JOIN workspace_brand_versions v ON v.id = b.active_version_id
`

/**
 * Parse a stored record body.
 *
 * A row that fails validation is surfaced as `null` rather than thrown: the
 * schema can tighten after rows exist, and a brand whose history predates a
 * new required field must not take down the chat route's prompt assembly.
 * The caller treats `null` as "no record", which degrades to no digest block
 * — the same state as a workspace that never created a brand.
 */
function parseRecord(value: unknown): BrandRecord | null {
  if (value === null || value === undefined) return null
  const parsed = BrandRecordSchema.safeParse(value)
  if (!parsed.success) {
    console.warn('[brand-store] stored record failed validation; treating as absent')
    return null
  }
  return parsed.data
}

function toSummary(row: BrandRow): BrandSummary {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    slug: row.slug,
    name: row.name,
    isDefault: row.is_default,
    status: row.status as BrandStatus,
    activeVersionId: row.active_version_id,
    activeVersion: row.active_version,
    hasDraft: row.draft !== null && row.draft !== undefined,
    sensitivity: row.sensitivity as BrandSensitivity,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function toDetail(row: BrandRow): BrandDetail {
  return {
    ...toSummary(row),
    draft: parseRecord(row.draft),
    activeRecord: parseRecord(row.active_record),
  }
}

function toVersionSummary(row: VersionRow): BrandVersionSummary {
  return {
    id: row.id,
    brandId: row.brand_id,
    version: row.version,
    approvedBy: row.approved_by,
    approvedAt: row.approved_at,
  }
}

let shared: BrandStore | null = null

/**
 * The process-wide brand store.
 *
 * Unlike the workspace-files store, this one has nothing to configure — no
 * blob client, no bucket, no credential — so there is no deployment in which
 * it is legitimately absent once migration 413 has run. Every consumer
 * reaching it through one accessor is what keeps a new channel surface from
 * silently shipping without the brand digest: there is no dependency to
 * forget to thread. Consumers that need a seam (tests) inject a fake
 * `BrandStore` directly.
 */
export function getBrandStore(): BrandStore {
  if (!shared) shared = createBrandStore()
  return shared
}

export function createBrandStore(): BrandStore {
  return {
    async list(userId, workspaceId) {
      const res = await queryWithRLS<BrandRow>(
        userId,
        `SELECT ${BRAND_SELECT} ${BRAND_FROM}
          WHERE b.workspace_id = $1
          ORDER BY b.is_default DESC, b.updated_at DESC`,
        [workspaceId],
      )
      return res.rows.map(toSummary)
    },

    async get(userId, workspaceId, ref?: BrandRef) {
      // Ref precedence: explicit id, then slug, then the workspace default.
      // The three are mutually exclusive branches rather than an OR-ed
      // WHERE, so passing a slug that belongs to a different brand than the
      // id can never silently resolve to whichever the planner reached first.
      let where = 'b.is_default'
      const params: unknown[] = [workspaceId]
      if (ref?.id) {
        where = 'b.id = $2'
        params.push(ref.id)
      } else if (ref?.slug) {
        where = 'b.slug = $2'
        params.push(ref.slug)
      }
      const res = await queryWithRLS<BrandRow>(
        userId,
        `SELECT ${BRAND_SELECT} ${BRAND_FROM}
          WHERE b.workspace_id = $1 AND ${where}
          LIMIT 1`,
        params,
      )
      return res.rows.length > 0 ? toDetail(res.rows[0]) : null
    },

    async create(userId, workspaceId, input: BrandCreateInput) {
      const draft = input.draft ?? emptyBrandRecord(input.name)
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`,
        )

        // "First brand is the default" is resolved inside the transaction, so
        // two concurrent creates cannot both decide they are first — the
        // partial unique index rejects the loser rather than silently
        // producing a workspace with two defaults.
        const existing = await client.query<{ count: string }>(
          `SELECT count(*)::text AS count FROM workspace_brands WHERE workspace_id = $1`,
          [workspaceId],
        )
        const isFirst = existing.rows[0].count === '0'
        const wantsDefault = input.isDefault ?? isFirst

        if (wantsDefault && !isFirst) {
          await client.query(
            `UPDATE workspace_brands SET is_default = false, updated_at = now()
              WHERE workspace_id = $1 AND is_default`,
            [workspaceId],
          )
        }

        const inserted = await client.query<BrandRow>(
          `INSERT INTO workspace_brands
             (id, workspace_id, slug, name, is_default, status, draft, sensitivity, created_by)
           VALUES ($1, $2, $3, $4, $5, 'draft', $6::jsonb, $7, $8)
           RETURNING id, workspace_id, slug, name, is_default, status,
                     active_version_id, draft, sensitivity, created_by,
                     created_at, updated_at,
                     NULL::integer AS active_version, NULL::jsonb AS active_record`,
          [
            randomUUID(),
            workspaceId,
            input.slug,
            input.name,
            wantsDefault,
            JSON.stringify(draft),
            input.sensitivity ?? 'internal',
            userId,
          ],
        )
        await client.query('COMMIT')
        const created = toDetail(inserted.rows[0])
        publishBrandLifecycle({
          workspaceId,
          brandId: created.id,
          action: 'created',
          slug: created.slug,
          name: created.name,
          version: null,
          actorId: userId,
          writtenBy: input.writtenBy ?? 'user',
        })
        return created
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async saveDraft(userId, workspaceId, brandId, record, writtenBy) {
      const res = await queryWithRLS<BrandRow>(
        userId,
        `WITH updated AS (
           UPDATE workspace_brands
              SET draft = $3::jsonb, updated_at = now()
            WHERE id = $1 AND workspace_id = $2
            RETURNING *
         )
         SELECT ${BRAND_SELECT}
           FROM updated b
           LEFT JOIN workspace_brand_versions v ON v.id = b.active_version_id`,
        [brandId, workspaceId, JSON.stringify(record)],
      )
      if (res.rows.length === 0) return null
      const saved = toDetail(res.rows[0])
      publishBrandLifecycle({
        workspaceId,
        brandId: saved.id,
        action: 'updated',
        slug: saved.slug,
        name: saved.name,
        version: null,
        actorId: userId,
        writtenBy: writtenBy ?? 'user',
      })
      return saved
    },

    async approve(userId, workspaceId, brandId, approverUserId): Promise<BrandApproval | null> {
      const client = await getAppPool().connect()
      try {
        await client.query('BEGIN')
        await client.query(
          `SET LOCAL app.current_user_id = '${userId.replace(/'/g, "''")}'`,
        )

        // FOR UPDATE serializes concurrent approvals of the same brand, so
        // two approvers cannot both read draft N and both insert version N+1
        // (the (brand_id, version) unique index would reject one, but with a
        // constraint error instead of the honest "nothing to approve").
        const current = await client.query<{ draft: unknown; prior_version: number | null }>(
          `SELECT b.draft, v.version AS prior_version
             FROM workspace_brands b
             LEFT JOIN workspace_brand_versions v ON v.id = b.active_version_id
            WHERE b.id = $1 AND b.workspace_id = $2
            FOR UPDATE OF b`,
          [brandId, workspaceId],
        )
        if (current.rows.length === 0) {
          await client.query('ROLLBACK')
          return null
        }
        const priorVersion = current.rows[0].prior_version
        const draft = parseRecord(current.rows[0].draft)
        if (!draft) {
          // Nothing in flight (or an unparseable body). Approving is a no-op
          // rather than an error: a double-click on Approve must not mint a
          // duplicate version.
          await client.query('ROLLBACK')
          return null
        }

        const next = await client.query<{ next_version: number }>(
          `SELECT COALESCE(max(version), 0) + 1 AS next_version
             FROM workspace_brand_versions WHERE brand_id = $1`,
          [brandId],
        )
        const versionNumber = next.rows[0].next_version

        const versionRow = await client.query<VersionRow>(
          `INSERT INTO workspace_brand_versions
             (brand_id, workspace_id, version, record, approved_by)
           VALUES ($1, $2, $3, $4::jsonb, $5)
           RETURNING id, brand_id, version, record, approved_by, approved_at`,
          [brandId, workspaceId, versionNumber, JSON.stringify(draft), approverUserId],
        )

        // Clearing the draft in the same statement that repoints the active
        // version is what makes "has an unapproved draft" a truthful signal:
        // leaving it would show a permanent "unapproved changes" badge over
        // content identical to the approved version.
        const brandRow = await client.query<BrandRow>(
          `WITH updated AS (
             UPDATE workspace_brands
                SET active_version_id = $3,
                    draft = NULL,
                    status = 'active',
                    updated_at = now()
              WHERE id = $1 AND workspace_id = $2
              RETURNING *
           )
           SELECT ${BRAND_SELECT}
             FROM updated b
             LEFT JOIN workspace_brand_versions v ON v.id = b.active_version_id`,
          [brandId, workspaceId, versionRow.rows[0].id],
        )

        await client.query('COMMIT')
        const record = parseRecord(versionRow.rows[0].record)
        const approved = toDetail(brandRow.rows[0])
        // `superseded` fires FIRST and only when a version was actually
        // retired: on a brand's first approval nothing was superseded, and
        // emitting it anyway would make "the brand's positioning changed"
        // subscriptions fire on a brand that had no prior positioning.
        if (priorVersion !== null) {
          publishBrandLifecycle({
            workspaceId,
            brandId: approved.id,
            action: 'superseded',
            slug: approved.slug,
            name: approved.name,
            version: priorVersion,
            actorId: approverUserId,
            writtenBy: 'user',
          })
        }
        publishBrandLifecycle({
          workspaceId,
          brandId: approved.id,
          action: 'approved',
          slug: approved.slug,
          name: approved.name,
          version: versionNumber,
          actorId: approverUserId,
          // Approval is always human: it is a Studio action gated on an
          // owner/admin role, and no tool can reach it.
          writtenBy: 'user',
        })
        return {
          brand: approved,
          version: { ...toVersionSummary(versionRow.rows[0]), record: record ?? draft },
        }
      } finally {
        await rollbackAndRelease(client)
      }
    },

    async listVersions(userId, workspaceId, brandId) {
      const res = await queryWithRLS<VersionRow>(
        userId,
        `SELECT id, brand_id, version, NULL::jsonb AS record, approved_by, approved_at
           FROM workspace_brand_versions
          WHERE brand_id = $1 AND workspace_id = $2
          ORDER BY version DESC`,
        [brandId, workspaceId],
      )
      return res.rows.map(toVersionSummary)
    },

    async getVersion(userId, workspaceId, brandId, version): Promise<BrandVersion | null> {
      const res = await queryWithRLS<VersionRow>(
        userId,
        `SELECT id, brand_id, version, record, approved_by, approved_at
           FROM workspace_brand_versions
          WHERE brand_id = $1 AND workspace_id = $2 AND version = $3`,
        [brandId, workspaceId, version],
      )
      if (res.rows.length === 0) return null
      const record = parseRecord(res.rows[0].record)
      if (!record) return null
      return { ...toVersionSummary(res.rows[0]), record }
    },
  }
}
