/**
 * Control-plane read tools — the Tier-1 "describe my workspace" surface of
 * the agent capability toolset (docs/plans/agent-facing-capability-surface.md
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
import type { ControlPlaneReader } from './types.js'

export type ControlPlaneTools = {
  listAssistants: Tool
  getAssistant: Tool
  listConnectors: Tool
  listSkills: Tool
  listChannels: Tool
  listModes: Tool
}

/** Resolve the acting (userId, workspaceId) pair or a tool-friendly error. */
function principalFrom(ctx: ToolContext): { userId: string; workspaceId: string } | { error: string } {
  if (!ctx.workspaceId) {
    return { error: 'This surface is not bound to a workspace, so there is no apparatus to inspect.' }
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
      const p = principalFrom(ctx)
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
      const p = principalFrom(ctx)
      if ('error' in p) return { data: p.error, isError: true }
      const row = await reader.getAssistant(p.userId, p.workspaceId, input.assistantId)
      if (!row) return { data: 'No such assistant in this workspace.', isError: true }
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
      const p = principalFrom(ctx)
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
      const p = principalFrom(ctx)
      if ('error' in p) return { data: p.error, isError: true }
      const rows = await reader.listSkills(p.userId, p.workspaceId)
      return { data: { skills: rows } }
    },
  })

  const listChannels = buildTool({
    name: 'listChannels',
    description:
      'List the messaging channels wired into this workspace (telegram / slack / whatsapp): ' +
      'id, type, display name, clearance, enabled capabilities, and status.',
    inputSchema: z.object({}),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(_input, ctx) {
      const p = principalFrom(ctx)
      if ('error' in p) return { data: p.error, isError: true }
      const rows = await reader.listChannels(p.userId, p.workspaceId)
      return { data: { channels: rows } }
    },
  })

  const listModes = buildTool({
    name: 'listModes',
    description:
      'List the consult modes defined on one assistant of this workspace: id, name, ' +
      'description, freshness (live / snapshot), and whether invocations require approval.',
    inputSchema: z.object({
      assistantId: z.string().uuid().describe('The assistant id (from listAssistants)'),
    }),
    isReadOnly: true,
    isConcurrencySafe: true,
    async execute(input, ctx) {
      const p = principalFrom(ctx)
      if ('error' in p) return { data: p.error, isError: true }
      const rows = await reader.listModes(p.userId, p.workspaceId, input.assistantId)
      return { data: { modes: rows } }
    },
  })

  return { listAssistants, getAssistant, listConnectors, listSkills, listChannels, listModes }
}
