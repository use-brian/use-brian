/**
 * Core composition of the runtime query loop. [COMP:engine/query-loop-ports]
 *
 * `engine/query-loop.ts` belongs to the runtime file set and takes its
 * decision-backed phases as injected ports (`query-loop-ports.ts`). This file
 * stays in core: it binds the core defaults, and callers import this
 * `queryLoop` (`@use-brian/core/engine/query-loop-defaults.js`), so every
 * caller keeps the exact behavior it had before the ports existed. A
 * caller-supplied port replaces only that port.
 *
 * Spec: docs/architecture/engine/query-loop.md → "Injected runtime ports".
 */
import { queryLoop as runtimeQueryLoop, type QueryEvent, type QueryLoopOptions } from '@use-brian/agent-runtime/engine/query-loop.js'
import type { QueryLoopPorts } from '@use-brian/agent-runtime/engine/query-loop-ports.js'
import { executeRoutineCalendarRead } from './routine-read.js'
import { selectInitialToolSchemas } from './tool-selection.js'

// The default ports widen the runtime's `toolSelection` and
// `routineCalendarRead` options by declaration merging. Re-exporting their
// option types keeps both augmenting modules in every importer's type graph
// (a value-only import is elided from the emitted declarations), so a caller
// of this composed loop sees the widened shapes without the deleted root barrel.
export type { ToolSelectionOptions } from './tool-selection.js'
export type { RoutineReadOptions } from './routine-read.js'

const DEFAULT_QUERY_LOOP_PORTS: Required<QueryLoopPorts> = {
  selectToolSchemas: selectInitialToolSchemas,
  routineRead: executeRoutineCalendarRead,
}

export function queryLoop(options: QueryLoopOptions): AsyncGenerator<QueryEvent> {
  const ports: QueryLoopPorts = {
    selectToolSchemas: options.ports?.selectToolSchemas ?? DEFAULT_QUERY_LOOP_PORTS.selectToolSchemas,
    routineRead: options.ports?.routineRead ?? DEFAULT_QUERY_LOOP_PORTS.routineRead,
  }
  return runtimeQueryLoop({ ...options, ports })
}
