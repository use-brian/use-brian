export * from './providers/index.js'
export * from './tools/index.js'
export * from './engine/index.js'
export { LAYER_1_SYSTEM_PROMPT, FOLLOW_UP_QUESTIONS_ADDENDUM, RESEARCH_MODE_ADDENDUM, COORDINATOR_BASE_ADDENDUM, COORDINATOR_RESEARCH_ADDENDUM } from './system-prompt.js'
export * from './memory/index.js'
export * from './tasks/index.js'
export * from './crm/index.js'
export * from './workspace/index.js'
export * from './entities/index.js'
export * from './classification/index.js'
export * from './corrections/index.js'
export * from './brain/index.js'
export * from './retrieval/index.js'
export * from './inspection/index.js'
export * from './workflow/index.js'
export * from './workflows/index.js'
export * from './views/index.js'
export * from './compaction/index.js'
export * from './workers/index.js'
export * from './scheduling/index.js'
export * from './files/index.js'
export * from './workspace-files/index.js'
export * from './mcp/index.js'
export * from './analytics/index.js'
export * from './billing/index.js'
export * from './consolidation/index.js'
export * from './security/index.js'
export * from './knowledge/index.js'
export * from './skills/index.js'
export * from './media/index.js'
export { generateHandle, validateHandle } from './handles.js'
export * from './inter-assistant/index.js'
export * from './a2a/index.js'
export * from './authorization/index.js'
export * from './control-plane/index.js'
export * from './doc/index.js'
export * from './home/index.js'

// Ingest engine — Pipeline B + routing executor + adapters. The API
// package wires concrete implementations of the engine ports (pipelineB,
// rulesStore, batches, placeholderResolver, onAlert) at app-boot time.
// See packages/core/src/ingest/index.ts for the full surface.
export * from './ingest/index.js'

// Source adapters — normalisers for inbound webhook events. Each adapter
// converts platform-native payloads into the universal Episode envelope.
// (Gmail had an ingest adapter; it was removed when Gmail ceased to be an
// ingestion source. Gmail remains a send/read connector — see
// packages/api/src/google/client.ts.)
export * from './ingest/adapters/slack/index.js'
export * from './ingest/adapters/github/index.js'
export * from './ingest/adapters/calendar/index.js'
export * from './ingest/adapters/fathom/index.js'

// Embedding worker surface — the worker factory + Gemini embedder are the
// boot-time public API (started from `apps/api`); `EMBEDDED_PRIMITIVES` is
// the narrow registry constant admin observability enumerates. The
// `EmbeddingStore` interface is fulfilled by `packages/api/src/db/embedding-store.ts`.
export {
  EMBEDDED_PRIMITIVES,
  createEmbeddingWorker,
  type EmbeddingPrimitive,
  type EmbeddingCandidate,
  type EmbeddingResult,
  type EmbeddingFailure,
  type EmbeddingStore,
  type EmbeddingWorkerOptions,
} from './embeddings/worker.js'
export {
  createGeminiEmbedder,
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MODEL_ID,
  type Embedder,
} from './embeddings/embedder.js'
