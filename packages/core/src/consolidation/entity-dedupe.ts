/**
 * Self-healing entity dedupe (Q-dedup of the brain-ingestion-classification
 * design thread). Companion to the canonical_id + name-pass dedup that
 * Pipeline B applies inline at write time — this surface heals the
 * back-catalogue when dupes have already accumulated (existing
 * 18k-row workspace baseline, or anything that slipped past the inline
 * pass).
 *
 * Algorithm:
 *   1. Pull every live entity cluster colliding on
 *      `(workspace_id, kind, lower(display_name))` via
 *      `EntityStore.findDuplicateClustersSystem`.
 *   2. Per cluster: pick the oldest row as the survivor (carries the
 *      richest history of edges + verifications by sheer age), call
 *      `mergeEntities()` for every other row in the cluster.
 *   3. Use `survivor-wins` reconciliation by default — safest mode for
 *      a background heal because it never throws on attribute conflicts
 *      and leaves the survivor's attributes unchanged. Attribute drift
 *      from the merged rows is dropped intentionally; users can re-state
 *      facts via chat if needed.
 *
 * No new audit row — `mergeEntities()` writes to `entity_merges` per
 * pair, which is the existing source of truth for "why are these two
 * one entity now".
 *
 * Scope guardrails:
 *   - `clusterCap` caps how many clusters we touch per invocation
 *     (default 25). Keeps a single chat-tool call bounded.
 *   - `kind` filter narrows the heal to one entity kind — useful for
 *     surgical reruns ("only dedupe repositories now").
 *
 * [COMP:brain/entity-dedupe]
 */

import {
  mergeEntities,
  EntityMergeError,
  type EntityMergeDeps,
} from '../corrections/entity-merge.js'
import type {
  CrossKindClusterRow,
  EntityKind,
  EntityStore,
} from '../entities/types.js'
import {
  clusterEntityAliases,
  type AliasCluster,
} from './alias-clusterer.js'
import type { LLMProvider } from '../providers/types.js'

/**
 * Priority order for cross-kind survivor selection. Higher index = lower
 * priority. CRM kinds win because they own a downstream specialization
 * row (contacts / companies / deals) — picking a non-CRM survivor would
 * orphan that row. Within the non-CRM tier, `repository` beats
 * `project` (more specific), `project` beats `product` (looser).
 *
 * Two entities of the same priority kind cannot exist in a cross-kind
 * cluster by construction (`COUNT(DISTINCT kind) > 1`), so ties are
 * broken by `created_at ASC` upstream.
 */
const CROSS_KIND_PRIORITY: Record<string, number> = {
  person: 0,
  company: 1,
  deal: 2,
  repository: 3,
  project: 4,
  product: 5,
}

function crossKindPriority(kind: EntityKind): number {
  const p = CROSS_KIND_PRIORITY[kind]
  // Unknown kinds (tenant.*) fall last but ahead of unmapped — anchor at 99.
  return p ?? 99
}

export interface EntityDedupeDeps {
  entities: EntityStore
  merge: EntityMergeDeps
  workspaceId: string
  actorUserId: string
  /** Cap on clusters processed per invocation. Default 25. */
  clusterCap?: number
  /** Optional kind narrowing — applies only to the within-kind pass. */
  kind?: EntityKind
  /**
   * Skip the cross-kind dedupe pass. The cross-kind pass merges entities
   * sharing `(workspace_id, lower(display_name))` across kinds (e.g.
   * `MeshJS` as both `company` and `project`). Default false — caller
   * opts out only when they're scoped to a single kind on purpose.
   */
  skipCrossKind?: boolean
  /**
   * Per-cluster row cap for the cross-kind pass. Defaults to 10 so
   * legitimately-ambiguous short names (e.g. one-letter names recurring
   * across many extractions) aren't auto-merged.
   */
  crossKindMaxClusterSize?: number
  /**
   * Enable the third LLM-clustering pass — finds semantic alias clusters
   * (e.g. "DD" ↔ "DeltaDeFi") that the lexical passes miss. Opt-in
   * because it incurs one LLM call per invocation. Requires
   * `llmClusterer` deps; no-op when those are absent.
   */
  clusterByLlm?: boolean
  /**
   * Confidence threshold (0-1) above which LLM-proposed clusters are
   * auto-applied (merged + alias-recorded). Lower-confidence clusters
   * are surfaced in `llmCluster.suggestions` for manual review.
   * Default 0.85 — empirically the point where Flash-class models stop
   * being overconfident on weak signals.
   */
  llmAutoApplyThreshold?: number
  /** LLM dependencies for the alias-clustering pass. */
  llmClusterer?: { provider: LLMProvider; model: string }
}

export interface EntityDedupeResult {
  clustersScanned: number
  pairsMerged: number
  pairsConflicted: number
  pairsErrored: number
  /** Per-cluster summaries — useful for the chat tool reply. */
  details: Array<{
    kind: EntityKind
    displayNameNormalized: string
    survivorId: string
    mergedIds: string[]
    conflictedIds: string[]
    erroredIds: string[]
  }>
  /** Second-pass results — entities that collapsed across kinds. */
  crossKind: {
    clustersScanned: number
    pairsMerged: number
    pairsErrored: number
    details: Array<{
      displayNameNormalized: string
      survivorId: string
      survivorKind: EntityKind
      mergedIds: string[]
      mergedKinds: EntityKind[]
      erroredIds: string[]
    }>
  }
  /** Third-pass results — LLM-driven semantic alias clusters. */
  llmCluster: {
    /** True when the pass actually ran (deps + flag set). */
    ran: boolean
    clustersFound: number
    /** Clusters auto-applied (confidence >= llmAutoApplyThreshold). */
    applied: Array<{
      canonicalEntityId: string
      canonicalDisplayName: string
      mergedEntityIds: string[]
      mergedDisplayNames: string[]
      confidence: number
      reasoning: string
    }>
    /** Clusters below the auto-apply threshold — surface for user review. */
    suggestions: Array<{
      canonicalEntityId: string
      canonicalDisplayName: string
      aliasEntityIds: string[]
      aliasDisplayNames: string[]
      confidence: number
      reasoning: string
    }>
    errors: number
  }
}

const DEFAULT_CLUSTER_CAP = 25

export async function runEntityDedupe(
  deps: EntityDedupeDeps,
): Promise<EntityDedupeResult> {
  const clusterCap = deps.clusterCap ?? DEFAULT_CLUSTER_CAP
  const clusters = await deps.entities.findDuplicateClustersSystem(
    deps.actorUserId,
    deps.workspaceId,
    { limit: clusterCap, kind: deps.kind },
  )

  const result: EntityDedupeResult = {
    clustersScanned: clusters.length,
    pairsMerged: 0,
    pairsConflicted: 0,
    pairsErrored: 0,
    details: [],
    crossKind: {
      clustersScanned: 0,
      pairsMerged: 0,
      pairsErrored: 0,
      details: [],
    },
    llmCluster: {
      ran: false,
      clustersFound: 0,
      applied: [],
      suggestions: [],
      errors: 0,
    },
  }

  for (const cluster of clusters) {
    const [survivorId, ...mergeIds] = cluster.entityIds
    if (!survivorId || mergeIds.length === 0) continue

    const detail = {
      kind: cluster.kind,
      displayNameNormalized: cluster.displayNameNormalized,
      survivorId,
      mergedIds: [] as string[],
      conflictedIds: [] as string[],
      erroredIds: [] as string[],
    }

    for (const mergeId of mergeIds) {
      try {
        await mergeEntities(
          {
            workspaceId: deps.workspaceId,
            survivingId: survivorId,
            mergedId: mergeId,
            actorUserId: deps.actorUserId,
            reason: 'self-heal: duplicate by (kind, lower(display_name))',
            mode: 'survivor-wins',
          },
          deps.merge,
        )
        detail.mergedIds.push(mergeId)
        result.pairsMerged += 1
      } catch (err) {
        if (err instanceof EntityMergeError && err.code === 'conflict_requires_resolution') {
          // Cannot happen under 'survivor-wins' (no conflicts surface to
          // the operator), but defend the loop anyway so a behavioural
          // change in reconcileAttributes doesn't take the heal down.
          detail.conflictedIds.push(mergeId)
          result.pairsConflicted += 1
        } else {
          detail.erroredIds.push(mergeId)
          result.pairsErrored += 1
          console.warn(
            `[entity-dedupe] merge failed for survivor=${survivorId} merged=${mergeId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }
    }

    result.details.push(detail)
  }

  // Cross-kind pass (skip when the caller scoped to one kind on purpose).
  if (!deps.skipCrossKind && !deps.kind) {
    const xClusters = await deps.entities.findCrossKindDuplicateClustersSystem(
      deps.actorUserId,
      deps.workspaceId,
      { limit: clusterCap, maxClusterSize: deps.crossKindMaxClusterSize },
    )
    result.crossKind.clustersScanned = xClusters.length
    for (const cluster of xClusters) {
      await runCrossKindCluster(cluster, deps, result)
    }
  }

  // Third pass — LLM semantic alias clustering. Opt-in (cost) and
  // requires llmClusterer deps. Catches the alias cases lexical
  // passes miss (e.g. `DD` ↔ `DeltaDeFi`).
  if (deps.clusterByLlm && deps.llmClusterer) {
    await runLlmAliasPass(deps, result)
  }

  return result
}

async function runLlmAliasPass(
  deps: EntityDedupeDeps,
  result: EntityDedupeResult,
): Promise<void> {
  if (!deps.llmClusterer) return
  const threshold = deps.llmAutoApplyThreshold ?? 0.85
  result.llmCluster.ran = true

  const entities = await deps.entities.listLiveEntitiesSystem(
    deps.actorUserId,
    deps.workspaceId,
    { kind: deps.kind },
  )
  const byId = new Map(entities.map((e) => [e.id, e]))

  let clusters: AliasCluster[]
  try {
    clusters = await clusterEntityAliases({
      entities,
      provider: deps.llmClusterer.provider,
      model: deps.llmClusterer.model,
    })
  } catch (err) {
    console.warn(
      `[entity-dedupe] alias clusterer threw: ${
        err instanceof Error ? err.message : String(err)
      }`,
    )
    result.llmCluster.errors += 1
    return
  }
  result.llmCluster.clustersFound = clusters.length

  for (const cluster of clusters) {
    if (cluster.confidence < threshold) {
      result.llmCluster.suggestions.push({
        canonicalEntityId: cluster.canonicalEntityId,
        canonicalDisplayName: cluster.canonicalDisplayName,
        aliasEntityIds: cluster.aliasEntityIds,
        aliasDisplayNames: cluster.aliasDisplayNames,
        confidence: cluster.confidence,
        reasoning: cluster.reasoning,
      })
      continue
    }
    // Auto-apply path: merge each alias entity into the canonical, then
    // record its surface form as an alias on the canonical.
    const canonical = byId.get(cluster.canonicalEntityId)
    if (!canonical) continue
    const applied = {
      canonicalEntityId: canonical.id,
      canonicalDisplayName: canonical.displayName,
      mergedEntityIds: [] as string[],
      mergedDisplayNames: [] as string[],
      confidence: cluster.confidence,
      reasoning: cluster.reasoning,
    }
    for (let i = 0; i < cluster.aliasEntityIds.length; i++) {
      const aliasId = cluster.aliasEntityIds[i]!
      const aliasName = cluster.aliasDisplayNames[i]!
      try {
        await mergeEntities(
          {
            workspaceId: deps.workspaceId,
            survivingId: canonical.id,
            mergedId: aliasId,
            actorUserId: deps.actorUserId,
            reason: `self-heal: LLM alias cluster (${cluster.confidence.toFixed(2)})`,
            mode: 'survivor-wins',
          },
          deps.merge,
        )
        applied.mergedEntityIds.push(aliasId)
        applied.mergedDisplayNames.push(aliasName)
        // Record the alias name on the canonical so the next mention
        // hits the cheap name+alias index. Best-effort; conflicts are
        // already merged so the addAlias should succeed.
        await deps.entities
          .addAlias(deps.actorUserId, canonical.id, aliasName)
          .catch((err) => {
            console.warn(
              `[entity-dedupe] alias record failed for ${canonical.id} alias='${aliasName}': ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          })
      } catch (err) {
        result.llmCluster.errors += 1
        console.warn(
          `[entity-dedupe] LLM-cluster merge failed for canonical=${canonical.id} alias=${aliasId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        )
      }
    }
    if (applied.mergedEntityIds.length > 0) {
      result.llmCluster.applied.push(applied)
    }
  }
}

const CRM_KINDS = new Set<string>(['person', 'company', 'deal'])

async function runCrossKindCluster(
  cluster: CrossKindClusterRow,
  deps: EntityDedupeDeps,
  result: EntityDedupeResult,
): Promise<void> {
  if (cluster.entityIds.length < 2) return

  // Safety: skip clusters with >1 CRM kind. Merging across CRM kinds
  // (e.g. company + deal) would close one CRM entity while its
  // specialization row (`deals.entity_id`) still pointed at it,
  // orphaning the row. The user can promote/demote via the brain UI
  // when this case arises — typically rare because the CRM kinds have
  // stronger schema discipline than project/product/repository.
  const crmCount = cluster.kinds.filter((k) => CRM_KINDS.has(k)).length
  if (crmCount > 1) {
    result.crossKind.details.push({
      displayNameNormalized: cluster.displayNameNormalized,
      survivorId: cluster.entityIds[0]!,
      survivorKind: cluster.kinds[0]!,
      mergedIds: [],
      mergedKinds: [],
      erroredIds: cluster.entityIds.slice(1),
    })
    result.crossKind.pairsErrored += cluster.entityIds.length - 1
    return
  }

  // Pick the survivor: best (lowest) priority kind, tie-break by oldest.
  // `kinds`, `entityIds`, `createdAts` are co-indexed.
  let survivorIdx = 0
  for (let i = 1; i < cluster.entityIds.length; i++) {
    const here = crossKindPriority(cluster.kinds[i]!)
    const best = crossKindPriority(cluster.kinds[survivorIdx]!)
    if (
      here < best
      || (here === best && cluster.createdAts[i]! < cluster.createdAts[survivorIdx]!)
    ) {
      survivorIdx = i
    }
  }

  const survivorId = cluster.entityIds[survivorIdx]!
  const survivorKind = cluster.kinds[survivorIdx]!
  const detail = {
    displayNameNormalized: cluster.displayNameNormalized,
    survivorId,
    survivorKind,
    mergedIds: [] as string[],
    mergedKinds: [] as EntityKind[],
    erroredIds: [] as string[],
  }

  for (let i = 0; i < cluster.entityIds.length; i++) {
    if (i === survivorIdx) continue
    const mergeId = cluster.entityIds[i]!
    try {
      await mergeEntities(
        {
          workspaceId: deps.workspaceId,
          survivingId: survivorId,
          mergedId: mergeId,
          actorUserId: deps.actorUserId,
          reason: 'self-heal: cross-kind duplicate by lower(display_name)',
          mode: 'survivor-wins',
        },
        deps.merge,
      )
      detail.mergedIds.push(mergeId)
      detail.mergedKinds.push(cluster.kinds[i]!)
      result.crossKind.pairsMerged += 1
    } catch (err) {
      detail.erroredIds.push(mergeId)
      result.crossKind.pairsErrored += 1
      console.warn(
        `[entity-dedupe] cross-kind merge failed for survivor=${survivorId} (${survivorKind}) merged=${mergeId} (${cluster.kinds[i]}): ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }

  result.crossKind.details.push(detail)
}
