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

import type { DocPageRead, DocPageStore } from '@use-brian/core/doc/tools.js'
import type { Page } from '@use-brian/core/views/blocks.js'
import type { NameOrigin } from '@use-brian/core/views/types.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { ToolContext } from '@use-brian/agent-runtime/tools/types.js'
import { readCurrentPageReceipt } from '../application-platform/conversation-evidence.js'
import { assertScopeEvidenceFitsCeiling, validateCallerScopeEvidence, validateAudienceScopeEvidence } from '../context-scope/caller-evidence.js'
import { nativeSourceAssistant } from '../context-scope/native-invocation-evidence.js'
import { runWithAgentAccess } from './agent-access-context.js'
import { queryWithRLS, withRLSTransaction } from './client.js'
import { readPageThreadAudienceAuthority } from '../context-scope/page-thread-audience.js'

// ── Row projections ────────────────────────────────────────────────────

type VersionedPageRow = {
  collaborative?: boolean
  pageRevision?: string
  source?: (ScopeSource & { requiredSources: ScopeSource[] }) | null
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
    async getVersionedPage(userId, pageId, context?: ToolContext): Promise<DocPageRead | null> {
      // Prefer the live collaborative snapshot. Once a page goes live in
      // Yjs (a human opened it, or the AI patched it), `documents`
      // is authoritative and `saved_views.page` is frozen — reading the
      // legacy column would show the AI a stale page that ignores every
      // human edit. The LEFT JOIN + COALESCE falls back to the legacy
      // column for pages that have never been opened collaboratively. The
      // version becomes the Yjs `seq` when live (so the outline reflects
      // the merged state). See doc.md → "Real-time collaboration".
      const execution = context?.executionContext
      if (execution) {
        if (execution.security.ceiling.userId !== userId || !context?.scopeAccumulator) throw new Error('page_source_authority_required')
        await execution.security.authority.assertCurrent()
      }
      const nativeAssistantId = execution && nativeSourceAssistant(execution)
      const readSql =
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
                cd.page_id IS NOT NULL                AS collaborative,
                COALESCE(cd.snapshot_title, sv.name)  AS name,
                sv.name_origin                        AS "nameOrigin",
                sv.icon                               AS icon
                ${execution ? ',sv.page_event_revision AS "pageRevision"' : ''}
                ${execution && !nativeAssistantId ? ",read_entity_derivation_source(sv.workspace_id,'page_event_changed',sv.page_event_revision) AS source" : ''}
           FROM saved_views sv
           LEFT JOIN documents cd ON cd.page_id = sv.id
          WHERE sv.id = $1${nativeAssistantId ? ' AND sv.workspace_id = $2' : ''}`
      const read = () => queryWithRLS<VersionedPageRow>(userId, readSql, [pageId])
      let row: VersionedPageRow | undefined
      if (execution && nativeAssistantId) {
        const { access, ceiling, authority } = execution.security
        const outcome = await runWithAgentAccess(access, () => withRLSTransaction(userId, async client => {
          const selected = (await client.query<VersionedPageRow>(readSql, [pageId, access.workspaceId])).rows[0]
          if (!selected) return null
          if (!selected.pageRevision) throw new Error('page_source_unavailable')
          const evidence = await readCurrentPageReceipt(client, access.workspaceId, selected.pageRevision, userId)
          return { row: selected, revision: selected.pageRevision, evidence }
        }, nativeAssistantId))
        if (!outcome) return null
        let evidence = outcome.evidence
        if (access.sharedAudience && (!evidence || evidence.sources?.some(source => source.userId !== null))) {
          // The private Page's own discussion has its distinct principal.
          // Its owner runs after the app transaction releases Page locks.
          const proof = await readPageThreadAudienceAuthority(access.workspaceId,
            { resourceKind: 'page_event_changed', resourceId: outcome.revision },
            { sessionId: execution.lifecycle.sessionId, actorUserId: userId })
          evidence = proof?.source ? { sources: [proof.source, ...proof.requiredSources] } : null
        }
        if (!evidence) throw new Error('page_source_unavailable')
        assertScopeEvidenceFitsCeiling(evidence, ceiling, 'caller')
        await authority.assertCurrent()
        context!.scopeAccumulator!.note(evidence)
        row = outcome.row
      } else {
        row = (execution ? await runWithAgentAccess(execution.security.access, read) : await read()).rows[0]
      }
      if (!row) return null
      if (execution && !nativeAssistantId) {
        // A private Page can have its own Page-gated discussion. Prove that
        // exact destination with the original actor before admitting its receipt;
        // the generic shared entity reader intentionally refuses private roots.
        if (!row.source && execution.security.access.sharedAudience && row.pageRevision) {
          const proof = await readPageThreadAudienceAuthority(execution.security.access.workspaceId,
            { resourceKind:'page_event_changed',resourceId:row.pageRevision },
            { sessionId:execution.lifecycle.sessionId,actorUserId:userId })
          if (!proof?.source) throw new Error('page_source_unavailable')
          row.source = { ...proof.source,requiredSources:proof.requiredSources }
        }
        if (!row.source || !Array.isArray(row.source.requiredSources)) throw new Error('page_source_unavailable')
        const { requiredSources, ...source } = row.source
        const evidence = { sources: [source, ...requiredSources] }
        if (execution.security.access.sharedAudience && evidence.sources.some(value => value.userId !== null
          && !['page_event_changed','page_event_destination','page_live_changed','page_live_destination'].includes(value.resourceKind))) throw new Error('page_source_unavailable')
        const checked = await validateCallerScopeEvidence(evidence, execution.security.ceiling)
        await validateAudienceScopeEvidence(checked, execution.security.ceiling)
        await execution.security.authority.assertCurrent()
        context!.scopeAccumulator!.note(checked)
      }
      if (!row.page) {
        // A pre-doc-redesign row that's never been opened in the
        // editor — `page` JSONB is null. The chat tools treat this as
        // an empty page rather than not-found; surface the empty
        // structure here so callers don't special-case.
        return {
          ...(row.collaborative && { collaborative: true as const }),
          page: { blocks: [] },
          version: row.version ?? 1,
          title: row.name ?? 'Untitled',
          nameOrigin: row.nameOrigin ?? 'placeholder',
          icon: row.icon ?? null,
        }
      }
      return {
        ...(row.collaborative && { collaborative: true as const }),
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
