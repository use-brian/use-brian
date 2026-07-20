/**
 * Edge vocabulary for `entity_links` (the universal graph layer).
 *
 * Pure constants + types + plain-TS validators. No DB access, no Zod. The
 * full DB row type lives in `entities/types.ts` (WU-1.2); call sites that
 * write edges (WU-1.7, Pipeline B in WU-3.6) layer this vocabulary on top.
 *
 * Spec: docs/architecture/brain/data-model.md §Edge vocabulary. When
 * adding a new edge, update the table in data-model.md first (and its
 * brian-kb/ pair), then mirror it here.
 */

// ── Endpoint kinds ─────────────────────────────────────────────────

/**
 * Valid `source_kind` / `target_kind` values on entity_links.
 *
 * `'workspace'` is included because the workspace-level edges
 * (`target_investor`, `target_competitor`) source from a workspace and
 * are not themselves entities.
 *
 * `'page'` (a doc `saved_views` row) and `'entity_instance'` (a doc
 * user-defined row) are the doc surfaces — added for the `detail_page_of`
 * binding (Notion-style "a row is a page"). See
 * `docs/plans/doc-entity-detail-page.md`. The vocabulary lands first; the
 * write path (resolve-or-create + store endpoint-existence checks) is a
 * follow-up, so these are INERT until a writer emits `detail_page_of`.
 */
export const LINK_ENDPOINT_KINDS = [
  'entity',
  'memory',
  'kb_chunk',
  'task',
  'event',
  'file',
  'episode',
  'workspace',
  'page',
  'entity_instance',
] as const
export type LinkEndpointKind = (typeof LINK_ENDPOINT_KINDS)[number]

// ── Entity kinds ───────────────────────────────────────────────────

/**
 * System `entities.kind` values per data-model.md:46. Used to narrow
 * the from/to constraints on edges whose endpoints are entities (e.g.
 * `works_at` requires the source entity to be a `person`). `repository`
 * is the newest member (added for code-repo extraction); edge specs
 * referencing it inherit the same validation surface as project/product.
 */
export const ENTITY_KINDS = ['person', 'company', 'project', 'product', 'deal', 'repository'] as const
export type EntityKind = (typeof ENTITY_KINDS)[number]

// ── Edge vocabulary ────────────────────────────────────────────────

/**
 * Every locked edge type in the graph. Order mirrors the SV waves in
 * data-model.md:210–230 so diff review against the spec is mechanical.
 */
export const EDGE_TYPES = [
  // Initial (locked)
  'works_at',
  'attended',
  'discussed_in',
  'represents',
  'mentioned',
  'signed_contract_with',
  'competes_with',
  'customer_since',
  // SV (2026-05-14)
  'engagement_of',
  'target_investor',
  'outreach_strategy_for',
  'mutual_connection',
  'discussed_with',
  'depends_on',
  'mentioned_publicly_at',
  // SV(2) (2026-05-14)
  'target_competitor',
  'documented_by',
  'platform_engagement_for',
  'replies_to',
  // Doc — entity detail page (2026-06-04)
  'detail_page_of',
] as const
export type EdgeType = (typeof EDGE_TYPES)[number]

// ── Typed attribute shapes (documented JSONB conventions) ──────────

/**
 * Per data-model.md:232 and decisions-log §SV (2026-05-14): `audience_clearance`
 * gates IFC sensitivity ceiling at outbound-compose time. Default is `'public'`
 * when unset.
 */
export type TargetInvestorAttributes = {
  audience_clearance?: 'public' | 'internal'
  preference_summary?: string
  last_digest_episode_id?: string
}

/** Per data-model.md:232 — same shape family as target_investor. */
export type TargetCompetitorAttributes = {
  tracking_focus?: string
  last_signal_episode_id?: string
}

/**
 * Per data-model.md:228 + decisions-log §SV(2) (2026-05-14): commit SHA
 * provides provenance back to the doc revision that produced the edge.
 */
export type DocumentedByAttributes = {
  commit_sha?: string
}

/**
 * Discriminated lookup: `EdgeAttributesFor<'target_investor'>` resolves to
 * `TargetInvestorAttributes`; other edge types fall back to the loose
 * `Record<string, unknown>` (the spec says new attribute keys register
 * via allowlist when first emitted).
 */
export type EdgeAttributesFor<E extends EdgeType> =
  E extends 'target_investor' ? TargetInvestorAttributes :
  E extends 'target_competitor' ? TargetCompetitorAttributes :
  E extends 'documented_by' ? DocumentedByAttributes :
  Record<string, unknown>

// ── Edge spec table ────────────────────────────────────────────────

export type EdgeSpec = {
  /** Allowed `source_kind` values. */
  readonly fromKinds: readonly LinkEndpointKind[]
  /**
   * When `'entity'` is in `fromKinds`, narrows which `entities.kind`
   * values are valid on the source. Omit to allow any entity kind.
   */
  readonly fromEntityKinds?: readonly EntityKind[]
  readonly toKinds: readonly LinkEndpointKind[]
  readonly toEntityKinds?: readonly EntityKind[]
  /** Tag for typed attribute validation; absent means loose-JSONB. */
  readonly attributesShape?: 'target_investor' | 'target_competitor' | 'documented_by'
  readonly description: string
}

/**
 * 1:1 with data-model.md:210–230. `customer_since` targets `workspace`
 * (Acme is a customer **of the workspace**); the date itself lives in
 * `attributes.since`, not as a typed target.
 */
export const EDGE_SPECS: Record<EdgeType, EdgeSpec> = {
  works_at: {
    fromKinds: ['entity'],
    fromEntityKinds: ['person'],
    toKinds: ['entity'],
    toEntityKinds: ['company'],
    description: 'Person works at company',
  },
  attended: {
    fromKinds: ['entity'],
    fromEntityKinds: ['person'],
    toKinds: ['episode'],
    description: 'Person attended an episode',
  },
  discussed_in: {
    fromKinds: ['entity'],
    toKinds: ['episode'],
    description: 'Entity was discussed in an episode',
  },
  represents: {
    fromKinds: ['entity'],
    fromEntityKinds: ['person'],
    toKinds: ['entity'],
    toEntityKinds: ['deal'],
    description: 'Person represents a deal',
  },
  mentioned: {
    fromKinds: LINK_ENDPOINT_KINDS,
    toKinds: ['entity'],
    description: 'Source row mentions an entity',
  },
  signed_contract_with: {
    fromKinds: ['entity'],
    fromEntityKinds: ['company'],
    toKinds: ['entity'],
    toEntityKinds: ['company'],
    description: 'Company signed a contract with another company',
  },
  competes_with: {
    fromKinds: ['entity'],
    fromEntityKinds: ['company'],
    toKinds: ['entity'],
    toEntityKinds: ['company'],
    description: 'Company competes with another company',
  },
  customer_since: {
    fromKinds: ['entity'],
    fromEntityKinds: ['company'],
    toKinds: ['workspace'],
    description: 'Company is a customer of the workspace (since date in attributes)',
  },
  engagement_of: {
    fromKinds: ['entity'],
    fromEntityKinds: ['deal'],
    toKinds: ['entity'],
    toEntityKinds: ['company'],
    description: 'Deal engagement belongs to a company',
  },
  target_investor: {
    fromKinds: ['workspace'],
    toKinds: ['entity'],
    toEntityKinds: ['company', 'person'],
    attributesShape: 'target_investor',
    description: 'Workspace tracks a target investor (company or person)',
  },
  outreach_strategy_for: {
    fromKinds: ['memory'],
    toKinds: ['entity'],
    description: 'Strategy memory applies to a target entity',
  },
  mutual_connection: {
    fromKinds: ['entity'],
    fromEntityKinds: ['person'],
    toKinds: ['entity'],
    toEntityKinds: ['person'],
    description: 'Two people share a mutual connection',
  },
  discussed_with: {
    fromKinds: ['entity'],
    fromEntityKinds: ['person'],
    toKinds: ['entity'],
    toEntityKinds: ['person'],
    description: 'One person discussed a topic with another',
  },
  depends_on: {
    fromKinds: ['task'],
    toKinds: ['task'],
    description: 'Task depends on another task',
  },
  mentioned_publicly_at: {
    fromKinds: ['entity'],
    toKinds: ['episode'],
    description: 'Entity was mentioned publicly at an episode',
  },
  target_competitor: {
    fromKinds: ['workspace'],
    toKinds: ['entity'],
    toEntityKinds: ['company', 'person'],
    attributesShape: 'target_competitor',
    description: 'Workspace tracks a target competitor (company or person)',
  },
  documented_by: {
    fromKinds: ['entity'],
    toKinds: ['file'],
    attributesShape: 'documented_by',
    description: 'Entity is documented by a file (commit_sha in attributes)',
  },
  platform_engagement_for: {
    fromKinds: ['memory'],
    toKinds: ['entity'],
    description: 'Engagement-metric memory attributed to a post entity',
  },
  replies_to: {
    fromKinds: ['episode'],
    toKinds: ['episode'],
    description: 'Inbound reply episode references the outbound episode it replies to',
  },
  detail_page_of: {
    fromKinds: ['page'],
    toKinds: ['entity', 'task', 'entity_instance'],
    description: 'Doc page is the detail page of an entity / task / user-defined row',
  },
}

// ── Type guards ────────────────────────────────────────────────────

export function isEdgeType(s: unknown): s is EdgeType {
  return typeof s === 'string' && (EDGE_TYPES as readonly string[]).includes(s)
}

export function isLinkEndpointKind(s: unknown): s is LinkEndpointKind {
  return typeof s === 'string' && (LINK_ENDPOINT_KINDS as readonly string[]).includes(s)
}

export function isEntityKind(s: unknown): s is EntityKind {
  return typeof s === 'string' && (ENTITY_KINDS as readonly string[]).includes(s)
}

export function getEdgeSpec(type: EdgeType): EdgeSpec {
  return EDGE_SPECS[type]
}

// ── Edge input + validation ────────────────────────────────────────

export type EdgeInput<E extends EdgeType = EdgeType> = {
  edge_type: E
  source_kind: LinkEndpointKind
  source_id: string
  /** Required when source_kind === 'entity' to enforce per-edge entity kind constraints. */
  source_entity_kind?: EntityKind
  target_kind: LinkEndpointKind
  target_id: string
  /** Required when target_kind === 'entity' to enforce per-edge entity kind constraints. */
  target_entity_kind?: EntityKind
  attributes?: EdgeAttributesFor<E>
}

export type ValidateEdgeResult = { ok: true } | { ok: false; reason: string }

const TARGET_INVESTOR_CLEARANCES = ['public', 'internal'] as const
const TARGET_INVESTOR_KEYS = new Set([
  'audience_clearance',
  'preference_summary',
  'last_digest_episode_id',
])
const TARGET_COMPETITOR_KEYS = new Set(['tracking_focus', 'last_signal_episode_id'])
const DOCUMENTED_BY_KEYS = new Set(['commit_sha'])

function validateAttributes(spec: EdgeSpec, attrs: Record<string, unknown> | undefined): ValidateEdgeResult {
  if (!spec.attributesShape || !attrs) return { ok: true }
  const keys = Object.keys(attrs)
  switch (spec.attributesShape) {
    case 'target_investor': {
      for (const k of keys) {
        if (!TARGET_INVESTOR_KEYS.has(k)) {
          return { ok: false, reason: `target_investor: unknown attribute "${k}"` }
        }
      }
      const ac = attrs.audience_clearance
      if (ac !== undefined && !(TARGET_INVESTOR_CLEARANCES as readonly unknown[]).includes(ac)) {
        return {
          ok: false,
          reason: `target_investor.audience_clearance must be 'public' or 'internal', got ${JSON.stringify(ac)}`,
        }
      }
      for (const k of ['preference_summary', 'last_digest_episode_id'] as const) {
        if (attrs[k] !== undefined && typeof attrs[k] !== 'string') {
          return { ok: false, reason: `target_investor.${k} must be a string when set` }
        }
      }
      return { ok: true }
    }
    case 'target_competitor': {
      for (const k of keys) {
        if (!TARGET_COMPETITOR_KEYS.has(k)) {
          return { ok: false, reason: `target_competitor: unknown attribute "${k}"` }
        }
      }
      for (const k of ['tracking_focus', 'last_signal_episode_id'] as const) {
        if (attrs[k] !== undefined && typeof attrs[k] !== 'string') {
          return { ok: false, reason: `target_competitor.${k} must be a string when set` }
        }
      }
      return { ok: true }
    }
    case 'documented_by': {
      for (const k of keys) {
        if (!DOCUMENTED_BY_KEYS.has(k)) {
          return { ok: false, reason: `documented_by: unknown attribute "${k}"` }
        }
      }
      if (attrs.commit_sha !== undefined && typeof attrs.commit_sha !== 'string') {
        return { ok: false, reason: 'documented_by.commit_sha must be a string when set' }
      }
      return { ok: true }
    }
  }
}

/**
 * Runtime validator for edge inputs. Returns a discriminated result so
 * callers can branch without throwing. Used by Pipeline B (WU-3.6) and
 * edge-write hooks (WU-1.7) before insert.
 */
export function validateEdge<E extends EdgeType>(input: {
  edge_type: E
  source_kind: LinkEndpointKind
  source_entity_kind?: EntityKind
  target_kind: LinkEndpointKind
  target_entity_kind?: EntityKind
  attributes?: EdgeAttributesFor<E>
}): ValidateEdgeResult {
  if (!isEdgeType(input.edge_type)) {
    return { ok: false, reason: `unknown edge_type "${String(input.edge_type)}"` }
  }
  const spec = EDGE_SPECS[input.edge_type]

  if (!(spec.fromKinds as readonly string[]).includes(input.source_kind)) {
    return {
      ok: false,
      reason: `${input.edge_type}: source_kind "${input.source_kind}" not allowed; expected one of ${spec.fromKinds.join(', ')}`,
    }
  }
  if (input.source_kind === 'entity' && spec.fromEntityKinds) {
    if (!input.source_entity_kind) {
      return { ok: false, reason: `${input.edge_type}: source_entity_kind required when source_kind='entity'` }
    }
    if (!(spec.fromEntityKinds as readonly string[]).includes(input.source_entity_kind)) {
      return {
        ok: false,
        reason: `${input.edge_type}: source_entity_kind "${input.source_entity_kind}" not allowed; expected one of ${spec.fromEntityKinds.join(', ')}`,
      }
    }
  }

  if (!(spec.toKinds as readonly string[]).includes(input.target_kind)) {
    return {
      ok: false,
      reason: `${input.edge_type}: target_kind "${input.target_kind}" not allowed; expected one of ${spec.toKinds.join(', ')}`,
    }
  }
  if (input.target_kind === 'entity' && spec.toEntityKinds) {
    if (!input.target_entity_kind) {
      return { ok: false, reason: `${input.edge_type}: target_entity_kind required when target_kind='entity'` }
    }
    if (!(spec.toEntityKinds as readonly string[]).includes(input.target_entity_kind)) {
      return {
        ok: false,
        reason: `${input.edge_type}: target_entity_kind "${input.target_entity_kind}" not allowed; expected one of ${spec.toEntityKinds.join(', ')}`,
      }
    }
  }

  return validateAttributes(spec, input.attributes as Record<string, unknown> | undefined)
}

/**
 * Type-safe edge-input constructor. Throws on invalid combinations so
 * callers can't silently bypass the spec. Returns the input verbatim
 * (the DB row type — id, timestamps, sensitivity — is layered on top
 * by WU-1.2's entity-links-store).
 */
export function makeEdgeInput<E extends EdgeType>(input: EdgeInput<E>): EdgeInput<E> {
  const result = validateEdge({
    edge_type: input.edge_type,
    source_kind: input.source_kind,
    source_entity_kind: input.source_entity_kind,
    target_kind: input.target_kind,
    target_entity_kind: input.target_entity_kind,
    attributes: input.attributes,
  })
  if (!result.ok) {
    throw new Error(`Invalid edge input: ${result.reason}`)
  }
  return input
}
