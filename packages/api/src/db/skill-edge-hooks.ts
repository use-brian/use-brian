import type {
  AccessContext,
  EdgeType,
  EntityLinksStore,
  EntitySource,
  LinkKind,
  Sensitivity,
} from '@sidanclaw/core'
import { parseSkillReferences } from '@sidanclaw/core'

/**
 * Skill edge derivation (`docs/architecture/engine/skill-system.md` §6).
 *
 * Materializes a skill's DERIVED-FROM-FACTS edges in `entity_links` and keeps
 * them self-healing on every skill edit:
 *
 *   skill → entity|memory|kb_chunk   `references_entity`   (explicit @-mentions in content)
 *   skill → connector                 `requires_connector`  (from requires_connectors)
 *
 * `learned_from` (induction provenance) is emitted at induction time (Phase 6),
 * not here; `refines` (memory → skill) is emitted from the memory side.
 *
 * Mirrors edge-hooks.ts's fire-and-forget contract: the skill row is the source
 * of truth; an edge failure logs and never throws back into the skill save.
 *
 * [COMP:api/skill-edge-hooks]
 */

const DERIVED_EDGE_TYPES = ['references_entity', 'requires_connector'] as const satisfies readonly EdgeType[]

const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 1, internal: 2, confidential: 3 }

export type SkillEdgeConnector = { id: string; provider: string }

export type SkillEdgeReferenceTarget = {
  kind: 'entity' | 'memory' | 'kb_chunk'
  id: string
  sensitivity: Sensitivity
}

export type RecomputeSkillEdgesDeps = {
  entityLinks: EntityLinksStore
  /** Workspace connector instances (system-level). */
  listConnectors: (workspaceId: string) => Promise<SkillEdgeConnector[]>
  /**
   * Validate which parsed references actually exist in the workspace and return
   * each one's sensitivity. References not returned are dropped — no dangling
   * edges, zero-inference, self-protecting.
   */
  resolveReferenceTargets: (
    workspaceId: string,
    refs: { entity: string[]; memory: string[]; kb_chunk: string[] },
  ) => Promise<SkillEdgeReferenceTarget[]>
}

export type RecomputeSkillEdgesParams = {
  /** workspace_skills.id — the `('skill', id)` graph node. */
  skillRowId: string
  workspaceId: string
  content: string
  requiresConnectors: readonly string[]
  /** RLS actor; must be a workspace member. */
  actorUserId: string
  source: EntitySource
  userId?: string | null
  assistantId?: string | null
}

export type RecomputeSkillEdgesResult = {
  created: number
  closed: number
  /** Max sensitivity across resolved references; 'internal' when none. The
   *  caller applies this to workspace_skills.sensitivity unless overridden. */
  inheritedSensitivity: Sensitivity
}

function maxSensitivity(values: readonly Sensitivity[]): Sensitivity {
  if (values.length === 0) return 'internal'
  let best: Sensitivity = 'public'
  for (const v of values) if (SENSITIVITY_RANK[v] > SENSITIVITY_RANK[best]) best = v
  return best
}

/**
 * Recompute (diff + materialize) a skill's derived edges. Idempotent: creates
 * edges in the desired set that aren't present, bi-temporally closes ones that
 * are no longer desired (self-heal on edit). Never throws.
 */
export async function recomputeSkillEdges(
  deps: RecomputeSkillEdgesDeps,
  params: RecomputeSkillEdgesParams,
): Promise<RecomputeSkillEdgesResult> {
  const { skillRowId, workspaceId, content, requiresConnectors, actorUserId, source } = params
  const ctx: AccessContext = {
    userId: actorUserId,
    workspaceId,
    assistantId: params.assistantId ?? '',
    assistantKind: 'standard',
  }

  // ── Desired set ──────────────────────────────────────────────────
  const desired: Array<{ targetKind: LinkKind; targetId: string; edgeType: EdgeType }> = []
  const refSensitivities: Sensitivity[] = []
  try {
    const refs = parseSkillReferences(content)
    if (refs.entity.length || refs.memory.length || refs.kb_chunk.length) {
      const resolved = await deps.resolveReferenceTargets(workspaceId, refs)
      for (const r of resolved) {
        desired.push({ targetKind: r.kind, targetId: r.id, edgeType: 'references_entity' })
        refSensitivities.push(r.sensitivity)
      }
    }
  } catch (err) {
    console.error(`[skill-edge-hooks] reference resolution failed (skill=${skillRowId}):`, err)
  }
  try {
    if (requiresConnectors.length) {
      const wanted = new Set(requiresConnectors.map((p) => p.toLowerCase()))
      const connectors = await deps.listConnectors(workspaceId)
      for (const c of connectors) {
        if (wanted.has(c.provider.toLowerCase())) {
          desired.push({ targetKind: 'connector', targetId: c.id, edgeType: 'requires_connector' })
        }
      }
    }
  } catch (err) {
    console.error(`[skill-edge-hooks] connector resolution failed (skill=${skillRowId}):`, err)
  }

  const inheritedSensitivity = maxSensitivity(refSensitivities)

  // ── Existing derived edges ───────────────────────────────────────
  let existing: Awaited<ReturnType<EntityLinksStore['walkOutbound']>> = []
  try {
    existing = await deps.entityLinks.walkOutbound(ctx, 'skill', skillRowId, {
      edgeTypes: DERIVED_EDGE_TYPES,
      limit: 500,
    })
  } catch (err) {
    console.error(`[skill-edge-hooks] walkOutbound failed (skill=${skillRowId}):`, err)
    return { created: 0, closed: 0, inheritedSensitivity }
  }

  const keyOf = (e: { edgeType: string; targetKind: string; targetId: string }) =>
    `${e.edgeType}|${e.targetKind}|${e.targetId}`
  const existingByKey = new Map(existing.map((e) => [keyOf(e), e] as const))
  const desiredKeys = new Set(desired.map(keyOf))

  // ── Create missing ───────────────────────────────────────────────
  let created = 0
  for (const d of desired) {
    if (existingByKey.has(keyOf(d))) continue
    try {
      await deps.entityLinks.create({
        sourceKind: 'skill',
        sourceId: skillRowId,
        targetKind: d.targetKind,
        targetId: d.targetId,
        edgeType: d.edgeType,
        workspaceId,
        source,
        userId: params.userId ?? actorUserId,
        assistantId: params.assistantId ?? null,
        attributes: {},
      })
      created += 1
    } catch (err) {
      console.error(
        `[skill-edge-hooks] create ${d.edgeType} edge failed (skill=${skillRowId} → ${d.targetKind}:${d.targetId}):`,
        err,
      )
    }
  }

  // ── Close removed (self-heal) ────────────────────────────────────
  let closed = 0
  for (const [k, e] of existingByKey) {
    if (desiredKeys.has(k)) continue
    try {
      const ok = await deps.entityLinks.closeAt(actorUserId, e.id, new Date())
      if (ok) closed += 1
    } catch (err) {
      console.error(`[skill-edge-hooks] close edge failed (skill=${skillRowId} edge=${e.id}):`, err)
    }
  }

  return { created, closed, inheritedSensitivity }
}
