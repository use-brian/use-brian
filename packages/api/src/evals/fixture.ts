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

/**
 * Tools whose semantics a generic ack would distort. proposeWorkflow is
 * read-only (it renders a preview card), so the generic read stub ("No
 * matching records") reads as a FAILED proposal and derails the model into
 * retry loops — the very WS9-critical probe the battery exists to grade.
 */
const SEMANTIC_ACKS: Record<string, string> = {
  proposeWorkflow: 'Proposal recorded and shown to the user as a preview card for approval.',
}

function stubExecute(tool: Tool): Tool {
  return {
    ...tool,
    // Probes grade proposals and execution is stubbed (no write can land),
    // so the approval flow is bypassed: the eval context has no confirmation
    // channel, and a requiresConfirmation tool would otherwise be
    // visible-but-rejected ("requires user confirmation but no confirmation
    // channel is available") — the same phantom wall as the capability gate.
    requiresConfirmation: false,
    resolveConfirmation: undefined,
    // Coherent with the frozen fixture semantics (fresh workspace, empty
    // KB): reads report an empty workspace so the model proceeds to the
    // write on a later turn; writes acknowledge without side effects. An
    // error-ish stub ("execution disabled") makes the model treat tools as
    // broken and derails the very proposal being graded — and any meta
    // framing on the write ack ("no real write occurred") reads as a
    // failed/blocked write and manufactures phantom-permission narratives.
    // The ack must be indistinguishable from a plain success.
    execute: async () => ({
      data:
        SEMANTIC_ACKS[tool.name] ??
        (tool.isReadOnly
          ? 'No matching records — this workspace is new and has no data yet.'
          : 'Done.'),
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
  /**
   * Capabilities active in the frozen state (§3: tasks enabled; crm implied
   * by the probe expectations). MUST be passed as `context.activeCapabilities`
   * by the runner: the fixture bypasses the route-level visibility filter
   * (`filterToolsByCapabilities`), but the tool executor's belt-and-braces
   * gate still runs per call — with no set, every `requiresCapability` tool
   * returns "requires the '<cap>' capability, which is not granted", which
   * the SUT honestly reports and the judge misreads as confabulation (the
   * 2026-07-07 phantom-permission mis-finding).
   */
  activeCapabilities: ReadonlySet<string>
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

  // Frozen-state capability grants: 'tasks' (§3 explicit) + 'crm' (probe
  // expectations require saveContact/listDeals callable). The other declared
  // capability ids (files/views/goals/bug_triage) gate builders this fixture
  // does not inject.
  const activeCapabilities: ReadonlySet<string> = new Set(['crm', 'tasks'])

  return { systemPrompt, tools, unavailable, activeCapabilities }
}
