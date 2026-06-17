// Entity primitive — canonical anchor for the company-brain graph.
//
// Three concerns split across this directory:
//   - types.ts  : record + interface types, store contracts, resolver-helper types
//   - edges.ts  : edge vocabulary metadata + typed attribute shapes + validators
//   - resolver.ts : 4-tier entity resolution algorithm (exact / canonical / fuzzy / LLM)
//
// Where types.ts and edges.ts overlap (EDGE_TYPES, LinkKind aliases, EntityKind),
// this barrel disambiguates: types.ts owns the broader EntityKind (with tenant.*
// namespacing per data-model.md), edges.ts owns the rich edge metadata layer.

export {
  SYSTEM_ENTITY_KINDS,
  ENTITY_SOURCES,
  EDGE_TYPES,
  LINK_KINDS,
  type SystemEntityKind,
  type EntityKind,
  type EntitySource,
  type EdgeType,
  type LinkKind,
  type EntityRecord,
  type EntityListRow,
  type EntityCreateParams,
  type EntityUpdateFields,
  type EntitySupersedePatch,
  type EntityLinkRecord,
  type EntityLinkCreateParams,
  type EntityRollupSummary,
  type EntityRollupEmbedded,
  type EntityRollup,
  type GetEntityOpts,
  type EntityStore,
  type EntityLinksStore,
  type EntityCandidate,
  type EntityMention,
  type DuplicateClusterRow,
  type CrossKindClusterRow,
} from './types.js'

export {
  type TargetInvestorAttributes,
  type TargetCompetitorAttributes,
  type DocumentedByAttributes,
  type EdgeAttributesFor,
  type EdgeSpec,
  EDGE_SPECS,
  type EdgeInput,
  type ValidateEdgeResult,
  isEdgeType,
  isLinkEndpointKind,
  getEdgeSpec,
  validateEdge,
  makeEdgeInput,
} from './edges.js'

export {
  type ResolveTier,
  type ResolveResult,
  type ResolveOptions,
  normalizeName,
  jaroWinkler,
  resolveEntity,
} from './resolver.js'

export {
  explicitLinkInputShape,
  explicitLinksField,
  explicitCloseInputShape,
  explicitClosesField,
  isoDateOrDateTime,
  applyExplicitLinks,
  applyExplicitCloses,
  formatLinksSummary,
  formatClosesSummary,
  type ExplicitLinkInput,
  type ExplicitCloseInput,
  type ApplyLinksParams,
  type ApplyClosesParams,
} from './explicit-links.js'

// ── Doc brain-first entity layer (Phase 1) ──────────────────────────
// User-defined entity types alongside built-in primitives (tasks, CRM,
// workflows). The Doc* prefix on EntityType/EntityInstance/EntityStore
// avoids collision with the brain-anchor `EntityRecord`/`EntityStore` above.
// See docs/plans/doc-v1-execution.md § 5.1 and
// .claude/plans/snuggly-noodling-tiger.md § Lock #11.

export {
  type PropertyKind,
  type PropertyConfig,
  type PropertyDef,
  type SelectOption,
  type StatusGroup,
  type EntityTypeRef as DocEntityTypeRef,
  type CellValue,
  type EntityType as DocEntityType,
  type EntityInstance as DocEntityInstance,
  type EntityStore as DocEntityStore,
  type EntityFilter as DocEntityFilter,
  type EntitySort as DocEntitySort,
} from './doc-types.js'

export {
  propertyKindSchema,
  propertyConfigSchema,
  propertyDefSchema,
  selectOptionSchema,
  statusGroupSchema,
  entityTypeRefSchema as docEntityTypeRefSchema,
  cellValueSchema,
  entityTypeSchema as docEntityTypeSchema,
  entityInstanceSchema as docEntityInstanceSchema,
  entityFilterSchema as docEntityFilterSchema,
  entitySortSchema as docEntitySortSchema,
} from './doc-schemas.js'

export * from './doc-built-ins.js'
export * from './doc-tools.js'
