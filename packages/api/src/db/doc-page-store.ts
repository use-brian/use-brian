/**
 * Doc v1 — `DocPageStore` adapter backed by `saved_views` rows.
 *
 * Phase 1 Batch 2 / Agent P1C. Fulfils the `DocPageStore` interface
 * declared in `packages/core/src/doc/tools.ts`.
 *
 * The interface is intentionally narrow:
 *   - `getVersionedPage(userId, pageId)` — RLS-gated SELECT of
 *     `(page, version, name)` from a single `saved_views` row.
 *   - `applyPatch(...)` — atomic compare-and-swap on `version`. Lock #8:
 *     concurrent patches against the same base version are mutually
 *     exclusive because exactly one row matches the `WHERE version =
 *     $expectedVersion` predicate at a time. Loser sees 0 rows affected.
 *
 * Title source. Phase 1's compatibility seam stores the page title in
 * `saved_views.name` (see `core/src/doc/page-types.ts` →
 * `VersionedPage.title`). Phase 5 may split title-as-block, at which
 * point this adapter changes.
 *
 * RLS. `saved_views_workspace_member` already gates reads/writes by
 * workspace membership; we route through `queryWithRLS(userId, ...)`
 * which sets `app.current_user_id` per call. No system bypass needed —
 * every doc patch is initiated by a logged-in user (or a workflow
 * step whose userId carries through).
 *
 * [COMP:api/doc-page-store]
 */

import type { DocPageRead, DocPageStore, NameOrigin, Page } from '@sidanclaw/core'
import { queryWithRLS } from './client.js'

// ── Row projections ────────────────────────────────────────────────────

type VersionedPageRow = {
  page: Page | null
  version: number
  name: string | null
  nameOrigin: NameOrigin | null
  icon: string | null
}

// ── Factory ────────────────────────────────────────────────────────────

/**
 * Build a `DocPageStore` that reads/writes the doc v1 columns on
 * `saved_views` (`page` JSONB, `version` INT, `last_undo` JSONB,
 * `name` TEXT for the title).
 */
export function createDbDocPageStore(): DocPageStore {
  return {
    async getVersionedPage(userId, pageId): Promise<DocPageRead | null> {
      // Prefer the live collaborative snapshot. Once a page goes live in
      // Yjs (a human opened it, or the AI patched it), `documents`
      // is authoritative and `saved_views.page` is frozen — reading the
      // legacy column would show the AI a stale page that ignores every
      // human edit. The LEFT JOIN + COALESCE falls back to the legacy
      // column for pages that have never been opened collaboratively. The
      // version becomes the Yjs `seq` when live (so the outline reflects
      // the merged state). See doc.md → "Real-time collaboration".
      const result = await queryWithRLS<VersionedPageRow>(
        userId,
        // `name_origin` + `icon` live only on `saved_views` (not the Yjs
        // snapshot), so they're read straight from `sv` — no COALESCE.
        // `name_origin` drives auto-title; `icon` seeds the `setIcon` op's
        // undo capture in `patchPage`.
        // `cd.seq` is a BIGINT, which node-postgres deserializes as a STRING —
        // unguarded it flows into `current.version + 1` in patchPage and
        // concatenates ("187" + 1 = "1871"), feeding the model garbage
        // versions. Cast to int so `version` is a JS number on both branches.
        `SELECT COALESCE(cd.snapshot_json, sv.page)   AS page,
                COALESCE(cd.seq::int, sv.version)     AS version,
                COALESCE(cd.snapshot_title, sv.name)  AS name,
                sv.name_origin                        AS "nameOrigin",
                sv.icon                               AS icon
           FROM saved_views sv
           LEFT JOIN documents cd ON cd.page_id = sv.id
          WHERE sv.id = $1`,
        [pageId],
      )
      const row = result.rows[0]
      if (!row) return null
      if (!row.page) {
        // A pre-doc-redesign row that's never been opened in the
        // editor — `page` JSONB is null. The chat tools treat this as
        // an empty page rather than not-found; surface the empty
        // structure here so callers don't special-case.
        return {
          page: { blocks: [] },
          version: row.version ?? 1,
          title: row.name ?? 'Untitled',
          nameOrigin: row.nameOrigin ?? 'placeholder',
          icon: row.icon ?? null,
        }
      }
      return {
        page: row.page,
        version: row.version,
        title: row.name ?? 'Untitled',
        nameOrigin: row.nameOrigin ?? 'placeholder',
        icon: row.icon ?? null,
      }
    },

    async applyPatch({ userId, pageId, expectedVersion, nextPage, undo }) {
      // Atomic compare-and-swap. The whole patch lands or none of it
      // does — Lock #8 in `docs/plans/doc-v1-execution.md`. The
      // `RETURNING version` projection lets us read the post-bump
      // value back without a second SELECT.
      const result = await queryWithRLS<{ version: number }>(
        userId,
        `UPDATE saved_views
            SET page       = $1::jsonb,
                version    = version + 1,
                last_undo  = $2::jsonb,
                updated_at = now()
          WHERE id = $3
            AND version = $4
          RETURNING version`,
        [
          JSON.stringify(nextPage),
          JSON.stringify(undo),
          pageId,
          expectedVersion,
        ],
      )
      if (result.rows.length === 0) return null
      return { newVersion: result.rows[0].version }
    },
  }
}
