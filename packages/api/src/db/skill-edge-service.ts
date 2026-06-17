/**
 * Skill edge recompute service — the `onWritten` adapter that wires every
 * skill write (`create` / `update`) into the graph
 * (`docs/plans/skills-as-procedural-brain-primitive.md` §5.1, §5.4, §6).
 *
 * `makeSkillEdgeRecomputer` closes over the workspace stores and returns a
 * function compatible with `WorkspaceSkillStoreHooks.onWritten`. Given a
 * freshly-written `WorkspaceSkill` it:
 *
 *   1. Resolves the workspace's connector instances → `{ id, provider }`.
 *   2. Validates the skill's explicit `kind:uuid` references against the live
 *      `entities` / `memories` / `kb_chunks` rows (existence + liveness),
 *      returning each surviving id with its `sensitivity`. Dangling ids are
 *      dropped (zero-inference, self-healing on edit).
 *   3. Calls `recomputeSkillEdges` (diff + materialize `references_entity` /
 *      `requires_connector` edges, bi-temporally closing removed ones).
 *   4. Applies the edge-derived sensitivity inheritance via
 *      `setInheritedSensitivity` (a no-op when the author overrode it).
 *
 * RLS actor: `recomputeSkillEdges` writes `entity_links` rows under a workspace
 * member. We prefer `skill.authorId`; for an auto-induced skill with a null
 * author we fall back to any workspace member (the same shape the curator-scope
 * writers rely on). If neither resolves, edge recompute is skipped + logged —
 * never let the skill write break.
 *
 * Fire-and-forget by contract: the caller (`fireOnWritten` in `skill-store.ts`)
 * never awaits us and swallows any rejection, but we also defend in depth here.
 *
 * [COMP:api/skill-edge-service]
 */

import { query } from './client.js'
import { recomputeSkillEdges, type SkillEdgeReferenceTarget } from './skill-edge-hooks.js'
import type { EntityLinksStore, Sensitivity } from '@sidanclaw/core'
import type { ConnectorInstanceStore } from './connector-instance-store.js'
import type { WorkspaceSkillStore, WorkspaceSkill } from './skill-store.js'

export type SkillEdgeRecomputerDeps = {
  entityLinks: EntityLinksStore
  connectorInstanceStore: ConnectorInstanceStore
  /** Late-bindable so app boot can construct the store, then the recomputer
   *  closing over it (the recomputer only reads the ref when `onWritten` fires,
   *  long after boot wiring is complete). */
  workspaceSkillStore: WorkspaceSkillStore
}

const VALID_SENSITIVITY = new Set<Sensitivity>(['public', 'internal', 'confidential'])

function coerceSensitivity(value: unknown): Sensitivity {
  return typeof value === 'string' && VALID_SENSITIVITY.has(value as Sensitivity)
    ? (value as Sensitivity)
    : 'internal'
}

/**
 * Validate one reference table: keep only ids that exist + are bi-temporally
 * live in the workspace, returning each with its `sensitivity`. `kb_chunks`,
 * `entities`, and `memories` all carry `id` + `sensitivity` + `workspace_id` +
 * `valid_to` directly (verified against migrations 125 / 065 / 132), so a
 * single existence query covers each — no parent-entry hop needed for kb_chunks.
 * System-level read (no acting user): a background induction write may have no
 * per-user RLS principal, and we only return ids + sensitivity (no content).
 */
async function resolveOneKind(
  table: 'entities' | 'memories' | 'kb_chunks',
  kind: SkillEdgeReferenceTarget['kind'],
  workspaceId: string,
  ids: string[],
): Promise<SkillEdgeReferenceTarget[]> {
  if (ids.length === 0) return []
  const result = await query<{ id: string; sensitivity: string }>(
    `SELECT id, sensitivity FROM ${table}
     WHERE workspace_id = $1 AND id = ANY($2::uuid[]) AND valid_to IS NULL`,
    [workspaceId, ids],
  )
  return result.rows.map((r) => ({ kind, id: r.id, sensitivity: coerceSensitivity(r.sensitivity) }))
}

/**
 * Resolve an RLS actor for the edge recompute. Prefer the skill author; for an
 * author-less auto-induced skill, fall back to any workspace member. Returns
 * null when even the fallback finds nothing (edge recompute is then skipped).
 */
async function resolveActorUserId(skill: WorkspaceSkill): Promise<string | null> {
  if (skill.authorId) return skill.authorId
  const result = await query<{ user_id: string }>(
    `SELECT user_id FROM workspace_members
     WHERE workspace_id = $1
     ORDER BY joined_at ASC
     LIMIT 1`,
    [skill.workspaceId],
  )
  return result.rows[0]?.user_id ?? null
}

export function makeSkillEdgeRecomputer(
  deps: SkillEdgeRecomputerDeps,
): (skill: WorkspaceSkill) => Promise<void> {
  return async (skill: WorkspaceSkill): Promise<void> => {
    try {
      const actorUserId = await resolveActorUserId(skill)
      if (!actorUserId) {
        console.warn(
          `[skill-edge-service] no workspace member to act as RLS principal ` +
            `(skill=${skill.rowId} workspace=${skill.workspaceId}); skipping edge recompute`,
        )
        return
      }

      const result = await recomputeSkillEdges(
        {
          entityLinks: deps.entityLinks,
          listConnectors: async (workspaceId) => {
            const instances = await deps.connectorInstanceStore.listByWorkspaceSystem(workspaceId)
            return instances.map((c) => ({ id: c.id, provider: c.provider }))
          },
          resolveReferenceTargets: async (workspaceId, refs) => {
            const [entities, memories, kbChunks] = await Promise.all([
              resolveOneKind('entities', 'entity', workspaceId, refs.entity),
              resolveOneKind('memories', 'memory', workspaceId, refs.memory),
              resolveOneKind('kb_chunks', 'kb_chunk', workspaceId, refs.kb_chunk),
            ])
            return [...entities, ...memories, ...kbChunks]
          },
        },
        {
          skillRowId: skill.rowId,
          workspaceId: skill.workspaceId,
          content: skill.content,
          requiresConnectors: skill.requiresConnectors,
          actorUserId,
          // Provenance on the materialized edges. Author-derived edges are
          // 'user'; system/auto-induced writes (no author) are 'extracted'.
          source: skill.authorId ? 'user' : 'extracted',
          userId: skill.authorId ?? null,
          assistantId: skill.originatingAssistantId ?? null,
        },
      )

      // Apply edge-derived sensitivity inheritance. No-op when the author
      // overrode sensitivity (`setInheritedSensitivity` guards on the column).
      await deps.workspaceSkillStore.setInheritedSensitivity(skill.rowId, result.inheritedSensitivity)
    } catch (err) {
      console.error(`[skill-edge-service] recompute failed (skill=${skill.rowId}):`, err)
    }
  }
}
