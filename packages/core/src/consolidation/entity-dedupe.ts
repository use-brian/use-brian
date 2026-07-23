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
 *      `EntityStore.findDuplicateClustersSystem` — scoped to the caller's
 *      visible rows (see "Visibility scoping" below).
 *   2. Per cluster: pick the survivor as `entityIds[0]` — the store
 *      orders it curated-first (verified, then `source='user'`) then
 *      oldest — and call `mergeEntities()` for every other row.
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
 * Visibility scoping (corrections.md §D.9 dedupe guard):
 *   - Pass `access` (the caller's `AccessContext`) and every read is
 *     projected through it — only rows the caller can see are clustered,
 *     and clusters never span the visibility double. This is what stops
 *     the sweep from collapsing a caller-visible record into an invisible
 *     survivor (the "accidental swipe" of an entity that has no duplicate
 *     the user can see). The chat `dedupeEntities` tool always passes it.
 *   - The LLM alias pass is **suggest-only** — a fuzzy matcher on
 *     self-reported confidence, never shown in the confirmation preview,
 *     so it surfaces proposals and never auto-merges (the lexical passes,
 *     being exact-name and previewed, still auto-apply on approval).
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
import type { AccessContext } from '../security/access-context.js'
import type { LLMProvider } from '../providers/types.js'

/**
 * Priority order for cross-kind survivor selection. Higher index = lower
 * priority. The CRM kinds (person / company / deal) win because they are
 * the user-curated, structured kinds — when a name collides across kinds,
 * the CRM record is the one the user actively manages, so it should be
 * the survivor. Within the non-CRM tier, `repository` beats `project`
 * (more specific), `project` beats `product` (looser).
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
  /**
   * The caller's access context (corrections.md §D.9 dedupe guard).
   * When supplied — the chat `dedupeEntities` path always does — every
   * cluster/list read is projected through it, so the sweep only ever
   * considers rows the caller can see and never merges across the
   * visibility double. Omitting it falls back to workspace-wide system
   * scope (trusted background callers only).
   */
  access?: AccessContext
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
   *
   * The pass is **suggest-only** (corrections.md §D.9 dedupe guard): it
   * surfaces every proposed cluster in `llmCluster.suggestions` and never
   * auto-merges — a fuzzy same-entity guess must be confirmed, never
   * applied unseen.
   */
  clusterByLlm?: boolean
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
    /**
     * Retained for result-shape stability but **always empty** — the LLM
     * pass is suggest-only (corrections.md §D.9 dedupe guard) and never
     * auto-merges. Every proposed cluster lands in `suggestions`.
     */
    applied: Array<{
      canonicalEntityId: string
      canonicalDisplayName: string
      mergedEntityIds: string[]
      mergedDisplayNames: string[]
      confidence: number
      reasoning: string
    }>
    /** Every LLM-proposed cluster — surfaced for the user to confirm. */
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
    deps.access,
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
      deps.access,
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
  result.llmCluster.ran = true

  const entities = await deps.entities.listLiveEntitiesSystem(
    deps.actorUserId,
    deps.workspaceId,
    { kind: deps.kind },
    deps.access,
  )

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

  // Suggest-only (corrections.md §D.9 dedupe guard). The LLM pass is a
  // FUZZY same-entity matcher scored on a self-reported confidence, and
  // it is deliberately NOT run inside the dedupeEntities confirmation
  // preview — so auto-merging here would collapse two distinct entities
  // on a hallucinated cluster that the user never saw (the "accidental
  // swipe" class). Every proposed cluster is surfaced for the user to
  // confirm; nothing is merged. The lexical passes keep auto-applying
  // because they are exact-name matches shown in the preview card.
  for (const cluster of clusters) {
    result.llmCluster.suggestions.push({
      canonicalEntityId: cluster.canonicalEntityId,
      canonicalDisplayName: cluster.canonicalDisplayName,
      aliasEntityIds: cluster.aliasEntityIds,
      aliasDisplayNames: cluster.aliasDisplayNames,
      confidence: cluster.confidence,
      reasoning: cluster.reasoning,
    })
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
  // (e.g. company + deal) would conflate two distinct user-curated
  // records whose typed `attributes` differ by kind (a company's domain
  // vs a deal's stage/amount), so we never auto-merge them. The user can
  // promote/demote via the brain UI when this case arises — typically
  // rare because the CRM kinds have stronger curation discipline than
  // project/product/repository.
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
