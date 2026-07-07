export { createEmbeddingWorker, createEmbeddingUsageRecorder } from './worker.js'
export type {
  EmbeddingPrimitive,
  EmbeddingCandidate,
  EmbeddingResult,
  EmbeddingFailure,
  EmbeddingStore,
  EmbeddingWorkerOptions,
  EmbeddingUsageBatch,
  EmbeddingUsageRecorder,
} from './worker.js'
export {
  createGeminiEmbedder,
  GEMINI_EMBEDDING_DIMENSIONS,
  GEMINI_EMBEDDING_MODEL_ID,
} from './embedder.js'
export type { Embedder } from './embedder.js'
