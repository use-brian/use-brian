import {z} from 'zod'
import {createMcpInputSchema,mcpArgumentError} from '@use-brian/agent-runtime/mcp/input-schema.js'
import {buildTool,type ToolContext} from '@use-brian/agent-runtime/tools/types.js'
import type {McpServerConfig,McpSettingsStore} from '@use-brian/agent-runtime/mcp/types.js'
import {wrapMcpTools} from '@use-brian/core/mcp/connector.js'
import {createMcpGateway} from '@use-brian/core/mcp/gateway.js'
import express from 'express'
import {afterAll,describe,expect,it,vi} from 'vitest'
import {ContextScopeAccumulator} from '@use-brian/agent-runtime/security/context-scope.js'
import {boundScopeSources} from '@use-brian/agent-runtime/security/source-evidence.js'
import {createExecutionContext,executionToolContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {createConfirmationResolver} from '@use-brian/agent-runtime/mcp/types.js'
import {queryLoop,type QueryEvent} from '@use-brian/agent-runtime/engine/query-loop.js'
import {NOOP_TURN_LEDGER} from '@use-brian/agent-runtime/engine/turn-ledger.js'
import {sanitize} from '@use-brian/core/analytics/logger.js'
import type {LLMProvider,Message,StreamChunk} from '@use-brian/agent-runtime/providers/types.js'
import {createMcpSearchTools,buildToolIndex} from '@use-brian/core/mcp/tool-search.js'
import {requireAuth} from '../../auth/middleware.js'
import {createTokens} from '../../auth/jwt.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbAnalyticsStore} from '../../db/analytics-store.js'
import {readAdmittedSessionQuery} from '../../db/conversation-store.js'
import {openAssistantTurn,type AssistantTurn} from '../../turn/kernel.js'
import {policyFor} from '../../session-kind.js'
import {admitModelSourceEvidence} from '../model-source-authority.js'
import {createProjectHarnessTools} from '../../project-harness/tools.js'
import {sessionRoutes} from '../../routes/sessions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const usage={inputTokens:1,outputTokens:1}
const obj=(properties:Record<string,unknown>,required:string[]=[])=>({type:'object',properties,additionalProperties:false,...(required.length?{required}:{})})
const str={type:'string'},strings={type:'array',items:str}
const wire=obj({prompt:str,cwd:str,context:obj({summary:str,project:str,product:str,verification:str,constraints:strings,references:strings,
 conversation:{type:'array',items:obj({role:{type:'string',enum:['system','developer','user','assistant','tool']},content:str},['role','content'])}})},['prompt','context'])
async function canonicalArguments(){
 const id=(n:number)=>`52000000-0000-4000-8000-${String(n).padStart(12,'0')}`
 const workspaceId=id(1),projectId=id(2),userId=id(3),productId=id(4),componentId=id(5),now='2026-01-01T00:00:00Z'
 const node=(nid:string,name:string)=>({id:nid,name,description:null,workspaceId,projectId,revision:1,status:'active' as const,createdAt:now,updatedAt:now})
 const scope={kind:'component' as const,productId,componentId}
 const snapshot={tree:{products:[node(productId,'Synthetic Product')],components:[{...node(componentId,'Synthetic Landing'),productId}]},revisions:[
  {id:id(10),workspaceId,projectId,scope:{kind:'project' as const},revision:1,createdAt:now,createdBy:userId,
   definition:{schemaVersion:1 as const,rules:[],codeChecks:[{key:'unit',kind:'unit' as const,instructions:'Run synthetic checks',command:'node --test'}],acceptanceScenarios:[]}}]}
 const tool=createProjectHarnessTools({store:{} as never,execution:{} as never,snapshot:vi.fn().mockResolvedValue(snapshot)}).find(t=>t.name==='prepareProjectHarnessTask')!
 const authority={assertCurrent:async()=>{},execute:async<T>(work:()=>Promise<T>)=>work()}
 const execution=createExecutionContext({
  identity:{kind:'attended',principal:{kind:'workspace_member',userId,authenticationKind:'native_session'}},
  ownership:{kind:'workspace',workspaceId},
  access:{userId,workspaceId,assistantId:id(6),assistantKind:'standard',clearance:'internal',
   compartments:[`project:${projectId}`],mutationCompartments:[],projectIds:[projectId],visibilityAssistantIds:[id(6)]},
  authority,writeDefaults:{compartments:[],projectIds:[projectId]},
  lifecycle:{sessionId:id(7),channelType:'web',channelId:'fixture',abortSignal:new AbortController().signal}})
 const context={...executionToolContext(execution,{appId:'synthetic-preparation'}),activeProjectId:projectId,scopeAccumulator:new ContextScopeAccumulator()}
 const result=await tool.execute({prompt:'Synthetic static page; no real coding task.',runtimeProject:'synthetic',scope,scopes:[scope]},context)
 expect(result.isError).not.toBe(true)
 const prepared=result.data as {status:string;arguments:Record<string,unknown>}
 expect(prepared.status).toBe('prepared')
 return prepared.arguments
}
function call(args:Record<string,unknown>,id:string):StreamChunk[]{return[
 {type:'message_start',model:'fixture'}, {type:'tool_use_start',id,name:'mcp_call'},
 {type:'tool_use_delta',id,input:JSON.stringify({server:'synthetic',tool:'new_task_with_context',args})},
 {type:'tool_use_end',id}, {type:'message_end',stopReason:'tool_use',usage},
]}
const terminal:StreamChunk[]=[{type:'message_start',model:'fixture'},{type:'text_delta',text:'Synthetic handoff test finished.'},{type:'message_end',stopReason:'end_turn',usage}]
function provider(scripts:StreamChunk[][]){
 let turn=0;const inputs:Message[][]=[]
 const stream=(messages:Message[])=>{inputs.push(structuredClone(messages));const chunks=scripts[turn++];if(!chunks)throw new Error('Unexpected provider turn');return(async function*(){yield* chunks})()}
 return{inputs,driver:{name:'synthetic',models:['fixture'],stream:(request)=>stream(request.messages),createSession:()=>({send:stream})} satisfies LLMProvider}
}
async function listen(app:ReturnType<typeof express>){
 const server=app.listen(0,'127.0.0.1')
 await new Promise<void>((resolve,reject)=>{server.once('listening',resolve);server.once('error',reject)})
 const address=server.address();if(!address||typeof address==='string')throw new Error('Expected loopback listener')
 return{url:`http://127.0.0.1:${address.port}`,close:()=>new Promise<void>((resolve,reject)=>server.close(error=>error?reject(error):resolve()))}
}

describe.sequential('[COMP:api/application-persistence] rejected inputs never become executable history',()=>{
 afterAll(async()=>{await getAppPool().end();await getPool().end()})
 it.each(['deny','allow','malformed-deny'] as const)('persists rejected input/analytics, forwards exact canonical arguments only after mock %s and reloads through HTTP',async decision=>{
  const f=await persistentContextFixture(),requests:unknown[]=[]
  const mcp=express();mcp.use(express.json());mcp.post('/synthetic', (req,res)=>{requests.push(req.body);res.json({synthetic:true,noCodingTask:true})})
  const transport=await listen(mcp)
  let reader:Awaited<ReturnType<typeof listen>>|undefined,owner:AssistantTurn|undefined
  try{
   await f.history()
   owner=await openAssistantTurn({sessionId:f.session.id,assistantId:f.assistantId,policy:policyFor(f.session),abortController:new AbortController()})
   const authority=await f.modelContext(f.firstId)
   const captured=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:3,authority}),sources=boundScopeSources(captured)
   expect((await getAppPool().query('SHOW statement_timeout')).rows[0].statement_timeout).toBe('15s')
   const canonical=await canonicalArguments(),invalid={...canonical,['\0unexpected']:null}
   const raw=decision==='malformed-deny'?'{"server":"synthetic","tool":"new_task_with_context","args":':JSON.stringify({server:'synthetic',tool:'new_task_with_context',args:invalid})
   const dispatch=vi.fn(async(_server:string,_name:string,args:Record<string,unknown>)=>{
    const response=await fetch(transport.url+'/synthetic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(args)})
    return response.json()
   })
   const server={name:'synthetic',url:transport.url,tools:[{name:'new_task_with_context',description:'Synthetic handoff; never starts a coding agent',inputSchema:wire}]}
   const settingsStore={getPolicy:vi.fn(async()=>({id:'synthetic-policy',assistantId:f.assistantId,userId:f.firstId,serverName:'synthetic',toolName:'new_task_with_context',policy:'ask' as const,classification:'write' as const,timesAllowed:0,timesDenied:0})),setPolicy:vi.fn(),recordUsage:vi.fn(),recordUsageAndGetCount:vi.fn(async()=>({timesAllowed:0,timesDenied:0}))}
   const tools=createMcpSearchTools({settingsStore,assistantId:f.assistantId,userId:f.firstId,index:buildToolIndex([{kind:'remote',server,serverUrl:server.url,callMcpTool:dispatch}])})
   const first=call(invalid,'rejected-1')
   first[2]={type:'tool_use_delta',id:'rejected-1',input:raw}
   const scripted=provider([first,call(canonical,'valid-2'),terminal]),events:QueryEvent[]=[]
   authority.accumulator.note({sources})
   const resolver=createConfirmationResolver(),evidenceBefore=structuredClone(authority.accumulator.evidence)
   let confirmations=0
   for await(const event of queryLoop({provider:scripted.driver,model:'fixture',systemPrompt:'Synthetic integration fixture only.',messages:[{role:'user',content:'Use fresh canonical arguments.'}],
    tools:new Map(tools.map(t=>[t.name,t])),context:{...executionToolContext(authority.execution,{appId:'fixture:nul-history'}),scopeAccumulator:authority.accumulator,
     admitModelInput:current=>admitModelSourceEvidence(current,'context'),admitModelOutput:current=>admitModelSourceEvidence(current,'context')},
    stateless:true,maxTurns:3,ledger:NOOP_TURN_LEDGER,confirmationResolver:resolver,confirmationTimeoutMs:2000})){
    events.push(event)
    if(event.type==='tool_confirmation_required'){
     confirmations++;expect(event.request.input).toEqual(canonical)
     resolver.resolve(event.request.toolCallId,decision==='allow'?'allow':'deny')
    }
   }
   expect(confirmations).toBe(1);expect(dispatch).toHaveBeenCalledTimes(decision==='allow'?1:0)
   expect(requests).toEqual(decision==='allow'?[canonical]:[])
   expect(authority.accumulator.evidence).toEqual(evidenceBefore)
   const turns=events.filter(event=>event.type==='assistant_turn')
   expect(turns).toHaveLength(3)
   const rejection=turns[0].response.content.find(block=>block.type==='text'&&block.text.startsWith('Rejected tool call'))
   if(rejection?.type!=='text')throw new Error('Missing lossless rejected-call record')
   expect(JSON.parse(rejection.text.split('\n').slice(1).join('\n')).rawArgumentsJson).toBe(raw)
   const messages=turns.flatMap(turn=>[
    {role:'assistant' as const,content:turn.response.content},...(turn.toolResults.length?[{role:'user' as const,content:turn.toolResults}]:[]),
   ])
   const saved=await owner.publish({disposition:'reply',rows:messages,native:authority,
    write:{derivationTarget:f.envelope,derivation:{producer:'fixture:rejected-history',sources}},
    execute:operation=>authority.execution.security.authority.execute(operation)})
   await owner.finish();owner=undefined
   expect(saved).toHaveLength(5)
   const analytics=createDbAnalyticsStore()
   await analytics.recordBatch(events.map(event=>({userId:f.firstId,actorUserId:f.firstId,assistantId:f.assistantId,sessionId:f.session.id,eventName:'fixture_nul_'+event.type,
    metadata:{event_type:sanitize(event.type),diagnostic:sanitize(event.type==='tool_input'?JSON.stringify(event.input):event.type==='tool_result'
      ?event.results.map(block=>block.type==='tool_result'?block.content:block.type==='text'?block.text:'').join('\n'):'')},channelType:'web',appId:'fixture:nul-history'})))
   expect((await f.pool.query('SELECT count(*)::integer n FROM analytics_events WHERE session_id=$1',[f.session.id])).rows[0].n).toBe(events.length)
   const fresh=await f.modelContext(f.firstId),reloaded=await readAdmittedSessionQuery({sessionId:f.session.id,throughSequence:8,authority:fresh})
   expect(reloaded.history).toHaveLength(8)
   const replay=JSON.parse(JSON.stringify(reloaded.history.flatMap(row=>typeof row.content==='string'?[]:row.content))) as Array<{type:string;id?:string;toolUseId?:string}>
   expect(replay.some(block=>block.type==='tool_use'&&block.id==='rejected-1')).toBe(false)
   expect(replay.some(block=>block.type==='tool_result'&&block.toolUseId==='rejected-1')).toBe(false)
   const replayModel=provider([terminal])
   for await(const _event of queryLoop({provider:replayModel.driver,model:'fixture',systemPrompt:'Synthetic reload.',messages:reloaded.history.map(row=>{const content=row.content;if(typeof content!=='string'&&!Array.isArray(content))throw new Error('Invalid history content');return{role:row.role as 'user'|'assistant',content}}),
    tools:new Map(tools.map(t=>[t.name,t])),context:executionToolContext(fresh.execution,{appId:'fixture:nul-reload'}),stateless:true,maxTurns:1,ledger:NOOP_TURN_LEDGER})){}
   expect(dispatch).toHaveBeenCalledTimes(decision==='allow'?1:0)
   const secret='fictional-rejected-history-secret',device=(await authSessionStore.create(f.firstId,{deviceLabel:'Synthetic reload browser',userAgent:null,ipAddress:null}))!
   const app=express();app.use('/sessions',requireAuth(secret),sessionRoutes());reader=await listen(app)
   const response=await fetch(reader.url+`/sessions/${f.session.id}/messages`,{headers:{Authorization:`Bearer ${createTokens(f.firstId,secret,device).accessToken}`}})
   expect(response.status).toBe(200)
   const body:unknown=await response.json();expect(Array.isArray(body)).toBe(true)
   expect(JSON.stringify(body)).toContain('rejected_tool_call')
   for(const table of ['native_turn_publication_work','native_turn_publication_events','native_turn_publication_seals','native_turn_publication_debt'])
    expect((await f.pool.query(`SELECT count(*)::integer n FROM ${table}`)).rows[0].n,table).toBe(0)
  }finally{await owner?.finish('failed');await reader?.close();await transport.close();await f.pool.query('DELETE FROM analytics_events WHERE session_id=$1',[f.session.id]);await f.cleanup()}
 },60_000)
})

// Core adapters remain tested at the host layer, never a runtime-to-core dependency.
describe('MCP adapter diagnostic parity', () => {
const settingsStore: McpSettingsStore = {
  getPolicy: async () => null,
  setPolicy: async () => {},
  recordUsage: async () => {},
  recordUsageAndGetCount: async () => ({ timesAllowed: 0, timesDenied: 0 }),
}
const params = { settingsStore, assistantId: 'a1', userId: 'u1' }
const context = {
  assistantId: 'a1', userId: 'u1', sessionId: 's1', appId: 'Use Brian',
  channelType: 'web', channelId: 'c1', abortSignal: new AbortController().signal,
} as ToolContext
const nestedKey = 'options\0/~'
const missingKey = 'required\0'
const extraKey = 'extra\0\udfff'
const schema = {
  type: 'object',
  properties: {
    [nestedKey]: {
      type: 'object', properties: { [missingKey]: { type: 'string' } },
      required: [missingKey], additionalProperties: false,
    },
  },
  additionalProperties: false,
}
const args = Object.freeze({
  [nestedKey]: Object.freeze({ [extraKey]: 'untouched\0\ud800', 'literal\\u0000': true }),
  [extraKey]: Object.freeze(['value\0']),
})
function diagnostic(tool: string, inputSchema: z.ZodTypeAny = createMcpInputSchema(schema), input: unknown = args) {
  const parsed = inputSchema.safeParse(input)
  if (parsed.success) throw new Error('Expected validation failure')
  return mcpArgumentError(tool, parsed.error)
}

function expectSafe(text: unknown) {
  expect(typeof text).toBe('string')
  expect(text).not.toMatch(/[\u0000-\u001f\u007f-\u009f\ud800-\udfff]/u)
}

  it('uses the same formatter for remote dispatch, direct wrappers and the gateway', async () => {
    const dispatch = vi.fn(async () => ({}))
    const server: McpServerConfig = {
      name: 'external', url: 'https://example.invalid/mcp',
      tools: [{ name: 'get_item', description: 'Get an item', inputSchema: schema }],
    }
    const before = JSON.stringify(args)
    const [, call] = createMcpSearchTools({ ...params,
      index: buildToolIndex([{ kind: 'remote', server, serverUrl: server.url, callMcpTool: dispatch }]),
    })
    const [direct] = wrapMcpTools({ ...params, server, callMcpTool: dispatch })
    const gateway = createMcpGateway({ ...params, server, callMcpTool: dispatch })
    const results = [
      await call.execute({ server: server.name, tool: 'get_item', args }, context),
      await direct.execute(args, context),
      await gateway.execute({ action: 'call', tool_name: 'get_item', args }, context),
    ]
    for (const result of results) {
      expect(result.isError).toBe(true)
      expect(result.data).toBe(diagnostic('get_item'))
      expectSafe(result.data)
    }
    expect(JSON.stringify(args)).toBe(before)
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('refuses local invalid arguments before resolving confirmation or executing transport', async () => {
    const execute = vi.fn(async () => ({ data: 'should not run' }))
    const resolveConfirmation = vi.fn(async () => true)
    const describeConfirmation = vi.fn(async () => ['should not run'])
    const notify = vi.fn()
    const inputSchema = z.object({ value: z.string() }).superRefine((_, ctx) => {
      ctx.addIssue({ code: 'custom', path: ['nested\0\ud800'], message: 'bad\0\n\udfff' })
    })
    const input = Object.freeze({ value: 'exact\0\ud800' })
    const tool = buildTool({ name: 'create_item', description: 'Create item', inputSchema,
      requiresConfirmation: true, resolveConfirmation, describeConfirmation, execute })
    const [, call] = createMcpSearchTools({ ...params,
      index: buildToolIndex([{ kind: 'local', serverName: 'local', tools: [tool] }]),
    })
    const result = await call.execute({ server: 'local', tool: tool.name, args: input },
      { ...context, notifyConfirmationRequired: notify })
    expect(result.isError).toBe(true)
    expect(result.data).toBe(diagnostic(tool.name, inputSchema, input))
    expectSafe(result.data)
    expect(input).toEqual({ value: 'exact\0\ud800' })
    expect(resolveConfirmation).not.toHaveBeenCalled()
    expect(describeConfirmation).not.toHaveBeenCalled()
    expect(notify).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })
})
