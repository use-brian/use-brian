/**
 * `workspace-viewpoint.ts` — resolve a member's read viewpoint on a workspace.
 *
 * Extracted verbatim from `routes/brain.ts`, where it was a private helper, so a
 * second caller (the recordings transcript route) can reuse it INSTEAD OF
 * reimplementing it. That distinction matters: this is a security predicate with
 * incident history baked in (see the read-side clearance note below — incident
 * 2026-06-01), and a security predicate that gets retyped is a security
 * predicate that drifts. One definition, every caller.
 *
 * Any route that reads brain-scoped rows on behalf of a MEMBER needs this. The
 * alternative — passing no clearance — means "passthrough (system callers)" to
 * the retrieval store, which silently bypasses the sensitivity ceiling.
 *
 * [COMP:brain/workspace-viewpoint]
 */

import type { AccessContext, Sensitivity } from '@use-brian/core'
import { query } from './client.js'
import { effectiveReadClearance, effectiveReadCompartments } from './workspace-store.js'

/**
 * Resolve the (clearance, assistantId) used for this user's view of a
 * workspace. Workspace membership is the access gate; the clearance
 * ceiling is then resolved in two stages:
 *
 *   1. If `selectedAssistantId` is provided AND that assistant belongs
 *      to this workspace, use its clearance — this is what powers the
 *      floating-pill picker on the brain page so the user can cap the
 *      surface at the selected assistant's level (e.g. picking a
 *      `public` assistant hides internal/confidential rows).
 *   2. Otherwise fall back to the highest-clearance assistant in the
 *      workspace — the historical behaviour for unscoped callers.
 *
 * The viewpoint stays under the reflector branch (`assistantKind =
 * 'primary'`, synthetic all-zeros assistantId) so the assistant_id
 * partition is dropped and the user sees every assistant's rows in the
 * workspace — just bounded by the ceiling. Returns null when the user
 * isn't a workspace member.
 *
 * Cross-workspace race: a stale `selectedAssistantId` that doesn't match
 * any assistant in this workspace is treated as absent (falls back to
 * the workspace-wide ceiling), not an error — workspace switches don't
 * 500 while localStorage catches up.
 */
export async function resolveWorkspaceViewpoint(
  userId: string,
  workspaceId: string,
  selectedAssistantId?: string | null,
): Promise<AccessContext | null> {
  const membership = await query<{
    role: 'owner' | 'admin' | 'member'
    clearance: Sensitivity
    compartments: string[] | null
  }>(
    `SELECT role, clearance, compartments FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  )
  if (membership.rows.length === 0) return null
  const member = membership.rows[0]

  // Stage 1: honour an explicit selection if it's in this workspace.
  let clearance: Sensitivity | null = null
  let viewpointId: string | null = null
  if (selectedAssistantId) {
    const selected = await query<{ id: string; clearance: Sensitivity }>(
      `SELECT id, clearance
         FROM assistants
        WHERE id = $1 AND workspace_id = $2
        LIMIT 1`,
      [selectedAssistantId, workspaceId],
    )
    if (selected.rows[0]) {
      viewpointId = selected.rows[0].id
      clearance = selected.rows[0].clearance
    }
  }

  // Stage 2: fall back to the highest-clearance assistant in the
  // workspace. Membership is verified above; under the workspace model
  // every member can reach all of a workspace's assistants (RLS:
  // owner_user_id = me OR workspace_id IN my workspaces), so the pick
  // is workspace-scoped, NOT owner-scoped. Filtering on owner_user_id
  // was wrong: migration 110 §8g creates kind='primary' assistants with
  // owner_user_id NULL, so an owner filter silently excludes them and
  // the brain view degrades to the empty all-zeros assistant id.
  // Order: restricted > confidential > internal > public.
  if (clearance === null) {
    const assistant = await query<{ id: string; clearance: Sensitivity }>(
      `SELECT id, clearance
         FROM assistants
        WHERE workspace_id = $1
        ORDER BY CASE clearance
                   WHEN 'restricted'   THEN 4
                   WHEN 'confidential' THEN 3
                   WHEN 'internal'     THEN 2
                   WHEN 'public'       THEN 1
                   ELSE 0
                 END DESC
        LIMIT 1`,
      [workspaceId],
    )
    const row = assistant.rows[0]
    viewpointId = row?.id ?? null
    clearance = row?.clearance ?? 'internal'
  }

  // Workspace brain explorer is a reflector surface — set assistantKind
  // = 'primary' so the universal predicate drops the assistant_id
  // partition and the view spans every assistant's rows. The synthetic
  // assistantId is non-functional under the primary branch.
  //
  // Read-side clearance (incident 2026-06-01): the clearance resolved above
  // is an *assistant*-derived ceiling (the selected, or the workspace's
  // highest-clearance, assistant). Bound it by the acting member's clearance
  // so a low-clearance member browsing the brain can't read above their tier.
  // Reuse the membership row already fetched above — no extra query.
  const readClearance = effectiveReadClearance(member.role, member.clearance, clearance)
  // Compartment ceiling: the brain explorer is a primary reflector (universe
  // assistant grant), so the effective grant is the member's own
  // (`member ∩ universe`). A compartment-restricted member browsing the brain
  // is bounded to their compartments; an owner/admin is universe.
  const readCompartments = effectiveReadCompartments(member.role, member.compartments, null)
  return {
    workspaceId,
    userId,
    assistantId: viewpointId ?? '00000000-0000-0000-0000-000000000000',
    assistantKind: 'primary',
    clearance: readClearance,
    compartments: readCompartments,
  }
}
