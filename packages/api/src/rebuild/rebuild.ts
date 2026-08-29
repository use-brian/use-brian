/**
 * Retroactive rebuild — the probe → confirm → shadow-derive → diff →
 * promote flow (plan §6, THE product bet: when a better model or
 * extraction pipeline ships, re-derive a workspace's brain from its
 * retained episode history; the moat compounds on model progress, not
 * just usage time).
 *
 * The flow is the preflight-confirmation contract
 * (docs/architecture/engine/preflight-confirmation.md): `probeRebuild`
 * is CHEAP (a count and an estimate — never the extraction itself),
 * derivation refuses to start without an explicit `confirmRebuildRun`,
 * and the expensive work lands in a shadow namespace the live brain
 * cannot see until an explicit, atomic, reversible promote.
 *
 * Extraction is a PORT (`RebuildExtractor`): production wires
 * `createPipelineBShadowDeps` (pipeline-b-extractor.ts) so the same
 * Pipeline B that derived the brain the first time re-derives it at the
 * new version; tests inject a fake. The flow does not know or care.
 *
 * Spec: docs/architecture/brain/retroactive-rebuild.md
 * [COMP:api/rebuild-flow]
 */

import { query } from '../db/client.js'
import {
  computeRebuildDiff,
  confirmRebuildRun,
  createRebuildRun,
  getRebuildRun,
  promoteRebuildRun,
  setRebuildStatus,
  updateRebuildProgress,
  type RebuildRun,
} from './rebuild-store.js'

export {
  confirmRebuildRun,
  promoteRebuildRun,
  cancelRebuildRun,
  getRebuildRun,
} from './rebuild-store.js'

/**
 * Placeholder average until the first dogfood rebuild produces a
 * measured number (plan §13.1 — the surcharge multiplier is founder-open
 * pending real COGS). The probe labels its output an estimate; this
 * constant is the only thing the measurement will replace.
 */
export const EST_TOKENS_PER_EPISODE = 3000

export type RebuildEpisodeRef = {
  id: string
  sourceKind: string
  workspaceId: string
  userId: string | null
  assistantId: string | null
  createdByUserId: string | null
}

/**
 * Derive one episode into the shadow namespace. Returns how many shadow
 * memories it wrote. Production: Pipeline B with a shadow-writing deps
 * override; tests: a fake.
 */
export type RebuildExtractor = (episode: RebuildEpisodeRef, run: RebuildRun) => Promise<{ written: number }>

/**
 * The cheap pre-flight (never the work itself): how many episodes would
 * re-derive, and a labelled token estimate. Locked episodes
 * (`extraction_locked`, the erasure override) are excluded — erased
 * content must never be re-derived.
 */
export async function probeRebuild(params: {
  workspaceId: string
  targetPipelineVersion: number
  createdByUserId?: string
}): Promise<RebuildRun> {
  const count = await query<{ n: string }>(
    `SELECT count(*) AS n FROM episodes
      WHERE workspace_id = $1 AND extraction_locked = FALSE`,
    [params.workspaceId],
  )
  const episodeCount = Number(count.rows[0]?.n ?? 0)
  return createRebuildRun({
    workspaceId: params.workspaceId,
    targetPipelineVersion: params.targetPipelineVersion,
    createdByUserId: params.createdByUserId,
    probe: {
      episodeCount,
      estimatedTokens: episodeCount * EST_TOKENS_PER_EPISODE,
      estimateBasis: `episodeCount x ${EST_TOKENS_PER_EPISODE} (placeholder average pending measured COGS)`,
    },
  })
}

/**
 * Walk the workspace's episodes through the extractor into the shadow
 * namespace. Requires an explicitly CONFIRMED run — the preflight gate;
 * a probed-but-unconfirmed run refuses. Batched, with progress persisted
 * per batch so an operator can watch the run row.
 */
export async function deriveShadow(params: {
  runId: string
  extract: RebuildExtractor
  batchSize?: number
}): Promise<RebuildRun> {
  const batchSize = params.batchSize ?? 25
  const started = await setRebuildStatus(params.runId, 'confirmed', 'deriving')
  if (!started) {
    const run = await getRebuildRun(params.runId)
    throw new Error(
      `rebuild ${params.runId} is ${run?.status ?? 'missing'} — derivation requires an explicitly confirmed run (preflight gate)`,
    )
  }

  let processed = 0
  let written = 0
  try {
    let lastCreatedAt: Date | null = null
    let lastId: string | null = null
    for (;;) {
      const page = await query(
        `SELECT id, source_kind, workspace_id, user_id, assistant_id, created_by_user_id, created_at
           FROM episodes
          WHERE workspace_id = $1 AND extraction_locked = FALSE
            AND ($2::timestamptz IS NULL OR (created_at, id) > ($2, $3::uuid))
          ORDER BY created_at ASC, id ASC
          LIMIT $4`,
        [started.workspaceId, lastCreatedAt, lastId, batchSize],
      )
      if (page.rows.length === 0) break
      for (const r of page.rows) {
        const out = await params.extract(
          {
            id: r.id as string,
            sourceKind: r.source_kind as string,
            workspaceId: r.workspace_id as string,
            userId: (r.user_id as string | null) ?? null,
            assistantId: (r.assistant_id as string | null) ?? null,
            createdByUserId: (r.created_by_user_id as string | null) ?? null,
          },
          started,
        )
        processed += 1
        written += out.written
      }
      const tail = page.rows[page.rows.length - 1]
      lastCreatedAt = tail.created_at as Date
      lastId = tail.id as string
      await updateRebuildProgress(params.runId, { processed, written })
    }
  } catch (err) {
    await setRebuildStatus(params.runId, 'deriving', 'failed', {
      progress: { processed, written },
      error: err instanceof Error ? err.message : String(err),
    })
    throw err
  }

  const run = (await getRebuildRun(params.runId))!
  const diff = await computeRebuildDiff(run)
  const done = await setRebuildStatus(params.runId, 'deriving', 'derived', {
    progress: { processed, written },
    diff,
  })
  return done ?? run
}
