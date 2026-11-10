/** External services use canonical owners, never install an ERP module. [COMP:api/external-services] */
import { randomUUID } from 'node:crypto'
import express, { Router } from 'express'
import { z } from 'zod'
import type { AccessCeiling, ExecutionContext } from '@use-brian/core'
import { ApplicationPlatformError, applicationCommandSchema, applicationJsonSchema } from '@use-brian/shared'
import { ApplicationPlatformService } from '../application-platform/service.js'
import { bindExternalServiceReceiptIdentity } from '../application-platform/external-service-receipt-identity.js'
import { createCanonicalNativeApplicationModule } from '../application-platform/native-adapters.js'
import { resolveExecutionContextSystem } from '../context-scope/execution-context.js'
import { AuthorityChangedError } from '../context-scope/authority-lease.js'
import { getPool } from '../db/client.js'
import { createWorkspaceStore,type WorkspaceStore } from '../db/workspace-store.js'
import { searchWorkspaceFiles } from '../db/workspace-files.js'
import { findAssistantById } from '../db/users.js'
import { serveStatelessMcp } from '../brain-mcp/stateless.js'
import type { BrainTool } from '../brain-mcp/tools.js'
import { authenticateExternalService, type ExternalServiceContext } from './context.js'

const queryKeys = ['get', 'query', 'file_candidates', 'member_candidates'] as const
const commandKeys = ['create_company', 'create_contact', 'patch_company', 'patch_contact'] as const
const queryInput = z.object({ key: z.enum(queryKeys), input: applicationJsonSchema }).strict()
const commandInput = z.object({ key: z.enum(commandKeys), command: applicationCommandSchema }).strict()
type Dispatcher = Pick<ApplicationPlatformService, 'query' | 'command' | 'reconcile'>

function maximum(context: ExternalServiceContext): AccessCeiling {
  return { workspaceId: context.workspaceId, userId: context.userId, clearance: context.clearance,
    compartments: context.compartments, mutationCompartments: context.mutationCompartments,
    projectIds: context.projectIds, visibilityAssistantIds: null,
    ...(context.departmentRead ? { departmentRead: context.departmentRead } : {}) }
}

/** Re-resolve membership and OAuth authority at every canonical transaction boundary.
 * The workspace's visible primary assistant may narrow the canonical owner scope.
 * No native-session claim or ERP module registration is manufactured here.
 */
async function resolve(context: ExternalServiceContext, token: string, signal: AbortSignal): Promise<ExecutionContext> {
  const current = async () => {
    const next = await authenticateExternalService(token, context.serviceId)
    return next?.revision === context.revision && next.authorizationId === context.authorizationId ? next : null
  }
  const row = (await getPool().query<{ id: string }>(`SELECT id FROM assistants WHERE workspace_id=$1 AND kind='primary'
    AND assistant_placement_visible($2,id) ORDER BY id LIMIT 1`, [context.workspaceId, context.userId])).rows[0]
  const assistant = row && await findAssistantById(row.id)
  if (!assistant || assistant.workspaceId !== context.workspaceId) throw new ApplicationPlatformError('access_unavailable', 'The canonical workspace context is unavailable.')
  const execution = (await resolveExecutionContextSystem({ workspaceId: context.workspaceId, userId: context.userId, assistant, memberMode: 'member',
    credentialCurrent: async () => !!await current(), maximumAccess: maximum(context),
    maximumAccessCurrent: async () => { const next = await current(); return next ? maximum(next) : null },
    identity: { kind: 'programmatic', principal: { kind: 'oauth_token', credentialId: context.authorizationId, actorUserId: context.userId }, credentialOwnerUserId: context.userId },
    ownership: { kind: 'workspace', workspaceId: context.workspaceId },
    ...(context.scope === 'read' ? { surface: { readOnly: true as const } } : {}),
    lifecycle: { sessionId: randomUUID(), sessionPersisted: false, channelId: 'external-service', channelType: 'web', abortSignal: signal },
  })).executionContext
  return bindExternalServiceReceiptIdentity(execution, context)
}

export function externalServiceCanonicalRoutes(options: {
  authenticate?: typeof authenticateExternalService
  resolve?: (context: ExternalServiceContext, token: string, signal: AbortSignal) => Promise<ExecutionContext>
  service?: Dispatcher
  searchFiles?: typeof searchWorkspaceFiles
  listMembers?: WorkspaceStore['listMembers']
} = {}): Router {
  const router = Router({ mergeParams: true }), authenticate = options.authenticate ?? authenticateExternalService
  // Construction is lazy: importing an auth-only router must not open a database.
  let dispatcher = options.service
  const service = () => dispatcher ??= new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
  router.use(express.json({ limit: '256kb' }))
  router.use('/canonical', (_req, res, next) => { res.set('Cache-Control', 'no-store'); next() })
  const invoke = async (execution: ExecutionContext, context: ExternalServiceContext, mode: 'query' | 'command' | 'reconcile', raw: unknown) => {
    await execution.security.authority.assertCurrent()
    if (mode === 'query') {
      const input = queryInput.parse(raw)
      if (input.key === 'member_candidates') {
        const selection=z.object({query:z.string().trim().max(200).default(''),limit:z.number().int().min(1).max(100).default(50)}).strict().parse(input.input)
        const list=options.listMembers??createWorkspaceStore().listMembers
        const roster=await list(context.userId,context.workspaceId),needle=selection.query.toLocaleLowerCase()
        const label=(member:typeof roster[number])=>member.userName?.trim()||member.email||member.userId
        const selected=roster.filter(member=>!needle||label(member).toLocaleLowerCase().includes(needle)||member.userId===selection.query).slice(0,selection.limit)
        const members=[]
        for (const member of selected) {
          const record=await service().query(execution,'native','get',{type:'workspace_member',id:member.userId,fields:['id']})
          members.push({record,displayName:label(member)})
        }
        const current=await list(context.userId,context.workspaceId)
        for (let index=0;index<selected.length;index++) {
          const member=current.find(member=>member.userId===selected[index].userId)
          const record=await service().query(execution,'native','get',{type:'workspace_member',id:selected[index].userId,fields:['id']}) as {ref?:{version?:string};policyVersion?:string}
          const original=members[index].record as typeof record
          if (!member||label(member)!==members[index].displayName||!record.ref||record.ref.version!==original.ref?.version||record.policyVersion!==original.policyVersion)
            throw new ApplicationPlatformError('access_unavailable','The current workspace roster changed.')
        }
        await execution.security.authority.assertCurrent()
        return {members}
      }
      if (input.key === 'file_candidates') {
        const selection=z.object({query:z.string().trim().max(200).default(''),limit:z.number().int().min(1).max(100).default(50)}).strict().parse(input.input)
        const candidates=await (options.searchFiles??searchWorkspaceFiles)(execution.security.access,selection)
        const fields=['name','mimeType','sizeBytes'],records=[]
        for (const candidate of candidates) {
          await execution.security.authority.assertCurrent()
          const record=await service().query(execution,'native','get',{type:'file',id:candidate.id,fields})
          records.push(record)
        }
        // Discovery metadata never becomes an outward projection. The canonical
        // owner authenticates every returned file, including its final version.
        for (let index=0;index<candidates.length;index++) {
          const current=await service().query(execution,'native','get',{type:'file',id:candidates[index].id,fields}) as {ref?:{version?:string};policyVersion?:string}
          const original=records[index] as typeof current
          if (!current.ref||current.ref.version!==original.ref?.version||current.policyVersion!==original.policyVersion)
            throw new ApplicationPlatformError('access_unavailable','The canonical file changed.')
        }
        await execution.security.authority.assertCurrent()
        return {records}
      }
      return service().query(execution, 'native', input.key, input.input)
    }
    if (context.scope !== 'read_write') throw new ApplicationPlatformError('access_unavailable', 'Write consent is required.')
    const input = commandInput.parse(raw)
    return service()[mode](execution, 'native', input.key, input.command)
  }
  const failure = (error: unknown, committed: boolean) => ({
    error: error instanceof z.ZodError ? 'invalid_value' : error instanceof AuthorityChangedError ? 'grant_revoked'
      : error instanceof ApplicationPlatformError ? error.code : 'access_unavailable',
    effect: committed ? 'committed' : error instanceof ApplicationPlatformError ? error.effect
      : error instanceof AuthorityChangedError && error.operationMayHaveExecuted ? 'uncertain' : 'none',
    retrySafe: !committed && error instanceof ApplicationPlatformError && error.retrySafe,
  })
  for (const mode of ['query', 'command', 'reconcile', 'mcp'] as const) router.post(`/canonical/${mode}`, async (req, res) => {
    let committed = false
    const controller = new AbortController(), timeout = setTimeout(() => controller.abort(), 60_000)
    timeout.unref()
    if (req.aborted) controller.abort(); else req.once('aborted', () => controller.abort())
    res.once('close', () => { if (!res.writableEnded) controller.abort() })
    try {
      const id = z.string().uuid().parse((req.params as Record<string, string>).serviceId), header = req.headers.authorization
      if (typeof header !== 'string' || !/^Bearer [A-Za-z0-9_-]+$/.test(header) || header.length > 256) { res.status(401).json({ error: 'authentication_required', effect: 'none', retrySafe: false }); return }
      const token = header.slice(7), context = await authenticate(token, id)
      if (!context || context.serviceId !== id) { res.status(401).json({ error: 'authentication_required', effect: 'none', retrySafe: false }); return }
      const execution = await (options.resolve ?? resolve)(context, token, controller.signal)
      if (mode === 'mcp') {
        const tool = (name: string, operation: 'query' | 'command' | 'reconcile', inputSchema: BrainTool['inputSchema']): BrainTool => ({
          name, description: operation === 'query' ? 'Read canonical Brian records under current workspace and field permissions.'
            : operation === 'command' ? 'Create or update canonical CRM once with an idempotency key. Reconcile uncertain results before retrying.'
              : 'Read the saved receipt for the exact original canonical CRM command without repeating its effects.', inputSchema,
          handler: async input => {
            let applied = false
            try { const result = await invoke(execution, context, operation, input); applied = operation === 'command'; await execution.security.authority.assertCurrent()
              return { content: [{ type: 'text', text: JSON.stringify(result) }] }
            } catch (error) { return { isError: true, content: [{ type: 'text', text: JSON.stringify(failure(error, applied)) }] } }
          },
        })
        const tools = [tool('canonicalQuery', 'query', queryInput.shape)]
        if (context.scope === 'read_write') tools.push(tool('canonicalCommand', 'command', commandInput.shape), tool('canonicalReconcile', 'reconcile', commandInput.shape))
        await serveStatelessMcp(req, res, tools, 'use-brian-external-canonical'); return
      }
      const result = await invoke(execution, context, mode, req.body); committed = mode === 'command'
      await execution.security.authority.assertCurrent()
      res.json(result)
    } catch (error) {
      if (res.headersSent) return
      const body = failure(error, committed)
      res.status(body.error === 'invalid_value' ? 400 : body.error === 'record_version_conflict' ? 409 : 403).json(body)
    } finally { clearTimeout(timeout) }
  })
  return router
}
