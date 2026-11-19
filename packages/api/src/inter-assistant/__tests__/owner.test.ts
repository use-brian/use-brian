import {beforeEach,describe,expect,it,vi} from 'vitest'
import {z} from 'zod'
const mocks=vi.hoisted(()=>({assistant:vi.fn(),session:vi.fn(),readSession:vi.fn(),facts:vi.fn(),scope:vi.fn(),live:vi.fn(),
  claim:vi.fn(),touch:vi.fn(),release:vi.fn(),wait:vi.fn(),capabilities:vi.fn(),custom:vi.fn(),memory:vi.fn(),add:vi.fn(),
  history:vi.fn(),compact:vi.fn(),usage:vi.fn(),publish:vi.fn(),budget:vi.fn(),extra:vi.fn(),doc:vi.fn(),preflight:vi.fn()}))
vi.mock('@use-brian/core/workers/preflight.js',async original=>({...await original<typeof import('@use-brian/core/workers/preflight.js')>(),runPreflight:mocks.preflight}))
vi.mock('../../db/users.js',()=>({findAssistantById:mocks.assistant,findUserById:async(id:string)=>({id,timezone:'UTC'}),resolveAssistantAccess:async()=>({role:'member'})}))
// The durable stored writer and completion reconciliation stay off any database (8277).
vi.mock('../../db/conversation-store.js', async importOriginal => (await import('../../turn/__tests__/fixtures/stored-publication.js')).storedPublicationModule(await importOriginal()))
vi.mock('../../db/conversation-publication-recovery.js', async importOriginal => (await import('../../turn/__tests__/fixtures/stored-publication.js')).completionRecoveryModule(await importOriginal()))
vi.mock('../../db/sessions.js',()=>({findOrCreateSession:mocks.session,readSessionById:mocks.readSession,
  addSessionMessage:mocks.add,getSessionMessages:mocks.history,listSessionsByChannelForWorkspaceSystem:async()=>[],
  claimTurnLeaseOutcome:mocks.claim,touchTurnLease:mocks.touch,releaseTurnOutcome:mocks.release,TURN_HEARTBEAT_INTERVAL_MS:5}))
vi.mock('../../db/workspace-store.js',()=>({getWorkspaceRoleSystem:async()=> 'member',getConnectorUserId:async()=> 'callee-owner',
  getWorkspacePlan:async()=> 'free',operationCeilingsFromMembership:()=>({clearance:'internal',compartments:[],mutationCompartments:[]})}))
vi.mock('../../context-scope/delivery-authority.js',()=>({createDeliveryAudienceAuthorizer:()=>async()=>({allowed:true})}))
vi.mock('../../billing-party.js',()=>({billingPartyForAssistant:async()=> 'callee-owner'}))
vi.mock('../../context-scope/session-authority-facts.js',()=>({readSessionAuthorityFacts:mocks.facts}))
vi.mock('../../context-scope/resolve-turn-scope.js',async original=>({...await original<typeof import('../../context-scope/resolve-turn-scope.js')>(),
  resolveTurnScopeSystem:mocks.scope,resolveLiveAccessCeilingSystem:mocks.live}))
// Exercise the executor's exact createSessionLease composition with the real
// canonical session lease. Only metadata acquisition/scope ports are fixtures.
vi.mock('../../context-scope/execution-context.js',()=>({resolveExecutionContextSystem:async(input:Parameters<typeof import('../../context-scope/execution-context.js').resolveExecutionContextSystem>[0],deps:NonNullable<Parameters<typeof import('../../context-scope/execution-context.js').resolveExecutionContextSystem>[1]>)=>{
  const {createExecutionContext}=await import('@use-brian/agent-runtime/security/execution-context.js')
  const scope=await deps.resolveScope!(input)
  const authority=deps.createSessionLease!({starting:access,session:input.sessionAuthority!,userId:input.userId,
    executingAssistantId:input.assistant.id,credentialCurrent:input.credentialCurrent})
  return {executionContext:createExecutionContext({...input,access:{...access,assistantId:input.assistant.id,assistantKind:'standard'},
    writeDefaults:{compartments:[],projectIds:[]},authority}),turnScope:scope}
}}))
vi.mock('../../turn/lease.js',async original=>({...await original<typeof import('../../turn/lease.js')>(),waitForTurnSlot:mocks.wait}))
vi.mock('../../routes/route-helpers.js',()=>({checkUsageBudget:mocks.budget,buildUnavailableCapabilitiesPrompt:()=>'',injectSkills:vi.fn()}))
vi.mock('../../doc/inject.js',()=>({injectDocTools:mocks.doc}))
vi.mock('../../routes/proactive-compaction.js',()=>({runProactiveCompaction:mocks.compact}))
vi.mock('../../briefs/context.js',()=>({captureBriefRunPreparation:()=>async(_execution:unknown,tools:unknown)=>({tools,contribution:null})}))
vi.mock('../../ledger/recorder.js',async()=>{const {NOOP_TURN_LEDGER}=await import('@use-brian/agent-runtime/engine/turn-ledger.js');return {createTurnLedger:()=>({ledger:NOOP_TURN_LEDGER})}})
vi.mock('../../ledger/runtime.js',()=>({getLedgerPayloadStore:()=>null}))
vi.mock('../../application-platform/model-source-authority.js',()=>({admitModelSourceEvidence:async(context:{authority?:{assertCurrent():Promise<void>}})=>context.authority?.assertCurrent()}))
vi.mock('../../brain-stream/notify.js',()=>({notifyBrainWriteIfMatch:vi.fn(),BRAIN_WRITE_TOOL_SIGNALS:{}}))

import type {LLMProvider} from '@use-brian/agent-runtime/providers/types.js'
import type {AccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {buildTool, type CurrentAuthorityBoundary} from '@use-brian/agent-runtime/tools/types.js'
import {createAuthorityLease,runWithAuthorityLease,AuthorityChangedError} from '../../context-scope/authority-lease.js'
import {abortLocalTurn} from '../../turn/lease.js'
import {createCalleeExecutor,type CalleeExecutorOptions,type CalleeQueryParams} from '../executor.js'

const caller={id:'caller-assistant',workspaceId:'callee-workspace',ownerUserId:'callee-owner',kind:'standard' as const,clearance:'internal' as const,compartments:[],defaultCompartments:[],name:'Fictional caller'}
const assistant={...caller,id:'callee-assistant',name:'Fictional callee'}
const session={id:'callee-session',userId:'callee-actor',assistantId:assistant.id,channelType:'assistant-call',channelId:'fictional-persistent',
  visibility:'workspace',mode:null,appOrigin:null,anchorKind:'none',anchorRef:null,contextGroupId:null,contextProjectId:null,
  contextLockedAt:null,effectiveClearance:null,contextCompartments:[],compactBoundarySequence:null}
const access:AccessCeiling={workspaceId:assistant.workspaceId,userId:session.userId,clearance:'internal',compartments:[],mutationCompartments:[],projectIds:[],visibilityAssistantIds:[assistant.id]}
const scope={access:{...access,assistantId:assistant.id,assistantKind:'standard' as const},effectiveCompartments:[],effectiveProjectIds:[],writeCompartments:[],writeProjectIds:[],activeGroupId:null,activeProjectId:null,activeTeam:null,activeProject:null}
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(accept=>{resolve=accept});return {promise,resolve}}
let held:string|null=null,nextToken=0,waiters:Array<()=>void>=[],current=true,effects=0,toolRequested=false
let requests:Array<string|null>=[],providerFailure:Error|undefined,providerGate:Promise<void>|null=null,afterSpend:(()=>void)|undefined
let childAuthority:CurrentAuthorityBoundary|undefined,childSnapshot:unknown
const tool=buildTool({name:'fixtureRead',description:'Fictional read',inputSchema:z.object({}),isReadOnly:true,isConcurrencySafe:true,
  async execute(_input,context){expect(held).not.toBeNull();expect(context.abortSignal?.aborted).toBe(false)
    childAuthority=context.authority;childSnapshot=context.authority?.snapshotSource?.();effects++;return {data:'Fictional verified fact'}}})
const provider:LLMProvider={name:'fixture-callee',models:['fixture'],stream(){throw new Error('Unexpected fallback')},createSession(){let first=true;return {send(){
  requests.push(held);return(async function*(){if(providerFailure)throw providerFailure
    yield{type:'message_start' as const,model:'fixture'};await providerGate
    if(toolRequested&&first){first=false;yield{type:'tool_use_start' as const,id:'callee-read',name:'fixtureRead'}
      yield{type:'tool_use_delta' as const,id:'callee-read',input:'{}'};yield{type:'tool_use_end' as const,id:'callee-read'}
      yield{type:'message_end' as const,stopReason:'tool_use' as const,usage:{inputTokens:2,outputTokens:3}}
    }else{yield{type:'text_delta' as const,text:'Fictional delegated answer'}
      yield{type:'message_end' as const,stopReason:'end_turn' as const,usage:{inputTokens:2,outputTokens:3}}}
    afterSpend?.()
  })()
}}}}
function params(overrides:Partial<CalleeQueryParams>={}):CalleeQueryParams{return {callerAssistantId:caller.id,calleeAssistantId:assistant.id,
  callerUserId:session.userId,callerSessionId:'fictional-caller-session',callerChannelType:'workflow',sessionKey:session.channelId,
  expectedWorkspaceId:assistant.workspaceId,question:'Fictional delegated question',...overrides}}
function executor(options:Partial<CalleeExecutorOptions>={}){return createCalleeExecutor({provider,tools:new Map([[tool.name,tool]]),
  memoryStore:{getSoulContext:async()=>({content:null,evidence:{}}),getIdentity:mocks.memory,getIndexRanked:async()=>({rows:[],totalCount:0}),
    getWorkspaceIdentity:async()=>[],getWorkspaceIndex:async()=>[]} as never,capabilityStore:{listActive:mocks.capabilities} as never,
  resolveWorkspaceCustomLlm:mocks.custom,usageStore:{recordUsage:mocks.usage} as never,publishSessionEvent:mocks.publish,...options})}
beforeEach(()=>{
  vi.clearAllMocks();held=null;nextToken=0;waiters=[];current=true;effects=0;toolRequested=false;requests=[];providerFailure=undefined;providerGate=null;afterSpend=undefined;childAuthority=undefined;childSnapshot=undefined
  mocks.assistant.mockImplementation(async id=>id===assistant.id?assistant:id===caller.id?caller:null)
  mocks.session.mockResolvedValue(session);mocks.readSession.mockResolvedValue(session)
  mocks.scope.mockResolvedValue(scope);mocks.live.mockImplementation(async()=>current?access:{...access,clearance:'public'})
  mocks.facts.mockImplementation(async()=>({session:await mocks.readSession(),assistant,member:{role:'member',clearance:'internal',readCompartments:[],mutationCompartments:[]},credentialCurrent:true,department:undefined,policy:null,scopeFacts:{}}))
  mocks.claim.mockImplementation(async()=>{if(held)return null;held=`callee-token-${++nextToken}`;return {token:held,turnId:`callee-turn-${nextToken}`}})
  mocks.touch.mockImplementation(async(_id,token)=>({held:held===token,cancelRequested:false}))
  mocks.release.mockImplementation(async(_id,reason,token)=>{if(held!==token)return null;held=null;for(const wake of waiters.splice(0))wake();return {reason,turnId:`callee-turn-${nextToken}`}})
  mocks.wait.mockImplementation(()=>new Promise<boolean>(resolve=>waiters.push(()=>resolve(true))))
  mocks.capabilities.mockImplementation(async()=>{expect(held).not.toBeNull();return []})
  mocks.custom.mockImplementation(async()=>{expect(held).not.toBeNull();return null})
  mocks.memory.mockImplementation(async()=>{expect(held).not.toBeNull();return []})
  mocks.add.mockImplementation(async row=>{expect(held).not.toBeNull();return {id:`callee-${row.role}`}})
  mocks.history.mockResolvedValue([]);mocks.compact.mockImplementation(async()=>{expect(held).not.toBeNull();return {messages:[{role:'user',content:[{type:'text',text:'Fictional delegated question'}]}]}})
  mocks.preflight.mockResolvedValue({type:'passthrough',usage:null,model:null})
  mocks.doc.mockResolvedValue(undefined)
  mocks.usage.mockImplementation(async()=>{expect(held).not.toBeNull()});mocks.budget.mockResolvedValue({status:'ok'})
  vi.spyOn(console,'error').mockImplementation(()=>{})
})

describe('[COMP:api/inter-assistant-executor] original callee operation ownership',()=>{
  it('announces a reclaimed stale predecessor before its own turn and attributes adapter and owner SQL to one request ledger',async()=>{
    const {setTurnSqlRecording,currentTurnFrame}=await import('../../db/turn-sql-accounting.js')
    const frames:Array<{at:string;turnId?:string;frameId?:string}>=[]
    mocks.claim.mockImplementationOnce(async()=>{held=`callee-token-${++nextToken}`
      return {token:held,turnId:`callee-turn-${nextToken}`,recovered:{turnId:'d'.repeat(64),reason:'stalled_reclaimed'}}})
    mocks.session.mockImplementationOnce(async()=>{const frame=currentTurnFrame();frames.push({at:'adapter',turnId:frame?.turnId,frameId:frame?.frameId});return session})
    mocks.custom.mockImplementationOnce(async()=>{const frame=currentTurnFrame();frames.push({at:'owner',turnId:frame?.turnId,frameId:frame?.frameId});return null})
    setTurnSqlRecording(true)
    try{expect(await executor()(params())).toBe('Fictional delegated answer')}finally{setTurnSqlRecording(undefined)}
    // The reclaimed predecessor's followers see its own terminal outcome first, never this turn's.
    const completed=mocks.publish.mock.calls.map(([event])=>event).filter(event=>event.kind==='turn_completed')
    expect(completed[0]).toEqual({kind:'turn_completed',sessionId:session.id,payload:{senderUserId:null,turnId:'d'.repeat(64),reason:'stalled_reclaimed'}})
    expect(completed.at(-1)?.payload).toMatchObject({turnId:'callee-turn-1'})
    // Adapter work before the owner and the owner's own phases share one request ledger.
    expect(frames).toEqual([{at:'adapter',turnId:expect.any(String),frameId:'adapter'},{at:'owner',turnId:frames[0]!.turnId,frameId:'preparation'}])
  })
  it('queues before preparation and keeps one owner through real tools, model, output, billing and live completion',async()=>{
    toolRequested=true;const gate=deferred<null>();mocks.custom.mockImplementationOnce(()=>gate.promise)
    const run=executor(),first=run(params());await vi.waitFor(()=>expect(mocks.custom).toHaveBeenCalledTimes(1))
    const second=run(params());await vi.waitFor(()=>expect(mocks.wait).toHaveBeenCalledTimes(1))
    expect(mocks.capabilities).toHaveBeenCalledTimes(1);expect(mocks.add).not.toHaveBeenCalled()
    gate.resolve(null);expect(await Promise.all([first,second])).toEqual(['Fictional delegated answer','Fictional delegated answer'])
    expect(effects).toBe(2);expect(requests).toEqual(['callee-token-1','callee-token-1','callee-token-2','callee-token-2'])
    expect(mocks.release.mock.calls.map(args=>[args[1],args[2]])).toEqual([['completed','callee-token-1'],['completed','callee-token-2']])
    expect(mocks.usage).toHaveBeenCalledTimes(2);expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({userId:'callee-owner',triggerKey:'workflow_assistant_call',inputTokens:4,outputTokens:6}))
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({kind:'turn_completed',payload:expect.objectContaining({turnId:'callee-turn-2'})}))
    expect(held).toBeNull()
  })
  it.each([{userId:'successor-actor'},{assistantId:'successor-assistant'},{channelId:'different-destination'},{visibility:'personal'}])('refuses queued original session drift %j before preparation',async change=>{
    held='prior-owner';const run=executor()(params());const refusal=expect(run).rejects.toBeInstanceOf(AuthorityChangedError)
    await vi.waitFor(()=>expect(mocks.wait).toHaveBeenCalled())
    mocks.readSession.mockResolvedValue({...session,...change});await mocks.release(session.id,'completed','prior-owner');await refusal
    expect(mocks.capabilities).not.toHaveBeenCalled();expect(mocks.add).not.toHaveBeenCalled();expect(requests).toEqual([])
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','callee-token-1')
  })
  it('checks fresh canonical scope for a direct workflow without callerAccessCeiling after its queue',async()=>{
    held='prior-owner';const run=executor()(params());const refusal=expect(run).rejects.toBeInstanceOf(AuthorityChangedError)
    await vi.waitFor(()=>expect(mocks.wait).toHaveBeenCalled());current=false
    await mocks.release(session.id,'completed','prior-owner');await refusal
    expect(mocks.facts).toHaveBeenCalled();expect(mocks.capabilities).not.toHaveBeenCalled();expect(mocks.add).not.toHaveBeenCalled()
  })
  it('retains the same child invocation source and original ambient leases outside the caller async context',async()=>{
    toolRequested=true;let callerCurrent=true
    const parent=createAuthorityLease(access,async()=>callerCurrent?access:null)
    expect(await runWithAuthorityLease(parent,()=>executor()(params()))).toBe('Fictional delegated answer')
    expect(childSnapshot).toMatchObject({version:1,kind:'invocation'});expect(childAuthority?.snapshotSource?.()).toEqual(childSnapshot)
    await childAuthority!.assertCurrent();callerCurrent=false
    await expect(childAuthority!.assertCurrent()).rejects.toBeInstanceOf(AuthorityChangedError)
  })
  it('pins a queued request rather than replaying changed input under a successor',async()=>{
    held='prior-owner';const request=params();const run=executor()(request)
    await vi.waitFor(()=>expect(mocks.wait).toHaveBeenCalled());request.question='Replaced question';request.sessionKey='Replaced destination'
    await mocks.release(session.id,'completed','prior-owner');await run
    expect(mocks.add).toHaveBeenCalledWith(expect.objectContaining({role:'user',content:[{type:'text',text:'Fictional delegated question'}]}))
  })
  it('releases a preparation failure and publishes its actual failed reason',async()=>{
    mocks.custom.mockRejectedValueOnce(new Error('Fictional model configuration failure'))
    await expect(executor()(params())).rejects.toThrow('Fictional model configuration failure')
    expect(mocks.add).not.toHaveBeenCalled();expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','callee-token-1')
    expect(mocks.publish).toHaveBeenCalledWith(expect.objectContaining({kind:'turn_completed',payload:expect.objectContaining({reason:'failed'})}))
  })
  it.each(['stop','lease_lost'] as const)('refuses %s during preparation without running effects',async kind=>{
    const gate=deferred<null>();mocks.custom.mockImplementationOnce(()=>gate.promise)
    const run=executor()(params());const refusal=expect(run).rejects.toMatchObject({reason:kind==='stop'?'stopped_by_user':'ownership_lost'})
    await vi.waitFor(()=>expect(mocks.custom).toHaveBeenCalled())
    if(kind==='stop')abortLocalTurn(session.id,held!)
    else{const previous=mocks.touch.mock.calls.length;mocks.touch.mockResolvedValue({held:false,cancelRequested:false});await vi.waitFor(()=>expect(mocks.touch.mock.calls.length).toBeGreaterThan(previous))}
    gate.resolve(null);await refusal;expect(mocks.add).not.toHaveBeenCalled();expect(requests).toEqual([])
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,kind==='stop'?'stopped_by_user':'failed','callee-token-1')
  })
  it('awaits original-payer settlement before releasing ownership',async()=>{
    const gate=deferred<void>();mocks.usage.mockImplementationOnce(()=>gate.promise)
    const run=executor()(params());await vi.waitFor(()=>expect(mocks.usage).toHaveBeenCalled())
    expect(held).toBe('callee-token-1');expect(mocks.release).not.toHaveBeenCalled()
    gate.resolve();await run;expect(held).toBeNull()
  })
  it.each(['stop','authority'] as const)('settles known provider spend once when %s refuses output',async kind=>{
    afterSpend=()=>{if(kind==='stop')abortLocalTurn(session.id,held!);else current=false}
    await expect(executor()(params())).rejects.toBeDefined()
    expect(mocks.usage).toHaveBeenCalledTimes(1);expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({userId:'callee-owner',inputTokens:2,outputTokens:3}))
    expect(mocks.add).not.toHaveBeenCalledWith(expect.objectContaining({role:'assistant'}))
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,kind==='stop'?'stopped_by_user':'failed','callee-token-1')
  })
  it('waits before draft maintenance and drains already-started doc-edit accounting before releasing',async()=>{
    held='prior-owner';const gate=deferred<void>(),touch=vi.fn(async()=>{expect(held).toBe('callee-token-1')})
    const getById=vi.fn(async()=>({id:'fictional-page',workspaceId:assistant.workspaceId,clearance:'internal',state:'draft'}))
    mocks.doc.mockImplementation(async args=>{void args.onEditUsage({model:'fixture',usage:{inputTokens:1,outputTokens:1}})})
    mocks.usage.mockImplementation(async row=>{expect(held).toBe('callee-token-1');if(row.source==='overhead:doc-edit')await gate.promise})
    const run=executor({savedViewStore:{getById,setAutoPruneAt:touch} as never})(params({pageAnchorId:'fictional-page'}))
    await vi.waitFor(()=>expect(mocks.wait).toHaveBeenCalled());expect(touch).not.toHaveBeenCalled()
    await mocks.release(session.id,'completed','prior-owner')
    await vi.waitFor(()=>expect(mocks.usage).toHaveBeenCalledTimes(1))
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({source:'overhead:doc-edit'}))
    expect(touch).toHaveBeenCalledTimes(1);expect(mocks.release).toHaveBeenCalledTimes(1)
    gate.resolve();expect(await run).toBe('Fictional delegated answer')
    expect(mocks.usage).toHaveBeenCalledTimes(2)
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'completed','callee-token-1')
  })
  it('refuses an exhausted budget before preparation while releasing the claimed owner',async()=>{
    mocks.budget.mockResolvedValue({status:'blocked'})
    await expect(executor()(params())).rejects.toMatchObject({code:'budget_blocked'})
    expect(mocks.capabilities).not.toHaveBeenCalled();expect(mocks.custom).not.toHaveBeenCalled();expect(requests).toEqual([])
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','callee-token-1')
  })
  it('forwards the original preflight authority and awaits distinct worker, splitter and main charges once',async()=>{
    const gate=deferred<void>()
    mocks.usage.mockImplementation(async row=>{expect(held).toBe('callee-token-1');if(row.triggerKey==='worker_run')await gate.promise})
    mocks.preflight.mockImplementation(async options=>{
      expect(options.context.executionContext.security.authority).toBe(options.context.authority)
      expect(options.context.channelId).toBe(session.channelId)
      expect(options.context.executionContext.lifecycle.channelId).toBe(session.channelId)
      expect(options.context.authority.snapshotSource()).toMatchObject({kind:'invocation'})
      await options.onUsage({workerId:'fictional-worker',userId:session.userId,assistantId:assistant.id,sessionId:session.id,
        workspaceId:assistant.workspaceId,model:'fictional-worker-model',usage:{inputTokens:3,outputTokens:4}})
      return {type:'researched',context:'Fictional gathered evidence',usage:{inputTokens:5,outputTokens:6},model:'fictional-splitter-model'}
    })
    const run=executor({workerRunsStore:{} as never})(params({depth:{tier:'deep'}}))
    await vi.waitFor(()=>expect(mocks.usage).toHaveBeenCalledTimes(1));expect(requests).toEqual([])
    expect(held).toBe('callee-token-1');gate.resolve();expect(await run).toBe('Fictional delegated answer')
    expect(mocks.usage).toHaveBeenCalledTimes(3)
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({userId:session.userId,triggerKey:'worker_run',inputTokens:3,outputTokens:4,source:'included'}))
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({userId:session.userId,triggerKey:'parallel_split_classifier',inputTokens:5,outputTokens:6,source:'overhead:splitter'}))
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({userId:'callee-owner',triggerKey:'workflow_assistant_call',inputTokens:2,outputTokens:3}))
  })
  it('preserves an uncertain tool effect instead of replaying it or replacing its failure marker',async()=>{
    toolRequested=true
    const uncertain=buildTool({name:'fixtureRead',description:'Fictional uncertain operation',inputSchema:z.object({}),isReadOnly:true,
      async execute(){effects++;current=false;return {data:'Possibly completed fictional operation'}}})
    const error=await executor({tools:new Map([[uncertain.name,uncertain]])})(params()).catch(caught=>caught)
    expect(error).toBeInstanceOf(AuthorityChangedError);expect(error).toMatchObject({operationMayHaveExecuted:true,retrySafe:false})
    expect(effects).toBe(1);expect(mocks.usage).toHaveBeenCalledTimes(1)
    expect(mocks.add).not.toHaveBeenCalledWith(expect.objectContaining({role:'assistant'}))
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','callee-token-1')
  })
  it('releases publication failure while settling the factual incurred usage',async()=>{
    mocks.add.mockImplementation(async row=>{if(row.role==='assistant')throw new Error('Fictional publication failure');return {id:'callee-user'}})
    await expect(executor()(params())).rejects.toThrow('Fictional publication failure')
    expect(mocks.usage).toHaveBeenCalledTimes(1);expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','callee-token-1')
  })
})
