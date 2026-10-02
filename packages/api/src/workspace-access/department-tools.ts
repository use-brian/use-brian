/**
 * Brian's path to the department commands (permission model v2, D25). The
 * same actor-bound store backs the REST routes and Organization -> Departments,
 * so a change made here and one made on screen carry identical authority,
 * confirmation and audit (I20).
 * Spec: docs/architecture/features/workspace-access.md -> "Department
 * management and home departments (v2, migration 651)".
 */
import { z } from 'zod'
import { buildTool, type Tool, type ToolContext } from '@use-brian/core'
import { createDepartmentStore, type DepartmentStore } from '../db/department-store.js'
import { WorkspaceAccessError } from './policy.js'

const uuid = z.string().uuid()
const principal = z.object({ kind: z.enum(['user', 'assistant']), id: uuid }).strict()
const clearance = z.enum(['public', 'internal', 'confidential'])

export const manageDepartmentsSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('set_member'), departmentId: uuid, principal, clearance, expiresAt: z.string().datetime().nullable().optional(), expectedRevision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('remove_member'), departmentId: uuid, principal, expectedRevision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('add_owner'), departmentId: uuid, userId: uuid, expectedRevision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('remove_owner'), departmentId: uuid, userId: uuid, expectedRevision: z.number().int().positive().optional() }).strict(),
  z.object({ action: z.literal('break_glass'), departmentId: uuid, reason: z.string().trim().min(1).max(1000) }).strict(),
  z.object({ action: z.literal('set_home'), principal, departmentId: uuid.nullable() }).strict(),
])
type ManageInput = z.infer<typeof manageDepartmentsSchema>

function actor(context: ToolContext): { workspaceId: string; userId: string } {
  // A verified person in a workspace turn. Keys, public lanes and system reads never manage departments.
  if (!context.workspaceId || !context.workspaceActorUserId || context.systemRead || context.programmaticPrincipal) {
    throw new WorkspaceAccessError('department_owner_required', 403)
  }
  return { workspaceId: context.workspaceId, userId: context.workspaceActorUserId }
}
const failure = (error: unknown) => ({ isError: true, data: { error: error instanceof WorkspaceAccessError ? error.code : 'department_unavailable' } })

function summary(input: ManageInput): string[] {
  switch (input.action) {
    case 'set_member': return [`Give ${input.principal.kind} ${input.principal.id} ${input.clearance} clearance in department ${input.departmentId}${input.expiresAt ? `, expiring ${input.expiresAt}` : ''}.`]
    case 'remove_member': return [`Remove ${input.principal.kind} ${input.principal.id} from department ${input.departmentId}. They lose every read there.`]
    case 'add_owner': return [`Make person ${input.userId} an owner of department ${input.departmentId}, with confidential clearance there.`]
    case 'remove_owner': return [`Remove person ${input.userId} as an owner of department ${input.departmentId}. Their membership stays.`]
    case 'break_glass': return [`Add yourself as an owner of department ${input.departmentId}. Its members will see this in the department audit, with the reason: ${input.reason}`]
    case 'set_home': return [input.departmentId
      ? `Set the home department of ${input.principal.kind} ${input.principal.id} to ${input.departmentId}. Writes that name no department will land there.`
      : `Clear the home department of ${input.principal.kind} ${input.principal.id}. Writes that name no department will be General.`]
  }
}

async function run(store: DepartmentStore, p: { workspaceId: string; userId: string }, input: ManageInput) {
  if (input.action !== 'set_home' && !(await store.inWorkspace(p.userId, p.workspaceId, input.departmentId))) {
    throw new WorkspaceAccessError('department_not_found', 404)
  }
  switch (input.action) {
    case 'set_member': return { revision: await store.setEdge(p.userId, input.departmentId, input.principal, input.clearance, input.expiresAt ? new Date(input.expiresAt) : null, input.expectedRevision) }
    case 'remove_member': return { revision: await store.removeEdge(p.userId, input.departmentId, input.principal, input.expectedRevision) }
    case 'add_owner': return { revision: await store.addOwner(p.userId, input.departmentId, input.userId, input.expectedRevision) }
    case 'remove_owner': return { revision: await store.removeOwner(p.userId, input.departmentId, input.userId, input.expectedRevision) }
    case 'break_glass': return { revision: await store.breakGlass(p.userId, input.departmentId, input.reason) }
    case 'set_home': await store.setHome(p.userId, p.workspaceId, input.principal, input.departmentId); return { ok: true }
  }
}

export function createDepartmentTools(store: DepartmentStore = createDepartmentStore()): Tool[] {
  return [buildTool({
    name: 'inspectDepartments',
    description: 'List the departments you can see in this workspace with your clearance in each, whether you own it, its owners and revision, plus home departments. Pass departmentId to read that department\'s members and assistants with their clearance, expiry and origin. A department you are not a member of is invisible unless you are the workspace owner, who sees only its name and owners.',
    inputSchema: z.object({ departmentId: uuid.optional() }).strict(),
    isReadOnly: true, isConcurrencySafe: true,
    async execute(input, context) {
      try {
        const p = actor(context)
        if (input.departmentId) {
          if (!(await store.inWorkspace(p.userId, p.workspaceId, input.departmentId))) throw new WorkspaceAccessError('department_not_found', 404)
          return { data: { edges: await store.listEdges(p.userId, input.departmentId) } }
        }
        return { data: { departments: await store.directory(p.userId, p.workspaceId), homes: await store.homes(p.userId, p.workspaceId) } }
      } catch (error) { return failure(error) }
    },
  }), buildTool({
    name: 'manageDepartments',
    description: 'Change who is in a department and how deep they read, the same commands as Organization > Departments. Actions: set_member (add a person or assistant, or change clearance or expiry; never above your own clearance there), remove_member, add_owner, remove_owner (a department always keeps one owner), break_glass (workspace owner only, with a reason the members can see), set_home (a person or assistant\'s home department: writes naming no department land there; null clears it). Only department owners manage a department; a workspace role grants nothing. Use inspectDepartments first for ids and the current revision; pass expectedRevision to refuse a stale change.',
    inputSchema: manageDepartmentsSchema,
    isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: true, allowPersistentApproval: false,
    async describeConfirmation(input) { return summary(manageDepartmentsSchema.parse(input)) },
    async execute(input, context) {
      try { return { data: await run(store, actor(context), manageDepartmentsSchema.parse(input)) } } catch (error) { return failure(error) }
    },
  })]
}
