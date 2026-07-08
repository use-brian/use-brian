/**
 * The shared AGENT CAPABILITY TOOLSET — the one toolset both agent surfaces
 * inject, each capped at its bound assistant
 * (docs/architecture/integrations/agent-capability-surface.md §3):
 *
 *   brain MCP      → bound to the workspace primary assistant
 *   assistant MCP  → bound to the keyed assistant
 *   public-api chat→ bound to the keyed assistant (same instances)
 *
 * Assembled once at boot from:
 *   - BRIDGE tools  — existing chat-side instances pulled from the boot
 *                     `allTools` map by name (workflows, scheduling,
 *                     corrections, ingest rules, retrieval WS-5 reads,
 *                     inter-assistant).
 *   - BUILD-NEW     — control-plane reads (`createControlPlaneTools`) and
 *                     writes (`createAgentWriteTools`).
 *
 * Tier-1 reads are ungated (clearance-bounded only). Tier-2 writes carry
 * `requiresCapability: 'configure'` and are wrapped per `banding.ts`:
 * Approve-band tools STAGE a `kind='staged_write'` approval instead of
 * executing — the human approves in the web Approvals inbox and the
 * staged-write executor (`staged-write.ts`) then runs the original tool.
 *
 * Component tag: [COMP:agent-surface/toolset].
 */

import {
  buildTool,
  CONFIGURE_CAPABILITY,
  createControlPlaneTools,
  type ControlPlaneReader,
  type Tool,
  type ToolContext,
} from '@sidanclaw/core'
import type { PendingApprovalsStore } from '../db/pending-approvals-store.js'
import { bandOf } from './banding.js'
import { createAgentWriteTools, type AgentWriteToolDeps } from './write-tools.js'

/** BRIDGE candidates pulled from the boot allTools map, by name. */
const BRIDGE_READ_NAMES = [
  // Workflows
  'listWorkflows',
  'getWorkflow',
  'getWorkflowRun',
  'proposeWorkflow', // read-only draft helper
  'listSlackChannels', // read-only: real Slack channel ids for a delivery target
  // WS-5 retrieval reads (getEntity/search already live on the brain MCP)
  'aggregate',
  'recentEpisodes',
  'provenance',
  'getRowHistory',
  // Scheduling + ingest reads
  'searchScheduledJobs',
  'listIngestRules',
  'listConnectorInstances',
  // Inter-assistant
  'listConnectedAssistants',
  'askAssistant',
] as const

const BRIDGE_WRITE_NAMES = [
  // Workflows
  'createWorkflow',
  'updateWorkflow',
  'runWorkflow',
  // Scheduling
  'createScheduledJob',
  'updateScheduledJob',
  'deleteScheduledJob',
  // Ingest rules
  'addIngestRule',
  'updateIngestRule',
  'deleteIngestRule',
  // Corrections
  'retractMemory',
  'deleteBrainRow',
  'reclassifySensitivity',
] as const

export type AgentSurfaceKind = 'brain_mcp' | 'assistant_mcp' | 'public_api'

export type StagedWriteOrigin = {
  surface: AgentSurfaceKind
  /** The authenticating credential id (brain key / api key / oauth grant). */
  credentialId: string
  /** Human-readable origin label for the Approvals inbox provenance stamp. */
  originLabel?: string
}

export type AgentToolsetDeps = {
  /** The boot-time allTools map — source of the BRIDGE instances. */
  allTools: Map<string, Tool>
  controlPlaneReader: ControlPlaneReader
  approvalsStore: PendingApprovalsStore
  writeToolDeps: Omit<AgentWriteToolDeps, 'approvalsStore'>
  /**
   * Resolve the staged-write origin from the per-call context. Each surface
   * stamps its own channelType; channelId always carries the credential id.
   */
  resolveOrigin?: (ctx: ToolContext) => StagedWriteOrigin
}

export type AgentToolset = {
  /** Tier-1 reads — ungated, listed for both key scopes. */
  reads: Map<string, Tool>
  /** Tier-2 writes — configure-gated; Approve-band entries are stage-wrapped. */
  writes: Map<string, Tool>
}

function defaultResolveOrigin(ctx: ToolContext): StagedWriteOrigin {
  const surface: AgentSurfaceKind =
    ctx.channelType === 'assistant_mcp'
      ? 'assistant_mcp'
      : ctx.channelType === 'api'
        ? 'public_api'
        : 'brain_mcp'
  return { surface, credentialId: ctx.channelId }
}

/**
 * Wrap an Approve-band tool: same name/schema/description, but `execute`
 * stages a `staged_write` approval and reports the pending state instead of
 * running. The original tool runs later via `applyStagedWrite` once a human
 * approves. The wrapper preserves `requiresCapability` so the configure
 * gate still applies to the wrapped instance.
 */
function wrapApproveBand(
  tool: Tool,
  deps: {
    approvalsStore: PendingApprovalsStore
    resolveApprover: (ctx: ToolContext) => Promise<string>
    resolveOrigin: (ctx: ToolContext) => StagedWriteOrigin
  },
): Tool {
  return buildTool({
    name: tool.name,
    description:
      `${tool.description} NOTE: this action requires human approval — calling it stages ` +
      'the request in the workspace Approvals inbox and returns immediately; it executes ' +
      'only after a human approves.',
    inputSchema: tool.inputSchema,
    isReadOnly: false,
    isConcurrencySafe: false,
    requiresCapability: tool.requiresCapability ?? CONFIGURE_CAPABILITY,
    async execute(input, ctx) {
      if (!ctx.workspaceId) {
        return { data: 'No workspace bound to this surface.', isError: true }
      }
      const origin = deps.resolveOrigin(ctx)
      const approverUserId = await deps.resolveApprover(ctx)
      const approval = await deps.approvalsStore.createStagedWrite({
        workspaceId: ctx.workspaceId,
        toolName: tool.name,
        toolInput: (input ?? {}) as Record<string, unknown>,
        approverUserId,
        originatingAssistantId: ctx.assistantId,
        surface: origin.surface,
        credentialId: origin.credentialId,
        originLabel: origin.originLabel,
      })
      return {
        data:
          `Staged for human approval (approval ${approval.id}). The ${tool.name} call will ` +
          'execute after a workspace member approves it in the Approvals inbox; check back later.',
      }
    },
  })
}

/**
 * Assemble the shared agent toolset. Built once at boot; the returned maps
 * hold plain `Tool` instances each surface bridges/injects with its own
 * bound-assistant context.
 *
 * Also returns `rawWrites` — the UNWRAPPED write instances keyed by name,
 * which the staged-write executor uses to apply an approved row (the
 * wrapped instance would just re-stage forever).
 */
export function buildAgentToolset(deps: AgentToolsetDeps): AgentToolset & {
  rawWrites: Map<string, Tool>
} {
  const resolveOrigin = deps.resolveOrigin ?? defaultResolveOrigin
  const reads = new Map<string, Tool>()
  const writes = new Map<string, Tool>()
  const rawWrites = new Map<string, Tool>()

  // ── BRIDGE — reuse the boot instances (never re-implement; same Tool,
  //    same analytics, same stores — the brain-MCP bridge rule).
  for (const name of BRIDGE_READ_NAMES) {
    const tool = deps.allTools.get(name)
    if (tool) reads.set(name, tool)
  }
  for (const name of BRIDGE_WRITE_NAMES) {
    const tool = deps.allTools.get(name)
    if (tool) rawWrites.set(name, tool)
  }

  // ── BUILD-NEW — control-plane reads + writes.
  const cp = createControlPlaneTools(deps.controlPlaneReader)
  for (const tool of Object.values(cp)) reads.set(tool.name, tool)
  for (const tool of createAgentWriteTools({ ...deps.writeToolDeps, approvalsStore: deps.approvalsStore })) {
    rawWrites.set(tool.name, tool)
  }

  // ── Banding — wrap Approve-band writes; pass Auto-band through.
  for (const [name, tool] of rawWrites) {
    const band = bandOf(name)
    if (band === 'approve') {
      writes.set(
        name,
        wrapApproveBand(tool, {
          approvalsStore: deps.approvalsStore,
          resolveApprover: deps.writeToolDeps.resolveApprover,
          resolveOrigin,
        }),
      )
    } else {
      writes.set(name, tool)
    }
  }

  return { reads, writes, rawWrites }
}
