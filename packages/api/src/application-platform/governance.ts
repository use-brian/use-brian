/** Current native module governance; deployed ports remain private. [COMP:api/application-governance] */
import { z } from 'zod'
import type { PoolClient } from 'pg'
import type { ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { getApplicationExecutionBinding } from './execution-context.js'

export const applicationGovernanceModuleInput = z.object({ moduleKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/) }).strict()
export const applicationGovernanceCatalogInput=applicationGovernanceModuleInput.extend({afterId:z.string().uuid().optional()}).strict()
const roleAssignment = z.object({ kind: z.literal('assign_role'),userId: z.string().uuid(),roleKey: z.string().regex(/^[a-z][a-z0-9_.-]{0,127}$/),
  startsAt: z.string().datetime({offset:true}),expiresAt: z.string().datetime({offset:true}).nullable() }).strict()
const roleRevocation = z.object({kind:z.literal('revoke_role'),assignmentId:z.string().uuid(),expectedVersion:z.string().regex(/^[1-9]\d*$/)}).strict()
const ownerBinding = z.object({kind:z.literal('bind_owner'),entityTypeId:z.string().uuid()}).strict()
export const applicationGovernancePreviewInput = applicationGovernanceModuleInput.extend({expectedRevision:z.string().regex(/^[0-9a-f]{64}$/),
  operation:z.discriminatedUnion('kind',[roleAssignment,roleRevocation,ownerBinding])}).strict()
export const applicationGovernanceApplyInput = z.object({reviewId:z.string().uuid()}).strict()
export type ApplicationGovernancePreviewInput = z.infer<typeof applicationGovernancePreviewInput>
export type ApplicationGovernanceApplyInput = z.infer<typeof applicationGovernanceApplyInput>

export function assertNativeApplicationGovernance(execution:ExecutionContext):void {
  if (getApplicationExecutionBinding(execution) || execution.identity.kind!=='attended'
    || execution.identity.principal.kind!=='workspace_member' || execution.surface.readOnly) {
    throw new ApplicationPlatformError('authentication_required','Native module governance authentication is required.')
  }
}
const catalogShape=applicationGovernanceModuleInput.extend({revision:z.string().regex(/^[0-9a-f]{64}$/),roleKeys:z.array(z.string()).max(64),
  operations:z.array(z.enum(['assign_role','revoke_role','bind_owner'])),roleAssignments:z.array(z.object({id:z.string().uuid(),userId:z.string().uuid(),roleKey:z.string(),
    status:z.enum(['active','revoked']),startsAt:z.string(),expiresAt:z.string().nullable(),version:z.string().regex(/^[1-9]\d*$/),issuedByUserId:z.string().uuid()}).strict()).max(100),
  nextCursor:z.string().uuid().nullable()}).strict()
export async function readApplicationGovernanceCatalog(client:PoolClient,execution:ExecutionContext,raw:unknown) {
  assertNativeApplicationGovernance(execution)
  const input=applicationGovernanceCatalogInput.safeParse(raw)
  if (!input.success) throw new ApplicationPlatformError('invalid_value','The governance module selection is invalid.')
  return catalogShape.parse((await client.query<{value:unknown}>('SELECT read_native_application_governance_catalog($1,$2,$3,$4) AS value',
    [execution.security.access.workspaceId,execution.assistant.id,input.data.moduleKey,input.data.afterId ?? null])).rows[0]?.value)
}
export async function previewApplicationGovernance(client:PoolClient,execution:ExecutionContext,raw:unknown) {
  assertNativeApplicationGovernance(execution)
  const input=applicationGovernancePreviewInput.safeParse(raw)
  if (!input.success) throw new ApplicationPlatformError('invalid_value','The native governance proposal is invalid.')
  const operation=input.data.operation.kind==='assign_role' ? {...input.data.operation,startsAt:new Date(input.data.operation.startsAt).toISOString(),
    expiresAt:input.data.operation.expiresAt ? new Date(input.data.operation.expiresAt).toISOString() : null} : input.data.operation
  return z.object({id:z.string().uuid(),moduleKey:z.string(),revision:z.string(),proposal:applicationGovernancePreviewInput.shape.operation,
    expiresAt:z.string(),canApply:z.literal(true)}).strict().parse((await client.query<{value:unknown}>(
    'SELECT application_prepare_native_governance_review($1,$2,$3,$4,$5) AS value',
    [execution.security.access.workspaceId,execution.assistant.id,input.data.moduleKey,input.data.expectedRevision,operation])).rows[0]?.value)
}
export async function applyApplicationGovernance(client:PoolClient,execution:ExecutionContext,raw:unknown) {
  assertNativeApplicationGovernance(execution)
  const input=applicationGovernanceApplyInput.safeParse(raw)
  if (!input.success) throw new ApplicationPlatformError('invalid_value','The native governance review is invalid.')
  return z.object({id:z.string().uuid(),moduleKey:z.string(),kind:z.enum(['assign_role','revoke_role','bind_owner']),resourceId:z.string().uuid(),
    version:z.string().regex(/^[1-9]\d*$/),applied:z.literal(true)}).strict().parse((await client.query<{value:unknown}>(
    'SELECT application_apply_native_governance_review($1,$2,$3) AS value',[execution.security.access.workspaceId,execution.assistant.id,input.data.reviewId])).rows[0]?.value)
}
