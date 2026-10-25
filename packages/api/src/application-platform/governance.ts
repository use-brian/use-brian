/** Current native module governance; deployed ports remain private. [COMP:api/application-governance] */
import { z } from 'zod'
import type { Pool, PoolClient } from 'pg'
import { CrmConfigCommandSchema,type ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { getApplicationExecutionBinding, runApplicationTransaction } from './execution-context.js'

export const applicationGovernanceModuleInput = z.object({ moduleKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/) }).strict()
export const applicationGovernanceCatalogInput=applicationGovernanceModuleInput.extend({afterId:z.string().uuid().optional()}).strict()
const roleAssignment = z.object({ kind: z.literal('assign_role'),userId: z.string().uuid(),roleKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
  startsAt: z.string().datetime({offset:true}),expiresAt: z.string().datetime({offset:true}).nullable() }).strict()
const roleRevocation = z.object({kind:z.literal('revoke_role'),assignmentId:z.string().uuid(),expectedVersion:z.string().regex(/^[1-9]\d*$/)}).strict()
export const nativeGovernanceResourceType = z.enum(['company','person','deal','task','file','workspace_member'])
export const applicationConfigurationField = z.discriminatedUnion('kind',[
  z.object({key:z.string(),kind:z.literal('text'),required:z.boolean(),maxLength:z.number().int().min(1).max(2048)}).strict(),
  z.object({key:z.string(),kind:z.literal('boolean'),required:z.boolean()}).strict(),
  z.object({key:z.string(),kind:z.literal('integer'),required:z.boolean()}).strict(),
  z.object({key:z.string(),kind:z.literal('enum'),required:z.boolean(),values:z.array(z.string()).min(1).max(64)}).strict(),
])
const nativeOwnerBinding=z.object({kind:z.literal('bind_native_owner'),typeKey:nativeGovernanceResourceType}).strict()
const configurationChange=z.object({kind:z.literal('configure'),operationKey:z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
  input:z.record(z.string().regex(/^[a-z][a-zA-Z0-9_]{0,63}$/),z.union([z.string().max(2048),z.boolean(),z.number().int().min(-2147483648).max(2147483647)])).refine(value=>Object.keys(value).length<=16)}).strict()
const orderIds=z.array(z.string().uuid()).max(200)
export const applicationCrmConfigurationCommandInput=z.union([CrmConfigCommandSchema,
  z.object({kind:z.literal('reorder_pipelines'),orderedIds:orderIds}).strict(),
  z.object({kind:z.literal('reorder_pipeline_stages'),pipelineId:z.string().uuid(),orderedIds:orderIds}).strict(),
  z.object({kind:z.literal('reorder_record_fields'),entityKind:z.enum(['company','person','deal']),orderedIds:orderIds}).strict(),
])
const crmConfigurationChange=z.object({kind:z.literal('configure_crm'),command:applicationCrmConfigurationCommandInput}).strict()
const ownerBinding = z.object({kind:z.literal('bind_owner'),entityTypeId:z.string().uuid()}).strict()
export const applicationGovernancePreviewInput = applicationGovernanceModuleInput.extend({expectedRevision:z.string().regex(/^[0-9a-f]{64}$/),
  operation:z.discriminatedUnion('kind',[roleAssignment,roleRevocation,ownerBinding,nativeOwnerBinding,configurationChange,crmConfigurationChange])}).strict()
export const applicationGovernanceApplyInput = z.object({reviewId:z.string().uuid()}).strict()
export type ApplicationGovernancePreviewInput = z.infer<typeof applicationGovernancePreviewInput>
export type ApplicationGovernanceApplyInput = z.infer<typeof applicationGovernanceApplyInput>

export function assertNativeApplicationGovernance(execution:ExecutionContext):void {
  if (getApplicationExecutionBinding(execution) || execution.identity.kind!=='attended'
    || execution.identity.principal.kind!=='workspace_member' || execution.surface.readOnly) {
    throw new ApplicationPlatformError('authentication_required','Native module governance authentication is required.')
  }
}
export const applicationGovernanceCatalogShape=applicationGovernanceModuleInput.extend({revision:z.string().regex(/^[0-9a-f]{64}$/),roleKeys:z.array(z.string()).max(64),
  operations:z.array(z.enum(['assign_role','revoke_role','bind_owner','bind_native_owner','configure','configure_crm'])),
  nativeResourceTypes:z.array(nativeGovernanceResourceType).max(6),ownedNativeResourceTypes:z.array(nativeGovernanceResourceType).max(6),configurationOperations:z.array(z.object({operationKey:z.string(),inputFields:z.array(applicationConfigurationField).max(16),requiredRoleKeys:z.array(z.string()).min(1).max(64)}).strict()).max(32),
  configurationRevision:z.string().min(1).max(256).nullable(),roleAssignments:z.array(z.object({id:z.string().uuid(),userId:z.string().uuid(),roleKey:z.string(),
    status:z.enum(['active','revoked']),startsAt:z.string(),expiresAt:z.string().nullable(),version:z.string().regex(/^[1-9]\d*$/),issuedByUserId:z.string().uuid()}).strict()).max(100),
  nextCursor:z.string().uuid().nullable()}).strict()
export const applicationGovernanceReviewShape=z.object({id:z.string().uuid(),moduleKey:z.string(),revision:z.string(),proposal:applicationGovernancePreviewInput.shape.operation,
  expiresAt:z.string(),canApply:z.literal(true)}).strict()
export const applicationGovernanceOutcomeShape=z.object({id:z.string().uuid(),moduleKey:z.string(),kind:z.enum(['assign_role','revoke_role','bind_owner','bind_native_owner','configure','configure_crm']),resourceId:z.string().uuid(),
  version:z.string().regex(/^[1-9]\d*$/),typeKey:nativeGovernanceResourceType.optional(),configurationRevision:z.string().min(1).max(256).optional(),subjectKind:z.string().optional(),created:z.boolean().optional(),changed:z.boolean().optional(),applied:z.literal(true)}).strict()
export type ApplicationGovernanceCatalog=z.infer<typeof applicationGovernanceCatalogShape>
export type ApplicationGovernanceReview=z.infer<typeof applicationGovernanceReviewShape>
export type ApplicationGovernanceOutcome=z.infer<typeof applicationGovernanceOutcomeShape>
export function readApplicationGovernanceCatalog(pool:Pool,execution:ExecutionContext,raw:unknown) {
  return runApplicationTransaction(pool,execution,client => readApplicationGovernanceCatalogInTransaction(client,execution,raw))
}
async function readApplicationGovernanceCatalogInTransaction(client:PoolClient,execution:ExecutionContext,raw:unknown) {
  assertNativeApplicationGovernance(execution)
  const input=applicationGovernanceCatalogInput.safeParse(raw)
  if (!input.success) throw new ApplicationPlatformError('invalid_value','The governance module selection is invalid.')
  return applicationGovernanceCatalogShape.parse((await client.query<{value:unknown}>('SELECT read_native_application_governance_catalog($1,$2,$3,$4) AS value',
    [execution.security.access.workspaceId,execution.assistant.id,input.data.moduleKey,input.data.afterId ?? null])).rows[0]?.value)
}
export function previewApplicationGovernance(pool:Pool,execution:ExecutionContext,raw:unknown) {
  return runApplicationTransaction(pool,execution,client => previewApplicationGovernanceInTransaction(client,execution,raw),true)
}
async function previewApplicationGovernanceInTransaction(client:PoolClient,execution:ExecutionContext,raw:unknown) {
  assertNativeApplicationGovernance(execution)
  const input=applicationGovernancePreviewInput.safeParse(raw)
  if (!input.success) throw new ApplicationPlatformError('invalid_value','The native governance proposal is invalid.')
  const operation=input.data.operation.kind==='assign_role' ? {...input.data.operation,startsAt:new Date(input.data.operation.startsAt).toISOString(),
    expiresAt:input.data.operation.expiresAt ? new Date(input.data.operation.expiresAt).toISOString() : null} : input.data.operation
  return applicationGovernanceReviewShape.parse((await client.query<{value:unknown}>(
    'SELECT application_prepare_native_governance_review($1,$2,$3,$4,$5) AS value',
    [execution.security.access.workspaceId,execution.assistant.id,input.data.moduleKey,input.data.expectedRevision,operation])).rows[0]?.value)
}
export function applyApplicationGovernance(pool:Pool,execution:ExecutionContext,raw:unknown) {
  return runApplicationTransaction(pool,execution,client => applyApplicationGovernanceInTransaction(client,execution,raw),true)
}
async function applyApplicationGovernanceInTransaction(client:PoolClient,execution:ExecutionContext,raw:unknown) {
  assertNativeApplicationGovernance(execution)
  const input=applicationGovernanceApplyInput.safeParse(raw)
  if (!input.success) throw new ApplicationPlatformError('invalid_value','The native governance review is invalid.')
  return applicationGovernanceOutcomeShape.parse((await client.query<{value:unknown}>(
    'SELECT application_apply_native_governance_review($1,$2,$3) AS value',[execution.security.access.workspaceId,execution.assistant.id,input.data.reviewId])).rows[0]?.value)
}

/** Build the exact deployed input vocabulary for the native Brian management profile. */
export function applicationConfigurationInputShape(fields:z.infer<typeof applicationConfigurationField>[]) {
  const shape:Record<string,z.ZodType>={}
  for(const field of fields) {
    let value:z.ZodType
    switch(field.kind) {
      case 'text':value=z.string().max(field.maxLength);break
      case 'boolean':value=z.boolean();break
      case 'integer':value=z.number().int().min(-2147483648).max(2147483647);break
      case 'enum':value=z.enum(field.values as [string,...string[]]);break
    }
    shape[field.key]=field.required?value:value.optional()
  }
  return z.object(shape).strict()
}
