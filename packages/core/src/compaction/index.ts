export {
  compactConversation,
  createCompactionCircuitBreaker,
  needsCompaction,
  estimateTokens,
  estimateStringTokens,
  getIdleCompactionLevel,
  extractMemoriesBeforeCompaction,
  parseMultiTopicOutput,
  modelToCompactionTier,
  COMPACT_THRESHOLDS,
  CHANNEL_CLASS_MULTIPLIER,
} from './compact.js'
export type {
  CompactionResult,
  CompactionOptions,
  CompactionTier,
  CompactionProfile,
  ChannelClass,
  EpisodeSection,
  IdleCompactionLevel,
  PreCompactionExtractionOptions,
  PreCompactionExtractionResult,
} from './compact.js'
export { createCacheTool } from './cache-tool.js'
export type { CacheStore } from './cache-tool.js'
