/**
 * Composition executor — writes the derived entities + edges from a
 * classifier match.
 *
 * Routes by kind:
 *   - person | company | deal  → CRM wrappers (atomic specialization write)
 *   - everything else          → EntityStore.create (with canonical_id dedup)
 *
 * Spec: docs/architecture/brain/classification/README.md §Composition executor
 */

import type { CrmStore } from '../crm/types.js'
import type {
  EntityCreateParams,
  EntityLinkCreateParams,
  EntityLinksStore,
  EntityRecord,
  EntityStore,
} from '../entities/types.js'
import type { Sensitivity } from '../security/sensitivity.js'
import type {
  ClassifierBoundary,
  DerivedEdge,
  DerivedEntity,
} from './types.js'

// ── Public types ─────────────────────────────────────────────────────

export type CompositionWrite = {
  /**
   * The primary entity. May be omitted when only derived edges/entities
   * are being written (e.g., self-heal scenario where the primary entity
   * already exists).
   */
  primary?: DerivedEntity & { ref: 'primary' }
  /**
   * Derived entities to write alongside the primary. `ref` distinguishes
   * them for edge wiring. Must not use the literal 'primary'.
   */
  entities?: DerivedEntity[]
  edges?: DerivedEdge[]
}

export type CompositionContext = {
  actorUserId: string
  workspaceId: string
  sensitivity: Sensitivity
  assistantId?: string | null
  userId?: string | null
  sourceEpisodeId?: string | null
  createdByRule: string
  boundary: ClassifierBoundary
}

export type CompositionResult = {
  /** Map from ref → freshly-written or matched-existing entity id. */
  entityIds: Record<string, string>
  edgeIds: string[]
}

export type ComposeExecutor = {
  write(writes: CompositionWrite, ctx: CompositionContext): Promise<CompositionResult>
}

// ── Dependencies ─────────────────────────────────────────────────────

export type ComposeExecutorDeps = {
  entities: EntityStore
  links: EntityLinksStore
  crm: CrmStore
}

// ── Factory ──────────────────────────────────────────────────────────

const CRM_KINDS = new Set(['person', 'company', 'deal'])

export function createComposeExecutor(deps: ComposeExecutorDeps): ComposeExecutor {
  return {
    async write(writes, ctx) {
      const entityIds: Record<string, string> = {}

      const queue: DerivedEntity[] = []
      if (writes.primary) queue.push(writes.primary)
      if (writes.entities) queue.push(...writes.entities)

      for (const ent of queue) {
        try {
          const id = await writeEntity(deps, ent, ctx)
          entityIds[ent.ref] = id
        } catch (err) {
          console.warn(
            `[classification/compose] entity write failed (ref=${ent.ref}, kind=${ent.kind}): ${
              err instanceof Error ? err.message : String(err)
            }`,
          )
        }
      }

      const edgeIds: string[] = []
      if (writes.edges) {
        for (const edge of writes.edges) {
          const sourceId = entityIds[edge.source_ref]
          const targetId = entityIds[edge.target_ref]
          if (!sourceId || !targetId) {
            console.warn(
              `[classification/compose] edge skipped — unresolved ref(s): source=${edge.source_ref}, target=${edge.target_ref}`,
            )
            continue
          }
          try {
            const linkParams: EntityLinkCreateParams = {
              sourceKind: 'entity',
              sourceId,
              targetKind: 'entity',
              targetId,
              edgeType: edge.edge_type,
              workspaceId: ctx.workspaceId,
              source: 'extracted',
              userId: ctx.userId ?? null,
              assistantId: ctx.assistantId ?? null,
              attributes: stampProvenance(edge.attributes, ctx),
              sensitivity: ctx.sensitivity,
              sourceEpisodeId: ctx.sourceEpisodeId ?? null,
            }
            const created = await deps.links.create(linkParams)
            edgeIds.push(created.id)
          } catch (err) {
            console.warn(
              `[classification/compose] edge write failed (${edge.source_ref} -> ${edge.target_ref}): ${
                err instanceof Error ? err.message : String(err)
              }`,
            )
          }
        }
      }

      return { entityIds, edgeIds }
    },
  }
}

// ── Per-entity write routing ─────────────────────────────────────────

async function writeEntity(
  deps: ComposeExecutorDeps,
  ent: DerivedEntity,
  ctx: CompositionContext,
): Promise<string> {
  if (CRM_KINDS.has(ent.kind)) {
    return writeCrmEntity(deps, ent, ctx)
  }

  // Non-CRM kind — dedup by canonical_id when present; else direct create.
  if (ent.canonical_id) {
    const existing = await deps.entities.findByCanonicalIdSystem(
      ctx.actorUserId,
      ctx.workspaceId,
      ent.canonical_id,
    )
    const live = existing.find((e) => e.kind === ent.kind && e.retractedAt === null && e.validTo === null)
    if (live) {
      // Merge attributes if needed
      const merged = mergeAttributes(live.attributes, stampProvenance(ent.attributes, ctx))
      if (merged !== null) {
        const superseded = await deps.entities.supersedeAttributes(
          ctx.actorUserId,
          live.id,
          {
            attributes: merged,
            sourceEpisodeId: ctx.sourceEpisodeId ?? null,
          },
        )
        return superseded?.id ?? live.id
      }
      return live.id
    }
  }

  const params: EntityCreateParams = {
    kind: ent.kind,
    displayName: ent.display_name,
    canonicalId: ent.canonical_id ?? null,
    attributes: stampProvenance(ent.attributes, ctx),
    sensitivity: ctx.sensitivity,
    workspaceId: ctx.workspaceId,
    userId: ctx.userId ?? null,
    assistantId: ctx.assistantId ?? null,
    createdByUserId: ctx.actorUserId,
    createdByAssistantId: ctx.assistantId ?? null,
    sourceEpisodeId: ctx.sourceEpisodeId ?? null,
    source: 'extracted',
  }
  const created = await deps.entities.create(params)
  return created.id
}

async function writeCrmEntity(
  deps: ComposeExecutorDeps,
  ent: DerivedEntity,
  ctx: CompositionContext,
): Promise<string> {
  switch (ent.kind) {
    case 'person': {
      const email =
        typeof ent.canonical_id === 'string' && ent.canonical_id.includes('@')
          ? ent.canonical_id
          : (ent.attributes?.email as string | undefined) ?? null
      const contact = await deps.crm.createContact({
        userId: ctx.actorUserId,
        workspaceId: ctx.workspaceId,
        name: ent.display_name,
        email,
      })
      return resolveCrmEntityId(deps, ctx, ent.display_name, ent.canonical_id ?? null, 'person')
    }
    case 'company': {
      const domain =
        typeof ent.canonical_id === 'string' && !ent.canonical_id.includes('@')
          ? ent.canonical_id
          : (ent.attributes?.domain as string | undefined) ?? null
      await deps.crm.createCompany({
        userId: ctx.actorUserId,
        workspaceId: ctx.workspaceId,
        name: ent.display_name,
        domain,
      })
      return resolveCrmEntityId(deps, ctx, ent.display_name, domain, 'company')
    }
    case 'deal': {
      const deal = await deps.crm.createDeal({
        userId: ctx.actorUserId,
        workspaceId: ctx.workspaceId,
      })
      // Deals don't have a name column on the specialization row; the
      // entity row is the addressable one. CRM.createDeal writes both
      // atomically; we resolve to the entity by display_name fallback.
      return resolveCrmEntityId(deps, ctx, ent.display_name, null, 'deal')
    }
    default:
      throw new Error(`[classification/compose] CRM_KINDS includes unhandled kind: ${ent.kind}`)
  }
}

/**
 * CRM tools return specialization records, not entity rows. We resolve
 * the entity id by name (and canonical_id when present) via the system
 * lookup. Best-effort — returns the first match.
 */
async function resolveCrmEntityId(
  deps: ComposeExecutorDeps,
  ctx: CompositionContext,
  displayName: string,
  canonicalId: string | null,
  kind: 'person' | 'company' | 'deal',
): Promise<string> {
  if (canonicalId) {
    const byCanonical = await deps.entities.findByCanonicalIdSystem(
      ctx.actorUserId,
      ctx.workspaceId,
      canonicalId,
    )
    const live = byCanonical.find((e) => e.kind === kind && e.retractedAt === null && e.validTo === null)
    if (live) return live.id
  }
  const byName = await deps.entities.findByNameSystem(
    ctx.actorUserId,
    ctx.workspaceId,
    displayName,
    { kind },
  )
  if (byName) return byName.id
  throw new Error(
    `[classification/compose] could not resolve CRM entity row for ${kind} "${displayName}" — CRM write may have failed`,
  )
}

// ── Helpers ──────────────────────────────────────────────────────────

function stampProvenance(
  attributes: Record<string, unknown> | undefined,
  ctx: CompositionContext,
): Record<string, unknown> {
  const base = attributes ? { ...attributes } : {}
  const existingProvenance = (base._provenance as Record<string, unknown> | undefined) ?? {}
  base._provenance = {
    ...existingProvenance,
    created_by_rule: ctx.createdByRule,
    boundary: ctx.boundary,
    first_written_at:
      (existingProvenance.first_written_at as string | undefined) ?? new Date().toISOString(),
  }
  return base
}

/**
 * Returns merged attributes when they differ from `existing`, or null
 * when the merge would be a no-op. Same semantics as the in-place merge
 * helper in pipeline-b.ts; lifted here so compose can do its own dedup
 * without round-tripping through the extraction writer.
 */
function mergeAttributes(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> | null {
  let changed = false
  const merged: Record<string, unknown> = { ...existing }
  for (const [k, v] of Object.entries(incoming)) {
    if (v === undefined) continue
    if (merged[k] === undefined) {
      merged[k] = v
      changed = true
      continue
    }
    if (JSON.stringify(merged[k]) !== JSON.stringify(v)) {
      merged[k] = v
      changed = true
    }
  }
  return changed ? merged : null
}
