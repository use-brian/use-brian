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

export async function buildApplicationMcpTools(service: ApplicationPlatformService, execution: ExecutionContext): Promise<BrainTool[]> {
  const catalog = await service.catalog(execution), binding = getApplicationExecutionBinding(execution)
  if (!binding) throw new ApplicationPlatformError('authentication_required', 'Application authentication is required.')
  const invoke = (operation: (input: Record<string, unknown>) => Promise<unknown>, effectful = false): BrainTool['handler'] => async input => {
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
