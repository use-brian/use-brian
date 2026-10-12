/**
 * Brian's path to the shared Project commands (project-shared-spaces.md ->
 * "Canonical commands"). The same actor-bound store backs the REST routes and
 * the Projects screens, so a change made here and one made on screen carry
 * identical authority, confirmation, revision checks and audit.
 *
 * [COMP:api/project-shared-governance]
 */
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '@use-brian/core'
import { query } from '../db/client.js'
import { createProjectSharedStore, type ProjectSharedStore } from '../db/project-shared-store.js'
import { WorkspaceAccessError } from './policy.js'

const uuid = z.string().uuid()
const principal = z.object({ kind: z.enum(['user', 'assistant']), id: uuid }).strict()
const revision = z.number().int().positive().optional()

export const manageProjectAccessSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('create'), name: z.string().trim().min(1).max(200), description: z.string().max(2000).optional(),
    userIds: z.array(uuid).max(200).default([]), assistantIds: z.array(uuid).max(50).default([]),
    excludePrimaryAssistant: z.boolean().default(false) }).strict(),
  z.object({ action: z.literal('add_participant'), projectId: uuid, principal, expiresAt: z.string().datetime().nullable().optional(), expectedRevision: revision }).strict(),
  z.object({ action: z.literal('remove_participant'), projectId: uuid, principal, expectedRevision: revision }).strict(),
  z.object({ action: z.literal('add_owner'), projectId: uuid, userId: uuid, expectedRevision: revision }).strict(),
  z.object({ action: z.literal('remove_owner'), projectId: uuid, userId: uuid, expectedRevision: revision }).strict(),
  z.object({ action: z.literal('transfer_owner'), projectId: uuid, userId: uuid, expectedRevision: revision }).strict(),
  z.object({ action: z.literal('recover'), projectId: uuid, targetUserId: uuid.nullable().optional(), reason: z.string().trim().min(1).max(1000), expectedRevision: revision }).strict(),
  z.object({ action: z.literal('archive'), projectId: uuid, archived: z.boolean(), expectedRevision: revision }).strict(),
  z.object({ action: z.literal('convert'), projectId: uuid, ownerUserId: uuid.nullable().optional(),
    userIds: z.array(uuid).max(200), assistantIds: z.array(uuid).max(50), idempotencyKey: uuid, requestHash: z.string().regex(/^[a-f0-9]{64}$/) }).strict(),
])
type ManageInput = z.infer<typeof manageProjectAccessSchema>

function actor(context: ToolContext): { workspaceId: string; userId: string } {
  // A verified person in a workspace turn. Keys, public lanes and system reads never govern a Project.
  if (!context.workspaceId || !context.workspaceActorUserId || context.systemRead || context.programmaticPrincipal) {
    throw new WorkspaceAccessError('project_owner_required', 403)
  }
  return { workspaceId: context.workspaceId, userId: context.workspaceActorUserId }
}
const failure = (error: unknown) => ({ isError: true, data: { error: error instanceof WorkspaceAccessError ? error.code : 'project_unavailable' } })

/** D21: the workspace's one primary Brian, preselected unless the person deselected it. */
async function primaryAssistant(workspaceId: string): Promise<string | null> {
  return (await query<{ id: string }>("SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary' ORDER BY created_at LIMIT 1", [workspaceId])).rows[0]?.id ?? null
}

async function createRoster(workspaceId: string, input: Extract<ManageInput, { action: 'create' }>) {
  const primary = input.excludePrimaryAssistant ? null : await primaryAssistant(workspaceId)
  return { userIds: input.userIds, assistantIds: [...new Set([...input.assistantIds, ...(primary ? [primary] : [])])] }
}

function summary(input: ManageInput, roster?: { userIds: string[]; assistantIds: string[] }): string[] {
  const who = (p: { kind: string; id: string }) => `${p.kind === 'user' ? 'person' : 'assistant'} ${p.id}`
  switch (input.action) {
    case 'create': return [
      `Create the shared Project "${input.name}" with you as its owner.`,
      `Participants: ${roster?.userIds.length ? roster.userIds.map(id => `person ${id}`).join(', ') : 'no other people'}; assistants: ${roster?.assistantIds.length ? roster.assistantIds.map(id => `assistant ${id}`).join(', ') : 'none'}.`,
      'Only these participants (and the workspace owner, read only) can see its material. No Department or other source becomes readable to them.',
    ]
    case 'add_participant': return [`Add ${who(input.principal)} to Project ${input.projectId}${input.expiresAt ? ` until ${input.expiresAt}` : ''}. They can read and edit its shared material within their own clearance.`]
    case 'remove_participant': return [`Remove ${who(input.principal)} from Project ${input.projectId}. Their access to its shared material ends now, including running work.`]
    case 'add_owner': return [`Make person ${input.userId} an owner of Project ${input.projectId}. Owners manage its participants.`]
    case 'remove_owner': return [`Remove person ${input.userId} as an owner of Project ${input.projectId}. Their participation stays; a Project always keeps one owner.`]
    case 'transfer_owner': return [`Transfer your ownership of Project ${input.projectId} to person ${input.userId}. You stay a participant.`]
    case 'recover': return [`Add ${input.targetUserId ? `person ${input.targetUserId}` : 'yourself'} as an owner of Project ${input.projectId} (workspace owner recovery). Existing owners and participants stay; no assistant is re-added. Recorded in the Project audit with the reason: ${input.reason}`]
    case 'archive': return [input.archived
      ? `Archive Project ${input.projectId}. Bound workflows and scheduled jobs pause; restoring does not restart them.`
      : `Restore Project ${input.projectId}. Paused workflows and jobs stay paused until restarted.`]
    case 'convert': return [
      `Convert legacy Project ${input.projectId} into a shared Project owned by ${input.ownerUserId ? `person ${input.ownerUserId}` : 'you'}.`,
      `Reviewed participants: ${input.userIds.map(id => `person ${id}`).join(', ') || 'owner only'}; assistants: ${input.assistantIds.map(id => `assistant ${id}`).join(', ') || 'none'}.`,
      'No existing material is relabelled or republished.',
    ]
  }
}

async function run(store: ProjectSharedStore, p: { workspaceId: string; userId: string }, input: ManageInput) {
  switch (input.action) {
    case 'create': {
      const roster = await createRoster(p.workspaceId, input)
      return { projectId: await store.create(p.userId, p.workspaceId, { name: input.name, description: input.description ?? null, ...roster }) }
    }
    case 'add_participant': return { revision: await store.setMember(p.userId, input.projectId, input.principal, input.expiresAt ? new Date(input.expiresAt) : null, input.expectedRevision) }
    case 'remove_participant': return { revision: await store.removeMember(p.userId, input.projectId, input.principal, input.expectedRevision) }
    case 'add_owner': return { revision: await store.addOwner(p.userId, input.projectId, input.userId, input.expectedRevision) }
    case 'remove_owner': return { revision: await store.removeOwner(p.userId, input.projectId, input.userId, input.expectedRevision) }
    case 'transfer_owner': return { revision: await store.transferOwner(p.userId, input.projectId, input.userId, input.expectedRevision) }
    case 'recover': return { revision: await store.recover(p.userId, input.projectId, input.targetUserId ?? null, input.reason, input.expectedRevision) }
    case 'archive': return { revision: await store.archive(p.userId, input.projectId, input.archived, input.expectedRevision) }
    case 'convert': return { receipt: await store.applyConversion(p.userId, p.workspaceId, input.projectId, input) }
  }
}

export function createProjectAccessTools(store: ProjectSharedStore = createProjectSharedStore()): Tool[] {
  return [buildTool({
    name: 'inspectProjectAccess',
    description: 'Read shared Project access in this workspace. With no projectId: whether shared Projects are enabled and the shared Projects you can see with your role (owner, participant, or workspace-owner oversight) and revision. With projectId: its participants (people and assistants, owners flagged, expiry), the workspace owner\'s read oversight shown separately, status, revision and recent audit. Pass convertPreview with the reviewed roster to preview converting a legacy Project (workspace owner only); the preview returns the requestHash the conversion must present. A Project you cannot see does not exist for you.',
    inputSchema: z.object({
      projectId: uuid.optional(),
      convertPreview: z.object({ ownerUserId: uuid.nullable().optional(), userIds: z.array(uuid).max(200), assistantIds: z.array(uuid).max(50) }).strict().optional(),
    }).strict(),
    isReadOnly: true, isConcurrencySafe: true,
    async execute(input, context) {
      try {
        const p = actor(context)
        if (input.projectId && input.convertPreview) return { data: { preview: await store.previewConversion(p.userId, p.workspaceId, input.projectId, input.convertPreview) } }
        if (input.projectId) return { data: { roster: await store.roster(p.userId, p.workspaceId, input.projectId) } }
        return { data: { capability: await store.capability(p.userId, p.workspaceId), projects: await store.summaries(p.userId, p.workspaceId) } }
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'manageProjectAccess',
    description: 'Change who shares a Project, the same commands as the Projects screen. Actions: create (a new shared Project with you as owner; the workspace\'s primary Brian is included unless excludePrimaryAssistant is true; other assistants and people only when listed), add_participant / remove_participant (a person or an assistant, optional expiry; no clearance choice), add_owner, remove_owner (a Project always keeps one owner), transfer_owner, recover (workspace owner only, with a reason recorded in the Project audit; existing owners stay), archive (archived true or false), convert (workspace owner only: apply a legacy-Project conversion previewed with inspectProjectAccess, presenting its requestHash and a UUID idempotencyKey). Only Project owners manage participants; a workspace role grants nothing except the workspace owner\'s recovery and conversion. Membership never releases a Department or private source. Use inspectProjectAccess first for ids and the current revision; pass expectedRevision to refuse a stale change.',
    inputSchema: manageProjectAccessSchema,
    isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: true, allowPersistentApproval: false,
    async describeConfirmation(input, context) {
      const parsed = manageProjectAccessSchema.parse(input)
      const roster = parsed.action === 'create' && context.workspaceId ? await createRoster(context.workspaceId, parsed) : undefined
      return summary(parsed, roster)
    },
    async execute(input, context) {
      try { return { data: await run(store, actor(context), manageProjectAccessSchema.parse(input)) } } catch (error) { return failure(error) }
    },
  })]
}
