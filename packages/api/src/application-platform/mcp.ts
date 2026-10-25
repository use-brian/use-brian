import type { Pool } from 'pg'
/** Application MCP is an authenticated profile of the shared Brain transport. [COMP:api/application-auth] */
import { z } from 'zod'
import type { ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError, applicationCommandSchema, applicationJsonSchema } from '@use-brian/shared'
import { AuthorityChangedError } from '../context-scope/authority-lease.js'
import type { BrainTool } from '../brain-mcp/tools.js'
import { getApplicationExecutionBinding } from './execution-context.js'
import type { ApplicationPlatformService } from './service.js'
import type { Request } from 'express'
import { query } from '../db/client.js'
import { parseBridgeToken } from '../home-apps/tokens.js'
import { authenticateApplicationHome } from './home-auth.js'
import { resolveApplicationExecutionContext } from './execution-context.js'
import { readApplicationGovernanceCatalog,previewApplicationGovernance,applyApplicationGovernance,applicationConfigurationInputShape,applicationGovernanceCatalogInput,applicationGovernancePreviewInput,applicationGovernanceApplyInput,assertNativeApplicationGovernance,type ApplicationGovernancePreviewInput,type ApplicationGovernanceApplyInput } from './governance.js'
import { previewApplicationSchema,applyApplicationSchema,applicationSchemaPreviewInput,applicationSchemaApplyInput,type ApplicationSchemaPreviewInput,type ApplicationSchemaApplyInput } from './schema-changes.js'

/** Resolve only signed Home binding metadata before entering the common service. */
export async function buildHomeApplicationMcpProfile(req: Request, secret: string, service: ApplicationPlatformService) {
  const header = req.headers.authorization
  if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(header) || header.length > 8192) return null
  const token = header.slice(7), parsed = parseBridgeToken({ token, secret })
  if (!parsed.ok || !parsed.payload.applicationBindingId) return null
  const result = await query<{ appId: string }>('SELECT app_id AS "appId" FROM application_home_bindings WHERE id=$1', [parsed.payload.applicationBindingId])
  if (!result.rows[0]) return null
  const home = await authenticateApplicationHome(token, result.rows[0].appId, secret)
  if (!home) return null
  const signal = new AbortController(); req.once('aborted', () => signal.abort())
  const execution = await resolveApplicationExecutionContext({ home }, { abortSignal: signal.signal })
  return { homeAppId: home.homeAppId, tools: await buildApplicationMcpTools(service, execution) }
}

function applicationMcpInvoker(execution: ExecutionContext) {
  return (operation: (input: Record<string, unknown>) => Promise<unknown>, effectful = false): BrainTool['handler'] => async input => {
    let committed = false
    try {
      await execution.security.authority.assertCurrent()
      const value = await operation(input)
      committed = effectful
      await execution.security.authority.assertCurrent()
      return { content: [{ type: 'text', text: JSON.stringify(value) }] }
    } catch (error) {
      const code = error instanceof AuthorityChangedError ? 'grant_revoked' : error instanceof ApplicationPlatformError ? error.code : 'access_unavailable'
      const effect = committed ? 'committed' : error instanceof ApplicationPlatformError ? error.effect
        : error instanceof AuthorityChangedError && error.operationMayHaveExecuted ? 'uncertain' : 'none'
      return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error: code, effect,
        retrySafe: error instanceof ApplicationPlatformError && error.retrySafe && !committed }) }] }
    }
  }
}

export async function buildApplicationMcpTools(service: ApplicationPlatformService, execution: ExecutionContext): Promise<BrainTool[]> {
  const catalog = await service.catalog(execution), binding = getApplicationExecutionBinding(execution)
  if (!binding) throw new ApplicationPlatformError('authentication_required', 'Application authentication is required.')
  const invoke = applicationMcpInvoker(execution)
  const tools: BrainTool[] = [{ name: 'applicationCatalog', description: 'Read the current bound application resource and operation catalog. This does not grant authority.',
    inputSchema: {}, handler: invoke(() => service.catalog(execution)) }]
  if (catalog.queries.length) tools.push({ name: 'applicationQuery', description: 'Invoke a registered query of this application. Use its current declared resource fields and typed input.',
    inputSchema: { queryKey: z.enum(catalog.queries as [string, ...string[]]), input: applicationJsonSchema },
    handler: invoke(input => service.query(execution, binding.state.moduleKey, String(input.queryKey), input.input)) })
  if (catalog.commands.length) tools.push({ name: 'applicationCommand', description: 'Invoke a registered typed command once with an idempotency key and exact expected versions. Reconcile uncertain effects before retrying.',
    inputSchema: { commandKey: z.enum(catalog.commands as [string, ...string[]]), command: applicationCommandSchema },
    handler: invoke(input => service.command(execution, binding.state.moduleKey, String(input.commandKey), applicationCommandSchema.parse(input.command)), true) })
  if (catalog.commands.length) tools.push({ name: 'applicationReconcile', description: 'Check the exact original command under current authority without executing it. An applied result returns its admitted saved receipt; uncertain does not permit an automatic retry.',
    inputSchema: { commandKey: z.enum(catalog.commands as [string, ...string[]]), command: applicationCommandSchema },
    handler: invoke(input => service.reconcile(execution, binding.state.moduleKey, String(input.commandKey), applicationCommandSchema.parse(input.command))) })
  return tools
}

/** Native human management profile; app/legacy programmatic audiences acquire no governance. */
export function buildNativeApplicationSchemaMcpTools(pool: Pool,execution: ExecutionContext): BrainTool[] {
  if (getApplicationExecutionBinding(execution) || execution.identity.kind !== 'attended'
    || execution.identity.principal.kind !== 'workspace_member' || execution.surface.readOnly) {
    throw new ApplicationPlatformError('authentication_required','Native schema management authentication is required.')
  }
  const invoke = applicationMcpInvoker(execution)
  return [{ name: 'applicationSchemaPreview',description: 'Preview a native schema change under current governance. Review the exact proposal and validity before applying.',
    inputSchema: applicationSchemaPreviewInput.shape,handler: invoke(input => {
      const value: ApplicationSchemaPreviewInput=applicationSchemaPreviewInput.parse(input)
      return previewApplicationSchema(pool,execution,value.typeId,value.expectedVersion,value.properties)
    },true) },{ name: 'applicationSchemaApply',description: 'Apply an actor-bound reviewed schema change once. Reconcile committed or uncertain effects using the same review in a fresh invocation.',
    inputSchema: applicationSchemaApplyInput.shape,handler: invoke(input => {
      const value: ApplicationSchemaApplyInput=applicationSchemaApplyInput.parse(input)
      return applyApplicationSchema(pool,execution,value.previewId)
    },true) }]
}

/** One module selection supplies the actual enumerable role vocabulary. */
export async function buildNativeApplicationGovernanceMcpTools(pool:Pool,execution:ExecutionContext,moduleKey:string):Promise<BrainTool[]> {
  assertNativeApplicationGovernance(execution)
  const catalog=await readApplicationGovernanceCatalog(pool,execution,{moduleKey}),invoke=applicationMcpInvoker(execution)
  const assignment=applicationGovernancePreviewInput.shape.operation.options[0].extend({roleKey:catalog.roleKeys.length
    ? z.enum(catalog.roleKeys as [string,...string[]]) : z.never()})
  const operations: z.ZodType[]=[assignment,applicationGovernancePreviewInput.shape.operation.options[1],applicationGovernancePreviewInput.shape.operation.options[2]]
  if(catalog.nativeResourceTypes.length) {
    operations.push(applicationGovernancePreviewInput.shape.operation.options[3].extend({typeKey:z.enum(catalog.nativeResourceTypes as [string,...string[]])}))
    operations.push(applicationGovernancePreviewInput.shape.operation.options[5])
  }
  for(const operation of catalog.configurationOperations) operations.push(z.object({kind:z.literal('configure'),operationKey:z.literal(operation.operationKey),input:applicationConfigurationInputShape(operation.inputFields)}).strict())
  const preview=applicationGovernancePreviewInput.extend({moduleKey:z.literal(moduleKey),operation:z.union(operations as [z.ZodType,z.ZodType,...z.ZodType[]])})
  return [{name:'applicationGovernanceCatalog',description:'Read the current native module role vocabulary and review revision. This grants no data or role authority.',
    inputSchema:{afterId:applicationGovernanceCatalogInput.shape.afterId},handler:invoke(input => readApplicationGovernanceCatalog(pool,execution,{moduleKey,afterId:input.afterId}))},
  {name:'applicationGovernancePreview',description:'Preview one exact native role or restrictive owner operation under current governance and delegation limits.',
    inputSchema:preview.shape,handler:invoke(input => {const value:ApplicationGovernancePreviewInput=applicationGovernancePreviewInput.parse(preview.parse(input));return previewApplicationGovernance(pool,execution,value)},true)},
  {name:'applicationGovernanceApply',description:'Apply the same actor-bound native governance review once. Reconcile committed or uncertain effects in a fresh invocation.',
    inputSchema:applicationGovernanceApplyInput.shape,handler:invoke(input => {const value:ApplicationGovernanceApplyInput=applicationGovernanceApplyInput.parse(input);return applyApplicationGovernance(pool,execution,value)},true)}]
}

import { applicationManagementCommandSchema,type ApplicationManagementService } from './management.js'

/** Native human/Brian governance over the identical management command dispatcher. [COMP:api/application-management] */
export function buildNativeApplicationManagementMcpTools(service:ApplicationManagementService,execution:ExecutionContext):BrainTool[] {
  assertNativeApplicationGovernance(execution)
  const actorId=execution.security.access.userId,workspaceId=execution.security.access.workspaceId
  const invoke=applicationMcpInvoker(execution)
  return [{name:'applicationManagementOverview',description:'Read your current application registration, exact grant/credential metadata, source availability and unqualified readiness. Never returns secrets or private source payloads.',
    inputSchema:{appId:z.string().uuid().optional()},handler:invoke(input=>service.overview(actorId,workspaceId,{...input,assistantId:execution.assistant.id}))},
    {name:'applicationManage',description:'Use the same native reviewed management commands as the human panel. Preview first and apply only an explicitly confirmed review. Uncertain writes require reconciliation, never automatic retry. Credential delivery returns a human-only link, never credential material.',
    inputSchema:{command:applicationManagementCommandSchema},handler:invoke(input=>service.executeCommand(actorId,workspaceId,input.command,{audience:'brian',assistantId:execution.assistant.id}),true)}]
}

/** Native member/Brian module profile, calling the same deployed handlers and canonical transactions. */
export function buildNativeApplicationModuleMcpTools(service:ApplicationPlatformService,execution:ExecutionContext,moduleKey:string):BrainTool[] {
 if(getApplicationExecutionBinding(execution)||execution.identity.kind!=='attended'||execution.identity.principal.kind!=='workspace_member')throw new ApplicationPlatformError('authentication_required','A native member session is required.')
 const module=service.registry.applications.get(moduleKey)
 if(!module)throw new ApplicationPlatformError('operation_not_available','The deployed module is unavailable.')
 const invoke=applicationMcpInvoker(execution),tools:BrainTool[]=[]
 if(module.application.queries.length)tools.push({name:'nativeModuleQuery',description:'Invoke one registered module query under your current member and assistant authority.',
 inputSchema:{queryKey:z.enum(module.application.queries as [string,...string[]]),input:applicationJsonSchema},handler:invoke(input=>service.query(execution,moduleKey,String(input.queryKey),input.input))})
 if(module.application.commands.length&&!execution.surface.readOnly)tools.push({name:'nativeModuleCommand',description:'Invoke one registered semantic module command with exact versions and an idempotency key. Reconcile uncertain effects before retrying.',
 inputSchema:{commandKey:z.enum(module.application.commands as [string,...string[]]),command:applicationCommandSchema},handler:invoke(input=>service.command(execution,moduleKey,String(input.commandKey),applicationCommandSchema.parse(input.command)),true)})
 if(module.application.commands.length&&!execution.surface.readOnly)tools.push({name:'nativeModuleReconcile',description:'Check the exact original module command under current member and assistant authority without executing it. An admitted saved receipt is applied; uncertain does not permit an automatic retry.',
 inputSchema:{commandKey:z.enum(module.application.commands as [string,...string[]]),command:applicationCommandSchema},handler:invoke(input=>service.reconcile(execution,moduleKey,String(input.commandKey),applicationCommandSchema.parse(input.command)))})
 return tools
}
