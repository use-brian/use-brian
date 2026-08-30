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
import { seedBuiltinPrimitiveCapabilities } from '../db/capability-seed.js'
import { z } from 'zod'
import {
  buildTool,
  classifyTool,
  CONFIGURE_CAPABILITY,
  minSensitivity,
  notFoundFailure,
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
import type { WorkspaceSkillStore } from '../db/skill-store.js'
import { materialiseAllAssistants } from '../skills/all-assistants.js'

export type AgentWriteToolDeps = {
  approvalsStore: PendingApprovalsStore
  enablementStore: WorkspaceSkillEnablementStore
  /**
   * Clears the `all_assistants` flag when `disableSkill` narrows a skill that
   * applies to every assistant (mig 491). Only `setAllAssistants` is used.
   */
  workspaceSkillStore: Pick<WorkspaceSkillStore, 'setAllAssistants'>
  /**
   * Every assistant in the workspace — needed only to materialise the
   * `all_assistants` flag into rows before clearing it. Absent in minimal
   * mounts, where `disableSkill` refuses that one case loudly instead of
   * reporting a no-op as success.
   */
  listWorkspaceAssistants?: (
    userId: string,
    workspaceId: string,
  ) => Promise<Array<{ id: string; name: string }>>
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

/**
 * The canonical workspace-gate failure for the agent surfaces.
 *
 * Every one of these tools used to answer "No workspace bound to this
 * surface." — which names neither the operation nor a remedy, so the only
 * move the sentence leaves the model is to try again. This failure NEVER
 * clears on a retry: it is a property of the CREDENTIAL the call
 * authenticated with (a brain key / assistant key / OAuth grant that carries
 * no workspace, or an assistant attached to none), not of the arguments. So
 * the copy names what could not run, why, who fixes it, and that retrying is
 * pointless (docs/architecture/engine/tool-executor.md → "Failure copy").
 *
 * Exported so `toolset.ts`'s Approve-band wrapper returns the identical
 * sentence — the wrapper hits the same gate before staging, and two
 * different accounts of one condition is how copy drifts.
 */
export function workspaceGateFailure(tool: string, verb = 'change'): { data: string; isError: true } {
  return {
    data:
      `\`${tool}\` cannot run: the credential this call authenticated with (brain key / assistant ` +
      'key / OAuth grant) is not bound to a workspace, so there is no workspace apparatus to ' +
      `${verb}. This is a provisioning problem with the key, not a problem with the arguments — ` +
      'no argument change helps and retrying this call will fail identically. Remedy: a workspace ' +
      'admin must re-issue or re-scope the key against the workspace, or attach the acting ' +
      'assistant to a workspace in Studio. Report that to the user instead of retrying.',
    isError: true,
  }
}

/**
 * The bound workspace id, or the canonical gate failure to return as-is.
 * Returns the RESULT OBJECT (not a bare string the caller re-wraps) so every
 * call site is physically unable to invent its own wording.
 */
function requireWorkspace(ctx: ToolContext, tool: string): string | { data: string; isError: true } {
  return ctx.workspaceId ?? workspaceGateFailure(tool)
}

/**
 * Live workspace-skill row behind an id, scoped to the bound workspace.
 *
 * `enableSkill` / `disableSkill` used to write straight through: the
 * enablement row is keyed by (skill, assistant) with no FK check the tool
 * observed, so a hallucinated or stale skill id reported SUCCESS and enabled
 * nothing. The model then told the user the skill was on. `workspace_skills`
 * is also VERSIONED (`valid_to` / `superseded_by`), so an id that was valid
 * before an edit now points at a superseded row — that is a different
 * diagnosis from "no such skill" and gets its own sentence.
 */
async function findWorkspaceSkill(
  skillId: string,
  workspaceId: string,
): Promise<{ name: string; isCurrent: boolean; allAssistants: boolean } | null> {
  const result = await query<{ name: string; isCurrent: boolean; allAssistants: boolean }>(
    `SELECT name, (valid_to IS NULL) AS "isCurrent",
            all_assistants AS "allAssistants"
       FROM workspace_skills
      WHERE id = $1 AND workspace_id = $2
      LIMIT 1`,
    [skillId, workspaceId],
  )
  return result.rows[0] ?? null
}

/**
 * Resolve a skill id to a live row, or the failure copy explaining which of
 * the two misses happened. Shared by `enableSkill` / `disableSkill` so the
 * pair cannot disagree about what a bad id means.
 */
async function resolveSkillOrFailure(
  skillId: string,
  workspaceId: string,
  tool: string,
): Promise<{ name: string; allAssistants: boolean } | { data: string; isError: true }> {
  const skill = await findWorkspaceSkill(skillId, workspaceId)
  if (!skill) {
    return notFoundFailure({
      kind: 'Workspace skill',
      id: skillId,
      discoveryTool: 'listSkills',
      extra:
        `Nothing was enabled or disabled by \`${tool}\`. Either no skill with that id has ever ` +
        'existed, or it belongs to a different workspace than the one this credential is bound to.',
      idSource: 'a listSkills result (the `id` field), never a slug or a skill name',
    })
  }
  if (!skill.isCurrent) {
    return {
      data:
        `Workspace skill ${skillId} ("${skill.name}") is a SUPERSEDED version — workspace skills are ` +
        'versioned, and every edit closes the old row and mints a new id, so this id can no longer be ' +
        `enabled or disabled. Nothing was changed. Call listSkills to get the CURRENT id for "${skill.name}" ` +
        `and re-issue \`${tool}\` with it. Do NOT retry this exact id.`,
      isError: true,
    }
  }
  return { name: skill.name, allAssistants: skill.allAssistants }
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
      'standard governance gate. Provide a clear name, a one-line description of what it ' +
      'does, the trigger condition that should make it fire, and the full procedure ' +
      'content in markdown.',
    inputSchema: z.object({
      name: z.string().min(3).max(100).describe('Human-readable skill name'),
      description: z.string().min(3).max(250).describe('One line: what this skill does'),
      // Required for the same reason as `skill_manage`'s create_umbrella: the
      // trigger is the only thing the skill listing offers the model to select
      // on, so a proposal without one produces a skill nothing can ever reach.
      whenToUse: z
        .string()
        .min(3)
        .max(300)
        .describe('The trigger: what the user says or does that should make this skill fire'),
      content: z.string().min(10).max(5000).describe('The full procedure, markdown'),
    }),
    requiresCapability: CONFIGURE_CAPABILITY,
    async execute(input, ctx) {
      const workspaceId = requireWorkspace(ctx, 'proposeSkill')
      if (typeof workspaceId !== 'string') return workspaceId
      const slug = slugify(input.name)
      if (!slug) {
        return {
          data:
            `proposeSkill did not stage anything: the name "${input.name}" produces an empty slug — ` +
            'a skill slug is built from the letters and digits of the name, and this name has none. ' +
            'Re-issue with a `name` containing at least one ASCII letter or digit. The same name will ' +
            'fail the same way.',
          isError: true,
        }
      }
      const approverUserId = await deps.resolveApprover(ctx)
      const approval = await deps.approvalsStore.createStagedSkillCreation({
        workspaceId,
        proposedUmbrella: {
          slug,
          name: input.name,
          description: input.description,
          whenToUse: input.whenToUse,
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
      const workspaceId = requireWorkspace(ctx, 'enableSkill')
      if (typeof workspaceId !== 'string') return workspaceId
      // Existence check BEFORE the write: the enablement row is keyed by
      // (skill, assistant) and the insert happily accepts an id no skill has,
      // so without this the tool reported "enabled" for a skill that does not
      // exist and the model passed that on to the user.
      const skill = await resolveSkillOrFailure(input.skillId, workspaceId, 'enableSkill')
      if ('isError' in skill) return skill
      const assistantId = input.assistantId ?? ctx.assistantId
      // mig 491: already covered by the workspace-wide flag. Writing a row
      // would leave the two representations disagreeing for no behaviour
      // change, so say what is true instead.
      if (skill.allAssistants) {
        return {
          data:
            `Skill ${input.skillId} ("${skill.name}") is already enabled for assistant ${assistantId} — ` +
            'it applies to every assistant in the workspace, including ones created later. Nothing to do.',
        }
      }
      await deps.enablementStore.enable(input.skillId, assistantId, ctx.userId)
      return { data: `Skill ${input.skillId} ("${skill.name}") enabled for assistant ${assistantId}.` }
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
      const workspaceId = requireWorkspace(ctx, 'disableSkill')
      if (typeof workspaceId !== 'string') return workspaceId
      // Same existence check as enableSkill: a DELETE that matches nothing is
      // indistinguishable from "already off", so without this a bad id read as
      // a successful no-op.
      const skill = await resolveSkillOrFailure(input.skillId, workspaceId, 'disableSkill')
      if ('isError' in skill) return skill
      const assistantId = input.assistantId ?? ctx.assistantId
      // mig 491: a skill flagged `all_assistants` holds no enablement row, so
      // `disable` would delete nothing and return false — which reads as
      // "already off" and would have the model tell the user the skill is
      // disabled while every assistant, this one included, keeps being offered
      // it. Convert the flag into rows for the others first.
      if (skill.allAssistants) {
        if (!deps.listWorkspaceAssistants) {
          return {
            data:
              `Skill ${input.skillId} ("${skill.name}") is set to apply to EVERY assistant in the ` +
              'workspace, and turning it off for one assistant is not available on this deployment. ' +
              'Nothing was changed. Ask the user to change it in Brain > Skills > Assistant access.',
            isError: true,
          }
        }
        await materialiseAllAssistants({
          skill: { rowId: input.skillId, workspaceId, allAssistants: true },
          actingUserId: ctx.userId,
          listAssistantIds: async () =>
            (await deps.listWorkspaceAssistants!(ctx.userId, workspaceId)).map((a) => a.id),
          enablementStore: deps.enablementStore,
          workspaceSkillStore: deps.workspaceSkillStore,
          exclude: [assistantId],
        })
        return {
          data:
            `Skill ${input.skillId} ("${skill.name}") disabled for assistant ${assistantId}. It applied ` +
            'to every assistant in the workspace, so it is now enabled on the others individually and ' +
            'will no longer be added to assistants created later.',
        }
      }
      const removed = await deps.enablementStore.disable(input.skillId, assistantId, ctx.userId)
      // The skill EXISTS and is now off either way — an already-off skill is
      // the requested end state, not a failure (tool-executor.md → D7).
      return {
        data: removed
          ? `Skill ${input.skillId} ("${skill.name}") disabled for assistant ${assistantId}.`
          : `Skill ${input.skillId} ("${skill.name}") was already not enabled for assistant ${assistantId} — it is off, nothing to do.`,
      }
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
      const workspaceId = requireWorkspace(ctx, 'setConnectorPolicy')
      if (typeof workspaceId !== 'string') return workspaceId
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
      const workspaceId = requireWorkspace(ctx, 'addPatConnector')
      if (typeof workspaceId !== 'string') return workspaceId
      const entry = OFFICIAL_CONNECTORS.find((c) => c.id === input.provider)
      if (entry && (entry.oauth_required || entry.auth_type === 'oauth')) {
        return {
          data:
            `addPatConnector cannot create '${input.provider}': it is an OAuth connector, and OAuth ` +
            'credentials can only be minted by a human completing the browser consent in Studio → ' +
            'Connectors. No instance and no grant were created. There is no token you can pass that ' +
            'changes this — tell the user to connect it in Studio, and do not retry this provider here.',
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
      const workspaceId = requireWorkspace(ctx, 'configureConnectorInstance')
      if (typeof workspaceId !== 'string') return workspaceId
      const updated = await deps.connectorInstanceStore.update(ctx.userId, input.instanceId, {
        label: input.label,
        sensitivity: input.sensitivity,
        connected: input.connected ?? (input.token ? true : undefined),
        credentials: input.token ? { client_id: '', client_secret: input.token } : undefined,
      })
      if (!updated) {
        return notFoundFailure({
          kind: 'Connector instance',
          id: input.instanceId,
          discoveryTool: 'listConnectors',
          extra:
            'Nothing was updated. `configureConnectorInstance` only reaches instances the acting user ' +
            'OWNS — an instance shared into this workspace by a teammate is visible to listConnectors ' +
            'but can only be reconfigured by its owner, so tell the user to ask that owner.',
          idSource: 'a listConnectors result (the `instanceId` field), never the provider id',
        })
      }
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
      const workspaceId = requireWorkspace(ctx, 'createAssistant')
      if (typeof workspaceId !== 'string') return workspaceId
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
        // workspace route's creation side effects via the same shared
        // constant, so an assistant drafted by an agent is not a
        // second-class one (this site was two capabilities behind).
        await query(
          `INSERT INTO assistant_capabilities (assistant_id, capability, granted_by_user_id, reason)
           VALUES ($1, 'tasks', $2, '§17 default-on at standard creation (agent surface)'),
                  ($1, 'crm',   $2, '§17 default-on at standard creation (agent surface)'),
                  ($1, 'goals', $2, 'goals default-on at standard creation (agent surface)'),
                  ($1, 'files', $2, 'built-in primitive — default-on at standard creation (agent surface)')`,
          [assistantId, ctx.userId],
        )
      }
      // Built-in primitives (office / computer) — every kind, see
      // docs/architecture/features/builtin-primitives.md.
      await seedBuiltinPrimitiveCapabilities(
        (sql, params) => query(sql, params as never[]),
        assistantId,
        ctx.userId,
        'built-in primitive — default-on at assistant creation (agent surface)',
      )
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
      const workspaceId = requireWorkspace(ctx, 'updateAssistant')
      if (typeof workspaceId !== 'string') return workspaceId
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
      if (sets.length === 0) {
        return {
          data:
            `updateAssistant on assistant ${input.assistantId} did nothing: the call carried only the ` +
            'id, with no field to change. Nothing was saved. Re-issue with at least one of `name`, ' +
            '`systemPrompt`, `bio`, or `clearance` set to its new value; call getAssistant first if you ' +
            'need the current values to decide. Retrying with the same arguments will fail identically.',
          isError: true,
        }
      }
      values.push(input.assistantId, workspaceId)
      const result = await queryWithRLS<{ id: string }>(
        ctx.userId,
        `UPDATE assistants SET ${sets.join(', ')}
         WHERE id = $${values.length - 1} AND workspace_id = $${values.length}
         RETURNING id`,
        values,
      )
      if (result.rows.length === 0) {
        return notFoundFailure({
          kind: 'Assistant',
          id: input.assistantId,
          discoveryTool: 'listAssistants',
          extra:
            'Nothing was saved. Either no assistant with that id exists in the workspace this ' +
            'credential is bound to, or it exists but is not visible to the acting principal — ' +
            'listAssistants shows exactly the ones that are reachable.',
          idSource: 'a listAssistants result (the `id` field), never an assistant name',
        })
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
