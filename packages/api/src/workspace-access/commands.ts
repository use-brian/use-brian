import { z } from 'zod'
import type { OrganizationCommand, DepartmentAccessCommand } from '@use-brian/shared'

const uuid = z.string().uuid()
const version = z.string().regex(/^[1-9][0-9]*$/)
export const departmentAccessRequestSchema = z.object({type:z.literal('access.request.create'),targetTeamId:uuid,beneficiaryKind:z.enum(['member','team']),beneficiaryId:uuid,reason:z.string().trim().min(1).max(1000),days:z.number().int().min(1).max(90),ongoing:z.boolean(),startsAt:z.string().datetime().optional()}).strict()
export const departmentAccessCommandSchema:z.ZodType<DepartmentAccessCommand> = z.discriminatedUnion('type',[
  z.object({type:z.literal('assistant.clearance.set'),assistantId:uuid,clearance:z.enum(['public','internal','confidential'])}).strict(),
  z.object({type:z.literal('member.access.set'),userId:uuid,clearance:z.enum(['public','internal','confidential']),teamScopeMode:z.enum(['legacy','assigned']),expectedPolicyRevision:version}).strict(),
  z.object({type:z.literal('assistant.audience.set'),assistantId:uuid,teamMode:z.enum(['all','assigned']),teamIds:z.array(uuid).max(100),defaultGroupId:uuid.nullable(),projectMode:z.enum(['all','assigned']),projectIds:z.array(uuid).max(100),defaultProjectId:uuid.nullable()}).strict(),
  z.object({type:z.literal('department.create'),name:z.string().trim().min(1).max(120),key:z.string().regex(/^[a-z0-9][a-z0-9-]{0,38}$/),description:z.string().max(2000).nullable().optional(),color:z.string().max(32).nullable().optional(),readAll:z.boolean().optional()}).strict(),
  z.object({type:z.literal('department.update'),teamId:uuid,name:z.string().trim().min(1).max(120).optional(),description:z.string().max(2000).nullable().optional(),color:z.string().max(32).nullable().optional(),status:z.literal('active').optional()}).strict(),
  z.object({type:z.literal('department.archive'),teamId:uuid}).strict(),
  z.object({type:z.literal('department.read_bundle.set'),teamId:uuid,readAll:z.boolean(),groupIds:z.array(uuid).max(100)}).strict(),
  z.object({type:z.literal('department.assistant.set'),teamId:uuid,assistantId:uuid,enabled:z.boolean()}).strict(),
  z.object({type:z.literal('department.configure'),teamId:uuid,directoryVisibility:z.enum(['members','workspace']),requestable:z.boolean()}).strict(),
  z.object({type:z.literal('department.manager.set'),teamId:uuid,userId:uuid,capabilities:z.array(z.enum(['manage_members','approve_read_requests'])).max(2)}).strict(),
  z.object({type:z.literal('department.member.set'),teamId:uuid,userId:uuid,enabled:z.boolean(),activateAssigned:z.boolean().optional()}).strict(),
  departmentAccessRequestSchema,
  z.object({type:z.literal('access.request.decide'),requestId:uuid,expectedVersion:version,payloadHash:z.string().regex(/^[a-f0-9]{64}$/),policyRevision:version,decision:z.enum(['approved','rejected']),reason:z.string().trim().max(1000).optional()}).strict(),
  z.object({type:z.literal('access.request.cancel'),requestId:uuid,expectedVersion:version}).strict(),
  z.object({type:z.literal('access.request.assign'),requestId:uuid}).strict(),
  z.object({type:z.literal('access.grant.revoke'),grantId:uuid,reason:z.string().trim().min(1).max(1000)}).strict(),
])
export const departmentCommandIntentSchema=z.object({command:departmentAccessCommandSchema,expectedPolicyRevision:version,idempotencyKey:uuid}).strict()
export const departmentCommandApplySchema=z.object({type:z.literal('access.command.apply'),reviewId:uuid,payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()
/** Untrusted input cannot set acting identity, workspace or administrative authority. */
export const organizationCommandSchema: z.ZodType<OrganizationCommand> = z.discriminatedUnion('type', [
  z.object({ type: z.literal('org.initialize.subject'), subjectId: uuid, kind: z.enum(['member','assistant']), teamId: uuid,
    expectedRevision: z.string().regex(/^(0|[1-9][0-9]*)$/), expectedPolicyRevision: version }).strict(),
  z.object({ type: z.literal('org.unit.save'), id: uuid.optional(), expectedVersion: version.optional(),
    name: z.string().trim().min(1).max(120), parentId: uuid.nullable(), teamId: uuid.nullable(),
    directoryVisibility: z.enum(['members','workspace']), position: z.number().int().min(0).max(1_000_000) }).strict(),
  z.object({ type: z.literal('org.unit.archive'), id: uuid, expectedVersion: version, destinationId: uuid.nullable() }).strict(),
  z.object({ type: z.literal('org.placement.save'), id: uuid.optional(), expectedVersion: version.optional(),
    unitId: uuid, userId: uuid.nullable(), assistantId: uuid.nullable(), isPrimary: z.boolean(),
    reportsToUserId: uuid.nullable(), accountableUserId: uuid.nullable() }).strict(),
  z.object({ type: z.literal('org.placement.remove'), id: uuid, expectedVersion: version }).strict(),
]).superRefine((command, ctx) => {
  if ((command.type === 'org.unit.save' || command.type === 'org.placement.save') && Boolean(command.id) !== Boolean(command.expectedVersion)) {
    ctx.addIssue({ code: 'custom', message: 'id_and_version_required_together' })
  }
  if (command.type === 'org.placement.save') {
    if (Boolean(command.userId) === Boolean(command.assistantId)) ctx.addIssue({ code: 'custom', message: 'one_subject_required' })
    if (command.reportsToUserId && (!command.userId || !command.isPrimary || command.userId === command.reportsToUserId)) ctx.addIssue({ code: 'custom', message: 'invalid_reporting' })
    if (command.accountableUserId && (!command.assistantId || !command.isPrimary)) ctx.addIssue({ code: 'custom', message: 'invalid_accountability' })
  }
})


export const organizationCommandIntentSchema=z.object({command:organizationCommandSchema,expectedRevision:z.string().regex(/^(0|[1-9][0-9]*)$/),expectedPolicyRevision:version,idempotencyKey:uuid}).strict()
export const organizationCommandApplySchema=z.object({type:z.literal('org.command.apply'),reviewId:uuid,payloadHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict()

export const workspaceAccessHistoryQuerySchema=z.object({after:z.string().uuid().optional(),expectedPolicyRevision:z.string().regex(/^[1-9][0-9]*$/).optional()}).strict().refine(value=>Boolean(value.after)===Boolean(value.expectedPolicyRevision));


export const workspaceAccessExplanationQuerySchema = z.object({
  memberId:uuid.optional(),assistantId:uuid.optional(),contextTeamId:uuid.optional(),contextProjectId:uuid.optional(),
  targetTeamId:uuid.optional(),action:z.enum(['read','edit']).optional(),sensitivity:z.enum(['public','internal','confidential']).optional(),
  expectedPolicyRevision:version.optional(),
}).strict()
