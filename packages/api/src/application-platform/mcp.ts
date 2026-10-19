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
import { applicationGovernanceCatalogInput,applicationGovernancePreviewInput,applicationGovernanceApplyInput,assertNativeApplicationGovernance,type ApplicationGovernancePreviewInput,type ApplicationGovernanceApplyInput } from './governance.js'
import { applicationSchemaPreviewInput,applicationSchemaApplyInput,type ApplicationSchemaPreviewInput,type ApplicationSchemaApplyInput } from './schema-changes.js'

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
  return tools
}

/** Native human management profile; app/legacy programmatic audiences acquire no governance. */
export function buildNativeApplicationSchemaMcpTools(service: ApplicationPlatformService,execution: ExecutionContext): BrainTool[] {
  if (getApplicationExecutionBinding(execution) || execution.identity.kind !== 'attended'
    || execution.identity.principal.kind !== 'workspace_member' || execution.surface.readOnly) {
    throw new ApplicationPlatformError('authentication_required','Native schema management authentication is required.')
  }
  const invoke = applicationMcpInvoker(execution)
  return [{ name: 'applicationSchemaPreview',description: 'Preview a native schema change under current governance. Review the exact proposal and validity before applying.',
    inputSchema: applicationSchemaPreviewInput.shape,handler: invoke(input => {
      const value: ApplicationSchemaPreviewInput=applicationSchemaPreviewInput.parse(input)
      return service.previewSchema(execution,value.typeId,value.expectedVersion,value.properties)
    }) },{ name: 'applicationSchemaApply',description: 'Apply an actor-bound reviewed schema change once. Reconcile committed or uncertain effects using the same review in a fresh invocation.',
    inputSchema: applicationSchemaApplyInput.shape,handler: invoke(input => {
      const value: ApplicationSchemaApplyInput=applicationSchemaApplyInput.parse(input)
      return service.applySchema(execution,value.previewId)
    },true) }]
}

/** One module selection supplies the actual enumerable role vocabulary. */
export async function buildNativeApplicationGovernanceMcpTools(service:ApplicationPlatformService,execution:ExecutionContext,moduleKey:string):Promise<BrainTool[]> {
  assertNativeApplicationGovernance(execution)
  const catalog=await service.governanceCatalog(execution,{moduleKey}),invoke=applicationMcpInvoker(execution)
  const assignment=applicationGovernancePreviewInput.shape.operation.options[0].extend({roleKey:catalog.roleKeys.length
    ? z.enum(catalog.roleKeys as [string,...string[]]) : z.never()})
  const preview=applicationGovernancePreviewInput.extend({moduleKey:z.literal(moduleKey),operation:z.discriminatedUnion('kind',[
    assignment,applicationGovernancePreviewInput.shape.operation.options[1],applicationGovernancePreviewInput.shape.operation.options[2]])})
  return [{name:'applicationGovernanceCatalog',description:'Read the current native module role vocabulary and review revision. This grants no data or role authority.',
    inputSchema:{afterId:applicationGovernanceCatalogInput.shape.afterId},handler:invoke(input => service.governanceCatalog(execution,{moduleKey,afterId:input.afterId}))},
  {name:'applicationGovernancePreview',description:'Preview one exact native role or restrictive owner operation under current governance and delegation limits.',
    inputSchema:preview.shape,handler:invoke(input => {const value:ApplicationGovernancePreviewInput=preview.parse(input);return service.previewGovernance(execution,value)})},
  {name:'applicationGovernanceApply',description:'Apply the same actor-bound native governance review once. Reconcile committed or uncertain effects in a fresh invocation.',
    inputSchema:applicationGovernanceApplyInput.shape,handler:invoke(input => {const value:ApplicationGovernanceApplyInput=applicationGovernanceApplyInput.parse(input);return service.applyGovernance(execution,value)},true)}]
}
