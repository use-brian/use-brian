import { createOfficeVersionRuntime } from '../../office/version-runtime.js'
import { documentSnapshot } from '../../../../core/src/office/__tests__/fixtures.js'
import { publishDepartmentOfficeSnapshot } from '../../office/generation-publication.js'
import { createOfficeReleaseRuntime } from '../../office/release-runtime.js'
import { createOfficeTemplateStore } from '../../db/office-templates.js'
import { artifactReadableForViewer } from '../../db/research-store.js'
import { createDbFileStore, getFileCachePreviewProjection } from '../../db/file-store.js'
import { scopeEvidenceFromRows } from '@use-brian/core'
import { createOfficeReleaseStore } from '../../db/office-release.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { generateAssistantOfficeCommands } from '../../office/command-revision.js'
import { createOfficeCommentStore } from '../../db/office-comments.js'
import { createGoalWorkTools } from '../../goals/work-tools.js'
import { advanceRetainedGoalWorkflow } from '../../workflow/wait-lifecycle.js'
import { resolveRetainedGoalWorkflowRuntime } from '../../workspace-access/goal-source-admission.js'
import { createTask } from '../../db/tasks.js'
import { produceTaskGoalDraft } from '../../db/goal-task-producer.js'
import { resolveRetainedTaskGoalAuthority } from '../../workspace-access/goal-source-admission.js'
import { getRetainedGoalById, confirmRetainedGoal } from '../../db/goals.js'
import { resolveBrowserTaskExecutionAuthority } from '../../sandbox/task-execution-authority.js'
import { assertSourceModelInputAuthority } from '../../application-platform/model-source-authority.js'
import { ContextScopeAccumulator, executionToolContext } from '@use-brian/core'
import { createOfficeTools } from '@use-brian/core'
import { createOfficeService } from '../../office/service.js'
import { officeArtifactStore } from '../../db/office-artifacts.js'
import { officeGenerationStore } from '../../db/office-generation.js'
import { createOfficeLiveStore } from '../../db/office-live.js'
import { resolveOfficeAccess, resolveDurableOfficeAccess } from '../../office/access.js'
import { withOfficeWorkspaceAuthority } from '../../office/workspace-authority.js'
import { Writable } from 'node:stream'
import { createFileTools } from '@use-brian/core'
import { createFilesApi } from '../../files/files-api.js'
import { createChunkedFileUploadService, CHUNKED_UPLOAD_PART_BYTES } from '../../files/chunked-upload.js'
import { createDbWorkspaceFilesStore } from '../../db/workspace-files-store.js'
import { createWorkspaceFileUploadsStore } from '../../db/workspace-file-uploads-store.js'
import { createWorkspaceAuditStore } from '../../db/workspace-audit-store.js'
import type { GcsFilesClient } from '../../files/gcs-client.js'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
import { pinToolAuthoringAuthority, workspaceCredentialDelegation } from '@use-brian/core'
import { createDbOAuthAuthorizationStore, parseOAuthBearerToken } from '../../db/oauth-authorization-store.js'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { oauthRoutes } from '../../brain-mcp/oauth/routes.js'
/** Actual credential issuance, native memory commands and MCP HTTP. */
import { createHash, randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildTool, createMemoryTools, createDocTools, type LLMProvider } from '@use-brian/core'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { createDbDocPageStore } from '../../db/doc-page-store.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createDbBrainKeyStore } from '../../db/brain-keys-store.js'
import { createDbApiKeyStore } from '../../db/api-key-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createWorkspaceStore } from '../../db/workspace-store.js'
import { createDbWorkspaceGroupStore } from '../../db/workspace-group-store.js'
import { requireAuth } from '../../auth/middleware.js'
import { createTokens } from '../../auth/jwt.js'
import { brainKeysRoutes } from '../../routes/brain-keys.js'
import { apiKeyRoutes } from '../../routes/api-keys.js'
import { brainMcpRoutes } from '../../brain-mcp/server.js'
import { assistantMcpRoutes } from '../../routes/assistant-mcp.js'
import { findOrCreateWorkspaceMcpSession } from '../../db/sessions.js'
import { createWorkspaceMcpProfile } from '../profile.js'
import { createSessionPinTools } from '../../session-pin-tools.js'
import { injectWorkspaceMcpSkills } from '../skills.js'
import { createDbSkillStore, createDbWorkspaceSkillStore, type SkillStore } from '../../db/skill-store.js'
import { createPendingApprovalsStore } from '../../db/pending-approvals-store.js'
import { approvalsRoutes } from '../../routes/approvals.js'
import { sessionKindSql } from '../../session-kind.js'
import { createNativeChatRuntime } from '../../routes/chat.js'
import type { WorkspaceTurnBinding, WorkspaceTurnInput, WorkspaceTurnResult } from '../native-turn.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), actor = randomUUID(), workspace = randomUUID(), assistant = randomUUID()
const secret = 'fictional-workspace-mcp-test-secret'
const memories = createMemoryTools(createDbMemoryStore())
const tools = new Map(Object.values(memories).map(tool => [tool.name, tool]))
const pageRead = createDocTools({ docPageStore: createDbDocPageStore() } as never).getCurrentPage
tools.set(pageRead.name, pageRead)
const workflowStore = createDbWorkflowStore(), workflowRuns = createDbWorkflowRunStore()
const authorWorkflow = buildTool({ name: 'authorFixtureWorkflow',description: 'Author a fictional workflow through canonical storage.',inputSchema: z.object({}),
  execute: async (_input,context) => ({ data: await workflowStore.create({ userId: context.userId,workspaceId: context.workspaceId!,name:'Fictional delegated workflow',
    definition:{startStepId:'inspect',steps:[{id:'inspect',type:'tool_call',toolName:'getWorkspaceContext',arguments:{}}]},
    contextGroupId: context.activeGroupId ?? null,contextProjectId: context.activeProjectId ?? null,authoringAuthority:pinToolAuthoringAuthority(context) }) }) })
tools.set(authorWorkflow.name,authorWorkflow)
const startWorkflow = buildTool({name:'startFixtureWorkflow',description:'Start a canonical saved workflow.',inputSchema:z.object({workflowId:z.string().uuid()}),
  execute:async(input,context)=>({data:await workflowRuns.createRun({workflowId:input.workflowId,workspaceId:context.workspaceId!,triggeredBy:context.userId,
    triggerKind:'manual',executionContext:context.executionContext})})})
tools.set(startWorkflow.name,startWorkflow)
const startBrowser=buildTool({name:'startFixtureBrowser',description:'Retain canonical browser task authority.',inputSchema:z.object({}),
  execute:async(_input,context)=>({data:{userId:context.userId,workspaceId:context.workspaceId!,
    executionAuthority:pinToolAuthoringAuthority(context),sourceAuthority:context.executionContext!.security.authority.snapshotSource!()}})})
tools.set(startBrowser.name,startBrowser)

const draftGoal=buildTool({name:'draftFixtureGoal',description:'Draft and confirm through canonical retained Task Goal commands.',inputSchema:z.object({}),
  execute:async(_input,context)=>{
    const task=await createTask(context.userId,{workspaceId:context.workspaceId!,title:'Fictional retained task',
      executorAssistantId:context.assistantId,compartments:context.executionContext!.security.writeDefaults.compartments,projectIds:[]})
    const authority={execution:context.executionContext!,accumulator:context.scopeAccumulator!}
    const goal=await produceTaskGoalDraft({userId:context.userId,workspaceId:context.workspaceId!,assistantId:context.assistantId,taskId:task.id,authority},
      async()=>({outcome:'Complete the fictional task',verification:'Check the recorded result',approach:'Use the native task commands',judgeReason:'Concrete outcome'}))
    if(!goal)throw new Error('fixture_goal_missing')
    const captured=await getRetainedGoalById(context.userId,goal.id,authority)
    if(!captured)throw new Error('fixture_goal_unreadable')
    return {data:await confirmRetainedGoal(context.userId,captured,{},authority)}
  }})
tools.set(draftGoal.name,draftGoal)

const startGoal=buildTool({name:'startFixtureGoal',description:'Start a retained Goal with its canonical deterministic workflow.',inputSchema:z.object({goalId:z.string().uuid()}),
  execute:async(input,context)=>{
    const workflow=await workflowStore.create({workspaceId:context.workspaceId!,userId:context.userId,name:'Fictional retained Goal workflow',
      definition:{startStepId:'finish',steps:[{id:'finish',type:'branch',condition:{'==':[1,1]},nextStepIdIfTrue:null,nextStepIdIfFalse:null}]},
      authoringAuthority:pinToolAuthoringAuthority(context),contextGroupId:context.activeGroupId??null,contextProjectId:context.activeProjectId??null})
    const work=createGoalWorkTools({createCompletionWorkflow:async()=>{throw new Error('Explicit workflow required')},kickoffGoal:async()=>{throw new Error('Unexpected recurring Goal')},
      advanceRetainedWorkflowRun:(id,claim)=>advanceRetainedGoalWorkflow(id,{workflowStore,runStore:workflowRuns,resolvePrimary:async()=>assistant,
        resolveRunScope:resolveWorkflowRunScope,buildToolRegistry:async()=>new Map(),consultTransport:{async send(){throw new Error('Unexpected model call')}}},claim)})
    return work.workTask.execute({goal_id:input.goalId,workflow_id:workflow.id},context)
  }})
tools.set(startGoal.name,startGoal)

let transferWriteHook: (() => Promise<void>) | undefined
const transferBytes=new Map<string,Buffer>()
const transferBlob: GcsFilesClient={
  writeBlob:async(key,bytes)=>{transferBytes.set(key,Buffer.from(bytes));const hook=transferWriteHook;transferWriteHook=undefined;await hook?.()},appendBlob:async()=>{throw new Error('unused')},
  readBlob:async key=>{const bytes=transferBytes.get(key);return bytes?{bytes,mime:'application/octet-stream',metadata:{workspaceId:workspace,mime:'application/octet-stream'}}:null},
  statBlob:async key=>{const bytes=transferBytes.get(key);return bytes?{sizeBytes:bytes.length,mime:'application/octet-stream',updatedAt:null}:null},
  deleteBlob:async key=>{transferBytes.delete(key)},signedReadUrl:async key=>`https://storage.example/${key}`,signedWriteUrl:async key=>`https://storage.example/${key}`,
  writeStream:key=>{const chunks:Buffer[]=[];return new Writable({write(chunk,_encoding,done){chunks.push(Buffer.from(chunk));done()},final(done){transferBytes.set(key,Buffer.concat(chunks));done()}})},
}
const transferResolver={forWorkspace:async()=>({gcs:transferBlob,bucket:'fixture',byo:true}),forUri:async()=>transferBlob}
const transferFiles=createDbWorkspaceFilesStore(),transferAudit=createWorkspaceAuditStore()
const transfers=createChunkedFileUploadService({resolver:transferResolver,filesStore:transferFiles,uploadsStore:createWorkspaceFileUploadsStore(),auditStore:transferAudit})
const transferApi=createFilesApi({resolver:transferResolver,store:transferFiles,auditStore:transferAudit})
for(const tool of Object.values(createFileTools(transferApi,{transfers,resolvePolicy:async()=> 'allow'})))tools.set(tool.name,tool)
const officeComments=createOfficeCommentStore()
const officeReleaseStore = createOfficeReleaseStore()
const officeReleaseRuntime = createOfficeReleaseRuntime({ filesApi: transferApi, artifacts: officeArtifactStore,
  live: createOfficeLiveStore(), releases: officeReleaseStore, templates: createOfficeTemplateStore() })
let beforeHistoryRestore: (() => Promise<void>) | undefined
const officeVersionRuntime = createOfficeVersionRuntime({ files: transferApi, artifacts: { ...officeArtifactStore,
  restoreVersion: async params => { const hook = beforeHistoryRestore; beforeHistoryRestore = undefined; await hook?.(); return officeArtifactStore.restoreVersion(params) },
}, replaceLive: async () => {} })
let beforeCommentResolve: (() => Promise<void>) | undefined
const officeService=createOfficeService({updateCommentThread:async input=>{await beforeCommentResolve?.();return officeComments.updateThread(input)},resolveComment:async input=>{await beforeCommentResolve?.();return officeComments.resolve(input)},versions:()=>officeVersionRuntime,release:()=>({
  load: officeReleaseRuntime.loadOfficeReleaseContext, revalidate: officeReleaseRuntime.revalidateOfficeRelease,
  resolveResource: (userId, workspaceId) => resourceId => officeReleaseRuntime.readOfficeResource(userId, workspaceId, resourceId),
  saveReleasedFile: officeReleaseRuntime.saveOfficeReleaseFile, createRecord: officeReleaseStore.createRelease,
  createDerivative: async()=>{throw new Error('Export must not create a derivative artifact')},
}),lifecycle:{resolveAccess:resolveDurableOfficeAccess,transition:officeArtifactStore.transitionLifecycle,revokeOffline:createOfficeReleaseStore().revokeOfflinePackages},getJob:officeGenerationStore.get,cancelJob:officeGenerationStore.cancel,listVersions:officeArtifactStore.listVersions,listThreads:officeComments.listThreads,listSuggestions:officeComments.listSuggestions,captureObservation:officeArtifactStore.captureObservation,list:officeArtifactStore.list,generationAvailable:()=>true,createShell:officeArtifactStore.createShell,
  deleteEmptyShell:officeArtifactStore.deleteEmptyShell,getArtifact:officeArtifactStore.get,raiseScope:officeArtifactStore.raiseScope,
  resolveAccess:resolveOfficeAccess,createJob:officeGenerationStore.create,latestJob:officeGenerationStore.latestForArtifact,getSnapshot:createOfficeLiveStore().get})
for(const tool of createOfficeTools({port:officeService,resolvePolicy:async()=> 'allow',appOrigin:'https://app.example'}))tools.set(tool.name,tool)
const capabilityStore = createDbCapabilityStore()
const approvalsStore = createPendingApprovalsStore()
let includeDatabaseSkills = false
const databaseSkills = createDbSkillStore(), workspaceSkills = createDbWorkspaceSkillStore()
    const provider: LLMProvider = { name: 'fictional-native-model', models: ['gemini-2.5-flash'],
      async *stream() {
        yield { type: 'message_start', model: 'gemini-2.5-flash' }
        yield { type: 'text_delta', text: JSON.stringify({ topic_label: 'Fictional check', state: 'continue', confidence: 0.9 }) }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 2, outputTokens: 2 } }
      },
      createSession(options) {
        return { async *send(_messages, sendOptions) {
          await (sendOptions?.assertInputAuthority ?? options.assertInputAuthority)?.()
          yield { type: 'message_start', model: 'gemini-2.5-flash' }
          yield { type: 'text_delta', text: 'Fictional native reply.' }
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 3, outputTokens: 3 } }
        } }
      },
    }
    const native = createNativeChatRuntime({ provider, systemPrompt: 'Fictional native workspace assistant.',
      tools: new Map(Object.values(memories).map(tool => [tool.name, tool])), memoryStore: createDbMemoryStore(),
      pendingApprovalsStore: approvalsStore, capabilityStore, filesApi: transferApi, fileStore: createDbFileStore() })
const nativeReply = native.runWorkspaceTurn
let runNative: (input: WorkspaceTurnInput, binding: WorkspaceTurnBinding) => Promise<WorkspaceTurnResult>
const profile = createWorkspaceMcpProfile({ nativeTools: tools, capabilityStore, approvalsStore,
  runNativeTurn: (input, binding) => runNative(input, binding),
  injectTools: async (tools, context) => {
    for (const tool of Object.values(createSessionPinTools({ sessionId: context.sessionId, workspaceId: context.workspaceId!,
      assistantId: context.assistantId, clearance: context.clearance ?? 'internal', publishSessionEvent: () => {} }))) tools.set(tool.name, tool)
    await injectWorkspaceMcpSkills(context, { tools, skillStore: {
      listForWorkspaceContent: async (workspaceId: string, userId: string) => includeDatabaseSkills ? databaseSkills.listForWorkspaceContent(workspaceId, userId) : [], listForAssistant: async () => [{ skillId: 'fictional-guide', enabled: true }],
    } as unknown as SkillStore, workspaceSkillStore: includeDatabaseSkills ? workspaceSkills : undefined, connectorUserId: context.userId, assistantId: context.assistantId,
    workspaceId: context.workspaceId ?? undefined, channel: 'workspace_mcp', unavailableCapabilities: [], availableConnectorIds: new Set(),
    communitySkills: [{ id: 'fictional-guide', name: 'Fictional guide', description: 'Fictional formatting instructions.',
      content: 'Read the format reference.', category: 'research', requiresConnectors: [], source: 'community', bundleVersion: 2,
      resources: [{ path: 'references/format.md', kind: 'reference', name: 'format.md', content: 'Use a short paragraph.', contentHash: 'fixture-format' }] }],
    })
    return {}
  } })
const oauthStore = createDbOAuthAuthorizationStore(), oauthClients = createDbOAuthClientStore()
const assistantOAuthStore = createDbOAuthAuthorizationStore({ audience: 'assistant', assistantId: assistant })
const brainStore = createDbBrainKeyStore(), apiStore = createDbApiKeyStore()
const app = express().use(express.json())
app.use('/brain', brainMcpRoutes({ brainKeyStore: brainStore, authorizationStore: oauthStore, workspaceProfile: profile,
  memoryTools: memories, taskTools: {} as never, crmTools: {} as never, retrievalTools: {} as never }))
app.use('/assistant', assistantMcpRoutes({ authorizationStoreFor: id => createDbOAuthAuthorizationStore({ audience: 'assistant', assistantId: id }), apiKeyStore: apiStore, capabilityStore, workspaceProfile: profile,
  agentTools: { reads: new Map(), writes: new Map() } }))
for (const surface of ['brain','assistant'] as const) app.use(`/oauth/${surface}`,oauthRoutes({
  ...(surface==='assistant' ? { assistantId: assistant } : {}),workspaceProfile: profile,
  clientStore: oauthClients,authorizationStore: surface==='brain' ? oauthStore : assistantOAuthStore,
  workspaceStore: createWorkspaceStore(),signingSecret: secret,webAppUrl: 'https://app.example',requireAuth: requireAuth(secret),
}))
app.use(requireAuth(secret))
app.use('/approvals', approvalsRoutes({ approvalsStore, workspaceStore: createWorkspaceStore(),
  bridgeDeps: {} as never, emailReviewContext: async () => null, workspaceMcpReview: profile.respondToApproval }))
app.use('/w/:workspaceId/keys', brainKeysRoutes({ brainKeyStore: brainStore, workspaceStore: createWorkspaceStore(), workspaceProfile: profile }))
app.use('/a/:assistantId/keys', apiKeyRoutes(apiStore, profile))
let bearer: string
let departmentId: string
beforeAll(async () => {
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [actor])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional MCP workspace',$2,false)", [workspace, actor])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspace, actor])
  await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Primary','primary','internal')", [assistant, workspace])
  for (const capability of ['office', 'home_app:office:read', 'home_app:office:write', 'files', 'page', 'home_app:page:read', 'home_app:page:write']) await capabilityStore.grant({ assistantId: assistant, capability, grantedByUserId: actor })
  const team = await createDbWorkspaceGroupStore().createTeam(actor, workspace, { name: 'Operations', key: 'operations' })
  departmentId = team.id
  await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='simple',default_department_id=$2,reviewed_inventory_revision=2 WHERE workspace_id=$1", [workspace, team.id])
  const session = (await pool.query("INSERT INTO auth_sessions(user_id,auth_version,device_label) VALUES($1,0,'Fixture') RETURNING id", [actor])).rows[0].id
  bearer = createTokens(actor, secret, { id: session, authVersion: 0 }).accessToken
})
afterAll(async () => { await getAppPool().end(); await pool.end() })
async function issue(surface: 'brain' | 'assistant', readOnly = false, scope: { contextGroupId?: string; contextProjectId?: string } = {}) {
  const path = surface === 'brain' ? `/w/${workspace}/keys` : `/a/${assistant}/keys`
  const result = await request(app).post(path).auth(bearer, { type: 'bearer' }).send({ name: 'Fictional integration',
    scope: surface === 'brain' ? readOnly ? 'read' : 'read_write' : 'agent', workspaceAccess: true, ...scope })
  expect(result.status, result.text).toBe(200)
  return result.body as { id: string; key: string; workspaceMcpConsent: { operationNames: string[] } }
}
async function call(surface: 'brain' | 'assistant', key: string, method: string, params: object) {
  const path = surface === 'brain' ? '/brain' : `/assistant/assistants/${assistant}/mcp`
  const response = await request(app).post(path).auth(key, { type: 'bearer' }).set('Accept', 'application/json, text/event-stream')
    .send({ jsonrpc: '2.0', id: 1, method, params })
  const data = response.text.split('\n').find(line => line.startsWith('data: '))
  return { response, body: data ? JSON.parse(data.slice(6)) : response.body }
}
async function issueOAuth(surface: 'brain' | 'assistant', scope: 'read' | 'read_write' = 'read_write') {
  const registered = await request(app).post(`/oauth/${surface}/register`).send({ client_name: 'Fictional MCP client',redirect_uris: ['https://client.example/callback'] })
  expect(registered.status,registered.text).toBe(201)
  const clientId = registered.body.client_id, verifier = 'v'.repeat(64)
  const authorized = await request(app).get(`/oauth/${surface}/authorize`).query({ client_id: clientId,redirect_uri: 'https://client.example/callback',
    response_type: 'code',code_challenge: createHash('sha256').update(verifier).digest('base64url'),code_challenge_method: 'S256',scope })
  expect(authorized.status,authorized.text).toBe(302)
  const signed = new URL(authorized.headers.location).searchParams.get('req')!
  const choices = await request(app).get(`/oauth/${surface}/consent`).query({req:signed}).auth(bearer,{type:'bearer'})
  expect(choices.status,choices.text).toBe(200)
  expect(choices.body.workspaces.some((w: {id:string})=>w.id===workspace)).toBe(true)
  const wrong = await request(app).post(`/oauth/${surface==='brain'?'assistant':'brain'}/consent`).auth(bearer,{type:'bearer'})
    .send({req:signed,workspaceId:workspace,decision:'allow',workspaceAccess:true})
  expect(wrong.status,wrong.text).toBe(400)
  const consent = await request(app).post(`/oauth/${surface}/consent`).auth(bearer,{type:'bearer'})
    .send({req:signed,workspaceId:workspace,decision:'allow',workspaceAccess:true})
  expect(consent.status,consent.text).toBe(200)
  const code = new URL(consent.body.redirectUrl).searchParams.get('code')!
  const exchange = {grant_type:'authorization_code',code,client_id:clientId,redirect_uri:'https://client.example/callback',code_verifier:verifier}
  expect((await request(app).post(`/oauth/${surface==='brain'?'assistant':'brain'}/token`).send(exchange)).status).toBe(400)
  const token = await request(app).post(`/oauth/${surface}/token`).send(exchange)
  expect(token.status,token.text).toBe(200)
  expect((await request(app).post(`/oauth/${surface}/token`).send(exchange)).status).toBe(400)
  return {clientId,key:token.body.access_token as string,refresh:token.body.refresh_token as string,id:parseOAuthBearerToken(token.body.access_token,'oat')!.id}
}
describe('[COMP:api/workspace-mcp] explicit native workspace profiles', () => {
  it.each([['brain', false], ['assistant', false], ['brain', true], ['assistant', true]] as const)('%s supports a reference MCP SDK client through initialize, discovery, calls and revocation (compact: %s)', async (surface, compact) => {
    const key = await issue(surface)
    const server = await new Promise<import('node:http').Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const address = server.address() as import('node:net').AddressInfo
    const client = new Client({ name: 'fictional-workspace-client', version: '1.0.0' }, { capabilities: {} })
    try {
      const path = surface === 'brain' ? '/brain' : `/assistant/assistants/${assistant}/mcp`
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${address.port}${path}${compact ? '?catalog=compact' : ''}`), {
        requestInit: { headers: { Authorization: `Bearer ${key.key}` } },
      }))
      const listed = await client.listTools()
      if (compact) expect(listed.tools.map(tool => tool.name)).toEqual(['callWorkspaceOperation', 'getWorkspaceOperationSchema', 'searchWorkspaceOperations'])
      else {
        expect(listed.tools.some(tool => tool.name === 'getWorkspaceContext')).toBe(true)
        expect(listed.tools.some(tool => tool.name === 'runBrian')).toBe(true)
      }
      const invoke = async (input: { name: string; arguments: Record<string, unknown>; _meta?: Record<string, string> }) => {
        if (!compact) return client.callTool(input)
        const schema = await client.callTool({ name: 'getWorkspaceOperationSchema', arguments: { name: input.name } })
        expect(schema.isError, JSON.stringify(schema)).toBeFalsy()
        const descriptor = (schema.structuredContent as { data: { schemaRevision: string } }).data
        return client.callTool({ name: 'callWorkspaceOperation', arguments: { name: input.name,
          schemaRevision: descriptor.schemaRevision, arguments: input.arguments }, _meta: input._meta })
      }
      const context = await invoke({ name: 'getWorkspaceContext', arguments: {} })
      expect(context.isError, JSON.stringify(context)).not.toBe(true)
      expect(context.structuredContent).toMatchObject({ data: { workspaceId: workspace, assistantId: assistant } })
      const operationId = randomUUID()
      const input = { name: 'runBrian', arguments: { message: 'Fictional reconnect verification' }, _meta: { 'usebrian.ai/operation-id': operationId } }
      const queued = await invoke(input)
      expect(queued.isError, JSON.stringify(queued)).not.toBe(true)
      expect(await invoke(input)).toEqual(queued)
      if (compact) expect((await call(surface, key.key, 'tools/call', input)).body.result).toEqual(queued)
      const data = (queued.structuredContent as { data: { runId: string; sessionId: string; openPath: string } }).data
      expect(data.openPath).toBe(`/w/${workspace}/chat?v=workspace&s=${data.sessionId}`)
      expect(queued.structuredContent).toMatchObject({ data: {
        createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/), updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      } })
      expect(context.structuredContent).toMatchObject({ data: { sessionId: data.sessionId, openPath: data.openPath } })
      expect((await pool.query(`SELECT s.id FROM sessions s WHERE s.id=$1 AND s.workspace_id=$2 AND (${sessionKindSql.railRoom('s')})`, [data.sessionId, workspace])).rowCount).toBe(1)
      const cancelled = await invoke({ name: 'cancelBrianRun', arguments: { runId: data.runId } })
      expect(cancelled.isError, JSON.stringify(cancelled)).not.toBe(true)
      expect(cancelled.structuredContent).toMatchObject({ data: { openPath: data.openPath } })
      const recovered = await invoke({ name: 'listBrianRuns', arguments: {} })
      expect(recovered.isError, JSON.stringify(recovered)).not.toBe(true)
      expect(recovered.structuredContent).toMatchObject({ data: { runs: [{ runId: data.runId, status: 'cancelled', openPath: data.openPath }] } })
      if (surface === 'brain') await brainStore.revoke(actor, key.id)
      else await apiStore.revokeForUser(actor, key.id)
      await expect(client.callTool({ name: 'getWorkspaceContext', arguments: {} })).rejects.toThrow()
    } finally {
      await client.close()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  }, 120_000)

  it.each(['brain', 'assistant'] as const)('%s recovers paginated run receipts only in their original credential and context', async surface => {
    const key = await issue(surface)
    const invoke = (name: string, args: Record<string, unknown> = {}, token = key.key) => call(surface, token, 'tools/call', { name, arguments: args })
    const runs: string[] = []
    for (let i = 0; i < 3; i++) {
      const queued = await invoke('runBrian', { message: `Fictional private request ${i}` })
      expect(queued.body.result.isError, JSON.stringify(queued.body)).toBeFalsy()
      const runId = queued.body.result.structuredContent.data.runId
      runs.unshift(runId)
      await invoke('cancelBrianRun', { runId })
    }
    const first = (await invoke('listBrianRuns', { limit: 2 })).body.result
    expect(first.isError, JSON.stringify(first)).toBeFalsy()
    expect(first.structuredContent.data.runs.map((row: { runId: string }) => row.runId)).toEqual(runs.slice(0, 2))
    expect(JSON.stringify(first)).not.toContain('Fictional private request')
    const second = (await invoke('listBrianRuns', { limit: 2, cursor: first.structuredContent.data.nextCursor })).body.result
    expect(second.structuredContent.data.runs.map((row: { runId: string }) => row.runId)).toEqual(runs.slice(2))
    expect(second.structuredContent.data.nextCursor).toBeUndefined()
    const other = await issue(surface)
    expect((await invoke('listBrianRuns', {}, other.key)).body.result.structuredContent.data.runs).toEqual([])
    expect((await invoke('listBrianRuns', { cursor: runs[0] }, other.key)).body.result.isError).toBe(true)
    // The source-held conversation still permits status recovery, never source reads.
    await pool.query('UPDATE workspace_mcp_contexts SET invalidated=true WHERE id=(SELECT context_id FROM workspace_mcp_runs WHERE id=$1)', [runs[0]])
    const held = (await invoke('listBrianRuns')).body.result
    expect(held.isError, JSON.stringify(held)).toBeFalsy()
    expect(held.structuredContent.data.runs).toHaveLength(3)
  }, 120_000)

  it.each(['brain','assistant'] as const)('%s persists the originating connection in canonical workflow authoring and stops resume after revocation',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    const authored=await call(surface,key.key,'tools/call',{name:'authorFixtureWorkflow',arguments:{}})
    expect(authored.body.result.isError,JSON.stringify(authored.body)).toBeFalsy()
    const workflowId=authored.body.result.structuredContent.data.id
    const stored=(await pool.query('SELECT authoring_authority FROM workflows WHERE id=$1',[workflowId])).rows[0].authoring_authority
    expect(stored.workspaceDelegation).toMatchObject({credentialId:key.id,userId:actor,workspaceId:workspace,assistantId:assistant})
    const run=await workflowRuns.createRun({workflowId,workspaceId:workspace,triggeredBy:actor,triggerKind:'manual'})
    const resolved=await resolveWorkflowRunScope({userId:actor,assistantId:assistant,workspaceId:workspace,run})
    expect(workspaceCredentialDelegation(resolved.executionContext)).toMatchObject({credentialId:key.id})
    await resolved.executionContext.security.authority.assertCurrent()
    if(surface==='brain') await brainStore.revoke(actor,key.id); else await apiStore.revokeForUser(actor,key.id)
    await expect(resolved.executionContext.security.authority.assertCurrent()).rejects.toThrow()
    await expect(resolveWorkflowRunScope({userId:actor,assistantId:assistant,workspaceId:workspace,run})).rejects.toThrow()
  })

  it.each(['brain','assistant'] as const)('%s keeps the initiating credential when starting a workflow authored by another connection',async surface=>{
    const author=await issue(surface,false,{contextGroupId:departmentId})
    const authored=await call(surface,author.key,'tools/call',{name:'authorFixtureWorkflow',arguments:{}})
    expect(authored.body.result.isError,JSON.stringify(authored.body)).toBeFalsy()
    const workflowId=authored.body.result.structuredContent.data.id
    const initiator=await issue(surface,false,{contextGroupId:departmentId})
    const started=await call(surface,initiator.key,'tools/call',{name:'startFixtureWorkflow',arguments:{workflowId}})
    expect(started.body.result.isError,JSON.stringify(started.body)).toBeFalsy()
    const run=await workflowRuns.getRunSystem(started.body.result.structuredContent.data.id)
    expect(run).not.toBeNull()
    const resolved=await resolveWorkflowRunScope({userId:actor,assistantId:assistant,workspaceId:workspace,run:run!})
    const parent=workspaceCredentialDelegation(resolved.executionContext)
    expect(parent).toMatchObject({credentialId:initiator.id,constraints:[{credentialId:author.id}]})
    await expect(pool.query('UPDATE workflow_runs SET invocation_authority=NULL WHERE id=$1',[run!.id])).rejects.toThrow('workflow_invocation_authority_immutable')
    if(surface==='brain') await brainStore.revoke(actor,initiator.id); else await apiStore.revokeForUser(actor,initiator.id)
    await expect(resolved.executionContext.security.authority.assertCurrent()).rejects.toThrow()
    await expect(resolveWorkflowRunScope({userId:actor,assistantId:assistant,workspaceId:workspace,run:run!})).rejects.toThrow()
  })

  it.each(['brain','assistant'] as const)('%s carries retained source evidence into detached workflow execution',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    const summary=`Fictional detached input ${surface}`
    await call(surface,key.key,'tools/call',{name:'saveMemory',arguments:{summary,scope:'team'}})
    const memory=(await pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND summary=$2',[workspace,summary])).rows[0].id
    const read=await call(surface,key.key,'tools/call',{name:'getMemory',arguments:{id:memory}})
    expect(read.body.result.isError,JSON.stringify(read.body)).toBeFalsy()
    const authored=await call(surface,key.key,'tools/call',{name:'authorFixtureWorkflow',arguments:{}})
    expect(authored.body.result.isError,JSON.stringify(authored.body)).toBeFalsy()
    const workflowId=authored.body.result.structuredContent.data.id
    const run=await workflowRuns.createRun({workflowId,workspaceId:workspace,triggeredBy:actor,triggerKind:'manual'})
    const resolved=await resolveWorkflowRunScope({userId:actor,assistantId:assistant,workspaceId:workspace,run})
    expect(resolved.inputScopeEvidence.sources?.length).toBeGreaterThan(0)
    expect(resolved.executionContext.security.provenance).toEqual(resolved.inputScopeEvidence)
    expect(resolved.executionContext.security.access.sharedAudience).toBe(true)
    const context={...executionToolContext(resolved.executionContext,{appId:assistant}),scopeAccumulator:new ContextScopeAccumulator(resolved.inputScopeEvidence)}
    await assertSourceModelInputAuthority(context)
    await pool.query("UPDATE memories SET sensitivity='confidential' WHERE id=$1",[memory])
    await expect(assertSourceModelInputAuthority(context)).rejects.toThrow()
    await expect(resolveWorkflowRunScope({userId:actor,assistantId:assistant,workspaceId:workspace,run})).rejects.toThrow()
  },120_000)

  it.each(['brain','assistant'] as const)('%s restores a retained Task Goal without inventing a human sign-in',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    const drafted=await call(surface,key.key,'tools/call',{name:'draftFixtureGoal',arguments:{}})
    expect(drafted.body.result,JSON.stringify(drafted.body)).toMatchObject({isError:false,structuredContent:{status:'succeeded'}})
    const goal=drafted.body.result.structuredContent.data
    expect(goal.authoringAuthority.workspaceDelegation.credentialId).toBe(key.id)
    const restored=await resolveRetainedTaskGoalAuthority(goal)
    expect(restored?.authority.execution.identity).toMatchObject({kind:'programmatic',principal:{credentialId:key.id,actorUserId:actor}})
    expect(restored?.authority.execution.security.access.sharedAudience).toBe(true)
    await restored!.assertCurrent()
    const started=await call(surface,key.key,'tools/call',{name:'startFixtureGoal',arguments:{goalId:goal.id}})
    expect(started.body.result,JSON.stringify(started.body)).toMatchObject({isError:false,structuredContent:{status:'succeeded'}})
    const runId=started.body.result.structuredContent.data.workflowRunId
    expect((await pool.query('SELECT status FROM workflow_runs WHERE id=$1',[runId])).rows[0].status).toBe('completed')
    const runtime=await resolveRetainedGoalWorkflowRuntime(runId)
    expect(workspaceCredentialDelegation(runtime!.authority.execution)?.credentialId).toBe(key.id)
    await(surface==='brain'?brainStore.revoke(actor,key.id):apiStore.revokeForUser(actor,key.id))
    await expect(restored!.assertCurrent()).rejects.toThrow()
    await expect(resolveRetainedTaskGoalAuthority(goal)).rejects.toThrow()
    await expect(resolveRetainedGoalWorkflowRuntime(runId)).rejects.toThrow()
  },120_000)
  it.each(['brain','assistant'] as const)('%s restores a browser task with its original credential and refuses revoked cold work',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    const started=await call(surface,key.key,'tools/call',{name:'startFixtureBrowser',arguments:{}})
    expect(started.body.result.isError,JSON.stringify(started.body)).toBeFalsy()
    const task=JSON.parse(JSON.stringify(started.body.result.structuredContent.data))
    expect(task.executionAuthority.workspaceDelegation.credentialId).toBe(key.id)
    const boundary=await resolveBrowserTaskExecutionAuthority(task)
    await expect(boundary.execute(async()=> 'provider result')).resolves.toBe('provider result')
    if(surface==='brain')await brainStore.revoke(actor,key.id);else await apiStore.revokeForUser(actor,key.id)
    let executed=false
    await expect(boundary.execute(async()=>{executed=true})).rejects.toThrow()
    expect(executed).toBe(false)
    await expect(resolveBrowserTaskExecutionAuthority(task)).rejects.toThrow()
  })

  it.each(['brain','assistant'] as const)('%s completes an exact bulk binary transfer with canonical source provenance and connection ownership',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    const bytes=Buffer.alloc(CHUNKED_UPLOAD_PART_BYTES+7,129);bytes[0]=0;bytes[bytes.length-1]=255
    const sha256=createHash('sha256').update(bytes).digest('hex')
    const started=await call(surface,key.key,'tools/call',{name:'startFileUpload',arguments:{fileName:`fixture-${randomUUID()}.bin`,mime:'application/octet-stream',sizeBytes:bytes.length,sha256}})
    expect(started.body.result.isError,JSON.stringify(started.body)).toBeFalsy()
    const manifest=started.body.result.structuredContent.data
    expect(manifest.parts).toHaveLength(2)
    for(const part of manifest.parts)transferBytes.set(new URL(part.url).pathname.slice(1),bytes.subarray(part.offset,part.offset+part.sizeBytes))
    const other=await issue(surface,false,{contextGroupId:departmentId})
    const refused=await call(surface,other.key,'tools/call',{name:'completeFileUpload',arguments:{uploadId:manifest.uploadId}})
    expect(refused.body.result.isError).toBe(true)
    const finished=await call(surface,key.key,'tools/call',{name:'completeFileUpload',arguments:{uploadId:manifest.uploadId}})
    expect(finished.body.result.isError,JSON.stringify(finished.body)).toBeFalsy()
    const file=finished.body.result.structuredContent.data
    expect(file).toMatchObject({id:manifest.fileId,created_by_assistant_id:assistant,metadata:{sha256}})
    expect(transferBytes.get(`${workspace}/${file.id}`)?.equals(bytes)).toBe(true)
    const row=(await pool.query('SELECT compartments,created_by_assistant_id FROM workspace_files WHERE id=$1',[file.id])).rows[0]
    expect(row.compartments).toContain(`team:${departmentId}`)
    expect(row.created_by_assistant_id).toBe(assistant)
    const download=await call(surface,key.key,'tools/call',{name:'getFileDownload',arguments:{file:file.id}})
    expect(download.body.result.isError,JSON.stringify(download.body)).toBeFalsy()
    expect(download.body.result.structuredContent.data.url).toBe(`https://storage.example/${workspace}/${file.id}`)
    const repeated=await call(surface,key.key,'tools/call',{name:'completeFileUpload',arguments:{uploadId:manifest.uploadId}})
    expect(repeated.body.result.isError,JSON.stringify(repeated.body)).toBeFalsy()
    expect(repeated.body.result.structuredContent.data.id).toBe(file.id)
  })

  it.each(['brain','assistant'] as const)('%s creates canonical Office jobs without human impersonation and retains the parent through claim',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    for(const family of ['document','presentation','spreadsheet']) {
      const created=await call(surface,key.key,'tools/call',{name:'createOfficeArtifact',arguments:{family,outcome:'Create a fictional operations overview',audience:'Team',sourceHandles:[],idempotencyKey:randomUUID()}})
      expect(created.body.result.isError,JSON.stringify(created.body)).toBeFalsy()
      const ids=created.body.result.structuredContent.data
      const job=await officeGenerationStore.get(actor,ids.jobId)
      expect(job).not.toBeNull()
      expect(job!.authorityProjection).toMatchObject({workspaceDelegation:{credentialId:key.id},creationBinding:{actorUserId:actor}})
      expect((job!.authorityProjection as {creationBinding:{authSessionId?:string}}).creationBinding.authSessionId).toBeUndefined()
      expect((await pool.query("SELECT workspace_mcp_parent_current(authority_projection->'workspaceDelegation') AS current FROM office_generation_jobs WHERE id=$1",[job!.id])).rows[0].current).toBe(true)
      const claimed=await officeGenerationStore.claim({userId:actor,leaseToken:randomUUID(),leaseMs:60_000,jobKinds:['create']})
      expect(claimed?.id).toBe(job!.id)
      await expect(withOfficeWorkspaceAuthority(claimed!,async()=> 'permitted')).resolves.toBe('permitted')
      await officeGenerationStore.finish({userId:actor,jobId:job!.id,leaseToken:claimed!.leaseToken!,status:'needs_input',stage:'needs_input',errorCode:'template_ambiguous'})
    }
    const last=await officeGenerationStore.latestForArtifact(actor,(await pool.query("SELECT artifact_id FROM office_generation_jobs WHERE authority_projection->'workspaceDelegation'->>'credentialId'=$1 ORDER BY created_at DESC LIMIT 1",[key.id])).rows[0].artifact_id)
    if(surface==='brain')await brainStore.revoke(actor,key.id);else await apiStore.revokeForUser(actor,key.id)
    await expect(withOfficeWorkspaceAuthority(last!,async()=> 'forbidden')).rejects.toThrow()
    expect((await pool.query("SELECT workspace_mcp_parent_current(authority_projection->'workspaceDelegation') AS current FROM office_generation_jobs WHERE id=$1",[last!.id])).rows[0].current).toBe(false)
  })

  it.each(['brain', 'assistant'] as const)('%s resolves and reopens native Office comments with assistant attribution and current sharing', async surface => {
    const key = await issue(surface, false, { contextGroupId: departmentId })
    const created = await call(surface, key.key, 'tools/call', { name: 'createOfficeArtifact', arguments: {
      family: 'document', outcome: 'Fictional reviewed document', audience: 'Team', idempotencyKey: randomUUID() } })
    expect(created.body.result.isError, JSON.stringify(created.body)).toBeFalsy()
    const { artifactId, jobId } = created.body.result.structuredContent.data
    const job = await officeGenerationStore.claim({ userId: actor, leaseToken: randomUUID(), leaseMs: 60_000, jobKinds: ['create'] })
    expect(job?.id).toBe(jobId)
    const snapshot = { ...documentSnapshot(), artifactId, workspaceId: workspace, templateVersionId: null }
    const version = await withOfficeWorkspaceAuthority(job!, () => publishDepartmentOfficeSnapshot({ job: job!, leaseToken: job!.leaseToken!, snapshot,
      resolver: transferResolver, storageLimitBytes: 1e9 }))
    const thread = await officeComments.createThread({ userId: actor, workspaceId: workspace, artifactId, artifactVersionId: version.id,
      anchor: { kind: 'block', targetIds: [snapshot.sections[0]!.nodes[0]!.id] }, body: 'Fictional review note' })
    // Comment authority is sufficient, even when the owner has an explicit narrower role.
    await pool.query("INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role,granted_by) VALUES($1,$2,$3,'comment',$3)", [artifactId, workspace, actor])
    const listener = await pool.connect()
    const signals: Array<Record<string, unknown>> = []
    const onNotification = (message: { channel: string; payload?: string }) => {
      if (message.channel === 'brain_events' && message.payload) {
        const payload = JSON.parse(message.payload)
        if (payload.workspaceId === workspace && payload.primitive === 'office' && payload.rowId === artifactId) signals.push(payload)
      }
    }
    listener.on('notification', onNotification)
    await listener.query('LISTEN brain_events')
    try {
    const assignment = { name: 'assignOfficeComment', arguments: { artifactId, threadId: thread.threadId,
      assignedUserId: actor, assignedToBrian: true, dueAt: '2026-12-01T04:00:00.000Z' },
      _meta: { 'usebrian.ai/operation-id': randomUUID() } }
    const assigned = await call(surface, key.key, 'tools/call', assignment)
    expect(assigned.body.result.isError, JSON.stringify(assigned.body)).toBeFalsy()
    expect((await call(surface, key.key, 'tools/call', assignment)).body.result).toEqual(assigned.body.result)
    expect((await pool.query('SELECT assigned_user_id,assigned_to_brian,due_at FROM office_comment_threads WHERE id=$1',[thread.threadId])).rows[0])
      .toMatchObject({assigned_user_id:actor,assigned_to_brian:true,due_at:new Date(assignment.arguments.dueAt)})
    const visibleAssignment = await call(surface,key.key,'tools/call',{name:'getOfficeComments',arguments:{artifactId}})
    expect(visibleAssignment.body.result.isError,JSON.stringify(visibleAssignment.body)).toBeFalsy()
    expect(visibleAssignment.body.result.structuredContent.data.items).toEqual(expect.arrayContaining([
      expect.objectContaining({id:thread.threadId,assignedUserId:actor,assignedToBrian:true}),
    ]))
    const assignmentAudits = () => pool.query("SELECT actor_user_id,actor_assistant_id FROM office_audit_events WHERE artifact_id=$1 AND event_type='office.comment.assign'",[artifactId])
    expect((await assignmentAudits()).rows).toEqual([{actor_user_id:null,actor_assistant_id:assistant}])
    const outsider = await call(surface,key.key,'tools/call',{name:assignment.name,arguments:{...assignment.arguments,assignedUserId:randomUUID()}})
    expect(outsider.body.result.isError).toBe(true)
    expect((await assignmentAudits()).rows).toHaveLength(1)
    const cleared = await call(surface,key.key,'tools/call',{name:assignment.name,arguments:{...assignment.arguments,assignedUserId:null,assignedToBrian:false,dueAt:null}})
    expect(cleared.body.result.isError,JSON.stringify(cleared.body)).toBeFalsy()
    expect((await pool.query('SELECT assigned_user_id,assigned_to_brian,due_at FROM office_comment_threads WHERE id=$1',[thread.threadId])).rows[0])
      .toEqual({assigned_user_id:null,assigned_to_brian:false,due_at:null})
    const input = { name: 'resolveOfficeComment', arguments: { artifactId, threadId: thread.threadId, resolved: true },
      _meta: { 'usebrian.ai/operation-id': randomUUID() } }
    const resolved = await call(surface, key.key, 'tools/call', input)
    expect(resolved.body.result.isError, JSON.stringify(resolved.body)).toBeFalsy()
    await expect.poll(() => signals.length, { timeout: 5_000 }).toBeGreaterThan(0)
    expect(signals[0]).toEqual({workspaceId: workspace, primitive: 'office', action: 'update', rowId: artifactId})
    expect((await call(surface, key.key, 'tools/call', input)).body.result).toEqual(resolved.body.result)
    expect((await pool.query('SELECT status,resolved_by FROM office_comment_threads WHERE id=$1', [thread.threadId])).rows[0])
      .toMatchObject({ status: 'resolved', resolved_by: null })
    const audits = () => pool.query("SELECT actor_user_id,actor_assistant_id,metadata FROM office_audit_events WHERE artifact_id=$1 AND event_type='office.comment.resolve' ORDER BY created_at", [artifactId])
    expect((await audits()).rows).toEqual([expect.objectContaining({ actor_user_id: null, actor_assistant_id: assistant, metadata: { threadId: thread.threadId, status: 'resolved' } })])
    const reopened = await call(surface, key.key, 'tools/call', { name: input.name, arguments: { ...input.arguments, resolved: false } })
    expect(reopened.body.result.isError, JSON.stringify(reopened.body)).toBeFalsy()
    expect((await pool.query('SELECT status FROM office_comment_threads WHERE id=$1', [thread.threadId])).rows[0].status).toBe('open')
    const wrongArtifact = await call(surface, key.key, 'tools/call', { name: input.name, arguments: { ...input.arguments, artifactId: randomUUID() } })
    expect(wrongArtifact.body.result.isError).toBe(true)
    beforeCommentResolve = async () => { await pool.query("UPDATE office_artifacts SET default_workspace_role='deny' WHERE id=$1", [artifactId]) }
    try {
      const raced = await call(surface, key.key, 'tools/call', { name: input.name, arguments: input.arguments })
      expect(raced.body.result.isError).toBe(true)
      expect((await pool.query('SELECT status FROM office_comment_threads WHERE id=$1', [thread.threadId])).rows[0].status).toBe('open')
      expect((await audits()).rows).toHaveLength(2)
      const racedAssignment = await call(surface,key.key,'tools/call',{name:assignment.name,arguments:assignment.arguments})
      expect(racedAssignment.body.result.isError).toBe(true)
      expect((await assignmentAudits()).rows).toHaveLength(2)
    } finally { beforeCommentResolve = undefined }
    } finally {
      await listener.query('UNLISTEN brain_events')
      listener.off('notification', onNotification)
      listener.release()
    }
  }, 120_000)

  it.each([['brain', 'sharing'], ['assistant', 'sharing'], ['brain', 'snapshot'], ['assistant', 'snapshot']] as const)('%s previews and restores saved Office history and stops after %s changes', async (surface, changedSource) => {
    const key = await issue(surface, false, { contextGroupId: departmentId })
    const created = await call(surface, key.key, 'tools/call', { name: 'createOfficeArtifact', arguments: {
      family: 'document', outcome: 'Fictional history document', audience: 'Team', idempotencyKey: randomUUID() } })
    expect(created.body.result.isError, JSON.stringify(created.body)).toBeFalsy()
    const { artifactId, jobId } = created.body.result.structuredContent.data
    const job = await officeGenerationStore.claim({ userId: actor, leaseToken: randomUUID(), leaseMs: 60_000, jobKinds: ['create'] })
    expect(job?.id).toBe(jobId)
    const snapshot = { ...documentSnapshot(), artifactId, workspaceId: workspace, templateVersionId: null }
    const version = await withOfficeWorkspaceAuthority(job!, () => publishDepartmentOfficeSnapshot({ job: job!, leaseToken: job!.leaseToken!, snapshot,
      resolver: transferResolver, storageLimitBytes: 1e9 }))
    expect((await pool.query('SELECT author_type,author_user_id,author_assistant_id FROM office_artifact_versions WHERE id=$1', [version.id])).rows[0])
      .toMatchObject({ author_type: 'assistant', author_user_id: null, author_assistant_id: assistant })
    const changed = { ...snapshot, title: 'Fictional unsaved revision' }
    await createOfficeLiveStore().initialize({ userId: actor, artifactId, snapshot: changed })
    const preview = await call(surface, key.key, 'tools/call', { name: 'getOfficeArtifact', arguments: {
      artifactId, versionId: version.id, targetIds: [snapshot.sections[0]!.id] } })
    expect(preview.body.result.isError, JSON.stringify(preview.body)).toBeFalsy()
    expect(preview.body.result.structuredContent.data).toMatchObject({ title: snapshot.title, versionId: version.id, version: 1, currentVersion: 1 })
    expect(preview.body.result.structuredContent.data.selection.targets[0].content).toEqual(snapshot.sections[0])
    const args = { name: 'restoreOfficeVersion', arguments: { artifactId, targetVersionId: version.id, expectedVersion: 1 },
      _meta: { 'usebrian.ai/operation-id': randomUUID() } }
    const restored = await call(surface, key.key, 'tools/call', args)
    expect(restored.body.result.isError, JSON.stringify(restored.body)).toBeFalsy()
    expect(restored.body.result.structuredContent.data).toMatchObject({ artifactId, version: 2 })
    const history = (await pool.query(`SELECT author_type,author_user_id,author_assistant_id,origin FROM office_artifact_versions WHERE artifact_id=$1 AND version=2`, [artifactId])).rows[0]
    expect(history).toMatchObject({ author_type: 'assistant', author_user_id: null, author_assistant_id: assistant, origin: 'restore' })
    expect((await createOfficeLiveStore().get(actor, artifactId))?.snapshot.title).toBe(snapshot.title)
    const replay = await call(surface, key.key, 'tools/call', args)
    expect(replay.body.result.isError, JSON.stringify(replay.body)).toBeFalsy()
    expect((await officeArtifactStore.get(actor, artifactId))?.headVersion).toBe(2)
    const conflict = await call(surface, key.key, 'tools/call', { ...args, _meta: { 'usebrian.ai/operation-id': randomUUID() } })
    expect(conflict.body.result.isError).toBe(true)
    expect(conflict.body.result.structuredContent.data.code).toBe('version_conflict')
    const wrong = await call(surface, key.key, 'tools/call', { name: 'getOfficeArtifact', arguments: { artifactId, versionId: randomUUID() } })
    expect(wrong.body.result.isError).toBe(true)
    beforeHistoryRestore = async () => {
      if (changedSource === 'sharing') await pool.query("UPDATE office_artifacts SET default_workspace_role='deny' WHERE id=$1", [artifactId])
      else await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=(SELECT snapshot_file_id FROM office_artifact_versions WHERE id=$1)', [version.id])
    }
    try {
      const revoked = await call(surface, key.key, 'tools/call', { ...args, arguments: { ...args.arguments, expectedVersion: 2 },
        _meta: { 'usebrian.ai/operation-id': randomUUID() } })
      expect(revoked.body.result.isError).toBe(true)
      expect((await pool.query('SELECT head_version::int AS version FROM office_artifacts WHERE id=$1', [artifactId])).rows[0].version).toBe(2)
      // Content-free context controls intentionally remain usable for recovery.
      // A source-bearing read must refuse the retained invalidated history.
      const retained = await call(surface, key.key, 'tools/call', { name: 'getOfficeArtifact', arguments: { artifactId } })
      expect(retained.body.result.isError).toBe(true)
    } finally { beforeHistoryRestore = undefined }
  })

  it.each(['brain', 'assistant'] as const)('%s exports a canonical Office head with native provenance and idempotent release receipts', async surface => {
    const key = await issue(surface, false, { contextGroupId: departmentId })
    const created = await call(surface, key.key, 'tools/call', { name: 'createOfficeArtifact', arguments: {
      family: 'document', outcome: 'Fictional export document', audience: 'Team', idempotencyKey: randomUUID() } })
    expect(created.body.result.isError, JSON.stringify(created.body)).toBeFalsy()
    const { artifactId, jobId } = created.body.result.structuredContent.data
    const job = await officeGenerationStore.claim({ userId: actor, leaseToken: randomUUID(), leaseMs: 60_000, jobKinds: ['create'] })
    expect(job?.id).toBe(jobId)
    const snapshot = { ...documentSnapshot(), artifactId, workspaceId: workspace, templateVersionId: null }
    await withOfficeWorkspaceAuthority(job!, () => publishDepartmentOfficeSnapshot({ job: job!, leaseToken: job!.leaseToken!, snapshot,
      resolver: transferResolver, storageLimitBytes: 1e9 }))
    const args = { name: 'exportOfficeArtifact', arguments: { artifactId, expectedVersion: 1, format: 'native' },
      _meta: { 'usebrian.ai/operation-id': randomUUID() } }
    const exported = await call(surface, key.key, 'tools/call', args)
    expect(exported.body.result.isError, JSON.stringify(exported.body)).toBeFalsy()
    const receipt = exported.body.result.structuredContent.data
    expect(receipt).toMatchObject({ version: 1, fileId: expect.any(String), releaseId: expect.any(String), receipt: { status: 'ready' } })
    const file = (await pool.query('SELECT path,created_by_assistant_id,compartments FROM workspace_files WHERE id=$1', [receipt.fileId])).rows[0]
    expect(file).toMatchObject({ path: expect.stringContaining('/exports/office/'), created_by_assistant_id: assistant, compartments: [`team:${departmentId}`] })
    expect(transferBytes.get(`${workspace}/${receipt.fileId}`)?.subarray(0, 2).toString()).toBe('PK')
    const lineage = (await pool.query(`SELECT s.source_kind FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id
      WHERE d.workspace_id=$1 AND d.resource_kind='workspace_file' AND d.resource_id=$2`, [workspace, receipt.fileId])).rows
    expect(lineage).toContainEqual({ source_kind: 'office_observation' })
    expect((await call(surface, key.key, 'tools/call', args)).body.result).toEqual(exported.body.result)
    expect((await pool.query('SELECT id FROM office_release_records WHERE artifact_id=$1', [artifactId])).rows).toHaveLength(1)
    expect((await pool.query("SELECT actor_assistant_id FROM office_audit_events WHERE artifact_id=$1 AND event_type='office.release.created'", [artifactId])).rows).toEqual([{ actor_assistant_id: assistant }])
    const claimId = randomUUID()
    await pool.query(`INSERT INTO office_claims(id,artifact_id,artifact_version_id,workspace_id,object_id,claim_text,classification,confidence,severity,reason_code)
      SELECT $1,id,head_version_id,workspace_id,$3,'Fictional unverified claim','unsupported_conflicted',0.5,'warning','source_missing'
      FROM office_artifacts WHERE id=$2`, [claimId, artifactId, snapshot.sections[0]!.nodes[0]!.id])
    const needsReview = await call(surface, key.key, 'tools/call', { name: 'exportOfficeArtifact', arguments: args.arguments })
    expect(needsReview.body.result.structuredContent.data.receipt.status).toBe('needs_ack')
    const codes = needsReview.body.result.structuredContent.data.receipt.warnings.map((warning: { code: string }) => warning.code)
    const acknowledged = { ...args.arguments, acknowledgeCodes: codes }
    const spoofed = await call(surface, key.key, 'tools/call', { name: 'exportOfficeArtifact', arguments: { ...acknowledged, approved: true } })
    expect(spoofed.body.result?.isError ?? Boolean(spoofed.body.error)).toBe(true)
    const review = await call(surface, key.key, 'tools/call', { name: 'exportOfficeArtifact', arguments: acknowledged })
    expect(review.body.result.structuredContent.status).toBe('waiting_approval')
    expect((await pool.query('SELECT id FROM office_release_records WHERE artifact_id=$1', [artifactId])).rows).toHaveLength(1)
    const approved = await request(app).post(`/approvals/${review.body.result.structuredContent.approvalId}/respond`).auth(bearer, { type: 'bearer' }).send({ decision: 'approved' })
    expect(approved.status, approved.text).toBe(200)
    const releases = (await pool.query('SELECT acknowledgement FROM office_release_records WHERE artifact_id=$1 ORDER BY created_at', [artifactId])).rows
    expect(releases).toHaveLength(2)
    expect(releases[1].acknowledgement).toMatchObject({ version: 1, action: 'export', codes })
    await pool.query("UPDATE office_claims SET status='resolved' WHERE id=$1", [claimId])
    const before = new Set(transferBytes.keys())
    transferWriteHook = async () => { await pool.query("UPDATE office_artifacts SET default_workspace_role='deny' WHERE id=$1", [artifactId]) }
    try {
      const raced = await call(surface, key.key, 'tools/call', { name: 'exportOfficeArtifact', arguments: args.arguments })
      expect(raced.body.result.isError).toBe(true)
    } finally { transferWriteHook = undefined }
    expect([...transferBytes.keys()].filter(key => !before.has(key))).toEqual([])
    expect((await pool.query('SELECT id FROM office_release_records WHERE artifact_id=$1', [artifactId])).rows).toHaveLength(2)
    expect((await pool.query('SELECT scope_held FROM workspace_files WHERE id=$1', [receipt.fileId])).rows[0].scope_held).toBe(true)
    expect((await call(surface, key.key, 'tools/call', args)).body.result.isError).toBe(true)
  }, 120_000)

  it.each(['brain','assistant'] as const)('%s reads exact Office selection and queues typed native commands with retained authority',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    const created=await call(surface,key.key,'tools/call',{name:'createOfficeArtifact',arguments:{family:'document',outcome:'Fictional typed revision',audience:'Team',idempotencyKey:randomUUID()}})
    expect(created.body.result.isError,JSON.stringify(created.body)).toBeFalsy()
    const artifactId=created.body.result.structuredContent.data.artifactId
    const nodeId=randomUUID(),runId=randomUUID(),sectionId=randomUUID()
    const style={fontFamily:'Arial',fontSizePt:11,bold:false,italic:false,underline:false,strike:false,color:'#111111'}
    const node={id:nodeId,kind:'paragraph' as const,styleName:'Body',alignment:'start' as const,runs:[{id:runId,text:'Original exact text',style}]}
    const snapshot={schemaVersion:1 as const,artifactId,capabilityVersion:1 as const,workspaceId:workspace,rootId:randomUUID(),locale:'en-US',defaultLanguage:'en-US',templateVersionId:null,resources:[],accessibility:{title:'Fixture'},family:'document' as const,title:'Fixture',
      sections:[{id:sectionId,page:{widthPt:612,heightPt:792,marginTopPt:72,marginRightPt:72,marginBottomPt:72,marginLeftPt:72,orientation:'portrait' as const},header:[],footer:[],showPageNumber:true,nodes:[node]}]}
    await createOfficeLiveStore().initialize({userId:actor,artifactId,snapshot})
    const read=await call(surface,key.key,'tools/call',{name:'getOfficeArtifact',arguments:{artifactId,targetIds:[nodeId]}})
    expect(read.body.result.isError,JSON.stringify(read.body)).toBeFalsy()
    expect(read.body.result.structuredContent.data.selection.targets).toEqual([{id:nodeId,content:node}])
    const commands=[{kind:'replaceTextRange' as const,targetId:nodeId,from:0,to:8,preimageHash:createHash('sha256').update('Original').digest('hex'),runs:[{id:runId,text:'Revised',style}]}]
    const input={artifactId,targetIds:[nodeId],expectedVersion:0,idempotencyKey:randomUUID(),commands}
    const invalid=await call(surface,key.key,'tools/call',{name:'applyOfficeCommands',arguments:{...input,commands:[{...commands[0],actor:{type:'user',id:actor}}]}})
    expect(invalid.body.result?.isError??Boolean(invalid.body.error)).toBe(true)
    const queued=await call(surface,key.key,'tools/call',{name:'applyOfficeCommands',arguments:input})
    expect(queued.body.result.isError,JSON.stringify(queued.body)).toBeFalsy()
    const job=await officeGenerationStore.get(actor,queued.body.result.structuredContent.data.jobId)
    expect(job?.brief).toMatchObject({commandOperations:commands,targetIds:[nodeId],expectedVersion:0})
    const planned=await withOfficeWorkspaceAuthority(job!,()=>generateAssistantOfficeCommands({snapshot,operations:commands,
      provider:{async *stream(){throw new Error('Explicit commands must not invoke a model')}} as never,model:'fixture',baseVersion:0,
      assistantId:assistant, targetIds:[nodeId],instruction:'Apply submitted commands'}))
    expect(planned[0]).toMatchObject({kind:'replaceTextRange',actor:{type:'assistant',id:assistant},origin:'ai'})
    if(surface==='brain')await brainStore.revoke(actor,key.id);else await apiStore.revokeForUser(actor,key.id)
    await expect(withOfficeWorkspaceAuthority(job!,async()=>true)).rejects.toThrow()
  },120_000)

  it.each(['brain', 'assistant'] as const)('%s uses native Office lifecycle audit, holds and human review', async surface => {
    const key = await issue(surface, false, { contextGroupId: departmentId })
    const created = await call(surface, key.key, 'tools/call', { name: 'createOfficeArtifact', arguments: { family: 'document', outcome: 'Fictional lifecycle draft', audience: 'Team', idempotencyKey: randomUUID() } })
    expect(created.body.result.isError, JSON.stringify(created.body)).toBeFalsy()
    const artifactId = created.body.result.structuredContent.data.artifactId
    expect(await artifactReadableForViewer(actor, 'document', artifactId)).toEqual({ readable: true, version: 0 })
    expect(await artifactReadableForViewer(randomUUID(), 'document', artifactId)).toEqual({ readable: false, version: null })
    const change = (action: string) => call(surface, key.key, 'tools/call', { name: 'changeOfficeLifecycle', arguments: { artifactId, action } })
    expect((await change('archive')).body.result.structuredContent.data).toEqual({ artifactId, lifecycleState: 'archived' })
    expect((await pool.query("SELECT actor_user_id,actor_assistant_id FROM office_audit_events WHERE artifact_id=$1 AND event_type='office.lifecycle.archive'", [artifactId])).rows[0]).toEqual({ actor_user_id: actor, actor_assistant_id: assistant })
    expect((await change('unarchive')).body.result.structuredContent.data).toEqual({ artifactId, lifecycleState: 'active' })
    await pool.query('UPDATE office_artifacts SET legal_hold=true WHERE id=$1', [artifactId])
    expect((await change('archive')).body.result.isError).toBe(true)
    await pool.query('UPDATE office_artifacts SET legal_hold=false WHERE id=$1', [artifactId])
    const review = await change('trash')
    expect(review.body.result.structuredContent.status).toBe('waiting_approval')
    expect((await pool.query('SELECT lifecycle_state FROM office_artifacts WHERE id=$1', [artifactId])).rows[0].lifecycle_state).toBe('active')
    const approval = await request(app).post(`/approvals/${review.body.result.structuredContent.approvalId}/respond`).auth(bearer, { type: 'bearer' }).send({ decision: 'approved' })
    expect(approval.status, approval.text).toBe(200)
    expect((await pool.query('SELECT lifecycle_state FROM office_artifacts WHERE id=$1', [artifactId])).rows[0].lifecycle_state).toBe('trash')
    expect((await change('restore')).body.result.structuredContent.data).toEqual({ artifactId, lifecycleState: 'active' })
  }, 120_000)

  it.each(['brain','assistant'] as const)('%s cancels Office work and retires jobs after connection revocation',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    const create=async()=>{
      const reply=await call(surface,key.key,'tools/call',{name:'createOfficeArtifact',arguments:{family:'document',outcome:'Fictional cancellable draft',audience:'Team',idempotencyKey:randomUUID()}})
      expect(reply.body.result.isError,JSON.stringify(reply.body)).toBeFalsy()
      const {artifactId,jobId}=reply.body.result.structuredContent.data
      return {artifactId,jobId} as {artifactId:string;jobId:string}
    }
    const first=await create()
    const denied=await call(surface,key.key,'tools/call',{name:'cancelOfficeJob',arguments:{...first,artifactId:randomUUID()}})
    expect(denied.body.result.isError).toBe(true)
    const cancelled=await call(surface,key.key,'tools/call',{name:'cancelOfficeJob',arguments:first})
    expect(cancelled.body.result,JSON.stringify(cancelled.body)).toMatchObject({isError:false,structuredContent:{data:{cancellationRequested:true}}})
    expect((await officeGenerationStore.get(actor,first.jobId))?.status).toBe('cancelled')
    expect((await officeGenerationStore.listEvents(actor,first.jobId,0)).at(-1)?.code).toBe('office.job.cancelled')
    const second=await create()
    if(surface==='brain')await brainStore.revoke(actor,key.id);else await apiStore.revokeForUser(actor,key.id)
    await officeGenerationStore.claim({userId:actor,leaseToken:randomUUID(),leaseMs:60_000,jobKinds:['create']})
    expect(await officeGenerationStore.get(actor,second.jobId)).toMatchObject({status:'failed',errorCode:'workspace_access_changed'})
    expect((await officeGenerationStore.listEvents(actor,second.jobId,0)).at(-1)?.code).toBe('office.job.failed')
  },120_000)

  it.each(['brain','assistant'] as const)('%s discovers Office artifacts with bounded pages and retained sharing evidence',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    const created=await call(surface,key.key,'tools/call',{name:'createOfficeArtifact',arguments:{family:'document',outcome:'Fictional library draft',audience:'Team',sourceHandles:[],idempotencyKey:randomUUID()}})
    expect(created.body.result.isError,JSON.stringify(created.body)).toBeFalsy()
    const artifactId=created.body.result.structuredContent.data.artifactId
    const seen=new Set<string>();let cursor:string|undefined
    do {
      const page=await call(surface,key.key,'tools/call',{name:'listOfficeArtifacts',arguments:{view:'active',limit:1,...(cursor?{cursor}:{})}})
      expect(page.body.result.isError,JSON.stringify(page.body)).toBeFalsy()
      const data=page.body.result.structuredContent.data
      expect(data.artifacts.length).toBeLessThanOrEqual(1)
      for(const artifact of data.artifacts){expect(seen.has(artifact.artifactId)).toBe(false);seen.add(artifact.artifactId);expect(artifact).not.toHaveProperty('scopeEvidence')}
      cursor=data.nextCursor
    }while(cursor)
    for(const name of ['getOfficeHistory','getOfficeComments','getOfficeSuggestions']){
      const review=await call(surface,key.key,'tools/call',{name,arguments:{artifactId,limit:1}})
      expect(review.body.result,JSON.stringify(review.body)).toMatchObject({isError:false,structuredContent:{data:{items:[],windowLimitReached:false}}})
      expect(review.body.result.structuredContent.data).not.toHaveProperty('scopeEvidence')
    }
    expect(seen.has(artifactId)).toBe(true)
    expect((await pool.query('SELECT id FROM office_scope_observations WHERE artifact_id=$1 AND NOT held',[artifactId])).rowCount).toBeGreaterThan(0)
    await pool.query("INSERT INTO office_artifact_grants(workspace_id,artifact_id,user_id,role,granted_by) VALUES($1,$2,$3,'deny',$3)",[workspace,artifactId,actor])
    const refused=await call(surface,key.key,'tools/call',{name:'listOfficeArtifacts',arguments:{view:'active',limit:20}})
    expect(refused.body.result.isError).toBe(true)
  },120_000)

  it.each(['brain','assistant'] as const)('%s retains Office sharing evidence and cannot revive it after access is restored',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    const created=await call(surface,key.key,'tools/call',{name:'createOfficeArtifact',arguments:{family:'document',outcome:'Draft an internal overview',audience:'Team',idempotencyKey:randomUUID()}})
    expect(created.body.result.isError,JSON.stringify(created.body)).toBeFalsy()
    const artifactId=created.body.result.structuredContent.data.artifactId
    const read=await call(surface,key.key,'tools/call',{name:'getOfficeArtifact',arguments:{artifactId}})
    expect(read.body.result.isError,JSON.stringify(read.body)).toBeFalsy()
    expect(read.body.result.structuredContent.data.artifactId).toBe(artifactId)
    const observed=(await pool.query('SELECT id,held FROM office_scope_observations WHERE artifact_id=$1 AND reader_user_id=$2',[artifactId,actor])).rows
    expect(observed).toHaveLength(1)
    expect(observed[0].held).toBe(false)
    const derived=await call(surface,key.key,'tools/call',{name:'saveMemory',arguments:{summary:'Fictional Office-derived note '+artifactId,scope:'team'}})
    expect(derived.body.result.isError,JSON.stringify(derived.body)).toBeFalsy()
    expect((await pool.query("SELECT source_id FROM scope_derivation_sources WHERE workspace_id=$1 AND source_kind='office_observation' AND source_id=$2",[workspace,observed[0].id])).rows.length).toBeGreaterThan(0)
    await pool.query("INSERT INTO office_artifact_grants(artifact_id,workspace_id,user_id,role,granted_by) VALUES($1,$2,$3,'deny',$3)",[artifactId,workspace,actor])
    expect((await pool.query('SELECT held FROM office_scope_observations WHERE id=$1',[observed[0].id])).rows[0].held).toBe(true)
    expect((await pool.query('SELECT scope_held FROM memories WHERE workspace_id=$1 AND summary=$2',[workspace,'Fictional Office-derived note '+artifactId])).rows[0].scope_held).toBe(true)
    const denied=await call(surface,key.key,'tools/call',{name:'getOfficeArtifact',arguments:{artifactId}})
    expect(denied.body.result.isError,JSON.stringify(denied.body)).toBe(true)
    await pool.query('DELETE FROM office_artifact_grants WHERE artifact_id=$1 AND user_id=$2',[artifactId,actor])
    const stillDenied=await call(surface,key.key,'tools/call',{name:'getOfficeArtifact',arguments:{artifactId}})
    expect(stillDenied.body.result.isError).toBe(true)
    const fresh=await issue(surface,false,{contextGroupId:departmentId})
    const current=await call(surface,fresh.key,'tools/call',{name:'getOfficeArtifact',arguments:{artifactId}})
    expect(current.body.result.isError,JSON.stringify(current.body)).toBeFalsy()
    expect(current.body.result.structuredContent.data.artifactId).toBe(artifactId)
  })

  it.each(['brain','assistant'] as const)('%s OAuth binds consent and refresh to its resource while durable runs survive token rotation',async surface=>{
    const grant=await issueOAuth(surface)
    const initial=await call(surface,grant.key,'tools/call',{name:'getWorkspaceContext',arguments:{}})
    expect(initial.body.result?.isError,JSON.stringify(initial.body)).toBeFalsy()
    expect(initial.body.result.structuredContent.data.workspaceId).toBe(workspace)
    const wrong=await call(surface==='brain'?'assistant':'brain',grant.key,'tools/list',{})
    expect(wrong.response.status).toBe(401)
    const selected=await call(surface,grant.key,'tools/call',{name:'createWorkspaceContext',arguments:{}})
    expect(selected.body.result.isError,JSON.stringify(selected.body)).toBeFalsy()
    const handle=selected.body.result.structuredContent.data.contextId
    const queued=await call(surface,grant.key,'tools/call',{name:'runBrian',arguments:{message:'Complete the fictional task.'},_meta:{'usebrian.ai/context-id':handle}})
    expect(queued.body.result.isError,JSON.stringify(queued.body)).toBeFalsy()
    const runId=queued.body.result.structuredContent.data.runId
    const refreshBody={grant_type:'refresh_token',refresh_token:grant.refresh,client_id:grant.clientId}
    expect((await request(app).post(`/oauth/${surface==='brain'?'assistant':'brain'}/token`).send(refreshBody)).status).toBe(400)
    const rotated=await request(app).post(`/oauth/${surface}/token`).send(refreshBody)
    expect(rotated.status,rotated.text).toBe(200)
    expect((await request(app).post(`/oauth/${surface}/token`).send(refreshBody)).status).toBe(400)
    expect((await call(surface,grant.key,'tools/list',{})).response.status).toBe(401)
    runNative=async()=>({status:'succeeded',messageIds:[]})
    profile.runWorker!.start();await profile.runWorker!.tick();await profile.runWorker!.stop()
    const status=await call(surface,rotated.body.access_token,'tools/call',{name:'getBrianRun',arguments:{runId},_meta:{'usebrian.ai/context-id':handle}})
    expect(status.body.result.structuredContent.data.status,JSON.stringify(status.body)).toBe('succeeded')
    const next=await call(surface,rotated.body.access_token,'tools/call',{name:'runBrian',arguments:{message:'Do not execute after revocation.'}})
    const nextId=next.body.result.structuredContent.data.runId
    await (surface==='brain'?oauthStore:assistantOAuthStore).revoke(actor,grant.id)
    let executed=false;runNative=async()=>{executed=true;return {status:'succeeded',messageIds:[]}}
    profile.runWorker!.start();await profile.runWorker!.tick();await profile.runWorker!.stop()
    expect(executed).toBe(false)
    expect((await pool.query('SELECT status FROM workspace_mcp_runs WHERE id=$1',[nextId])).rows[0].status).toBe('failed')
  })
  it.each(['brain','assistant'] as const)('%s OAuth read-only consent excludes mutating operations',async surface=>{
    const grant=await issueOAuth(surface,'read')
    const listed=await call(surface,grant.key,'tools/list',{})
    expect(listed.response.status,JSON.stringify(listed.body)).toBe(200)
    expect(listed.body.result.tools.map((t:{name:string})=>t.name)).not.toContain('saveMemory')
    expect(listed.body.result.tools.map((t:{name:string})=>t.name)).not.toContain('runBrian')
  })

  it.each(['brain', 'assistant'] as const)('%s retains the actual workspace skill revision and stops after its source is held', async surface => {
    const skillId = randomUUID(), slug = `fictional-procedure-${surface}`
    await pool.query(`INSERT INTO workspace_skills(id,slug,name,description,content,workspace_id,all_assistants,activated_at,confidence)
      VALUES($1,$2,'Fictional procedure','Formatting procedure','Use the reviewed fictional format.',$3,true,now(),1)`, [skillId, slug, workspace])
    includeDatabaseSkills = true
    try {
      const key = await issue(surface)
      const used = await call(surface, key.key, 'tools/call', { name: 'useSkill', arguments: { skill: slug } })
      expect(used.body.result.isError, JSON.stringify(used.body)).toBeFalsy()
      expect(JSON.stringify(used.body)).toContain('Use the reviewed fictional format.')
      const column = surface === 'brain' ? 'brain_key_id' : 'api_key_id'
      const retained = (await pool.query(`SELECT evidence FROM workspace_mcp_contexts WHERE ${column}=$1`, [key.id])).rows[0]
      expect(JSON.stringify(retained)).toContain('workspace_skill_revision')
      await pool.query('UPDATE workspace_skill_scope_revisions SET scope_held=true WHERE id=(SELECT scope_revision_id FROM workspace_skills WHERE id=$1)', [skillId])
      const refused = await call(surface, key.key, 'tools/call', { name: 'useSkill', arguments: { skill: slug } })
      expect(refused.body.result.isError).toBe(true)
      expect(JSON.stringify(refused.body)).not.toContain('Use the reviewed fictional format.')
    } finally { includeDatabaseSkills = false }
  })
  it.each(['brain','assistant'] as const)('%s invalidates an authored skill context after body or bundle edits', async surface => {
    const skillId=randomUUID(),slug=`fictional-versioned-${surface}`;
    await pool.query(`INSERT INTO workspace_skills(id,slug,name,description,content,workspace_id,all_assistants,activated_at,confidence,bundle_version)
      VALUES($1,$2,'Fictional guide','Versioned guide','Original procedure',$3,true,now(),1,2)`,[skillId,slug,workspace]);
    includeDatabaseSkills=true;
    try {
      const key=await issue(surface);
      const use=(token:string)=>call(surface,token,'tools/call',{name:'useSkill',arguments:{skill:slug}});
      expect((await use(key.key)).body.result.isError).toBeFalsy();
      await workspaceSkills.update(actor,workspace,skillId,{content:'Revised procedure'});
      expect((await use(key.key)).body.result.isError).toBe(true);
      const fresh=await issue(surface);
      expect(JSON.stringify((await use(fresh.key)).body)).toContain('Revised procedure');
      await pool.query(`INSERT INTO workspace_skill_files(workspace_skill_id,kind,name,path,content,content_hash)
        VALUES($1,'reference','format.md','references/format.md','New format','fictional-hash')`,[skillId]);
      expect((await use(fresh.key)).body.result.isError).toBe(true);
      const changed=await issue(surface);
      expect((await use(changed.key)).body.result.isError).toBeFalsy();
      await workspaceSkills.update(actor,workspace,skillId,{sensitivity:'confidential'});
      expect((await use(changed.key)).body.result.isError).toBe(true);
    } finally { includeDatabaseSkills=false; }
  });
  it.each(['brain', 'assistant'] as const)('%s retains Page source boundaries and refuses private or reclassified content', async surface => {
    const space = randomUUID()
    await pool.query("INSERT INTO teamspaces(id,workspace_id,name,created_by) VALUES($1,$2,'Shared notes',$3)", [space, workspace, actor])
    await pool.query('INSERT INTO teamspace_members(teamspace_id,user_id) VALUES($1,$2)', [space, actor])
    const page = (await pool.query(`INSERT INTO saved_views(workspace_id,created_by,name,entity,view_type,page,state,clearance,teamspace_id)
      VALUES($1,$2,'Shared note','tasks','table','{"blocks":[]}','saved','internal',$3) RETURNING id`, [workspace, actor, space])).rows[0]
    const key = await issue(surface)
    const read = () => call(surface, key.key, 'tools/call', { name: 'getCurrentPage', arguments: { pageId: page.id } })
    const pinned = await call(surface, key.key, 'tools/call', { name: 'addPin', arguments: { kind: 'page', refId: page.id } })
    expect(pinned.body.result.isError, JSON.stringify(pinned.body)).toBeFalsy()
    expect((await call(surface, key.key, 'tools/call', { name: 'listPins', arguments: {} })).body.result.isError).toBeFalsy()
    const initial = await read()
    expect(initial.body.result.isError, JSON.stringify(initial.body)).toBeFalsy()
    const column = surface === 'brain' ? 'brain_key_id' : 'api_key_id'
    const retained = (await pool.query(`SELECT evidence FROM workspace_mcp_contexts WHERE ${column}=$1`, [key.id])).rows[0]
    expect(JSON.stringify(retained)).toContain('page_live_changed')
    await pool.query("UPDATE saved_views SET clearance='confidential' WHERE id=$1", [page.id])
    expect((await read()).body.result.isError).toBe(true)
    await pool.query("UPDATE saved_views SET clearance='internal' WHERE id=$1", [page.id])
    expect((await read()).body.result.isError).toBe(true)
    const fresh = await issue(surface)
    await pool.query('UPDATE saved_views SET teamspace_id=NULL WHERE id=$1', [page.id])
    const privateRead = await call(surface, fresh.key, 'tools/call', { name: 'getCurrentPage', arguments: { pageId: page.id } })
    expect(privateRead.body.result.isError).toBe(true)
    const privatePin = await call(surface, fresh.key, 'tools/call', { name: 'addPin', arguments: { kind: 'page', refId: page.id } })
    expect(privatePin.body.result.isError).toBe(true)
    expect(JSON.stringify(privatePin.body)).not.toContain('Shared note')
  })
  it.each(['brain', 'assistant'] as const)('%s isolates explicit work contexts, binds handles to the key and restores runtime selection', async surface => {
    const key = await issue(surface)
    const original = await call(surface, key.key, 'tools/call', { name: 'getWorkspaceContext', arguments: {} })
    const created = await call(surface, key.key, 'tools/call', { name: 'createWorkspaceContext', arguments: {} })
    expect(created.body.result.isError, JSON.stringify(created.body)).toBeFalsy()
    const selection = created.body.result.structuredContent.data
    const selectedCall = (name: string, args: object) => call(surface, key.key, 'tools/call', { name, arguments: args, _meta: { 'usebrian.ai/context-id': selection.contextId } })
    const inspected = await selectedCall('getWorkspaceContext', {})
    expect(inspected.body.result.structuredContent.data.contextId).toBe(selection.contextId)
    selection.sessionId = inspected.body.result.structuredContent.data.sessionId
    expect(inspected.body.result.structuredContent.data.openPath).toBe(`/w/${workspace}/chat?v=workspace&s=${selection.sessionId}`)
    expect(selection.sessionId).not.toBe(original.body.result.structuredContent.data.sessionId)
    const activated = await selectedCall('useSkill', { skill: 'fictional-guide' })
    expect(activated.body.result.isError).toBeFalsy()
    const defaultRead = await call(surface, key.key, 'tools/call', { name: 'readSkillResource', arguments: { skill: 'fictional-guide', path: 'references/format.md' } })
    expect(defaultRead.body.result.isError).toBe(true)
    const other = await issue(surface)
    const refused = await call(surface, other.key, 'tools/call', { name: 'getWorkspaceContext', arguments: {}, _meta: { 'usebrian.ai/context-id': selection.contextId } })
    expect(refused.response.status).toBe(500)
    runNative = async (_input, { context }) => {
      expect(context.sessionId).toBe(selection.sessionId)
      return { status: 'succeeded', messageIds: [] }
    }
    const queued = await selectedCall('runBrian', { message: 'Work in this separate context.' })
    const runId = queued.body.result.structuredContent.data.runId
    expect(runId).toBeDefined()
    profile.runWorker!.start(); await profile.runWorker!.tick(); await profile.runWorker!.stop()
    const status = await selectedCall('getBrianRun', { runId })
    expect(status.body.result.structuredContent.data.status).toBe('succeeded')
    expect((await call(surface, key.key, 'tools/call', { name: 'getBrianRun', arguments: { runId } })).body.result.isError).toBe(true)
    expect((await call(surface, key.key, 'tools/call', { name: 'listBrianRuns', arguments: {} })).body.result.structuredContent.data.runs).toEqual([])
    await pool.query('UPDATE workspace_mcp_contexts SET invalidated=true WHERE selection_id=$1', [selection.contextId])
    const recovered = await selectedCall('listBrianRuns', {})
    expect(recovered.body.result.isError, JSON.stringify(recovered.body)).toBeFalsy()
    expect(recovered.body.result.structuredContent.data.runs).toEqual([expect.objectContaining({ runId, status: 'succeeded' })])
    expect((await selectedCall('cancelBrianRun', { runId })).body.result.isError).toBeFalsy()
    expect((await selectedCall('runBrian', { message: 'Do not resume an invalid context.' })).body.result.isError).toBe(true)
  })
  it.each(['brain', 'assistant'] as const)('%s selects an admitted Department while a fixed-context credential cannot leave it', async surface => {
    const key = await issue(surface)
    const created = await call(surface, key.key, 'tools/call', { name: 'createWorkspaceContext', arguments: { groupId: departmentId } })
    expect(created.body.result.isError, JSON.stringify(created.body)).toBeFalsy()
    expect(created.body.result.structuredContent.data.groupId).toBe(departmentId)
    const selection = created.body.result.structuredContent.data.contextId
    const write = await call(surface, key.key, 'tools/call', { name: 'saveMemory', arguments: { summary: `Department selection ${surface}`, scope: 'team' },
      _meta: { 'usebrian.ai/context-id': selection } })
    expect(write.body.result.isError, JSON.stringify(write.body)).toBeFalsy()
    const fixed = await issue(surface, false, { contextGroupId: departmentId })
    expect((await call(surface, fixed.key, 'tools/call', { name: 'createWorkspaceContext', arguments: { groupId: null } })).body.result.isError).toBe(true)
    const otherGroup = await createDbWorkspaceGroupStore().createTeam(actor, workspace, { name: 'Later department', key: `later-${surface}` })
    expect((await call(surface, key.key, 'tools/call', { name: 'createWorkspaceContext', arguments: { groupId: otherGroup.id } })).body.result.isError).toBe(true)
  })
  it.each(['brain', 'assistant'] as const)('%s preserves skill activation across requests without sharing it with another key', async surface => {
    const key = await issue(surface)
    const read = () => call(surface, key.key, 'tools/call', { name: 'readSkillResource', arguments: { skill: 'fictional-guide', path: 'references/format.md' } })
    expect((await read()).body.result.isError).toBe(true)
    const activated = await call(surface, key.key, 'tools/call', { name: 'useSkill', arguments: { skill: 'fictional-guide' } })
    expect(activated.body.result.isError).toBeFalsy()
    expect((await read()).body.result.structuredContent.data.content).toBe('Use a short paragraph.')
    const other = await issue(surface)
    expect((await call(surface, other.key, 'tools/call', { name: 'readSkillResource', arguments: { skill: 'fictional-guide', path: 'references/format.md' } })).body.result.isError).toBe(true)
  })
  it.each(['brain', 'assistant'] as const)('%s runs the native chat assembly under machine authority and retains only durable message references', async surface => {
    runNative = nativeReply
    try {
      const key = await issue(surface, false, { contextGroupId: departmentId })
      const bytes = Buffer.from('Fictional attached report: quarterly output is twelve.')
      const started = await call(surface, key.key, 'tools/call', { name: 'startFileUpload', arguments: {
        fileName: `report-${randomUUID()}.txt`, mime: 'text/plain', sizeBytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') } })
      expect(started.body.result.isError, JSON.stringify(started.body)).toBeFalsy()
      const manifest = started.body.result.structuredContent.data
      for (const part of manifest.parts) transferBytes.set(new URL(part.url).pathname.slice(1), bytes.subarray(part.offset, part.offset + part.sizeBytes))
      const finished = await call(surface, key.key, 'tools/call', { name: 'completeFileUpload', arguments: { uploadId: manifest.uploadId } })
      expect(finished.body.result.isError, JSON.stringify(finished.body)).toBeFalsy()
      const fileId = finished.body.result.structuredContent.data.id
      const queued = await call(surface, key.key, 'tools/call', { name: 'runBrian', arguments: { message: 'test', workspaceFileIds: [fileId] } })
      expect(queued.body.result.structuredContent.data.status).toBe('queued')
      const runId = queued.body.result.structuredContent.data.runId
      profile.runWorker!.start()
      await profile.runWorker!.tick()
      await profile.runWorker!.stop()
      const result = await call(surface, key.key, 'tools/call', { name: 'getBrianRunResult', arguments: { runId } })
      expect(result.body.result, JSON.stringify(result.body)).toMatchObject({ isError: false,
        structuredContent: { data: { status: 'succeeded' } } })
      const replies = result.body.result.structuredContent.data.replies
      expect(replies[0]?.text).toBe('Fictional native reply.')
      const ids = replies.map((reply: { id: string }) => reply.id)
      expect(ids).toHaveLength(1)
      expect((await pool.query(`SELECT s.id FROM sessions s JOIN workspace_mcp_runs r ON r.session_id=s.id WHERE r.id=$1 AND (${sessionKindSql.railRoom('s')})`, [runId])).rowCount).toBe(1)
      const rows = (await pool.query('SELECT role,content,sender_user_id FROM session_messages WHERE session_id=(SELECT session_id FROM session_messages WHERE id=$1) ORDER BY sequence_num', [ids[0]])).rows
      expect(rows.some(row => JSON.stringify(row.content).includes('Fictional native reply.'))).toBe(true)
      expect(rows.filter(row => row.role === 'user').every(row => row.sender_user_id === null)).toBe(true)
      expect(rows.some(row => JSON.stringify(row.content).includes(bytes.toString()))).toBe(true)
      const cached = (await pool.query('SELECT id,source_file_version FROM file_cache WHERE source_file_id=$1', [fileId])).rows
      expect(cached).toHaveLength(1)
      const access = { workspaceId: workspace, userId: actor, assistantId: assistant, assistantKind: 'primary' as const }
      const store = createDbFileStore()
      const attached = await store.get(cached[0].id, access)
      expect(attached?.content).toBe(bytes.toString())
      expect(scopeEvidenceFromRows([attached]).sources).toEqual([expect.objectContaining({ resourceKind: 'workspace_file', resourceId: fileId, version: String(cached[0].source_file_version) })])
      await expect(pool.query('UPDATE file_cache SET source_file_id=NULL,source_file_version=NULL WHERE id=$1', [cached[0].id])).rejects.toThrow('file_cache_source_immutable')
      await pool.query('UPDATE workspace_files SET scope_held=true WHERE id=$1', [fileId])
      expect(await store.get(cached[0].id, access)).toBeNull()
      expect(await store.getOriginalContent!(cached[0].id, access)).toBeNull()
      expect(await getFileCachePreviewProjection(access, cached[0].id)).toBeNull()
      expect((await store.getBySession(attached!.sessionId, access)).map(f => f.id)).not.toContain(cached[0].id)

    } finally { await profile.runWorker!.stop() }
  }, 300_000)
  it.each(['brain','assistant'] as const)('%s records research under the actual machine conversation',async surface=>{
    const key=await issue(surface,false,{contextGroupId:departmentId})
    runNative=nativeReply
    const queued=await call(surface,key.key,'tools/call',{name:'runBrian',arguments:{message:'Research fictional widget suppliers',mode:'research'}})
    expect(queued.body.result.isError,JSON.stringify(queued.body)).toBeFalsy()
    const runId=queued.body.result.structuredContent.data.runId
    profile.runWorker!.start();try{await profile.runWorker!.tick()}finally{await profile.runWorker!.stop()}
    const row=(await pool.query('SELECT session_id,status,result FROM workspace_mcp_runs WHERE id=$1',[runId])).rows[0]
    expect(row.status,JSON.stringify(row)).toBe('succeeded')
    const activity=(await pool.query('SELECT id,status,save_error,actor_user_id,request_message_id FROM research_activities WHERE session_id=$1',[row.session_id])).rows[0]
    expect(activity).toMatchObject({actor_user_id:actor})
    const result=await call(surface,key.key,'tools/call',{name:'getBrianRunResult',arguments:{runId}})
    expect(result.body.result.structuredContent.data.research).toEqual([{activityId:activity.id,status:activity.status,saveError:activity.save_error}])
    expect((await pool.query('SELECT sender_user_id FROM session_messages WHERE id=$1',[activity.request_message_id])).rows[0].sender_user_id).toBeNull()
  },120_000)
  it.each(['brain', 'assistant'] as const)('%s cancels queued work and does not replay a submitted run', async surface => {
    const key = await issue(surface), operationId = randomUUID()
    const params = { name: 'runBrian', arguments: { message: 'Queued fictional work' }, _meta: { 'usebrian.ai/operation-id': operationId } }
    const first = await call(surface, key.key, 'tools/call', params)
    const runId = first.body.result.structuredContent.data.runId
    expect((await call(surface, key.key, 'tools/call', params)).body.result).toEqual(first.body.result)
    expect((await pool.query('SELECT id FROM workspace_mcp_runs WHERE id=$1', [runId])).rowCount).toBe(1)
    const cancelled = await call(surface, key.key, 'tools/call', { name: 'cancelBrianRun', arguments: { runId } })
    expect(cancelled.body.result.structuredContent.data.status).toBe('cancelled')
    runNative = async () => { throw new Error('Cancelled work must not enter the model') }
    profile.runWorker!.start(); await profile.runWorker!.tick(); await profile.runWorker!.stop()
    expect((await pool.query('SELECT status FROM workspace_mcp_runs WHERE id=$1', [runId])).rows[0].status).toBe('cancelled')
  })
  it('keeps inspection and cancellation responsive during a native turn and stops subsequent effects', async () => {
    const key = await issue('brain')
    let enter!: () => void, release!: () => void
    const entered = new Promise<void>(resolve => { enter = resolve }), paused = new Promise<void>(resolve => { release = resolve })
    let effect = false
    runNative = async (_input, { context }) => {
      enter(); await paused; await context.authority!.assertCurrent(); effect = true
      return { status: 'failed', messageIds: [] }
    }
    const queued = await call('brain', key.key, 'tools/call', { name: 'runBrian', arguments: { message: 'Paused fictional work' } })
    const runId = queued.body.result.structuredContent.data.runId
    profile.runWorker!.start()
    const pending = profile.runWorker!.tick()
    try {
      await entered
      const status = await call('brain', key.key, 'tools/call', { name: 'getBrianRun', arguments: { runId } })
      expect(status.body.result.structuredContent.data.status).toBe('running')
      const cancel = await call('brain', key.key, 'tools/call', { name: 'cancelBrianRun', arguments: { runId } })
      expect(cancel.body.result.structuredContent.data.cancelRequested).toBe(true)
    } finally { release(); await pending; await profile.runWorker!.stop() }
    expect(effect).toBe(false)
    expect((await pool.query('SELECT status FROM workspace_mcp_runs WHERE id=$1', [runId])).rows[0].status).toBe('uncertain')
  })
  it.each(['brain', 'assistant'] as const)('%s binds a runtime tool review to its run and continues without replaying the action', async surface => {
    const key = await issue(surface), summary = `Fictional run review ${surface}`
    await call(surface, key.key, 'tools/call', { name: 'saveMemory', arguments: { summary, scope: 'team' } })
    const memory = (await pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND summary=$2', [workspace, summary])).rows[0].id
    runNative = async (_input, { context }) => {
      const approvalId = await context.createToolInvocationApproval!({ toolName: 'deleteMemory', toolInput: { ids: [memory] },
        description: 'Delete the fictional record', displayLines: [], expiresAt: new Date(Date.now() + 10 * 60_000) })
      return { status: 'waiting_approval', messageIds: [], approvalIds: [approvalId] }
    }
    const queued = await call(surface, key.key, 'tools/call', { name: 'runBrian', arguments: { message: 'Remove the fictional record' } })
    const runId = queued.body.result.structuredContent.data.runId
    profile.runWorker!.start(); await profile.runWorker!.tick(); await profile.runWorker!.stop()
    const status = await call(surface, key.key, 'tools/call', { name: 'getBrianRun', arguments: { runId } })
    expect(status.body.result.structuredContent.data.status).toBe('waiting_approval')
    const approvalId = status.body.result.structuredContent.data.approvalIds[0]
    const early = await call(surface, key.key, 'tools/call', { name: 'continueBrianRun', arguments: { runId } })
    expect(early.body.result.structuredContent.data.code).toBe('review_not_complete')
    const review = await request(app).post(`/approvals/${approvalId}/respond`).auth(bearer, { type: 'bearer' }).send({ decision: 'approved' })
    expect(review.status, review.text).toBe(200)
    expect((await pool.query('SELECT id FROM memories WHERE id=$1', [memory])).rowCount).toBe(0)
    runNative = nativeReply
    if (surface === 'brain') {
      const continued = await call(surface, key.key, 'tools/call', { name: 'continueBrianRun', arguments: { runId } })
      expect(continued.body.result.structuredContent.data.status).toBe('queued')
    } // Assistant case proves the native human review wakes the run automatically.
    profile.runWorker!.start(); await profile.runWorker!.tick(); await profile.runWorker!.stop()
    const final = await call(surface, key.key, 'tools/call', { name: 'getBrianRunResult', arguments: { runId } })
    expect(final.body.result.structuredContent.data).toMatchObject({ status: 'succeeded', replies: [{ text: 'Fictional native reply.' }] })
    expect((await pool.query('SELECT count(*)::int AS count FROM workspace_mcp_operations WHERE run_id=$1', [runId])).rows[0].count).toBe(1)
    await pool.query("UPDATE pending_approvals SET expires_at=now()-interval '1 second' WHERE id=$1",[approvalId])
    const repeated = await request(app).post(`/approvals/${approvalId}/respond`).auth(bearer, { type: 'bearer' }).send({ decision: 'approved' })
    expect(repeated.status, repeated.text).toBe(200)

  }, 120_000)
  it.each(['brain', 'assistant'] as const)('%s answers an ordinary native question without fabricating a human decision', async surface => {
    const key = await issue(surface)
    runNative = async (_input, { context }) => {
      const questionId = await context.createPendingQuestion!({ question: 'Which fictional format?', toolUseId: randomUUID(),
        options: ['Text', 'Table'], expiresAt: new Date(Date.now() + 10 * 60_000) })
      return { status: 'waiting_input', messageIds: [], questionIds: [questionId] }
    }
    const queued = await call(surface, key.key, 'tools/call', { name: 'runBrian', arguments: { message: 'Prepare a fictional summary' } })
    const runId = queued.body.result.structuredContent.data.runId
    profile.runWorker!.start(); await profile.runWorker!.tick(); await profile.runWorker!.stop()
    const pending = await call(surface, key.key, 'tools/call', { name: 'getBrianRunResult', arguments: { runId } })
    expect(pending.body.result.structuredContent.data).toMatchObject({ status: 'waiting_input', questions: [{ question: 'Which fictional format?' }] })
    const questionId = pending.body.result.structuredContent.data.questions[0].questionId
    const answered = await call(surface, key.key, 'tools/call', { name: 'continueBrianRun', arguments: { runId, answer: 'Text' } })
    expect(answered.body.result.structuredContent.data.status).toBe('queued')
    const row = (await pool.query('SELECT answer_text,responded_by,resolution_origin FROM pending_approvals WHERE id=$1', [questionId])).rows[0]
    expect(row).toEqual({ answer_text: 'Text', responded_by: null, resolution_origin: 'system' })
    runNative = nativeReply
    profile.runWorker!.start(); await profile.runWorker!.tick(); await profile.runWorker!.stop()
    const final = await call(surface, key.key, 'tools/call', { name: 'getBrianRunResult', arguments: { runId } })
    expect(final.body.result, JSON.stringify(final.body)).toMatchObject({ isError: false, structuredContent: { data: { status: 'succeeded' } } })
  }, 120_000)
  it('does not replay a crashed claimed run or start queued work after revocation', async () => {
    for (const interrupted of [true, false]) {
      const key = await issue('brain')
      const queued = await call('brain', key.key, 'tools/call', { name: 'runBrian', arguments: { message: 'Fictional recovery probe' } })
      const runId = queued.body.result.structuredContent.data.runId
      let entered = false
      runNative = async () => { entered = true; return { status: 'failed', messageIds: [] } }
      if (interrupted) await pool.query("UPDATE workspace_mcp_runs SET status='running',claim_token=gen_random_uuid(),heartbeat_at=now()-interval '3 minutes' WHERE id=$1", [runId])
      else await brainStore.revoke(actor, key.id)
      profile.runWorker!.start(); await profile.runWorker!.tick(); await profile.runWorker!.stop()
      expect(entered).toBe(false)
      expect((await pool.query('SELECT status FROM workspace_mcp_runs WHERE id=$1', [runId])).rows[0].status).toBe(interrupted ? 'uncertain' : 'failed')
    }
  })
  it.each(['brain', 'assistant'] as const)('%s prepares a native review and applies exactly once under its original parent', async surface => {
    const key = await issue(surface), summary = `Fictional reviewed ${surface} record`
    await call(surface, key.key, 'tools/call', { name: 'saveMemory', arguments: { summary, scope: 'team' } })
    const memory = (await pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND summary=$2', [workspace, summary])).rows[0].id
    const operationId = randomUUID()
    const parked = await call(surface, key.key, 'tools/call', { name: 'deleteMemory', arguments: { ids: [memory] },
      _meta: { 'usebrian.ai/operation-id': operationId } })
    expect(parked.body.result.structuredContent).toMatchObject({ status: 'waiting_approval', operationId })
    const approvalId = parked.body.result.structuredContent.approvalId
    const approval = await approvalsStore.getById(actor, approvalId)
    expect(approval).toMatchObject({ approverUserId: actor, originatingAssistantId: assistant, status: 'pending' })
    expect(approval?.blockingSessionId).toBeTruthy()
    const before = (await pool.query('SELECT valid_to FROM memories WHERE id=$1', [memory])).rows[0]
    expect(before.valid_to).toBeNull()
    const result = await request(app).post(`/approvals/${approvalId}/respond`).auth(bearer, { type: 'bearer' }).send({ decision: 'approved' })
    expect(result.status, result.text).toBe(200)
    expect(result.body.result).toMatchObject({ status: 'succeeded', operationId })
    expect((await pool.query('SELECT id FROM memories WHERE id=$1', [memory])).rowCount).toBe(0)
    const duplicate = await request(app).post(`/approvals/${approvalId}/respond`).auth(bearer, { type: 'bearer' }).send({ decision: 'approved' })
    expect(duplicate.body.result).toEqual(result.body.result)
    expect((await pool.query('SELECT id FROM memories WHERE id=$1', [memory])).rowCount).toBe(0)
  })
  it.each(['brain', 'assistant'] as const)('%s refuses a reviewed action after parent revocation', async surface => {
    const key = await issue(surface), summary = `Fictional revoked review ${surface}`
    await call(surface, key.key, 'tools/call', { name: 'saveMemory', arguments: { summary, scope: 'team' } })
    const memory = (await pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND summary=$2', [workspace, summary])).rows[0].id
    const parked = await call(surface, key.key, 'tools/call', { name: 'deleteMemory', arguments: { ids: [memory] } })
    expect(parked.body.result.structuredContent.status).toBe('waiting_approval')
    await (surface === 'brain' ? brainStore.revoke(actor, key.id) : apiStore.revokeForUser(actor, key.id))
    const result = await request(app).post(`/approvals/${parked.body.result.structuredContent.approvalId}/respond`)
      .auth(bearer, { type: 'bearer' }).send({ decision: 'approved' })
    expect(result.status, result.text).toBe(409)
    expect(result.body.result.code).toBe('approval_parent_unavailable')
    expect((await pool.query('SELECT valid_to FROM memories WHERE id=$1', [memory])).rows[0].valid_to).toBeNull()
  })
  it.each(['brain', 'assistant'] as const)('%s performs the native write without configure and rejects revocation', async surface => {
    const key = await issue(surface)
    expect(key.workspaceMcpConsent.operationNames).toContain('saveMemory')
    const summary = `Fictional ${surface} parity record`
    const result = await call(surface, key.key, 'tools/call', { name: 'saveMemory', arguments: { summary, scope: 'team' } })
    expect(result.response.status, result.response.text).toBe(200)
    expect(result.body.result, JSON.stringify(result.body)).toMatchObject({ isError: false, structuredContent: { status: 'succeeded' } })
    const rows = await pool.query('SELECT id,user_id,created_by_user_id,source_session_id FROM memories WHERE workspace_id=$1 AND summary=$2', [workspace, summary])
    expect(rows.rows).toHaveLength(1)
    expect(rows.rows[0]).toMatchObject({ user_id: null, created_by_user_id: actor })
    const origin = await pool.query('SELECT channel_type,user_id,visibility FROM sessions WHERE id=$1', [rows.rows[0].source_session_id])
    expect(origin.rows[0]).toMatchObject({ user_id: actor, visibility: 'workspace',
      channel_type: surface === 'brain' ? 'programmatic' : 'assistant_mcp' })
    const read = await call(surface, key.key, 'tools/call', { name: 'getMemory', arguments: { id: rows.rows[0].id } })
    expect(JSON.stringify(read.body)).toContain(summary)
    await (surface === 'brain' ? brainStore.revoke(actor, key.id) : apiStore.revokeForUser(actor, key.id))
    expect((await call(surface, key.key, 'tools/list', {})).response.status).toBeGreaterThanOrEqual(400)
  })
  it.each(['brain', 'assistant'] as const)('%s returns the durable receipt on retry and rejects changed arguments', async surface => {
    const key = await issue(surface), operationId = randomUUID(), summary = `Fictional idempotent ${surface} record`
    const params = { name: 'saveMemory', arguments: { summary, scope: 'team' }, _meta: { 'usebrian.ai/operation-id': operationId } }
    const first = await call(surface, key.key, 'tools/call', params)
    expect(first.body.result.structuredContent).toMatchObject({ status: 'succeeded', operationId })
    expect((await call(surface, key.key, 'tools/call', params)).body.result).toEqual(first.body.result)
    expect((await pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND summary=$2', [workspace, summary])).rowCount).toBe(1)
    const conflict = await call(surface, key.key, 'tools/call', { ...params, arguments: { summary: 'Changed arguments', scope: 'team' } })
    expect(conflict.body.result.structuredContent.code).toBe('operation_id_conflict')
    const receipt = await call(surface, key.key, 'tools/call', { name: 'getWorkspaceOperation', arguments: { operationId } })
    expect(receipt.body.result.structuredContent.data).toMatchObject({ operationId, status: 'succeeded' })
    const other = await issue(surface)
    expect((await call(surface, other.key, 'tools/call', { name: 'getWorkspaceOperation', arguments: { operationId } })).body.result.isError).toBe(true)
  })
  it('retains source restrictions across requests and does not revive an invalid context', async () => {
    const key = await issue('brain'), summary = 'Fictional retained source record'
    expect((await call('brain', key.key, 'tools/call', { name: 'saveMemory', arguments: { summary, scope: 'team' } })).body.result.isError).toBe(false)
    const row = (await pool.query('SELECT id FROM memories WHERE workspace_id=$1 AND summary=$2', [workspace, summary])).rows[0]
    expect((await call('brain', key.key, 'tools/call', { name: 'getMemory', arguments: { id: row.id } })).body.result.isError).toBe(false)
    await pool.query("UPDATE memories SET sensitivity='confidential' WHERE id=$1", [row.id])
    const write = { name: 'saveMemory', arguments: { summary: 'Must remain unsaved', scope: 'team' } }
    expect((await call('brain', key.key, 'tools/call', write)).body.result.structuredContent.code).toBe('context_unavailable')
    await pool.query("UPDATE memories SET sensitivity='internal' WHERE id=$1", [row.id])
    expect((await call('brain', key.key, 'tools/call', write)).body.result.structuredContent.code).toBe('context_unavailable')
    expect((await pool.query("SELECT id FROM memories WHERE workspace_id=$1 AND summary='Must remain unsaved'", [workspace])).rowCount).toBe(0)
    const fresh = await call('brain', key.key, 'tools/call', { name: 'createWorkspaceContext', arguments: {} })
    expect(fresh.body.result.isError).toBeFalsy()
    const newWork = await call('brain', key.key, 'tools/call', { name: 'saveMemory', arguments: { summary: 'Independent fresh work', scope: 'team' },
      _meta: { 'usebrian.ai/context-id': fresh.body.result.structuredContent.data.contextId } })
    expect(newWork.body.result.isError).toBeFalsy()
    expect((await call('brain', key.key, 'tools/call', write)).body.result.structuredContent.code).toBe('context_unavailable')

  })
  it('cannot turn a machine key receipt into an authenticated human Chat session', async () => {
    const key = await issue('brain')
    await expect(findOrCreateWorkspaceMcpSession({ assistantId: assistant, userId: actor, workspaceId: workspace,
      channelType: 'web', channelId: randomUUID(), appOrigin: 'chat', visibility: 'workspace',
      effectiveClearance: 'internal', contextCompartments: [] }, { kind: 'brain_key', id: key.id }))
      .rejects.toThrow('workspace_mcp_session_unavailable')
  })

  it('keeps read-only consent finite when another operation is registered', async () => {
    const key = await issue('brain', true)
    tools.set('laterOperation', buildTool({ name: 'laterOperation', description: 'Added after consent', inputSchema: z.object({}), isReadOnly: true,
      execute: async () => ({ data: 'not consented' }) }))
    const listed = await call('brain', key.key, 'tools/list', {})
    const names = listed.body.result.tools.map((tool: { name: string }) => tool.name)
    expect(names).toContain('getMemory'); expect(names).not.toContain('saveMemory'); expect(names).not.toContain('laterOperation')
    expect((await call('brain', key.key, 'tools/call', { name: 'saveMemory', arguments: { summary: 'Must not exist' } })).body.result.isError).toBe(true)
    await brainStore.revoke(actor, key.id)
  })
  it.each(['brain', 'assistant'] as const)('%s rejects consent changes and resurrection at the SQL boundary', async surface => {
    const key = await issue(surface), table = surface === 'brain' ? 'brain_keys' : 'api_keys'
    for (const change of ["workspace_mcp_consent=NULL", "workspace_mcp_consent=jsonb_set(workspace_mcp_consent,'{operationNames}','[\"invented\"]')"]) {
      await expect(queryWithRLS(actor, `UPDATE ${table} SET ${change} WHERE id=$1`, [key.id])).rejects.toThrow('workspace_mcp_consent_immutable')
    }
    await (surface === 'brain' ? brainStore.revoke(actor, key.id) : apiStore.revokeForUser(actor, key.id))
    await expect(queryWithRLS(actor, `UPDATE ${table} SET status='active' WHERE id=$1`, [key.id])).rejects.toThrow('external_key_resume_unsupported')
  })
})
