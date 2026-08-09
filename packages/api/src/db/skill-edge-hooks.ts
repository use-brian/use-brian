import type {
  AccessContext,
  EdgeType,
  EntityLinksStore,
  EntitySource,
  LinkKind,
  Sensitivity,
} from '@use-brian/core'
import { extractSkillMarkdownLinks, parseSkillReferences } from '@use-brian/core'

/**
 * Skill edge derivation (`docs/architecture/engine/skill-system.md` §6).
 *
 * Materializes a skill's DERIVED-FROM-FACTS edges in `entity_links` and keeps
 * them self-healing on every skill edit:
 *
 *   skill → entity|memory|kb_chunk   `references_entity`   (explicit @-mentions in content)
 *   skill → connector                 `requires_connector`  (from requires_connectors)
 *   skill → skill_file                `contains`            (every bundle resource)
 *   skill → skill                     `uses_skill`          (explicit relative SKILL.md links)
 *   skill_file → entity|memory|chunk  `references_resource` (explicit ids in resource bodies)
 *
 * `learned_from` (induction provenance) is emitted at induction time (Phase 6),
 * not here; `refines` (memory → skill) is emitted from the memory side.
 *
 * Mirrors edge-hooks.ts's fire-and-forget contract: the skill row is the source
 * of truth; an edge failure logs and never throws back into the skill save.
 *
 * [COMP:api/skill-edge-hooks]
 */

const DERIVED_EDGE_TYPES = [
  'references_entity',
  'requires_connector',
  'contains',
  'uses_skill',
] as const satisfies readonly EdgeType[]
const DERIVED_RESOURCE_EDGE_TYPES = ['references_resource'] as const satisfies readonly EdgeType[]

const SENSITIVITY_RANK: Record<Sensitivity, number> = { public: 1, internal: 2, confidential: 3 }

export type SkillEdgeConnector = { id: string; provider: string }

export type SkillEdgeReferenceTarget = {
  kind: 'entity' | 'memory' | 'kb_chunk'
  id: string
  sensitivity: Sensitivity
}

export type SkillEdgeResource = {
  id: string
  path: string
  content: string
}

export type SkillEdgeSkillTarget = { id: string; slug: string }

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
  /** Resolve literal ../<slug>/SKILL.md dependencies inside this workspace. */
  resolveSkillTargets?: (
    workspaceId: string,
    slugs: string[],
  ) => Promise<SkillEdgeSkillTarget[]>
}

export type RecomputeSkillEdgesParams = {
  /** workspace_skills.id — the `('skill', id)` graph node. */
  skillRowId: string
  workspaceId: string
  content: string
  requiresConnectors: readonly string[]
  resources?: readonly SkillEdgeResource[]
  /** File rows deleted immediately before this recompute. Their outbound
   * resource-reference edges still need closing after the row disappears. */
  retiredResourceIds?: readonly string[]
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

type DesiredEdge = { targetKind: LinkKind; targetId: string; edgeType: EdgeType }

function edgeKey(e: { edgeType: string; targetKind: string; targetId: string }): string {
  return `${e.edgeType}|${e.targetKind}|${e.targetId}`
}

async function syncOutboundEdges(
  deps: Pick<RecomputeSkillEdgesDeps, 'entityLinks'>,
  params: RecomputeSkillEdgesParams,
  ctx: AccessContext,
  sourceKind: 'skill' | 'skill_file',
  sourceId: string,
  edgeTypes: readonly EdgeType[],
  desired: readonly DesiredEdge[],
): Promise<{ created: number; closed: number }> {
  let existing: Awaited<ReturnType<EntityLinksStore['walkOutbound']>> = []
  try {
    existing = await deps.entityLinks.walkOutbound(ctx, sourceKind, sourceId, {
      edgeTypes: [...edgeTypes],
      limit: 500,
    })
  } catch (err) {
    console.error(`[skill-edge-hooks] walkOutbound failed (${sourceKind}=${sourceId}):`, err)
    return { created: 0, closed: 0 }
  }

  const existingByKey = new Map(existing.map((edge) => [edgeKey(edge), edge] as const))
  const desiredKeys = new Set(desired.map(edgeKey))
  let created = 0
  for (const edge of desired) {
    if (existingByKey.has(edgeKey(edge))) continue
    try {
      await deps.entityLinks.create({
        sourceKind,
        sourceId,
        targetKind: edge.targetKind,
        targetId: edge.targetId,
        edgeType: edge.edgeType,
        workspaceId: params.workspaceId,
        source: params.source,
        userId: params.userId ?? params.actorUserId,
        assistantId: params.assistantId ?? null,
        attributes: {},
      })
      created += 1
    } catch (err) {
      console.error(
        `[skill-edge-hooks] create ${edge.edgeType} edge failed (${sourceKind}=${sourceId} → ${edge.targetKind}:${edge.targetId}):`,
        err,
      )
    }
  }

  let closed = 0
  for (const [key, edge] of existingByKey) {
    if (desiredKeys.has(key)) continue
    try {
      if (await deps.entityLinks.closeAt(params.actorUserId, edge.id, new Date())) closed += 1
    } catch (err) {
      console.error(`[skill-edge-hooks] close edge failed (${sourceKind}=${sourceId} edge=${edge.id}):`, err)
    }
  }
  return { created, closed }
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
  const { skillRowId, workspaceId, content, requiresConnectors, actorUserId } = params
  const ctx: AccessContext = {
    userId: actorUserId,
    workspaceId,
    assistantId: params.assistantId ?? '',
    assistantKind: 'standard',
  }

  // ── Desired set ──────────────────────────────────────────────────
  const desired: DesiredEdge[] = []
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
  for (const resource of params.resources ?? []) {
    desired.push({ targetKind: 'skill_file', targetId: resource.id, edgeType: 'contains' })
  }
  try {
    const dependencySlugs = extractSkillMarkdownLinks(content)
      .map((target) => target.match(/^\.\.\/([^/]+)\/SKILL\.md$/i)?.[1])
      .filter((slug): slug is string => Boolean(slug))
    if (dependencySlugs.length > 0 && deps.resolveSkillTargets) {
      const targets = await deps.resolveSkillTargets(workspaceId, [...new Set(dependencySlugs)])
      for (const target of targets) {
        if (target.id !== skillRowId) {
          desired.push({ targetKind: 'skill', targetId: target.id, edgeType: 'uses_skill' })
        }
      }
    }
  } catch (err) {
    console.error(`[skill-edge-hooks] skill dependency resolution failed (skill=${skillRowId}):`, err)
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

  const rootResult = await syncOutboundEdges(
    deps,
    params,
    ctx,
    'skill',
    skillRowId,
    DERIVED_EDGE_TYPES,
    desired,
  )
  let created = rootResult.created
  let closed = rootResult.closed

  // Resource bodies use the same explicit-token parser as the root. There is
  // deliberately no semantic inference here: graph edges must be inspectable
  // and deterministic from bundle source.
  for (const resource of params.resources ?? []) {
    const resourceDesired: DesiredEdge[] = []
    try {
      const refs = parseSkillReferences(resource.content)
      const resolved = await deps.resolveReferenceTargets(workspaceId, refs)
      for (const target of resolved) {
        resourceDesired.push({
          targetKind: target.kind,
          targetId: target.id,
          edgeType: 'references_resource',
        })
        refSensitivities.push(target.sensitivity)
      }
    } catch (err) {
      console.error(`[skill-edge-hooks] resource reference resolution failed (file=${resource.id}):`, err)
    }
    const result = await syncOutboundEdges(
      deps,
      params,
      ctx,
      'skill_file',
      resource.id,
      DERIVED_RESOURCE_EDGE_TYPES,
      resourceDesired,
    )
    created += result.created
    closed += result.closed
  }

  for (const resourceId of params.retiredResourceIds ?? []) {
    const result = await syncOutboundEdges(
      deps,
      params,
      ctx,
      'skill_file',
      resourceId,
      DERIVED_RESOURCE_EDGE_TYPES,
      [],
    )
    closed += result.closed
  }

  return { created, closed, inheritedSensitivity: maxSensitivity(refSensitivities) }
}
