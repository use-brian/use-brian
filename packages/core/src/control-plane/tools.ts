/**
 * Control-plane read tools — the Tier-1 "describe my workspace" surface of
 * the agent capability toolset (docs/architecture/integrations/agent-capability-surface.md
 * §4). Six reads over apparatus: assistants, connectors, skills, channels,
 * modes. Clearance-bounded by membership scoping inside the reader; no
 * capability grant required (Tier-1 reads are deliberately ungated — an
 * agent can inspect the workspace it is keyed into, but not change it).
 *
 * Exposed on the agent surfaces (brain MCP, assistant MCP) and the
 * public-api chat path. Deliberately compact projections: an agent reads
 * these to decide a follow-up call, not to render a UI.
 *
 * Component tag: [COMP:control-plane/read-tools].
 */

import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import { notFoundFailure } from '../tools/tool-failure.js'
import type { ControlPlaneReader } from './types.js'

export type ControlPlaneTools = {
  listAssistants: Tool
  getAssistant: Tool
  listConnectors: Tool
  listSkills: Tool
  listChannels: Tool
}

/**
 * The canonical workspace-gate failure, shared by all five reads.
 *
 * These tools are reachable ONLY from the agent surfaces (brain MCP,
 * assistant MCP, public-api chat — `buildAgentToolset` is the sole caller of
 * `createControlPlaneTools`), so the missing binding is always a property of
 * the CREDENTIAL, never something the model can fix by rewording the call.
 * The old sentence ("...so there is no apparatus to inspect.") stated the
 * condition and stopped there, which leaves retrying as the only move the
 * model has; this one names the operation, the diagnosis, the remedy, and
 * the retry verdict (docs/architecture/engine/tool-executor.md → "Failure
 * copy"). Kept in step with `agent-surface/write-tools.ts`'s
 * `workspaceGateFailure` — same condition, same account of it.
 */
function workspaceGateMessage(tool: string): string {
  return (
    `\`${tool}\` cannot run: the credential this call authenticated with (brain key / assistant ` +
    'key / OAuth grant) is not bound to a workspace, so there is no workspace apparatus to inspect. ' +
    'This is a provisioning problem with the key, not a problem with the arguments — no argument ' +
    'change helps and retrying this call will fail identically. Remedy: a workspace admin must ' +
    're-issue or re-scope the key against the workspace, or attach the acting assistant to a ' +
    'workspace in Studio. Report that to the user instead of retrying.'
  )
}

/** Resolve the acting (userId, workspaceId) pair or a tool-friendly error. */
function principalFrom(ctx: ToolContext, tool: string): { userId: string; workspaceId: string } | { error: string } {
  if (!ctx.workspaceId) {
    return { error: workspaceGateMessage(tool) }
  }
  return { userId: ctx.userId, workspaceId: ctx.workspaceId }
}

export function createControlPlaneTools(reader: ControlPlaneReader): ControlPlaneTools {
  const listAssistants = buildTool({
    name: 'listAssistants',
    description:
      'List the assistants of this workspace: id, name, kind (primary / standard / app), ' +
      'clearance, and active capability grants. Use it to discover which assistant a ' +
      'follow-up call should target.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(_input, ctx) {
      const p = principalFrom(ctx, 'listAssistants')
      if ('error' in p) return { data: p.error, isError: true }
      const rows = await reader.listAssistants(p.userId, p.workspaceId)
      return { data: { assistants: rows } }
    },
  })

  const getAssistant = buildTool({
    name: 'getAssistant',
    description:
      'Fetch one assistant of this workspace by id: name, kind, clearance, app type, and ' +
      'active capability grants.',
    inputSchema: z.object({
      assistantId: z.string().uuid().describe('The assistant id (from listAssistants)'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, ctx) {
      const p = principalFrom(ctx, 'getAssistant')
      if ('error' in p) return { data: p.error, isError: true }
      const row = await reader.getAssistant(p.userId, p.workspaceId, input.assistantId)
      if (!row) {
        return notFoundFailure({
          kind: 'Assistant',
          id: input.assistantId,
          discoveryTool: 'listAssistants',
          extra:
            'Either no assistant with that id exists in the workspace this credential is bound to, ' +
            'or it exists but is not visible to the acting principal — listAssistants returns exactly ' +
            'the ones that are reachable.',
          idSource: 'a listAssistants result (the `id` field), never an assistant name',
        })
      }
      return { data: row }
    },
  })

  const listConnectors = buildTool({
    name: 'listConnectors',
    description:
      'List the connectors configured for this workspace: provider, instance id, label, ' +
      'connected state, and auth type. `oauthRequired: true` means connecting needs a human ' +
      'browser consent — an agent can scaffold such a connector but never complete it.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(_input, ctx) {
      const p = principalFrom(ctx, 'listConnectors')
      if ('error' in p) return { data: p.error, isError: true }
      const rows = await reader.listConnectors(p.userId, p.workspaceId)
      return { data: { connectors: rows } }
    },
  })

  const listSkills = buildTool({
    name: 'listSkills',
    description:
      'List the workspace skills (procedural knowledge): id, slug, name, lifecycle state, ' +
      'activation (null activatedAt = suggested, pending the governance gate), induction ' +
      'source, and sensitivity.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(_input, ctx) {
      const p = principalFrom(ctx, 'listSkills')
      if ('error' in p) return { data: p.error, isError: true }
      const rows = await reader.listSkills(p.userId, p.workspaceId)
      return { data: { skills: rows } }
    },
  })

  const listChannels = buildTool({
    name: 'listChannels',
    description:
      'List the messaging channels wired into this workspace (telegram / slack / whatsapp): ' +
      'id, integrationId, integration status, type, display name, clearance, enabled capabilities, and status. ' +
      'For a workflow channel event source, use integrationId as channelIntegrationId; id is the owning channel row and is not interchangeable.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(_input, ctx) {
      const p = principalFrom(ctx, 'listChannels')
      if ('error' in p) return { data: p.error, isError: true }
      const rows = await reader.listChannels(p.userId, p.workspaceId)
      return { data: { channels: rows } }
    },
  })

  return { listAssistants, getAssistant, listConnectors, listSkills, listChannels }
}
