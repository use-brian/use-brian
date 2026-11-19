/**
 * Injected `queryLoop` ports. [COMP:engine/query-loop-ports]
 *
 * The query loop is part of the runtime file set (M4, docs/plans/
 * oss-chat-m4-runtime-separation-plan.md section 2) and must not import product
 * decision code. The two pre-turn phases that call the decision runtime are
 * therefore ports the caller supplies through `QueryLoopOptions.ports`; core
 * wires its defaults in `query-loop-defaults.ts`, which the `@use-brian/core`
 * root exports as `queryLoop`.
 *
 * The option payloads are augmentable interfaces: the runtime declares only
 * what the loop itself reads, and core adds the decision-runtime fields with
 * `declare module '@use-brian/agent-runtime/engine/query-loop-ports.js'` blocks
 * in core's `tool-selection.ts` and `routine-read.ts`.
 *
 * Spec: docs/architecture/engine/query-loop.md → "Injected runtime ports".
 */
import type { HostObservation } from '@use-brian/shared'
import type { Message, TokenUsage, ToolDefinition } from '../providers/types.js'
import type { Tool } from '../tools/types.js'
import type { LoopDetector } from './loop-detector.js'
import type { QueryEvent, QueryLoopOptions } from './query-loop.js'
import type { TurnTrace } from './turn-ledger.js'

// ── Initial tool-schema selection ─────────────────────────────────────

export type ToolSelectionResult = {
  names: string[]
  model: string | null
  usage: TokenUsage | null
  path: string
  failureKind?: string
  durationMs: number
}

/**
 * `QueryLoopOptions.toolSelection`. Core augments it with the decision runtime
 * route (`runtime`, `llm`, `workspaceId`); see `engine/tool-selection.ts`.
 */
export interface ToolSelectionConfig {
  /** Trusted host input slice with its own current source authority. */
  input?: { messages: Message[]; assertInputAuthority: () => Promise<void> }
  /** Host decision already completed against its admitted preparation inputs. */
  preselected?: readonly string[]
  onResult?: (result: ToolSelectionResult) => void | Promise<void>
}

export type ToolSchemaSelectionInput = ToolSelectionConfig & {
  definitions: ToolDefinition[]
  messages: Message[]
  runId: string
  signal: AbortSignal
  assertInputAuthority: () => Promise<void>
}

/** Advisory schema planning. Only the executor can authorize an action. */
export type ToolSchemaSelector = (input: ToolSchemaSelectionInput) => Promise<ToolSelectionResult>

// ── Host routine read ─────────────────────────────────────────────────

/**
 * `QueryLoopOptions.routineCalendarRead`. Empty on the runtime side: the loop
 * only tests for its presence and hands the whole options object to the
 * `routineRead` port. Core augments it in `engine/routine-read.ts`.
 */
export interface RoutineReadConfig {}

/** Private execution-bound receipt on the host-read `tool_result` event. */
export type HostReadReceipt = Readonly<{ kind: 'host_read' }>

export type RoutineReadPhaseInput = {
  options: QueryLoopOptions
  tools: Map<string, Tool>
  loopDetector: LoopDetector
  deniedTools: Set<string>
  ledger: TurnTrace
  assertInputAuthority: () => Promise<void>
}

export type RoutineReadPhaseResult = {
  messages: Message[]
  complete: boolean
  records: HostObservation[]
  calls: number
}

export type RoutineReadPhase = (input: RoutineReadPhaseInput) => AsyncGenerator<QueryEvent, RoutineReadPhaseResult>

// ── Port set ──────────────────────────────────────────────────────────

export type QueryLoopPorts = {
  /** Required when `toolSelection` needs a model decision (no `preselected`). */
  selectToolSchemas?: ToolSchemaSelector
  /** Required when `routineCalendarRead` is set. */
  routineRead?: RoutineReadPhase
}

/** A configured phase without its port fails loudly; it is never skipped. */
export function requireQueryLoopPort<K extends keyof QueryLoopPorts>(
  ports: QueryLoopPorts | undefined,
  port: K,
  option: string,
): NonNullable<QueryLoopPorts[K]> {
  const value = ports?.[port]
  if (!value) {
    throw new Error(`queryLoop: \`${option}\` is set but no \`ports.${String(port)}\` was supplied. ` +
      `Pass the port, or import \`queryLoop\` from @use-brian/core, which wires the core defaults.`)
  }
  return value as NonNullable<QueryLoopPorts[K]>
}
