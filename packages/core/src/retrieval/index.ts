// Retrieval primitive — 6-tool surface that exposes the company brain.
//
// types.ts — envelope, cursor, error model, per-tool input/output, RetrievalStore interface
// tools.ts — createRetrievalTools(store, opts?) factory backed by RetrievalStore
//
// Spec: docs/architecture/brain/retrieval-layer.md.
// WU-5.1 scaffolds the contract only; store implementations land in WU-5.2–5.7.

export {
  type ApiVersion,
  type RetrievalCursor,
  type RetrievalMeta,
  type RetrievalEnvelope,
  type RetrievalErrorBody,
  type RetrievalResult,
  type RetrievalActor,
  type RetrievalFilters,
  type FollowedSupersession,
  type GetEntityInput,
  type GetEntityData,
  type GetEntityLimits,
  type EntitySummaryCounts,
  type SearchInput,
  type SearchData,
  type SearchResultRow,
  type RecentEpisodesInput,
  type RecentEpisodesData,
  type RecentEpisodeRow,
  type ProvenanceInput,
  type ProvenanceData,
  type ProvenanceSourceEpisode,
  type ProvenanceDerivedRef,
  type MarkUsefulInput,
  type MarkUsefulData,
  type MarkUsefulPrimitive,
  type AggregateInput,
  type AggregateData,
  type AggregateResultRow,
  type AggregateMeasure,
  type RowStatus,
  type RowHistoryPrimitive,
  type RowHistoryInput,
  type RowHistoryVersion,
  type RowHistoryData,
  type RetrievalStore,
  type RetrievalToolEvent,
  type EntityInstanceSearchRow,
  type RetrievalStep,
  type RetrievalStepName,
  type RetrievalStepCandidate,
} from './types.js'

export {
  type RetrievalToolOptions,
  createRetrievalTools,
} from './tools.js'

// WS-5 W5c additions (coordinator-wired).
export * from './layer-1-topic-index.js'
export * from './rrf.js'
export * from './mmr.js'
export * from './trust-signals.js'
