/**
 * In-memory fixture workspace for the capability probe battery (D4,
 * docs/plans/behavioral-evals.md §1/§3).
 *
 * Frozen state the probes' expected answers assume:
 *   gcal CONNECTED · Jira/Slack/other connectors ABSENT · KB empty ·
 *   tasks enabled.
 *
 * The toolset comes from the REAL core builders — real names, schemas,
 * and descriptions (the trigger description derived from
 * WORKFLOW_TRIGGER_KINDS is exactly the seam WS9 audited) — constructed
 * against a universal stub deps object, then every tool's `execute` is
 * wholesale-replaced with a no-op stub: probes grade PROPOSALS, a probe
 * turn must never write anywhere. "gcal connected" is toolset
 * composition (real gcal tools injected); "Jira absent" is the
 * unavailable-capabilities block, derived from OFFICIAL_CONNECTORS
 * (never a hardcoded all-builtins list — CLAUDE.md drift rule).
 *
 * Stated v1 deviation from full boot parity: boot.ts assembles the prod
 * map inline against ~20 live stores (closed tools, connector variants,
 * skills listing preamble). The subset here covers every domain the
 * battery probes; boot-parity assembly is a v1.1 hardening item.
 * [COMP:evals/capability-probes]
 */

import {
  LAYER_1_SYSTEM_PROMPT,
  createCrmTools,
  createDocTools,
  createGoogleCalendarTools,
  createMemoryTools,
  createRetrievalTools,
  createSchedulingTools,
  createTaskTools,
  createWorkflowBrainTools,
  createWorkspaceTools,
  createWorkflowTools,
  type Tool,
} from '@sidanclaw/core'
import { OFFICIAL_CONNECTORS } from '@sidanclaw/shared/connector-registry'

import { buildUnavailableCapabilitiesPrompt } from '../routes/route-helpers.js'

/**
 * Universal deps stub: any property access yields another stub, callable
 * as an async function returning null / empty. Builders only need deps to
 * survive CONSTRUCTION — every execute is replaced below, so no stub is
 * ever exercised by a probe turn.
 */
function anyStub(): never {
  const fn = () => stub
  const stub: never = new Proxy(fn, {
    get: (_t, prop) => {
      if (prop === 'then') return undefined // never thenable — breaks await-chains cleanly
      return stub
    },
    apply: () => Promise.resolve(null),
  }) as never
  return stub
}

function stubExecute(tool: Tool): Tool {
  return {
    ...tool,
    // Coherent with the frozen fixture semantics (fresh workspace, empty
    // KB): reads report an empty workspace so the model proceeds to the
    // write on a later turn; writes acknowledge without side effects. An
    // error-ish stub ("execution disabled") makes the model treat tools as
    // broken and derails the very proposal being graded.
    execute: async () => ({
      data: tool.isReadOnly
        ? 'No matching records — this workspace is new and has no data yet.'
        : 'Done (recorded in the eval fixture; no real write occurred).',
    }),
  }
}

function addAll(map: Map<string, Tool>, tools: Tool[] | Record<string, Tool>): void {
  const list = Array.isArray(tools) ? tools : Object.values(tools)
  for (const t of list) {
    if (t && typeof t === 'object' && 'name' in t && 'execute' in t) {
      map.set(t.name, stubExecute(t))
    }
  }
}

export type FixtureWorkspace = {
  systemPrompt: string
  tools: Map<string, Tool>
  /** Connector ids listed as unavailable this turn (everything official except gcal). */
  unavailable: string[]
}

export function buildFixtureWorkspace(): FixtureWorkspace {
  const tools = new Map<string, Tool>()

  // Real builders, stub deps, stubbed execute. Each call is isolated so a
  // builder whose construction genuinely needs live deps fails loudly here
  // (a fixture gap), not silently at probe time.
  addAll(tools, createWorkflowTools(anyStub()))
  addAll(tools, createSchedulingTools(anyStub()))
  addAll(tools, createTaskTools(anyStub(), anyStub()))
  addAll(tools, createCrmTools(anyStub()))
  addAll(tools, createMemoryTools(anyStub()))
  addAll(tools, createRetrievalTools(anyStub()))
  addAll(tools, createWorkflowBrainTools(anyStub()))
  addAll(tools, createWorkspaceTools(anyStub()))
  addAll(tools, createDocTools(anyStub()))
  // gcal is the one CONNECTED connector in the frozen state.
  addAll(tools, createGoogleCalendarTools(anyStub()))

  // Everything official except gcal is absent — derived, never hardcoded.
  const unavailable = OFFICIAL_CONNECTORS.map((c) => c.id).filter((id) => id !== 'gcal')

  const systemPrompt =
    LAYER_1_SYSTEM_PROMPT + '\n\n' + buildUnavailableCapabilitiesPrompt(unavailable)

  return { systemPrompt, tools, unavailable }
}
