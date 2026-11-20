import {EventEmitter} from 'node:events'
import express from 'express'
import request from 'supertest'
import {beforeEach, describe, expect, it, vi} from 'vitest'
import {z} from 'zod'

const mocks = vi.hoisted(() => ({
  assistant:vi.fn(), session:vi.fn(), freshSession:vi.fn(), query:vi.fn(), add:vi.fn(), history:vi.fn(), truncate:vi.fn(),
  claim:vi.fn(), touch:vi.fn(), release:vi.fn(), wait:vi.fn(), accrue:vi.fn(), resolve:vi.fn(), custom:vi.fn(),
  inject:vi.fn(), compact:vi.fn(), usage:vi.fn(), audience:vi.fn(), capabilities:vi.fn(),
}))
vi.mock('../../db/client.js', () => ({query:mocks.query,queryWithRLS:mocks.query,
  runWithAgentAccess:(_access:unknown,run:()=>unknown)=>run(),currentAgentAccess:()=>undefined}))
vi.mock('../../db/users.js', () => ({findAssistantById:mocks.assistant,
  findUserById:async () => ({id:'public-payer',timezone:'UTC'}),findUserByEmail:vi.fn(),findUserByAuthProvider:vi.fn()}))
vi.mock('../../db/workspace-store.js', () => ({getWorkspacePlan:async () => 'free',
  getConnectorUserId:async () => 'public-payer',getWorkspaceMembershipSystem:async () => ({role:'member'})}))
vi.mock('../../billing-party.js', () => ({billingPartyForAssistant:async () => 'public-payer'}))
vi.mock('../../db/external-principal.js', () => ({isExternalPrincipal:() => true}))
vi.mock('../client-principal-runtime.js', async original => ({
  ...await original<typeof import('../client-principal-runtime.js')>(),
  resolveExternalClientIdentity:async () => ({user:{id:'public-actor'},identified:false}),
}))
vi.mock('../client-accrual.js', () => ({accrueClientPrincipal:mocks.accrue}))
// The durable stored writer and completion reconciliation stay off any database (8277).
vi.mock('../../db/conversation-store.js', async importOriginal => (await import('../../turn/__tests__/fixtures/stored-publication.js')).storedPublicationModule(await importOriginal()))
vi.mock('../../db/conversation-publication-recovery.js', async importOriginal => (await import('../../turn/__tests__/fixtures/stored-publication.js')).completionRecoveryModule(await importOriginal()))
vi.mock('../../db/sessions.js', () => ({findOrCreateSession:mocks.session,findSessionByChannel:mocks.freshSession,
  addSessionMessage:mocks.add,readSessionMessageScopeSource:async () => null,getSessionMessages:mocks.history,
  truncateMessagesFrom:mocks.truncate,claimTurnLeaseOutcome:mocks.claim,touchTurnLease:mocks.touch,
  releaseTurnOutcome:mocks.release,TURN_HEARTBEAT_INTERVAL_MS:5,
}))
vi.mock('../../turn/lease.js', async original => ({...await original<typeof import('../../turn/lease.js')>(),waitForTurnSlot:mocks.wait}))
vi.mock('../../context-scope/execution-context.js', () => ({resolveExecutionContextSystem:mocks.resolve}))
vi.mock('../../context-scope/delivery-authority.js', async original => ({
  ...await original<typeof import('../../context-scope/delivery-authority.js')>(),createDeliveryAudienceAuthorizer:() => mocks.audience,
}))
vi.mock('../route-helpers.js', () => ({checkUsageBudget:async () => ({status:'ok'}),applyMcpInjection:mocks.inject,
  buildUnavailableCapabilitiesPrompt:() => '',injectSkills:vi.fn()}))
vi.mock('../../model-resolution.js', () => ({resolveChatModelSelection:() => ({logicalModel:'fixture',logicalTier:'standard',servingModel:'fixture'})}))
vi.mock('../proactive-compaction.js', () => ({runProactiveCompaction:mocks.compact}))
vi.mock('../../decision-learning/playbook-context.js', () => ({loadDecisionPlaybookContext:async () => ({playbookRules:[]})}))
vi.mock('../../briefs/context.js', () => ({captureBriefRunPreparation:() => async (_execution:unknown,tools:unknown) => ({tools,contribution:null})}))
vi.mock('../../ledger/recorder.js', async () => {
  const {NOOP_TURN_LEDGER}=await import('@use-brian/agent-runtime/engine/turn-ledger.js')
  return {createTurnLedger:() => ({ledger:NOOP_TURN_LEDGER})}
})
vi.mock('../../ledger/runtime.js', () => ({getLedgerPayloadStore:() => null}))
vi.mock('../../application-platform/model-source-authority.js', () => ({admitModelSourceEvidence:async (context:{authority?:{assertCurrent():Promise<void>}}) => context.authority?.assertCurrent()}))
vi.mock('../../brain-stream/notify.js', () => ({notifyBrainWriteIfMatch:vi.fn()}))

import type {LLMProvider} from '@use-brian/agent-runtime/providers/types.js'
import type {AccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {createExecutionContext} from '@use-brian/agent-runtime/security/execution-context.js'
import {buildTool} from '@use-brian/agent-runtime/tools/types.js'
import {createAuthorityLease} from '../../context-scope/authority-lease.js'
import {abortLocalTurn} from '../../turn/lease.js'
import {executePublicTurn,upsertClientMemory,type PublicTurnInput} from '../public-turn.js'

const session={id:'public-session',userId:'public-actor',assistantId:'public-assistant',channelType:'api',channelId:'public-room',
  visibility:'workspace',anchorKind:'none',anchorRef:null,appOrigin:null,mode:null,contextGroupId:null,contextProjectId:null,
  contextLockedAt:null,contextCompartments:[],effectiveClearance:'public',compactBoundarySequence:null,compactSummary:null}
const assistant={id:session.assistantId,workspaceId:'public-workspace',ownerUserId:'public-payer',kind:'standard' as const,
  clearance:'public',name:'Fictional assistant',apiModelAlias:'standard'}
const access:AccessCeiling={workspaceId:assistant.workspaceId,userId:session.userId,clearance:'public',
  compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[assistant.id]}
function deferred<T>() {let resolve!:(value:T)=>void;const promise=new Promise<T>(accept=>{resolve=accept});return {promise,resolve}}
let held:string|null=null,nextToken=0,waiters:Array<()=>void>=[],current=true,effects=0,providerFailure:Error|undefined
let requests:Array<string|null>=[]
let toolRequested=false
let finalProviderText: string
let providerGate:Promise<void>|null=null
let afterSpend:(()=>void|Promise<void>)|undefined
let extraTools:Array<ReturnType<typeof buildTool>>=[]
let offeredTools:string[][]=[]
const tool=buildTool({name:'fixtureEcho',description:'Fictional echo',inputSchema:z.object({value:z.string()}),
  isReadOnly:false,isConcurrencySafe:false,async execute(_input,context) {
    expect(held).not.toBeNull();expect(context.abortSignal?.aborted).toBe(false);effects++;return {data:'Fictional effect'}
  }})
const provider:LLMProvider={name:'fixture-public',models:['fixture'],stream(){throw new Error('Unexpected fallback')},
  createSession(options){offeredTools.push((options.tools??[]).map(tool=>tool.name));let first=true;return {send(){requests.push(held);return (async function*(){
    if(providerFailure)throw providerFailure
    yield {type:'message_start' as const,model:'fixture'}
    await providerGate
    if(toolRequested&&first){first=false
      yield {type:'tool_use_start' as const,id:'public-call',name:'fixtureEcho'}
      yield {type:'tool_use_delta' as const,id:'public-call',input:'{"value":"fictional"}'}
      yield {type:'tool_use_end' as const,id:'public-call'}
      yield {type:'message_end' as const,stopReason:'tool_use' as const,usage:{inputTokens:2,outputTokens:3}}
    }else{
      yield {type:'text_delta' as const,text:finalProviderText}
      yield {type:'message_end' as const,stopReason:'end_turn' as const,usage:{inputTokens:2,outputTokens:3}}
    }
    await afterSpend?.()
  })()}}}}
function input(overrides:Partial<PublicTurnInput>={}):PublicTurnInput {
  return {assistantId:assistant.id,identityNamespace:'api:fictional-key',body:{externalUserId:'fictional-client',sessionId:session.channelId,message:'Fictional question'},...overrides}
}
function deps() {
  return {provider,tools:new Map([[tool.name,tool],...extraTools.map(extra=>[extra.name,extra] as const)]),systemPrompt:'Fictional system',memoryStore:{} as never,
    capabilityStore:{listActive:mocks.capabilities} as never,usageStore:{recordUsage:mocks.usage} as never,
    resolveWorkspaceCustomLlm:mocks.custom}
}
function start(options:Partial<PublicTurnInput>={}) {
  const req=new EventEmitter()
  const res=Object.assign(new EventEmitter(), {statusCode:200,body:undefined as unknown,writableEnded:false,destroyed:false,frames:[] as string[],headers:new Map<string,string>(),
    status(code:number){this.statusCode=code;return this},json(value:unknown){if(this.statusCode===200)expect(held).not.toBeNull();this.body=value},
    setHeader(key:string,value:string){this.headers.set(key,value)},flushHeaders:vi.fn(),
    write(frame:string){this.frames.push(frame);return true},end(){this.writableEnded=true}})
  const params=input(options)
  const promise=executePublicTurn(deps(),params,req as never,res as never)
  return {promise,req,res,params}
}
beforeEach(()=>{
  vi.clearAllMocks();held=null;nextToken=0;waiters=[];current=true;effects=0;requests=[];toolRequested=false;providerFailure=undefined;providerGate=null;afterSpend=undefined;extraTools=[];offeredTools=[]
  finalProviderText = 'Fictional public answer'
  mocks.assistant.mockResolvedValue(assistant);mocks.session.mockResolvedValue(session);mocks.freshSession.mockResolvedValue(session)
  mocks.query.mockImplementation(async () => {expect(held).not.toBeNull();return {rows:[]}})
  mocks.add.mockImplementation(async row => {expect(held).not.toBeNull();return {id:`public-${row.role}`,role:row.role,content:row.content}})
  mocks.history.mockResolvedValue([{role:'user',content:[{type:'text',text:'Fictional question'}]}]);mocks.truncate.mockResolvedValue({deletedMessages:[]})
  mocks.claim.mockImplementation(async ()=>{if(held)return null;held=`public-token-${++nextToken}`;return {token:held,turnId:`public-turn-${nextToken}`}})
  mocks.touch.mockImplementation(async (_id,token)=>({held:held===token,cancelRequested:false}))
  mocks.release.mockImplementation(async (_id,reason,token)=>{if(held!==token)return null;held=null;for(const wake of waiters.splice(0))wake();return {reason,turnId:`public-turn-${nextToken}`}})
  mocks.wait.mockImplementation(()=>new Promise<boolean>(resolve=>waiters.push(()=>resolve(true))))
  mocks.accrue.mockImplementation(async ()=>{expect(held).not.toBeNull();return {compartments:[],contactEntityId:null}})
  mocks.custom.mockImplementation(async ()=>{expect(held).not.toBeNull();return null})
  mocks.inject.mockImplementation(async ()=>{expect(held).not.toBeNull();return {unavailable:[],searchableSources:[]}})
  mocks.compact.mockImplementation(async args=>{expect(held).not.toBeNull();expect(args.modelContext.execution.lifecycle.abortSignal.aborted).toBe(false);return {messages:args.sessionMessages}})
  mocks.usage.mockImplementation(async ()=>{expect(held).not.toBeNull()})
  mocks.capabilities.mockResolvedValue([])
  mocks.audience.mockResolvedValue({allowed:true,evidence:{sensitivity:'public',compartments:[],projectIds:[]}})
  mocks.resolve.mockImplementation(async args=>{
    const authority=createAuthorityLease(access,async()=>current&&(!args.credentialCurrent||await args.credentialCurrent())?access:null)
    const resolvedAccess={...access,assistantId:assistant.id,assistantKind:assistant.kind}
    return {turnScope:{access:resolvedAccess,effectiveCompartments:[],effectiveProjectIds:[],writeCompartments:[],writeProjectIds:[],activeGroupId:null,activeProjectId:null,activeTeam:null,activeProject:null},
      executionContext:createExecutionContext({identity:args.identity,ownership:args.ownership,access:resolvedAccess,
        writeDefaults:{compartments:[],projectIds:[]},lifecycle:args.lifecycle,authority,surface:args.surface,attribution:args.attribution})}
  })
  vi.spyOn(console,'error').mockImplementation(()=>{})
})

describe('[COMP:api/public-turn] complete public operation ownership',()=>{
  it('announces a reclaimed stale predecessor before its own turn and attributes adapter and owner SQL to one request ledger',async()=>{
    const {setTurnSqlRecording,currentTurnFrame}=await import('../../db/turn-sql-accounting.js')
    const frames:Array<{at:string;turnId?:string;frameId?:string}>=[],events:Array<{kind:string;sessionId:string;payload:unknown}>=[]
    mocks.claim.mockImplementationOnce(async()=>{held=`public-token-${++nextToken}`
      return {token:held,turnId:`public-turn-${nextToken}`,recovered:{turnId:'e'.repeat(64),reason:'stalled_reclaimed'}}})
    mocks.session.mockImplementationOnce(async()=>{const frame=currentTurnFrame();frames.push({at:'adapter',turnId:frame?.turnId,frameId:frame?.frameId});return session})
    mocks.custom.mockImplementationOnce(async()=>{const frame=currentTurnFrame();frames.push({at:'owner',turnId:frame?.turnId,frameId:frame?.frameId});return null})
    const req=new EventEmitter(),res=Object.assign(new EventEmitter(),{statusCode:200,body:undefined as unknown,writableEnded:false,
      status(code:number){this.statusCode=code;return this},json(value:unknown){this.body=value},setHeader(){},end(){this.writableEnded=true}})
    setTurnSqlRecording(true)
    try{await executePublicTurn({...deps(),publishSessionEvent:event=>{events.push(structuredClone(event) as never)}},input(),req as never,res as never)}
    finally{setTurnSqlRecording(undefined)}
    expect(res.body).toMatchObject({reply:'Fictional public answer'})
    // The reclaimed predecessor's followers see its own terminal outcome, never this turn's.
    expect(events).toEqual([{kind:'turn_completed',sessionId:session.id,payload:{senderUserId:null,turnId:'e'.repeat(64),reason:'stalled_reclaimed'}}])
    // Adapter work before the owner and the owner's own phases share one request ledger.
    expect(frames).toEqual([{at:'adapter',turnId:expect.any(String),frameId:'adapter'},{at:'owner',turnId:frames[0]!.turnId,frameId:'preparation'}])
  })
  it('never offers a confirmation-required boot tool on the approval-less public surface (D11-10: the strip is kept)',async()=>{
    // The public capability surface indexes no confirmation-required connector
    // capability; boot-roster write tools are outside the catalog, so the route's
    // strip remains their only fence.
    extraTools=[buildTool({name:'fixtureConfirmedWrite',description:'Fictional write needing approval',inputSchema:z.object({}),
      isReadOnly:false,requiresConfirmation:true,async execute(){effects++;return {data:'unexpected'}}})]
    const run=start();await run.promise
    expect(run.res.body).toMatchObject({reply:'Fictional public answer'})
    expect(offeredTools.length).toBeGreaterThan(0)
    for(const names of offeredTools){expect(names).toContain('fixtureEcho');expect(names).not.toContain('fixtureConfirmedWrite')}
  })
  it('holds the original owner across preparation, actual tools/provider, publication and awaited billing',async()=>{
    const gate=deferred<null>();mocks.custom.mockImplementationOnce(()=>gate.promise)
    toolRequested=true
    const first=start()
    await vi.waitFor(()=>expect(mocks.custom).toHaveBeenCalledTimes(1))
    const second=start()
    await vi.waitFor(()=>expect(mocks.wait).toHaveBeenCalledTimes(1))
    expect(mocks.accrue).toHaveBeenCalledTimes(1);expect(mocks.add).not.toHaveBeenCalled()
    await vi.waitFor(()=>expect(mocks.touch).toHaveBeenCalled())
    gate.resolve(null);await Promise.all([first.promise,second.promise])
    expect(first.res.body).toMatchObject({reply:'Fictional public answer',sessionId:session.channelId})
    expect(second.res.body).toMatchObject({reply:'Fictional public answer'})
    expect(effects).toBe(2);expect(requests).toEqual(['public-token-1','public-token-1','public-token-2','public-token-2'])
    expect(mocks.release.mock.calls.map(args=>[args[1],args[2]])).toEqual([['completed','public-token-1'],['completed','public-token-2']])
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({userId:'public-payer',actorUserId:'public-actor',source:'api'}))
    expect(first.req.listenerCount('aborted')).toBe(0);expect(first.res.listenerCount('close')).toBe(0);expect(held).toBeNull()
  })
  it.each([{assistantId:'successor'},{channelId:'different-room'},{anchorKind:'doc_thread',anchorRef:'different-doc'},{visibility:'personal'}])('refuses queued identity/destination/kind drift %j before preparation',async change=>{
    held='prior-owner';const run=start();await vi.waitFor(()=>expect(mocks.wait).toHaveBeenCalled())
    mocks.freshSession.mockResolvedValue({...session,...change})
    await mocks.release(session.id,'completed','prior-owner');await run.promise
    expect(run.res.statusCode).toBe(409);expect(run.res.body).toEqual({error:'authority_changed'})
    expect(mocks.query).not.toHaveBeenCalled();expect(mocks.accrue).not.toHaveBeenCalled();expect(mocks.custom).not.toHaveBeenCalled()
    expect(mocks.add).not.toHaveBeenCalled();expect(requests).toEqual([])
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','public-token-1')
  })
  it('retains the original authority across the queue instead of resolving a replacement',async()=>{
    held='prior-owner';const run=start();await vi.waitFor(()=>expect(mocks.wait).toHaveBeenCalled())
    current=false;await mocks.release(session.id,'completed','prior-owner');await run.promise
    expect(mocks.resolve).toHaveBeenCalledTimes(1);expect(run.res.statusCode).toBe(409)
    expect(mocks.accrue).not.toHaveBeenCalled();expect(mocks.add).not.toHaveBeenCalled()
  })
  it('pins the queued request body',async()=>{
    held='prior-owner';const run=start();await vi.waitFor(()=>expect(mocks.wait).toHaveBeenCalled())
    run.params.body.message='replaced';await mocks.release(session.id,'completed','prior-owner');await run.promise
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({role:'user',content:[{type:'text',text:'Fictional question'}]}))
  })
  it('returns conversation_busy without preparation effects if the slot wait refuses',async()=>{
    held='prior-owner';mocks.wait.mockResolvedValue(false);const run=start();await run.promise
    expect(run.res.statusCode).toBe(409);expect(run.res.body).toMatchObject({error:'conversation_busy'})
    expect(mocks.accrue).not.toHaveBeenCalled();expect(mocks.custom).not.toHaveBeenCalled();expect(mocks.release).not.toHaveBeenCalled()
  })
  it('settles preparation failure before provider/output',async()=>{
    mocks.custom.mockRejectedValueOnce(new Error('Fictional configuration failure'))
    const run=start();await run.promise
    expect(run.res.statusCode).toBe(502);expect(mocks.add).not.toHaveBeenCalled();expect(requests).toEqual([])
    expect(mocks.release).toHaveBeenCalledWith(session.id,'failed','public-token-1')
  })
  it.each(['stop','disconnect','lease_lost'] as const)('cancels pending preparation on %s before persistence/provider',async kind=>{
    const gate=deferred<null>();mocks.custom.mockImplementationOnce(()=>gate.promise)
    const run=start();await vi.waitFor(()=>expect(mocks.custom).toHaveBeenCalled())
    if(kind==='stop')expect(abortLocalTurn(session.id,held!)).toBe(true)
    else if(kind==='disconnect')run.res.emit('close')
    else {const before=mocks.touch.mock.calls.length;mocks.touch.mockResolvedValue({held:false,cancelRequested:false});await vi.waitFor(()=>expect(mocks.touch.mock.calls.length).toBeGreaterThan(before))}
    gate.resolve(null);await run.promise
    expect(mocks.add).not.toHaveBeenCalled();expect(requests).toEqual([]);expect(mocks.usage).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledWith(session.id,kind==='stop'?'stopped_by_user':'failed','public-token-1')
  })
  it('rejects an inconsistent established session before claiming its owner',async()=>{
    mocks.session.mockResolvedValue({...session,userId:'different-actor'})
    const run=start();await run.promise
    expect(run.res.statusCode).toBe(409);expect(mocks.claim).not.toHaveBeenCalled();expect(mocks.accrue).not.toHaveBeenCalled()
  })
  it('checks retry ownership after queueing before truncating history',async()=>{
    held='prior-owner'
    mocks.query.mockImplementation(async sql=>{expect(held).not.toBeNull();return {rows:sql.includes('SELECT')?[{sessionId:session.id}]:[]}})
    const run=start({body:{...input().body,truncateFromMessageId:'fictional-old-message'}})
    await vi.waitFor(()=>expect(mocks.wait).toHaveBeenCalled())
    expect(mocks.truncate).not.toHaveBeenCalled();expect(mocks.query).not.toHaveBeenCalled()
    await mocks.release(session.id,'completed','prior-owner');await run.promise
    expect(mocks.truncate).toHaveBeenCalledExactlyOnceWith('fictional-old-message', session.id)
    expect(run.res.body).toMatchObject({reply:'Fictional public answer'})
  })
  it('withholds output and settlement success after lease loss during the real provider stream',async()=>{
    const gate=deferred<void>();providerGate=gate.promise
    const run=start();await vi.waitFor(()=>expect(requests).toHaveLength(1))
    const before=mocks.touch.mock.calls.length;mocks.touch.mockResolvedValue({held:false,cancelRequested:false})
    await vi.waitFor(()=>expect(mocks.touch.mock.calls.length).toBeGreaterThan(before))
    gate.resolve();await run.promise
    expect(run.res.statusCode).toBe(409);expect(run.res.body).toEqual({error:'authority_changed'})
    expect(mocks.add).not.toHaveBeenCalledWith(expect.objectContaining({role:'assistant'}));expect(mocks.usage).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','public-token-1')
  })
  it('releases a real provider failure without publishing a success',async()=>{
    providerFailure=new Error('Fictional provider failure')
    const run=start();await run.promise
    expect(run.res.statusCode).toBe(502);expect(mocks.usage).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','public-token-1')
  })
  it('rechecks Stop after the deterministic memory lookup and before its write',async()=>{
    const gate=deferred<never[]>(),controller=new AbortController(),create=vi.fn()
    const run=upsertClientMemory({store:{getIndex:()=>gate.promise,create} as never,
      access:{...access,compartments:[],assistantId:assistant.id,assistantKind:'standard',clientSelfMemory:{compartment:'client:fictional-client'}},
      sessionId:session.id,value:{key:'fictional-key',summary:'Fictional fact'},assertCurrent:async()=>controller.signal.throwIfAborted()})
    controller.abort(new Error('Fictional cancellation'));gate.resolve([])
    await expect(run).rejects.toThrow('Fictional cancellation');expect(create).not.toHaveBeenCalled()
  })
  it('keeps ownership until billing settlement completes',async()=>{
    const gate=deferred<void>();mocks.usage.mockImplementationOnce(()=>gate.promise)
    const run=start();await vi.waitFor(()=>expect(mocks.usage).toHaveBeenCalled())
    expect(held).toBe('public-token-1');expect(mocks.release).not.toHaveBeenCalled();expect(run.res.body).toBeUndefined()
    gate.resolve();await run.promise;expect(held).toBeNull();expect(run.res.body).toMatchObject({reply:'Fictional public answer'})
  })
  it('preserves live SSE deltas and completion fields while holding ownership',async()=>{
    const run=start({delivery:'sse'});await run.promise
    expect(run.res.headers.get('Cache-Control')).toBe('no-cache, no-transform')
    expect(run.res.frames.join('')).toContain('event: text_delta\ndata: {"text":"Fictional public answer"}')
    expect(run.res.frames.join('')).toContain('event: turn_complete\ndata: {"sessionId":"public-room","messageId":"public-assistant","model":"fixture"}')
    expect(run.res.writableEnded).toBe(true);expect(mocks.release).toHaveBeenLastCalledWith(session.id,'completed','public-token-1')
  })
  it('renders the owner’s sanitized final JSON answer without including tool narration', async () => {
    toolRequested = true
    finalProviderText = 'Message body:\nFictional clean answer. (Word count: ~3)'
    const run = start()
    await run.promise
    expect(effects).toBe(1)
    expect(run.res.body).toMatchObject({ reply: 'Fictional clean answer.' })
    expect(mocks.release).toHaveBeenLastCalledWith(session.id, 'completed', 'public-token-1')
  })
  it.each(['json','sse'] as const)('delivers %s over actual HTTP without treating completed request input as disconnect',async delivery=>{
    const app=express();app.use(express.json())
    app.post('/fictional-turn',(req,res,next)=>{
      void executePublicTurn(deps(),input({delivery,body:req.body}),req,res).catch(next)
    })
    const response=await request(app).post('/fictional-turn').send(input().body)
    expect(response.status).toBe(200)
    if(delivery==='json')expect(response.body).toMatchObject({reply:'Fictional public answer'})
    else expect(response.text).toContain('event: turn_complete')
    expect(mocks.usage).toHaveBeenCalledTimes(1)
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'completed','public-token-1')
  })
  it.each(['stop','authority','lease_lost'] as const)('settles original factual spend once when %s refuses output after provider usage',async kind=>{
    afterSpend=async()=>{
      if(kind==='stop')abortLocalTurn(session.id,held!)
      else if(kind==='authority')current=false
      else{const previous=mocks.touch.mock.calls.length;mocks.touch.mockResolvedValue({held:false,cancelRequested:false});await vi.waitFor(()=>expect(mocks.touch.mock.calls.length).toBeGreaterThan(previous))}
    }
    const run=start();await run.promise
    expect(run.res.statusCode).toBe(kind==='stop'?502:409)
    expect(mocks.usage).toHaveBeenCalledTimes(1)
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({userId:'public-payer',actorUserId:'public-actor',inputTokens:2,outputTokens:3}))
    expect(mocks.add).not.toHaveBeenCalledWith(expect.objectContaining({role:'assistant'}))
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,kind==='stop'?'stopped_by_user':'failed','public-token-1')
  })
  it('does not settle completed if writing the final JSON response throws',async()=>{
    const run=start();run.res.json=()=>{throw new Error('Fictional response failure')}
    await expect(run.promise).rejects.toThrow('Fictional response failure')
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','public-token-1')
  })
  it('releases on assistant publication failure without reporting or billing success',async()=>{
    mocks.add.mockImplementation(async row=>{if(row.role==='assistant')throw new Error('Fictional publication failure');return {id:'public-user'}})
    const run=start();await run.promise
    expect(run.res.statusCode).toBe(502);expect(mocks.usage).toHaveBeenCalledTimes(1)
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','public-token-1')
  })
})

describe('[COMP:api/public-turn] stale-takeover notice through the real public routers',()=>{
  // The port is optional on both routers: an unforwarded bus typechecks and the
  // reclaimed predecessor's followers never learn its outcome (turn-kernel.md).
  it.each(['public-api','chat-link'] as const)('the %s router hands its injected bus to the public turn',async surface=>{
    const events:Array<{kind:string;sessionId:string;payload:unknown}>=[]
    const publishSessionEvent=(event:{kind:string;sessionId:string;payload:unknown})=>{events.push(structuredClone(event))}
    mocks.claim.mockImplementationOnce(async()=>{held=`public-token-${++nextToken}`
      return {token:held,turnId:`public-turn-${nextToken}`,recovered:{turnId:'f'.repeat(64),reason:'stalled_reclaimed'}}})
    const app=express();app.use(express.json())
    let response:request.Response
    if(surface==='public-api'){
      const {publicApiRoutes}=await import('../public-api.js')
      const {mintPlaintext,hashSecret}=await import('../../db/api-key-store.js')
      const keyId='0f0e0d0c-0b0a-4908-8706-050403020100',minted=mintPlaintext(keyId)
      const keyRow={id:keyId,assistantId:assistant.id,name:'Fictional key',prefix:minted.prefix,scope:'chat',audience:'external',
        anonymousContext:'thin',toolPolicy:'assistant',status:'active',createdBy:null,createdAt:new Date(),lastUsedAt:null,
        keyHash:await hashSecret(minted.secret),workspaceMcpConsent:null}
      app.use('/api/v1',publicApiRoutes({...deps(),publishSessionEvent,
        apiKeyStore:{getByIdSystem:async()=>keyRow,touchLastUsedAt:async()=>{}} as never}))
      response=await request(app).post(`/api/v1/assistants/${assistant.id}/messages`).set('Authorization',`Bearer ${minted.plaintext}`)
        .send({externalUserId:'fictional-client',sessionId:session.channelId,message:'Fictional question'})
    }else{
      const {publicChatRoutes}=await import('../public-chat.js')
      // The chat link reads at the assistant's own clearance (`assistant-full`,
      // a system-side read surface): the resolved access carries that grant.
      const resolveDefault=mocks.resolve.getMockImplementation()!
      mocks.resolve.mockImplementationOnce(async args=>{
        const resolved=await resolveDefault({...args,surface:{}})
        const systemAccess={...resolved.turnScope.access,systemRead:true as const}
        return {turnScope:{...resolved.turnScope,access:systemAccess},executionContext:createExecutionContext({identity:args.identity,
          ownership:args.ownership,access:systemAccess,writeDefaults:{compartments:[],projectIds:[]},lifecycle:args.lifecycle,
          authority:resolved.executionContext.security.authority,surface:args.surface,attribution:args.attribution})}
      })
      // The assistant-full lane reads the assistant's own memory surface; empty here.
      const memoryStore={getSoulContext:async()=>({content:null,evidence:{}}),getIdentity:async()=>[],getIndexRanked:async()=>({rows:[]}),
        getWorkspaceIdentity:async()=>[],getWorkspaceIndex:async()=>[]}
      app.use('/api',publicChatRoutes({...deps(),memoryStore:memoryStore as never,publishSessionEvent,chatLinkStore:{
        resolveToken:async()=>({linkId:'fictional-link',assistantId:assistant.id,assistantName:'Fictional assistant',assistantIconSeed:null,assistantBio:null}),
        consumeDailyBudget:async()=>({allowed:true})} as never}))
      response=await request(app).post('/api/public/chat/fictional-token/messages')
        .send({visitorId:'fictional-visitor',sessionId:session.channelId,message:'Fictional question'})
    }
    expect(response.status,JSON.stringify(response.body)).toBe(200)
    expect(events).toEqual([{kind:'turn_completed',sessionId:session.id,payload:{senderUserId:null,turnId:'f'.repeat(64),reason:'stalled_reclaimed'}}])
  })
})
