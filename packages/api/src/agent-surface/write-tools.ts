/**
 * Agent-surface control-plane WRITE tools — the Tier-2 BUILD-NEW set
 * (docs/architecture/integrations/agent-capability-surface.md §4 / Phase 4):
 *
 *   proposeSkill                — stages a `staged_skill_creation` approval;
 *                                 rides the skills governance loop (§6.2),
 *                                 never creates an active skill directly.
 *   enableSkill / disableSkill  — per-assistant workspace-skill enablement.
 *   setConnectorPolicy          — L2 allow/ask/block on one connector tool.
 *   addPatConnector             — personal connector instance with a PAT/token
 *                                 credential (the headless-completable kind),
 *                                 auto-shared with the bound workspace via a
 *                                 grant (canonical unified-connectors model).
 *   configureConnectorInstance  — label / sensitivity / connected / token
 *                                 rotation on an existing instance.
 *   createAssistant / updateAssistant — assistant drafting (§6.3) under the
 *                                 no-escalation invariant: a created or
 *                                 edited assistant's clearance never exceeds
 *                                 the acting assistant's.
 *
 * All are `requiresCapability: 'configure'` (CONFIGURE_CAPABILITY) and run
 * through the Auto/Approve banding in `banding.ts` when exposed on an agent
 * surface. They live in the api package (not core) because they wrap
 * api-layer stores and route logic; each is a normal `Tool` instance so any
 * surface (including chat, later) shares the same implementation.
 *
 * OAuth connectors are NEVER completable here — `addPatConnector` rejects
 * registry providers whose auth is OAuth and points the caller at the
 * Studio connect flow instead (§5.3 connect-link handoff).
 *
 * Component tag: [COMP:agent-surface/write-tools].
 */

import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import {
  buildTool,
  classifyTool,
  CONFIGURE_CAPABILITY,
  minSensitivity,
  type McpSettingsStore,
  type Sensitivity,
  type Tool,
  type ToolContext,
} from '@use-brian/core'
import { OFFICIAL_CONNECTORS } from '@use-brian/shared'
import { query, queryWithRLS } from '../db/client.js'
import type { ConnectorInstanceStore } from '../db/connector-instance-store.js'
import type { ConnectorGrantStore } from '../db/connector-grant-store.js'
import type { PendingApprovalsStore } from '../db/pending-approvals-store.js'
import type { WorkspaceSkillEnablementStore } from '../db/workspace-skill-enablement-store.js'

export type AgentWriteToolDeps = {
  approvalsStore: PendingApprovalsStore
  enablementStore: WorkspaceSkillEnablementStore
  mcpSettingsStore: McpSettingsStore
  connectorInstanceStore: ConnectorInstanceStore
  /**
   * Exposes a freshly-created personal connector to the bound workspace.
   * `addPatConnector` follows the canonical unified-connectors model — a
   * personal `scope='user'` instance reaches workspace assistants only via a
   * `connector_grant` (mcp.md → "Unified connectors"); team-native
   * `scope='workspace'` creation is retired.
   */
  connectorGrantStore: ConnectorGrantStore
  /**
   * Resolve the human approver for a staged row created from this context —
   * the credential's creator when known, else the workspace owner (the
   * `ToolContext.userId` on every agent surface). See approver precedent in
   * docs/architecture/integrations/agent-capability-surface.md §11.3.
   */
  resolveApprover: (ctx: ToolContext) => Promise<string>
}

const CLEARANCE = z.enum(['public', 'internal', 'confidential'])

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

function requireWorkspace(ctx: ToolContext): string | null {
  return ctx.workspaceId ?? null
}

/** The acting assistant's write ceiling — the no-escalation bound (§2). */
function actingClearance(ctx: ToolContext): Sensitivity {
  return ctx.assistantClearance ?? ctx.clearance ?? 'internal'
}

export function createAgentWriteTools(deps: AgentWriteToolDeps): Tool[] {
  const proposeSkill = buildTool({
    name: 'proposeSkill',
    description:
      'Propose a new workspace skill (a reusable procedure the brain can follow). The ' +
      'proposal is STAGED for human review — it never becomes an active skill directly; a ' +
      'workspace member approves it in the web app, and the skill is then born under the ' +
      'standard governance gate. Provide a clear name, a one-line description of when to ' +
      'use it, and the full procedure content in markdown.',
    inputSchema: z.object({
      name: z.string().min(3).max(100).describe('Human-readable skill name'),
      description: z.string().min(3).max(250).describe('One line: what this skill does / when to use it'),
      content: z.string().min(10).max(5000).describe('The full procedure, markdown'),
    }),
    requiresCapability: CONFIGURE_CAPABILITY,
    async execute(input, ctx) {
      const workspaceId = requireWorkspace(ctx)
      if (!workspaceId) return { data: 'No workspace bound to this surface.', isError: true }
      const slug = slugify(input.name)
      if (!slug) return { data: 'Skill name must contain alphanumeric characters.', isError: true }
      const approverUserId = await deps.resolveApprover(ctx)
      const approval = await deps.approvalsStore.createStagedSkillCreation({
        workspaceId,
        proposedUmbrella: {
          slug,
          name: input.name,
          description: input.description,
          content: input.content,
        },
        approverUserId,
        originatingAssistantId: ctx.assistantId,
      })
      return {
        data:
          `Skill proposal staged for human review (approval ${approval.id}). ` +
          'A workspace member can approve it under Approvals or the skills review surface; ' +
          'once approved it is created and enabled for the proposing assistant.',
      }
    },
  })

  const enableSkill = buildTool({
    name: 'enableSkill',
    description:
      'Enable an existing workspace skill on an assistant, so that assistant can invoke it. ' +
      'Use listSkills to find the skill id and listAssistants for the assistant id ' +
      '(defaults to the acting assistant).',
    inputSchema: z.object({
      skillId: z.string().uuid().describe('workspace skill id (from listSkills)'),
      assistantId: z.string().uuid().optional().describe('target assistant; defaults to the acting assistant'),
    }),
    requiresCapability: CONFIGURE_CAPABILITY,
    async execute(input, ctx) {
      const workspaceId = requireWorkspace(ctx)
      if (!workspaceId) return { data: 'No workspace bound to this surface.', isError: true }
      const assistantId = input.assistantId ?? ctx.assistantId
      await deps.enablementStore.enable(input.skillId, assistantId, ctx.userId)
      return { data: `Skill ${input.skillId} enabled for assistant ${assistantId}.` }
    },
  })

  const disableSkill = buildTool({
    name: 'disableSkill',
    description:
      'Disable a workspace skill on an assistant (reversible — enable it again any time). ' +
      'Defaults to the acting assistant.',
    inputSchema: z.object({
      skillId: z.string().uuid().describe('workspace skill id (from listSkills)'),
      assistantId: z.string().uuid().optional().describe('target assistant; defaults to the acting assistant'),
    }),
    requiresCapability: CONFIGURE_CAPABILITY,
    async execute(input, ctx) {
      const workspaceId = requireWorkspace(ctx)
      if (!workspaceId) return { data: 'No workspace bound to this surface.', isError: true }
      const assistantId = input.assistantId ?? ctx.assistantId
      const removed = await deps.enablementStore.disable(input.skillId, assistantId, ctx.userId)
      return { data: removed ? `Skill disabled for assistant ${assistantId}.` : 'Skill was not enabled — nothing to do.' }
    },
  })

  const setConnectorPolicy = buildTool({
    name: 'setConnectorPolicy',
    description:
      "Set the assistant-level (L2) policy for one connector tool: 'allow' (runs " +
      "silently), 'ask' (requires confirmation), or 'block'. The effective policy is the " +
      'strictest of the app-level (L1) and assistant-level (L2) settings. Defaults to the ' +
      'acting assistant.',
    inputSchema: z.object({
      connectorId: z.string().min(1).describe('connector id (from listConnectors `provider`, or a custom connector UUID)'),
      toolName: z.string().min(1).describe('the connector tool name to govern'),
      policy: z.enum(['allow', 'ask', 'block']),
      assistantId: z.string().uuid().optional().describe('target assistant; defaults to the acting assistant'),
    }),
    requiresCapability: CONFIGURE_CAPABILITY,
    async execute(input, ctx) {
      const workspaceId = requireWorkspace(ctx)
      if (!workspaceId) return { data: 'No workspace bound to this surface.', isError: true }
      const assistantId = input.assistantId ?? ctx.assistantId
      await deps.mcpSettingsStore.setPolicy({
        assistantId,
        userId: ctx.userId,
        serverName: input.connectorId,
        toolName: input.toolName,
        policy: input.policy,
        classification: classifyTool(input.toolName),
      })
      return {
        data: `Policy for ${input.connectorId}.${input.toolName} on assistant ${assistantId} set to '${input.policy}'.`,
      }
    },
  })

  const addPatConnector = buildTool({
    name: 'addPatConnector',
    description:
      'Add a token-authenticated (PAT / API-key) connector for yourself and share it with ' +
      'this workspace, marked connected. Works headless because a token is just data. ' +
      'OAuth connectors (Gmail, Google Calendar, Drive, Notion, Fathom) can NOT be ' +
      'completed here — for those, create nothing and tell the user to connect via Studio.',
    inputSchema: z.object({
      provider: z.string().min(1).describe("registry provider id (e.g. 'github') — see listConnectors"),
      label: z.string().min(1).max(120).describe('Display label for this connection'),
      token: z.string().min(8).max(4096).describe('The PAT / API token'),
    }),
    requiresCapability: CONFIGURE_CAPABILITY,
    async execute(input, ctx) {
      const workspaceId = requireWorkspace(ctx)
      if (!workspaceId) return { data: 'No workspace bound to this surface.', isError: true }
      const entry = OFFICIAL_CONNECTORS.find((c) => c.id === input.provider)
      if (entry && (entry.oauth_required || entry.auth_type === 'oauth')) {
        return {
          data:
            `'${input.provider}' is an OAuth connector — a human must complete the browser ` +
            'consent in Studio > Connectors. No instance was created.',
          isError: true,
        }
      }
      // Canonical unified-connectors model (mcp.md → "Unified connectors"):
      // mint a PERSONAL instance owned by the acting user, then expose it to
      // the bound workspace via a grant — the same shape the human
      // connect-then-share flow produces. Team-native `scope='workspace'`
      // creation is retired; it produced connectors that were usable but
      // invisible/unmanageable on the Studio → Connectors page.
      const instance = await deps.connectorInstanceStore.createUserInstance({
        userId: ctx.userId,
        provider: input.provider,
        label: input.label,
        // Same credential shape the connect flow stores (client_secret = the token).
        credentials: { client_id: '', client_secret: input.token },
        connected: true,
        createdBy: ctx.userId,
      })
      // Idempotent (ON CONFLICT DO NOTHING). Solo workspaces have no audience,
      // but the grant is harmless and keeps the connector workspace-reachable
      // the moment a teammate joins.
      await deps.connectorGrantStore.create({
        actingUserId: ctx.userId,
        connectorInstanceId: instance.id,
        targetType: 'workspace',
        targetId: workspaceId,
      })
      return {
        data:
          `Connector '${input.label}' (${input.provider}) created, connected, and shared ` +
          `with this workspace. instanceId=${instance.id}`,
      }
    },
  })

  const configureConnectorInstance = buildTool({
    name: 'configureConnectorInstance',
    description:
      'Update an existing connector instance you own: label, sensitivity tier, connected ' +
      'flag, or rotate its PAT token. Use listConnectors for the instanceId. Cannot mint ' +
      'OAuth credentials.',
    inputSchema: z.object({
      instanceId: z.string().uuid().describe('connector_instance id (from listConnectors)'),
      label: z.string().min(1).max(120).optional(),
      sensitivity: CLEARANCE.optional(),
      connected: z.boolean().optional(),
      token: z.string().min(8).max(4096).optional().describe('new PAT / API token (rotation)'),
    }),
    requiresCapability: CONFIGURE_CAPABILITY,
    async execute(input, ctx) {
      const workspaceId = requireWorkspace(ctx)
      if (!workspaceId) return { data: 'No workspace bound to this surface.', isError: true }
      const updated = await deps.connectorInstanceStore.update(ctx.userId, input.instanceId, {
        label: input.label,
        sensitivity: input.sensitivity,
        connected: input.connected ?? (input.token ? true : undefined),
        credentials: input.token ? { client_id: '', client_secret: input.token } : undefined,
      })
      if (!updated) return { data: 'No such connector instance in this workspace.', isError: true }
      return { data: `Connector instance ${updated.id} updated.` }
    },
  })

  const createAssistant = buildTool({
    name: 'createAssistant',
    description:
      'Create a new workspace assistant (a draft a human approves before it exists). ' +
      "kind 'standard' gets the default tasks/crm capability grants. The new assistant's " +
      "clearance can never exceed the acting assistant's own clearance.",
    inputSchema: z.object({
      name: z.string().min(1).max(100),
      kind: z.enum(['standard', 'app']).default('standard'),
      clearance: CLEARANCE.optional().describe("defaults to 'internal', capped at the acting assistant's clearance"),
      systemPrompt: z.string().max(10_000).optional(),
      bio: z.string().max(200).optional(),
    }),
    requiresCapability: CONFIGURE_CAPABILITY,
    async execute(input, ctx) {
      const workspaceId = requireWorkspace(ctx)
      if (!workspaceId) return { data: 'No workspace bound to this surface.', isError: true }
      // No-escalation invariant (§2): cap at the acting assistant's clearance.
      const ceiling = actingClearance(ctx)
      const clearance = minSensitivity(input.clearance ?? 'internal', ceiling)
      const iconSeed = randomUUID().slice(0, 8)
      const inserted = await query<{ id: string }>(
        `INSERT INTO assistants (name, owner_user_id, workspace_id, icon_seed, clearance, kind, app_type, system_prompt, bio)
         VALUES ($1, NULL, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          input.name,
          workspaceId,
          iconSeed,
          clearance,
          input.kind,
          input.kind === 'app' ? 'distribution' : null,
          input.systemPrompt ?? null,
          input.bio ?? null,
        ],
      )
      const assistantId = inserted.rows[0].id
      if (input.kind === 'standard') {
        // §17 default-on grants for standard assistants — mirrors the
        // workspace route's creation side effects.
        await query(
          `INSERT INTO assistant_capabilities (assistant_id, capability, granted_by_user_id, reason)
           VALUES ($1, 'tasks', $2, '§17 default-on at standard creation (agent surface)'),
                  ($1, 'crm',   $2, '§17 default-on at standard creation (agent surface)')`,
          [assistantId, ctx.userId],
        )
      }
      return { data: `Assistant '${input.name}' created. id=${assistantId}, kind=${input.kind}, clearance=${clearance}` }
    },
  })

  const updateAssistant = buildTool({
    name: 'updateAssistant',
    description:
      "Update a workspace assistant's name, system prompt, bio, or clearance. The new " +
      "clearance can never exceed the acting assistant's own clearance (raising above it " +
      'is a human action in Studio).',
    inputSchema: z.object({
      assistantId: z.string().uuid(),
      name: z.string().min(1).max(100).optional(),
      systemPrompt: z.string().max(10_000).nullable().optional(),
      bio: z.string().max(200).nullable().optional(),
      clearance: CLEARANCE.optional(),
    }),
    requiresCapability: CONFIGURE_CAPABILITY,
    async execute(input, ctx) {
      const workspaceId = requireWorkspace(ctx)
      if (!workspaceId) return { data: 'No workspace bound to this surface.', isError: true }
      const sets: string[] = []
      const values: unknown[] = []
      const push = (sql: string, v: unknown) => {
        values.push(v)
        sets.push(`${sql} = $${values.length}`)
      }
      if (input.name !== undefined) push('name', input.name)
      if (input.systemPrompt !== undefined) push('system_prompt', input.systemPrompt)
      if (input.bio !== undefined) push('bio', input.bio)
      if (input.clearance !== undefined) {
        // No-escalation invariant (§2).
        push('clearance', minSensitivity(input.clearance, actingClearance(ctx)))
      }
      if (sets.length === 0) return { data: 'Nothing to update.', isError: true }
      values.push(input.assistantId, workspaceId)
      const result = await queryWithRLS<{ id: string }>(
        ctx.userId,
        `UPDATE assistants SET ${sets.join(', ')}
         WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
         RETURNING id`,
        values,
      )
      if (result.rows.length === 0) {
        return { data: 'No such assistant in this workspace (or not visible to this principal).', isError: true }
      }
      return { data: `Assistant ${input.assistantId} updated (${sets.length} field(s)).` }
    },
  })

  return [
    proposeSkill,
    enableSkill,
    disableSkill,
    setConnectorPolicy,
    addPatConnector,
    configureConnectorInstance,
    createAssistant,
    updateAssistant,
  ]
}
