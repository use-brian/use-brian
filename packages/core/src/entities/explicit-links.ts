/**
 * Shared input schema + applier for the `links` parameter on every
 * brain-write chat tool (`saveContact`, `saveCompany`, `saveDeal`,
 * `createEntity`, `saveMemory`, and their update variants).
 *
 * Spec: docs/architecture/brain/graph-view.md → "Edge creation in
 * save tools" and docs/architecture/brain/data-model.md → Entity Links.
 *
 * ── Why this lives here ────────────────────────────────────────────
 *
 * Before this helper, edges only existed via two paths:
 *
 *   1. Implicit hooks: `saveContact({ companyId })` emitted a
 *      `works_at` edge post-commit via `edge-hooks.ts`. Limited to two
 *      edge types (`works_at`, `engagement_of`); silently no-op when
 *      the FK was absent.
 *   2. Pipeline B extraction: external ingest produced edges but never
 *      ran on chat-driven research turns.
 *
 * Research-mode chat sessions could create entities (`saveContact`,
 * `saveCompany`, `createEntity`) but had no way to express the richer
 * vocabulary in `EDGE_TYPES` — cofounder relationships, past
 * employment with a closed date, product-of, etc. The result was the
 * "no connected entities" graph the user hit.
 *
 * This helper gives every save tool a uniform `links` input that
 * writes edges from the just-saved entity to any number of target
 * entities, with full access to the locked edge vocabulary and
 * bi-temporal `validFrom` / `validTo` for closed relationships.
 *
 * ── Fire-and-forget semantics ──────────────────────────────────────
 *
 * Like `edge-hooks.ts`, this helper runs after the primary entity
 * write and never throws back into the tool's `execute()`. A failed
 * edge write logs (`console.error`) but the user-visible tool result
 * still reports the entity save as successful — losing one edge is
 * cheaper than rolling back a real-world fact. The helper returns a
 * `{ created, failed }` summary so the tool can mention any partial
 * failure in its result string without escalating.
 */

import { z } from 'zod'
import type { EntityLinksStore, EntitySource, LinkKind } from './types.js'
import { EDGE_TYPES, LINK_KINDS } from './types.js'

const linkKindEnum = z.enum(LINK_KINDS)

/**
 * Model-facing date input — shared by task due-dates and edge validity
 * (`validFrom` / `validTo`). Accepts a zone-qualified ISO-8601 datetime
 * (offset OR `Z`) or a bare calendar date.
 *
 * Zod's strict `z.string().datetime()` accepts ONLY a UTC `Z` suffix and
 * rejects both the offset form the model emits when it resolves a relative
 * date in `userTimezone` (`2026-06-04T09:00:00+08:00`) and bare dates
 * (`2025-08-31`, which this file's own `validTo` example uses). It rejected
 * them with an uninformative "Invalid datetime", so the model blind-guessed
 * format variants instead of correcting — eight `saveTask` calls in one turn
 * (session b0903ea6, 2026-06-02). The custom message names the accepted shapes
 * so a non-conforming value self-corrects in a single retry. See
 * docs/architecture/features/tasks.md.
 */
export const isoDateOrDateTime = z.string().refine(
  (v) =>
    z.string().datetime({ offset: true }).safeParse(v).success ||
    z.string().date().safeParse(v).success,
  {
    message:
      'Use a zone-qualified ISO-8601 timestamp (offset "2026-06-04T09:00:00+08:00" or UTC "2026-06-04T01:00:00Z") or a bare date ("2026-06-04"). A zoneless time is ambiguous and is rejected — resolve it in userTimezone first.',
  },
)

/** UUID + locked edge-type Zod shape — reused by every tool input. */
export const explicitLinkInputShape = z.object({
  /**
   * Target id. UUID by default (matching a row in `entities`); for
   * non-entity targets pass the row id of the corresponding primitive
   * (memory.id, task.id, file.id, episode.id, kb_chunk.id) and set
   * `targetKind` to match. For CRM rows, use the underlying entity
   * id returned in tool outputs (NOT the contact_id / company_id /
   * deal_id).
   */
  targetEntityId: z.string().uuid(),
  /**
   * Kind of the target row. Defaults to `'entity'` — the common case
   * where the model is recording a relationship to another entity.
   * Set explicitly for cross-primitive edges:
   *   - `'file'` for `documented_by` (entity → file)
   *   - `'memory'` for `replies_to` (memory → memory)
   *   - `'episode'` for `discussed_in` (entity → episode)
   *   - `'task'` for `depends_on` (task → task)
   */
  targetKind: linkKindEnum.optional(),
  /** Relationship type from the locked vocab — see `.describe()` for the verb list. */
  edgeType: z.enum(EDGE_TYPES).describe(
    'Relationship verb from the locked vocabulary. ' +
    'Person→org: works_at, engagement_of, represents, mutual_connection. ' +
    'Company/deal: competes_with, signed_contract_with, customer_since, target_investor, target_competitor, outreach_strategy_for. ' +
    'Conversation/event: attended, discussed_in, discussed_with, mentioned, mentioned_publicly_at. ' +
    'Cross-primitive: depends_on (task→task), documented_by (→file), replies_to (memory→memory), platform_engagement_for (feed). ' +
    'Pick the closest verb; do not invent new ones (the enum rejects unknown values).',
  ),
  /** When the relationship started. Defaults to `now()` if omitted. */
  validFrom: isoDateOrDateTime.optional(),
  /** When the relationship ended. Set for past relationships
   *  ("Kinson left DeltaDeFi in August 2025" → validTo: '2025-08-31'). */
  validTo: isoDateOrDateTime.optional(),
  /** Free-form metadata for this edge (e.g. role title, deal size). */
  attributes: z.record(z.unknown()).optional(),
})

export type ExplicitLinkInput = z.infer<typeof explicitLinkInputShape>

/**
 * Input shape for `closeLinks` — closes an existing active edge by
 * semantic match. The model rarely knows the raw `entity_links.id`,
 * so this addresses an edge by its endpoint + edge type.
 *
 * If the source entity has multiple active edges matching the same
 * `(targetEntityId, edgeType)` (rare but legal — e.g. two consulting
 * stints at the same company), the most recently created one is
 * closed. `closeLinks` is an end-the-relationship operation, not a
 * retraction (no `retracted_at`); the edge stays in history.
 */
export const explicitCloseInputShape = z.object({
  /** UUID of the target row whose edge from this source should close. */
  targetEntityId: z.string().uuid(),
  /** Optional — disambiguate when multiple edges to the same target. */
  edgeType: z.enum(EDGE_TYPES).optional(),
  /** Kind of the target row; defaults to `'entity'`. Match the
   *  source-side targetKind used when the edge was opened. */
  targetKind: linkKindEnum.optional(),
  /** When the relationship ended. Defaults to `now()`. */
  validTo: isoDateOrDateTime.optional(),
})

export type ExplicitCloseInput = z.infer<typeof explicitCloseInputShape>

/**
 * Zod shape for the `links` field on a tool input. Bounded so a model
 * spamming 100 edges in one call can't DoS the edge store.
 */
export const explicitLinksField = z
  .array(explicitLinkInputShape)
  .max(20)
  .optional()
  .describe(
    'Optional array of relationship edges to write from the row being saved. ' +
    'Use this to encode connections the model has observed — e.g. when saving ' +
    'a person, link them to their employer ({targetEntityId: <company entity id>, edgeType: "works_at"}). ' +
    'Set validTo for past/closed relationships ("left in Aug 2025"). ' +
    'targetEntityId is the underlying entity UUID — NOT the contacts/companies/deals row id. Read it from ' +
    'the `entity_id` field present on every listContacts/listCompanies/listDeals/getContact row, from a prior ' +
    'save-tool result, or via getEntity (resolves by id-or-name and returns the entity plus its existing edges, ' +
    'so you can avoid duplicating one). See the edgeType field for the locked verb vocabulary. ' +
    'Default targetKind is "entity"; pass targetKind explicitly for cross-primitive edges (file, memory, task, episode, kb_chunk).',
  )

/**
 * Zod shape for the `closeLinks` field on update tools. Closes
 * existing active edges via semantic match — the model passes the
 * other endpoint, not the edge id.
 */
export const explicitClosesField = z
  .array(explicitCloseInputShape)
  .max(20)
  .optional()
  .describe(
    'Optional array of existing edges to close via supersession. Use when ' +
    'recording that a relationship ended ("Kinson left DeltaDeFi in August 2025" → ' +
    'closeLinks: [{targetEntityId: <DeltaDeFi entity id>, edgeType: "works_at", validTo: "2025-08-31T00:00:00Z"}]). ' +
    'Different from retracting: the edge stays in history with its valid_to set — ' +
    'it represented a real relationship that ended. For wrong-data retraction, use ' +
    'the corrections retract tool instead. If multiple matching edges exist, the ' +
    'most recently created one is closed.',
  )

export type ApplyLinksParams = {
  entityLinks: EntityLinksStore | undefined
  workspaceId: string
  userId: string
  assistantId: string | null
  sourceKind: LinkKind
  sourceId: string
  source: EntitySource
  links: readonly ExplicitLinkInput[] | undefined
  /** Episode ref to thread through to `entity_links.source_episode_id`. */
  sourceEpisodeId?: string | null
}

/**
 * Write the explicit links to `entity_links`. Returns a per-call
 * counter so the tool can surface partial failure without rolling
 * back the entity write.
 */
export async function applyExplicitLinks(
  params: ApplyLinksParams,
): Promise<{ created: number; failed: number }> {
  if (!params.entityLinks || !params.links || params.links.length === 0) {
    return { created: 0, failed: 0 }
  }
  let created = 0
  let failed = 0
  for (const link of params.links) {
    const targetKind: LinkKind = link.targetKind ?? 'entity'
    try {
      await params.entityLinks.create({
        sourceKind: params.sourceKind,
        sourceId: params.sourceId,
        targetKind,
        targetId: link.targetEntityId,
        edgeType: link.edgeType,
        attributes: link.attributes ?? {},
        source: params.source,
        workspaceId: params.workspaceId,
        userId: params.userId,
        assistantId: params.assistantId,
        validFrom: link.validFrom ? new Date(link.validFrom) : undefined,
        validTo: link.validTo ? new Date(link.validTo) : null,
        sourceEpisodeId: params.sourceEpisodeId ?? null,
      })
      created += 1
    } catch (err) {
      failed += 1
      console.error(
        `[explicit-links] edge create failed (source=${params.sourceKind}:${params.sourceId} ` +
          `target=${targetKind}:${link.targetEntityId} edge=${link.edgeType}):`,
        err,
      )
    }
  }
  return { created, failed }
}

export type ApplyClosesParams = {
  entityLinks: EntityLinksStore | undefined
  userId: string
  sourceKind: LinkKind
  sourceId: string
  closes: readonly ExplicitCloseInput[] | undefined
}

/**
 * Close existing active edges by semantic match. Returns the per-
 * call counter. Same fire-and-forget invariant as
 * `applyExplicitLinks` — failed close ops log to `console.error`
 * but never throw back to the tool.
 *
 * Match algorithm: scan active outbound edges (via the store's
 * `walkOutbound` + edgeType filter); if multiple match, close the
 * most recently created one (descending `created_at` is the store's
 * default ordering).
 */
export async function applyExplicitCloses(
  params: ApplyClosesParams,
): Promise<{ closed: number; failed: number }> {
  if (!params.entityLinks || !params.closes || params.closes.length === 0) {
    return { closed: 0, failed: 0 }
  }
  let closed = 0
  let failed = 0
  for (const close of params.closes) {
    const targetKind: LinkKind = close.targetKind ?? 'entity'
    try {
      // Find the most recent active outbound edge matching the
      // (target, edgeType) pair. `walkOutbound` returns active-only
      // (the bi-temporal predicate is baked in), descending by
      // created_at. Filter for the exact target + edge type.
      const candidates = await params.entityLinks.walkOutbound(
        // The store walks under the current user's RLS. The
        // pseudo-ctx mirrors what the chat tools pass — we pull
        // workspaceId from the existing access predicate via the
        // store's RLS guard, so the ctx need only carry userId.
        // (See `walkOutboundLinks` in entity-links-store.ts; it
        // applies `buildAccessPredicate(ctx)`, which uses
        // `ctx.workspaceId`. Tools route via their own ctxFor.)
        { userId: params.userId, workspaceId: '', assistantId: '', assistantKind: 'standard' },
        params.sourceKind,
        params.sourceId,
        close.edgeType ? { edgeTypes: [close.edgeType], limit: 20 } : { limit: 50 },
      )
      const match = candidates.find(
        (e) => e.targetKind === targetKind && e.targetId === close.targetEntityId,
      )
      if (!match) {
        failed += 1
        console.error(
          `[explicit-links] close failed: no active edge from ${params.sourceKind}:${params.sourceId} ` +
            `to ${targetKind}:${close.targetEntityId}` +
            (close.edgeType ? ` with edgeType=${close.edgeType}` : ''),
        )
        continue
      }
      const validTo = close.validTo ? new Date(close.validTo) : new Date()
      const result = await params.entityLinks.closeAt(params.userId, match.id, validTo)
      if (!result) {
        failed += 1
        console.error(
          `[explicit-links] close failed: store.closeAt returned null for edge id=${match.id}`,
        )
        continue
      }
      closed += 1
    } catch (err) {
      failed += 1
      console.error(
        `[explicit-links] close failed (source=${params.sourceKind}:${params.sourceId} ` +
          `target=${targetKind}:${close.targetEntityId} edge=${close.edgeType ?? 'any'}):`,
        err,
      )
    }
  }
  return { closed, failed }
}

export function formatClosesSummary(summary: { closed: number; failed: number }): string {
  if (summary.closed === 0 && summary.failed === 0) return ''
  if (summary.failed === 0) {
    return summary.closed === 1
      ? ' (1 edge closed)'
      : ` (${summary.closed} edges closed)`
  }
  return ` (${summary.closed} edge(s) closed, ${summary.failed} failed — see logs)`
}

/** Short summary suitable for appending to a tool result string. */
export function formatLinksSummary(summary: { created: number; failed: number }): string {
  if (summary.created === 0 && summary.failed === 0) return ''
  if (summary.failed === 0) {
    return summary.created === 1
      ? ' (1 edge linked)'
      : ` (${summary.created} edges linked)`
  }
  return ` (${summary.created} edge(s) linked, ${summary.failed} failed — see logs)`
}
