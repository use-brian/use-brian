/**
 * workspace_brain_evolution — aggregated cross-primitive correction
 * signals per workspace (migration 179). Sibling of
 * workspace_memory_evolution; this one closes the loop for entities /
 * edges / tasks / CRM rows / files via the `brain_verifications` event
 * stream (mig 174).
 *
 * Headline signal: per-primitive delete rate over the 30-day window.
 * A high delete rate is "the model is creating things the user doesn't
 * want" — bias future model behaviour via a Layer 2 snippet.
 *
 * [COMP:api/workspace-brain-evolution-store]
 */

import { query } from './client.js'

export type PrimitiveDeleteStat = {
  deleteRate: number
  sampleSize: number
}

export type WorkspaceBrainEvolution = {
  workspaceId: string
  rates: Record<string, PrimitiveDeleteStat>
  promptSnippet: string | null
  promptSnippetVersion: number
  lastAggregatedAt: Date | null
  updatedAt: Date
}

const SELECT_CLAUSE = `
  workspace_id           as "workspaceId",
  rates,
  prompt_snippet         as "promptSnippet",
  prompt_snippet_version as "promptSnippetVersion",
  last_aggregated_at     as "lastAggregatedAt",
  updated_at             as "updatedAt"
`

/**
 * Read the current evolution row for a workspace. Returns `null` when
 * no row exists yet (workspace has never crossed the worker's
 * significance threshold). System-bypass — called from the prompt
 * builder, which needs workspace-level data regardless of acting user.
 */
export async function getBrainEvolution(
  workspaceId: string,
): Promise<WorkspaceBrainEvolution | null> {
  const result = await query<WorkspaceBrainEvolution>(
    `SELECT ${SELECT_CLAUSE} FROM workspace_brain_evolution
     WHERE workspace_id = $1`,
    [workspaceId],
  )
  return result.rows[0] ?? null
}

export type UpsertBrainEvolutionParams = {
  workspaceId: string
  rates: Record<string, PrimitiveDeleteStat>
  promptSnippet: string | null
}

/**
 * Idempotent upsert from the worker. Bumps `prompt_snippet_version`
 * only when the snippet text actually changes.
 */
export async function upsertBrainEvolution(
  params: UpsertBrainEvolutionParams,
): Promise<void> {
  await query(
    `INSERT INTO workspace_brain_evolution (
       workspace_id,
       rates,
       prompt_snippet, prompt_snippet_version,
       last_aggregated_at, updated_at
     )
     VALUES (
       $1,
       $2::jsonb,
       $3::text, CASE WHEN $3::text IS NULL THEN 0 ELSE 1 END,
       now(), now()
     )
     ON CONFLICT (workspace_id) DO UPDATE SET
       rates              = EXCLUDED.rates,
       prompt_snippet     = EXCLUDED.prompt_snippet,
       prompt_snippet_version =
         CASE
           WHEN workspace_brain_evolution.prompt_snippet IS NOT DISTINCT FROM EXCLUDED.prompt_snippet
             THEN workspace_brain_evolution.prompt_snippet_version
           ELSE workspace_brain_evolution.prompt_snippet_version + 1
         END,
       last_aggregated_at = now(),
       updated_at         = now()`,
    [
      params.workspaceId,
      JSON.stringify(params.rates),
      params.promptSnippet,
    ],
  )
}

/**
 * Per-workspace per-primitive aggregation over a rolling window.
 *
 * Counts:
 *   - `confirms` = brain_verifications.action='confirm'
 *   - `deletes`  = brain_verifications.action='delete'
 *
 * Adjustments (`adjust_*` / `edit_*`) are tracked separately in the
 * future; for v1 we only use the confirm/delete axis because that's
 * the clearest "model was right vs. model was wrong" signal across
 * primitives.
 */
export type PrimitiveCorrectionCounts = {
  primitive: string
  confirms: number
  deletes: number
}

export async function countCorrectionsByPrimitive(
  workspaceId: string,
  windowDays: number,
): Promise<PrimitiveCorrectionCounts[]> {
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const result = await query<{
    primitive: string
    confirms: string
    deletes: string
  }>(
    `SELECT target_kind AS primitive,
            count(*) FILTER (WHERE action = 'confirm')::text AS confirms,
            count(*) FILTER (WHERE action = 'delete')::text  AS deletes
     FROM brain_verifications
     WHERE workspace_id = $1
       AND created_at >= $2
     GROUP BY target_kind`,
    [workspaceId, since],
  )
  return result.rows.map((r) => ({
    primitive: r.primitive,
    confirms: Number(r.confirms),
    deletes: Number(r.deletes),
  }))
}

/**
 * Enumerate workspaces that have any brain_verifications activity in
 * the window. The worker scans only these — workspaces with no
 * signal don't burn cycles.
 */
export async function listActiveWorkspaces(
  windowDays: number,
): Promise<string[]> {
  const since = new Date(Date.now() - windowDays * 86_400_000)
  const result = await query<{ workspaceId: string }>(
    `SELECT DISTINCT workspace_id AS "workspaceId"
     FROM brain_verifications
     WHERE created_at >= $1`,
    [since],
  )
  return result.rows.map((r) => r.workspaceId)
}
