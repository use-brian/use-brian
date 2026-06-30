/**
 * gatherGoalEvidence — read-only host snapshot for the agentic verifier (§12).
 *
 * Before `markGoalComplete` asks the adversarial verifier to disprove a
 * completion claim, we hand it a concise, READ-ONLY snapshot of the goal's host
 * so it judges the claim against reality, not just the agent's self-report. The
 * verifier's `evidence` field has always existed; this is what populates it.
 *
 *   - `task`  host: the LIVE task row (title / status / due), followed through
 *     the bi-temporal supersession chain exactly like writeback's `hostTaskDone`
 *     resolver — `updateTask` mints a new id on every edit (incl. the close), so
 *     a direct id lookup would miss the current row.
 *   - `entity` / `page` / `workflow` host: the row's key identifying fields.
 *   - self-hosted (host `null`): the open sub-goal count (its acceptance source).
 *
 * Strictly best-effort and READ-ONLY: any error — or an unwired host type —
 * resolves to `undefined` (no evidence). It must NEVER throw or block the verify
 * path. Absent evidence simply means the verifier judges on the claim alone,
 * exactly as it did before this seam existed (and the verifier stays
 * FAIL-CLOSED regardless).
 */
import type { GoalRecord } from '@sidanclaw/core'
import { query } from '../db/client.js'
import { countOpenSubGoalsSystem } from '../db/goals.js'

/** Keep a host-supplied label short so the evidence line stays compact. */
function clip(s: string, max = 160): string {
  const t = s.trim()
  return t.length > max ? `${t.slice(0, max - 1)}...` : t
}

export async function gatherGoalEvidence(goal: GoalRecord): Promise<string | undefined> {
  try {
    const host = goal.host
    if (!host) {
      // Self-hosted: acceptance is "no open sub-goals". Report the live count.
      const open = await countOpenSubGoalsSystem(goal.id)
      return open === 0
        ? 'Self-hosted goal: 0 open sub-goals remaining (all sub-goals closed).'
        : `Self-hosted goal: ${open} open sub-goal(s) still remaining.`
    }
    switch (host.type) {
      case 'task': {
        // Follow the supersession chain to the LIVE row (same CTE as the
        // `hostTaskDone` resolver in writeback.ts).
        const res = await query<{ title: string; status: string; due: Date | null }>(
          `WITH RECURSIVE chain AS (
             SELECT id, title, status, due, valid_to, superseded_by FROM tasks WHERE id = $1
             UNION ALL
             SELECT t.id, t.title, t.status, t.due, t.valid_to, t.superseded_by
               FROM tasks t JOIN chain ch ON t.id = ch.superseded_by
           )
           SELECT title, status, due FROM chain WHERE valid_to IS NULL LIMIT 1`,
          [host.id],
        )
        const row = res.rows[0]
        if (!row) return `Host task ${host.id}: not found (deleted or never created).`
        const due = row.due ? new Date(row.due).toISOString().slice(0, 10) : 'none'
        return `Host task "${clip(row.title)}": status=${row.status}; due=${due}.`
      }
      case 'entity': {
        const res = await query<{ displayName: string | null; kind: string }>(
          `SELECT display_name AS "displayName", kind FROM entities WHERE id = $1 LIMIT 1`,
          [host.id],
        )
        const row = res.rows[0]
        if (!row) return `Host entity ${host.id}: not found.`
        return `Host entity "${clip(row.displayName ?? '(unnamed)')}" (kind=${row.kind}).`
      }
      case 'page': {
        const res = await query<{ name: string | null; viewType: string | null }>(
          `SELECT name, view_type AS "viewType" FROM saved_views WHERE id = $1 LIMIT 1`,
          [host.id],
        )
        const row = res.rows[0]
        if (!row) return `Host page ${host.id}: not found.`
        return `Host page "${clip(row.name ?? '(untitled)')}"${row.viewType ? ` (type=${row.viewType})` : ''}.`
      }
      case 'workflow': {
        const res = await query<{ name: string | null; enabled: boolean }>(
          `SELECT name, enabled FROM workflows WHERE id = $1 LIMIT 1`,
          [host.id],
        )
        const row = res.rows[0]
        if (!row) return `Host workflow ${host.id}: not found.`
        return `Host workflow "${clip(row.name ?? '(unnamed)')}" (enabled=${row.enabled}).`
      }
      default:
        // Host union widened (additive) without an evidence reader — fail-soft.
        return undefined
    }
  } catch (err) {
    // Fail-soft — evidence is an optional verifier aid; never block the verify path.
    console.error('[goal-evidence] gather failed; proceeding without evidence:', err)
    return undefined
  }
}
