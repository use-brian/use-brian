export { applyOutputRevisions, outputContentDigest } from '@use-brian/agent-runtime/engine/output-provenance.js'
export type { QueryOutputProvenance, OutputRecord, OutputRevision, OutputDisposition } from '@use-brian/agent-runtime/engine/output-provenance.js'
// The core-composed loop (default ports wired); see query-loop-defaults.ts.
export { queryLoop } from './query-loop-defaults.js'
export { assertModelInputAuthority, assertModelOutputAuthority, assertOutputOperationAuthority, isConnectionDropError, isEndpointUnreachableError, streamErrorCode, streamErrorCodes } from '@use-brian/agent-runtime/engine/query-loop.js'
export type { QueryLoopPorts, ToolSchemaSelector, RoutineReadPhase } from '@use-brian/agent-runtime/engine/query-loop-ports.js'
export type { ToolSelectionOptions, ToolSelectionResult } from './tool-selection.js'
export type { RoutineReadOptions } from './routine-read.js'
export type { QueryEvent, QueryLoopOptions, QueryUsageSnapshot, TerminalStopReason } from '@use-brian/agent-runtime/engine/query-loop.js'
export { createTurnOutputCollector } from '@use-brian/agent-runtime/engine/turn-output.js'
export type {
  TurnOutputCollector,
  FinalizedOutputSelection,
  TurnOutputEmptyReason,
  TurnOutputFormat,
  TurnOutputSelection,
} from '@use-brian/agent-runtime/engine/turn-output.js'
export {
  matchesDisputedFigure,
  buildDisputeContextNote,
} from '@use-brian/agent-runtime/engine/grounding-gate.js'
export {
  formatMidTurnInput,
  resolveDrainMode,
  shouldInterruptStreamForSteer,
  MID_TURN_INPUT_MAX_CHARS,
} from '@use-brian/agent-runtime/engine/turn-inbox.js'
export type {
  MidTurnInputMode,
  PendingTurnInput,
  TurnInboxPeek,
  TurnInboxPort,
} from '@use-brian/agent-runtime/engine/turn-inbox.js'
export { createToolExecutor, formatToolError, NO_TOOL_TIMEOUT } from '@use-brian/agent-runtime/engine/tool-executor.js'
export { NOOP_TURN_LEDGER, safeTrace } from '@use-brian/agent-runtime/engine/turn-ledger.js'
export type {
  TurnLedger,
  TurnLedgerActor,
  TurnRetrievalProvenance,
  TurnTrace,
  TurnTraceStart,
} from '@use-brian/agent-runtime/engine/turn-ledger.js'
export {
  createStallWatchdog,
  withStallSignal,
  isStalledError,
  StalledError,
  DEFAULT_STALL_IDLE_MS,
} from '@use-brian/agent-runtime/engine/stall-watchdog.js'
export type { ProgressClock, StallWatchdog, StallInfo } from '@use-brian/agent-runtime/engine/stall-watchdog.js'
export type { ToolExecutor, ToolExecutorOptions } from '@use-brian/agent-runtime/engine/tool-executor.js'
export { createLoopDetector, DEFAULT_HARD_LIMIT } from '@use-brian/agent-runtime/engine/loop-detector.js'
export type { LoopDetector, LoopAction } from '@use-brian/agent-runtime/engine/loop-detector.js'
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
  modelRequiresToolSignatures,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
} from '@use-brian/agent-runtime/engine/tool-pairing.js'
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
} from '@use-brian/agent-runtime/engine/hooks.js'

export {consumeHostReadObservation,combineHostReadObservations,assertHostObservationPublication} from './routine-read.js'
export type {RoutineCalendarCall} from './routine-read.js'
export {inheritRoutineCalendarRead,ownsRoutineCalendarRead,withRoutineCalendarContext} from './routine-read-ownership.js'

export type {HostReadReceipt} from "./routine-read.js"
