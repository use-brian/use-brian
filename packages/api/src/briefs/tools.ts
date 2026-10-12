/**
 * Brian's path to the Brief commands (project-briefs.md -> "Commands"). The
 * same service backs the REST routes and the Brief pane, so a change made here
 * and one made on screen carry identical authority, revision checks, errors
 * and receipts. Governing actions (apply, select_departments, restore, repair)
 * require the person's confirmation: Brian executes an owner's explicit
 * acceptance, never its own inference.
 *
 * [COMP:api/brief-publication]
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '@use-brian/core'
import { WorkspaceAccessError } from '../workspace-access/policy.js'
import {
  dismissProposal,
  ensureBrief,
  inspectBrief,
  briefHistory,
  listDepartmentBriefs,
  proposeChange,
  repairBrief,
  saveDraft,
  selectDepartmentBriefs,
  type BriefActor,
  type BriefView,
} from './service.js'
import { applyDirection, restoreRevision } from './publication.js'
import { maintainBriefContext } from './maintenance.js'

const uuid = z.string().uuid()
const lines = z.array(z.string().trim().min(1).max(2000)).max(50)
const sections = z.object({ outcome: lines.optional(), rules: lines.optional(), decisions: lines.optional() }).strict()
const evidence = z.object({
  kind: z.string().trim().min(1).max(64),
  id: z.string().max(200).nullable().optional(),
  version: z.string().max(200).nullable().optional(),
  passage: z.string().max(4000).nullable().optional(),
  label: z.string().max(200).nullable().optional(),
}).strict()

export const manageBriefSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('save_draft'), bindingId: uuid, sections, summary: z.string().max(2000).optional() }).strict(),
  z.object({ action: z.literal('propose'), bindingId: uuid, sections, evidence: z.array(evidence).min(1).max(20), summary: z.string().max(2000).optional() }).strict(),
  z.object({ action: z.literal('dismiss'), proposalId: uuid }).strict(),
  z.object({ action: z.literal('apply'), bindingId: uuid, proposalId: uuid.optional(), sections: sections.optional(),
    expectedDirectionRevision: z.number().int().min(0), expectedSelectionRevision: z.number().int().min(0),
    activeWork: z.enum(['pause', 'continue']).default('pause'), idempotencyKey: uuid.optional() }).strict(),
  z.object({ action: z.literal('restore'), bindingId: uuid, revisionId: uuid }).strict(),
  z.object({ action: z.literal('select_departments'), bindingId: uuid, departmentBindingIds: z.array(uuid).max(20),
    expectedSelectionRevision: z.number().int().min(0), activeWork: z.enum(['pause', 'continue']).default('pause'), idempotencyKey: uuid.optional() }).strict(),
  z.object({ action: z.literal('repair'), bindingId: uuid }).strict(),
])
type ManageInput = z.infer<typeof manageBriefSchema>
const GOVERNING = new Set(['apply', 'restore', 'select_departments', 'repair'])

export const maintainBriefContextSchema = z.object({
  bindingId: uuid,
  section: z.enum(['findings', 'questions', 'references']),
  items: z.array(z.object({ text: z.string().trim().max(2000).optional(), source: evidence }).strict()).min(1).max(20),
  coverage: z.enum(['complete', 'partial']).default('complete'),
}).strict()

/** A verified person in a workspace turn. System reads never govern a Brief. */
export function briefActor(context: ToolContext): BriefActor {
  const userId = context.workspaceActorUserId ?? context.programmaticPrincipal?.userId
  if (!context.workspaceId || !userId || context.systemRead) throw new WorkspaceAccessError('brief_owner_required', 403)
  return { userId, workspaceId: context.workspaceId, assistantId: context.assistantId ?? null }
}

const failure = (error: unknown) => ({ isError: true, data: { error: error instanceof WorkspaceAccessError ? error.code : 'brief_unavailable' } })

/** Model-facing projection: accepted Direction, context, pending proposals (labelled pending). */
function present(view: BriefView) {
  return {
    bindingId: view.binding.id,
    owner: { kind: view.binding.ownerKind, id: view.binding.ownerId },
    role: view.role,
    pageId: view.pageId,
    missing: view.missing,
    directionRevision: view.binding.directionRevision,
    selectionRevision: view.binding.selectionRevision,
    established: view.established,
    acceptedDirection: view.direction,
    currentContext: view.context ? Object.fromEntries(Object.entries(view.context).map(([key, blocks]) =>
      [key, blocks.map(block => (block as { text?: string }).text ?? '').filter(Boolean)])) : null,
    pendingProposals: view.proposals.map(p => ({ id: p.id, status: 'pending', stale: p.stale, summary: p.summary,
      authorUserId: p.authorUserId, authorAssistantId: p.authorAssistantId, evidence: p.evidence, baseDirectionRevision: p.baseDirectionRevision })),
    myDraft: view.myDraft ? { id: view.myDraft.id, stale: view.myDraft.stale, summary: view.myDraft.summary } : null,
    selectedDepartmentBriefs: view.selections,
  }
}

function summary(input: ManageInput): string[] {
  switch (input.action) {
    case 'apply': return [
      `Apply new accepted direction to Brief ${input.bindingId}${input.proposalId ? ` from proposal ${input.proposalId}` : ''}.`,
      'Every new chat in this scope follows it from the next turn. Running work governed by it',
      input.activeWork === 'continue' ? 'continues (you are declaring the change compatible).' : 'pauses at its next action for review.',
    ]
    case 'restore': return [`Prepare a proposal that restores accepted revision ${input.revisionId} of Brief ${input.bindingId}. Nothing changes until an owner applies it.`]
    case 'select_departments': return [
      `Set the Department Briefs whose accepted rules apply to Project Brief ${input.bindingId}: ${input.departmentBindingIds.join(', ') || 'none'}.`,
      'Selection grants no access to Department sources and copies no rules.',
    ]
    case 'repair': return [`Recreate the missing Brief Page for ${input.bindingId} from its last accepted revision. Current context starts empty.`]
    default: return [`Brief ${input.action}.`]
  }
}

async function run(actor: BriefActor, input: ManageInput) {
  switch (input.action) {
    case 'save_draft': return { draft: await saveDraft(actor, input.bindingId, { sections: input.sections }, { summary: input.summary ?? null }) }
    case 'propose': return { proposal: await proposeChange(actor, input.bindingId, { sections: input.sections }, { evidence: input.evidence, summary: input.summary ?? null }) }
    case 'dismiss': await dismissProposal(actor, input.proposalId); return { dismissed: input.proposalId }
    case 'apply': return { receipt: await applyDirection(actor, input.bindingId, {
      proposalId: input.proposalId ?? null, ...(input.sections ? { change: { sections: input.sections } } : {}),
      expectedDirectionRevision: input.expectedDirectionRevision, expectedSelectionRevision: input.expectedSelectionRevision,
      activeWork: input.activeWork, idempotencyKey: input.idempotencyKey ?? randomUUID(),
    }) }
    case 'restore': return await restoreRevision(actor, input.bindingId, input.revisionId)
    case 'select_departments': return { receipt: await selectDepartmentBriefs(actor, input.bindingId, {
      departmentBindingIds: input.departmentBindingIds, expectedSelectionRevision: input.expectedSelectionRevision,
      activeWork: input.activeWork, idempotencyKey: input.idempotencyKey ?? randomUUID(),
    }) }
    case 'repair': return await repairBrief(actor, input.bindingId)
  }
}

export function createBriefTools(): Tool[] {
  return [buildTool({
    name: 'inspectBrief',
    description: 'Read the governed Brief of a shared Project or a Department: its accepted Direction (outcome, working rules, accepted decisions; empty means not established), Current context (findings, open questions, references and progress), pending proposals (always labelled pending; never accepted direction), your own autosaved draft, the selected Department Briefs and the revisions. Pass projectId or departmentId (or bindingId). Pass create: true to create the Brief if it does not exist yet (a name-only Brief has no Direction until an owner applies one). Pass history: true for the accepted revision history, or listDepartments: true for the Department Briefs you can see.',
    inputSchema: z.object({
      projectId: uuid.optional(), departmentId: uuid.optional(), bindingId: uuid.optional(),
      create: z.boolean().default(false), history: z.boolean().default(false), listDepartments: z.boolean().default(false),
    }).strict(),
    isReadOnly: true, isConcurrencySafe: true,
    async execute(input, context) {
      try {
        const actor = briefActor(context)
        if (input.listDepartments) return { data: { departmentBriefs: await listDepartmentBriefs(actor) } }
        const owner = input.projectId ? { kind: 'project' as const, id: input.projectId } : input.departmentId ? { kind: 'department' as const, id: input.departmentId } : null
        let bindingId = input.bindingId
        if (!bindingId && owner && input.create) bindingId = (await ensureBrief(actor, owner)).bindingId
        const view = await inspectBrief(actor, bindingId ? { bindingId } : owner ? { owner } : (() => { throw new WorkspaceAccessError('brief_not_found', 404) })())
        return { data: { brief: present(view), ...(input.history ? { history: await briefHistory(actor, view.binding.id) } : {}) } }
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'manageBrief',
    description: 'Change a Brief through the same commands as the Brief pane. save_draft stores your own unaccepted draft of Direction sections. propose stores a reviewable proposal with its original source passages and versions as evidence (use this for every goal, rule or decision change you suggest, including from a meeting note or chat). dismiss closes a proposal. apply is an owner\'s explicit acceptance: pass proposalId (or the owner\'s exact sections), the expectedDirectionRevision and expectedSelectionRevision from inspectBrief, and activeWork (pause, the default, pauses running work governed by the change at its next action; continue declares it compatible). Never apply on your own inference that a change is wanted. restore prepares a proposal that restores a past accepted revision. select_departments sets which Department Briefs\' accepted rules apply to a Project (owners only; grants no access). repair recreates a missing Brief Page from its last accepted revision. Only owners apply, select, restore or repair; workspace-owner oversight is read only.',
    inputSchema: manageBriefSchema,
    isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: true, allowPersistentApproval: false,
    async resolveConfirmation(_context, input) {
      const parsed = manageBriefSchema.safeParse(input)
      return !parsed.success || GOVERNING.has(parsed.data.action)
    },
    async describeConfirmation(input) {
      return summary(manageBriefSchema.parse(input))
    },
    async execute(input, context) {
      try { return { data: await run(briefActor(context), manageBriefSchema.parse(input)) } } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'maintainBriefContext',
    description: 'Add attributable Current context to a Brief: findings, open questions, or references and progress, each with the source you actually inspected (kind and id, version when known, the original passage). Repeating an item already recorded is a no-op. For task or goal sources the status line is read from the record itself. Mark coverage partial when you only saw part of the material. A source the Brief audience cannot read is not written. This never changes accepted Direction; propose goal, rule or decision changes with manageBrief.',
    inputSchema: maintainBriefContextSchema,
    isReadOnly: false, isConcurrencySafe: false,
    async execute(input, context) {
      try {
        const parsed = maintainBriefContextSchema.parse(input)
        return { data: await maintainBriefContext(briefActor(context), parsed.bindingId, parsed) }
      } catch (error) { return failure(error) }
    },
  })]
}
