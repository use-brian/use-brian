export { queryLoop } from './query-loop.js'
export type { QueryEvent, QueryLoopOptions } from './query-loop.js'
export { createToolExecutor } from './tool-executor.js'
export type { ToolExecutor, ToolExecutorOptions } from './tool-executor.js'
export { createLoopDetector, DEFAULT_HARD_LIMIT } from './loop-detector.js'
export type { LoopDetector, LoopAction } from './loop-detector.js'
export {
  resolveResearchBudget,
  ResearchDepthConfigSchema,
  RESEARCH_DEPTH_TIERS,
  RESEARCH_BUDGET_CEILING,
  RESEARCH_BUDGET_FLOOR,
  ASSISTANT_CALL_DEFAULT_BUDGET,
} from './research-depth.js'
export type {
  ResearchDepthTier,
  ResearchDepthConfig,
  ResearchBudget,
} from './research-depth.js'
export {
  synthesizeMissingToolResults,
  ensureToolResultPairing,
  stripUnsignedToolUses,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
} from './tool-pairing.js'
export {
  elideStaleDocToolResults,
  DOC_PAGE_STATE_TOOLS,
  KEEP_RECENT_DOC_RESULTS,
  ELIDED_DOC_RESULT_PLACEHOLDER,
} from './doc-history.js'
export type {
  EngineHooks,
  ToolUseHookContext,
  PreToolUseDirective,
  PostToolUseHookContext,
} from './hooks.js'
