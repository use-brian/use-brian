import {beforeEach, describe, expect, it, vi} from 'vitest'
import {z} from 'zod'

const mocks = vi.hoisted(() => ({
  session: vi.fn(), assistant: vi.fn(), history: vi.fn(), addMessage: vi.fn(),
  live: vi.fn(), scope: vi.fn(), claim: vi.fn(), touch: vi.fn(), release: vi.fn(), wait: vi.fn(),
  billing: vi.fn(), usage: vi.fn(), authorizeAudience: vi.fn(), recovered: vi.fn((): unknown => undefined),
}))
// The durable stored writer and completion reconciliation stay off any database (8277).
vi.mock('../../db/conversation-store.js', async importOriginal => (await import('../../turn/__tests__/fixtures/stored-publication.js')).storedPublicationModule(await importOriginal()))
vi.mock('../../db/conversation-publication-recovery.js', async importOriginal => (await import('../../turn/__tests__/fixtures/stored-publication.js')).completionRecoveryModule(await importOriginal()))
vi.mock('../../db/sessions.js', () => ({
  findSessionById: mocks.session, getSessionMessages: mocks.history,
  addSessionMessage: mocks.addMessage, toStampedMessages: (rows: unknown[]) => rows,
  claimTurnLease: mocks.claim, touchTurnLease: mocks.touch, releaseTurnLease: mocks.release,
  claimTurnLeaseOutcome: async (...args: unknown[]) => {const token=await mocks.claim(...args),recovered=mocks.recovered();return token?{token,turnId:`public-${token}`,...recovered?{recovered}:{}}:null},
  releaseTurnOutcome: async (...args: unknown[]) => await mocks.release(...args)?{reason:args[1],turnId:`public-${args[2]}`}:null,
  TURN_HEARTBEAT_INTERVAL_MS: 5, TURN_LEASE_STALE_AFTER_MS: 90_000,
}))
vi.mock('../../db/users.js', () => ({findAssistantById: mocks.assistant}))
vi.mock('../../turn/lease.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../turn/lease.js')>(), waitForTurnSlot: mocks.wait,
}))
// A busy slot here is another holder's lease, never this resume's predecessor:
// the wait delegates to the ordinary slot wait (predecessor cases: session-resume-slot-wait.test.ts).
vi.mock('../../db/session-resume-store.js', () => ({
  readResumePredecessorLease: async () => ({ running: true, predecessorToken: null, stale: false }),
}))
vi.mock('../../turn/billing.js', async importOriginal => ({...await importOriginal<typeof import('../../turn/billing.js')>(), resolveTurnBilling: mocks.billing}))
vi.mock('../../context-scope/resolve-turn-scope.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../context-scope/resolve-turn-scope.js')>(),
  resolveLiveAccessCeilingSystem: mocks.live, resolveTurnScopeSystem: mocks.scope,
}))
vi.mock('../../context-scope/delivery-authority.js', async importOriginal => ({
  ...await importOriginal<typeof import('../../context-scope/delivery-authority.js')>(),
  createDeliveryAudienceAuthorizer: () => mocks.authorizeAudience,
}))
vi.mock('../../application-platform/model-source-authority.js', async () => ({
  admitModelSourceEvidence: async () => {
    const {assertCurrentAuthority} = await import('../../context-scope/authority-lease.js')
    await assertCurrentAuthority()
  },
}))
// The unattended Brief basis store; the resolver is the test's own.
const workBasis = vi.hoisted(() => ({get: vi.fn(async (): Promise<unknown> => null), put: vi.fn(async () => {})}))
vi.mock('../../db/brief-store.js', async importOriginal => ({...await importOriginal<typeof import('../../db/brief-store.js')>(),
  getWorkBasisSystem: workBasis.get, putWorkBasisSystem: workBasis.put}))
// The M3 resume composition (activates exactly the suspended tool); its catalog is M3's.
const surface = vi.hoisted(() => ({composeResume: vi.fn()}))
vi.mock('../../mcp/surface.js', () => ({composeResumeCapabilities: surface.composeResume}))
vi.mock('../../ledger/recorder.js', async () => {
  const {NOOP_TURN_LEDGER}=await import('@use-brian/agent-runtime/engine/turn-ledger.js')
  return {createTurnLedger: () => ({ledger:NOOP_TURN_LEDGER})}
})
// The real query loop and kernel execute; only persistence/admission dependencies
// are synthetic. Its ledger uses the production no-op contract below.
vi.mock('../../ledger/runtime.js', () => ({getLedgerPayloadStore: () => null}))

import type {LLMProvider} from '@use-brian/agent-runtime/providers/types.js'
import type {AccessCeiling} from '@use-brian/agent-runtime/security/access-ceiling.js'
import {buildTool} from '@use-brian/agent-runtime/tools/types.js'
import {abortLocalTurn} from '../../turn/lease.js'
import {AuthorityChangedError} from '../../context-scope/authority-lease.js'
import {createSessionResumeReplay, RESUME_FAILED_TEXT, RESUME_WRITE_ATTEMPTS, type SessionResumeReplayDeps} from '../session-resume-replay.js'
import {configureBriefTurnContext, type BriefTurn} from '../../briefs/context.js'
import type {ResumeReplayParams} from '../chat.js'

const session = {id:'session-resume-owner', userId:'resume-actor', assistantId:'resume-assistant',
  channelType:'web', channelId:'resume-room', visibility:'workspace', workspaceId:'resume-workspace',
  contextGroupId:null, contextProjectId:null, contextLockedAt:null, effectiveClearance:'internal', contextCompartments:[],
  appOrigin:null,anchorKind:'none',anchorRef:null,mode:null}
const assistant = {id:session.assistantId, workspaceId:session.workspaceId, ownerUserId:'workspace-payer',
  kind:'primary', clearance:'internal', systemPrompt:null}
const access: AccessCeiling = {workspaceId:session.workspaceId, userId:session.userId, clearance:'internal',
  compartments:[], mutationCompartments:[], projectIds:[], visibilityAssistantIds:null}
const scope = {access:{...access, assistantId:assistant.id, assistantKind:'primary'},
  effectiveCompartments:[], effectiveProjectIds:[], writeCompartments:[], writeProjectIds:[],
  activeGroupId:null, activeProjectId:null, activeTeam:null, activeProject:null}
function params(overrides: Partial<ResumeReplayParams> = {}): ResumeReplayParams {
  return {sessionId:session.id, approvalId:'approved-invocation', suspendedToolName:'fixtureSend',
    suspendedToolInput:{value:'fictional payload'}, loopStepIndex:2, startingAccessCeiling:access,
    approvalStatus:'approved', rejectReason:null, answerText:null, approvalKind:'tool_invocation', ...overrides}
}
function deferred<T>() {
  let resolve!: (value:T) => void
  const promise = new Promise<T>(accept => {resolve=accept})
  return {promise, resolve}
}
let held: string | null = null
let nextToken = 0
let waiters: Array<() => void> = []
let effectCount = 0
let providerRequests: Array<{token:string|null; messages:unknown}> = []
let providerFailure: Error | undefined
let afterSpend:(()=>void|Promise<void>)|undefined
const receipts = new Map<string, {data:string}>()
const tool = buildTool({name:'fixtureSend', description:'Fictional approved action',
  inputSchema:z.object({value:z.string()}), isReadOnly:false, isConcurrencySafe:false,
  async execute(_input, context) {
    expect(held).not.toBeNull()
    expect(context.abortSignal?.aborted).toBe(false)
    expect(context.approvedToolInvocation).toEqual({approvalId:'approved-invocation', approverUserId:session.userId, toolName:'fixtureSend'})
    const key=context.approvedToolInvocation!.approvalId
    const previous=receipts.get(key)
    if (previous) return previous
    effectCount++
    const result={data:'Fictional approved result'}
    receipts.set(key,result)
    return result
  },
})
const provider: LLMProvider = {
  name:'fixture-resume-provider', models:['fixture'],
  stream() {throw new Error('Unexpected provider fallback')},
  createSession() {
    return {send(messages) {
      providerRequests.push({token:held, messages:structuredClone(messages)})
      return (async function* () {
        if (providerFailure) throw providerFailure
        yield {type:'message_start' as const, model:'fixture'}
        yield {type:'text_delta' as const, text:'Fictional resumed answer'}
        yield {type:'message_end' as const, stopReason:'end_turn' as const, usage:{inputTokens:2,outputTokens:3}}
        await afterSpend?.()
      })()
    }}
  },
}
function replay(overrides: Partial<SessionResumeReplayDeps> = {}) {
  return createSessionResumeReplay({provider, tools:new Map([[tool.name,tool]]), systemPrompt:'Fictional resume fixture',
    resolveWorkspaceCustomLlm:null, resolveWorkspaceByoGeminiKey:null, buildWorkspaceProvider:null,
    usageStore:{recordUsage:mocks.usage} as never, ...overrides})
}
beforeEach(() => {
  vi.clearAllMocks()
  held=null; nextToken=0; waiters=[]; effectCount=0; providerRequests=[]; providerFailure=undefined; afterSpend=undefined; receipts.clear()
  mocks.session.mockResolvedValue(session); mocks.assistant.mockResolvedValue(assistant)
  mocks.history.mockResolvedValue([]); mocks.addMessage.mockImplementation(async () => {expect(held).not.toBeNull(); return undefined})
  mocks.live.mockResolvedValue(access); mocks.scope.mockResolvedValue(scope)
  mocks.claim.mockImplementation(async () => {if (held) return null; held=`resume-token-${++nextToken}`; return held})
  mocks.touch.mockImplementation(async (_session, token) => ({held:held===token,cancelRequested:false}))
  mocks.release.mockImplementation(async (_session, _reason, token) => {
    if (held!==token) return false
    held=null
    for (const wake of waiters.splice(0)) wake()
    return true
  })
  mocks.wait.mockImplementation(() => new Promise<boolean>(resolve => waiters.push(() => resolve(true))))
  mocks.billing.mockImplementation(async () => {expect(held).not.toBeNull(); return {payerUserId:'workspace-payer',actorUserId:session.userId}})
  mocks.usage.mockImplementation(async () => {expect(held).not.toBeNull()})
  mocks.authorizeAudience.mockResolvedValue({allowed:true})
})

describe('[COMP:brain/session-resume-worker] complete resume turn ownership', () => {
  it('owns preparation, queues another replay and preserves approved-action deduplication through real provider/output', async () => {
    const gate=deferred<string|null>()
    const resolveKey=vi.fn().mockImplementationOnce(() => gate.promise).mockResolvedValue('fixture-key')
    const run=replay({resolveWorkspaceByoGeminiKey:resolveKey,buildWorkspaceProvider:() => provider})
    const first=run(params({selectedLegacyByo:true}))
    await vi.waitFor(() => expect(resolveKey).toHaveBeenCalledTimes(1))
    expect(held).toBe('resume-token-1')
    await vi.waitFor(() => expect(mocks.touch).toHaveBeenCalled())
    const second=run(params({selectedLegacyByo:true}))
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledTimes(1))
    expect(resolveKey).toHaveBeenCalledTimes(1)
    expect(effectCount).toBe(0); expect(mocks.addMessage).not.toHaveBeenCalled(); expect(mocks.billing).not.toHaveBeenCalled()
    gate.resolve('fixture-key')
    expect(await Promise.all([first,second])).toEqual(['completed','completed'])
    expect(effectCount).toBe(1)
    expect(providerRequests.map(request => request.token)).toEqual(['resume-token-1','resume-token-2'])
    expect(JSON.stringify(providerRequests[0]?.messages)).toContain('Fictional approved result')
    expect(mocks.addMessage).toHaveBeenCalledWith(expect.objectContaining({role:'assistant',content:[{type:'text',text:'Fictional resumed answer'}]}))
    expect(mocks.release.mock.calls.map(call => [call[1],call[2]])).toEqual([['completed','resume-token-1'],['completed','resume-token-2']])
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({userId:'workspace-payer',actorUserId:session.userId,triggerKey:'session_resume'}))
    expect(held).toBeNull()
  })
  it('prepares and runs on its canonical session_resume execution with the accepted Brief, as every lane does', async () => {
    const contexts:Array<import('@use-brian/agent-runtime/tools/types.js').ToolContext>=[], configs:Array<Record<string,unknown>>=[]
    const probe=buildTool({name:'fixtureSend', description:'Fictional approved action', inputSchema:z.object({value:z.string()}),
      isReadOnly:false, isConcurrencySafe:false, async execute(_input, context) {contexts.push(context); return {data:'Fictional approved result'}}})
    const capturing: LLMProvider={...provider, createSession(config) {configs.push(config as never); return provider.createSession(config)}}
    const brief=vi.fn(async (_execution: unknown) => ({workspaceId:session.workspaceId, projectId:'fixture-project', projectBindingId:'fixture-binding',
      basis:{} as BriefTurn['basis'], fingerprint:'f'.repeat(64), incomplete:false, content:'<brief>Fictional accepted rules</brief>'}) as BriefTurn)
    configureBriefTurnContext(brief)
    try {
      expect(await replay({provider:capturing, tools:new Map([[probe.name,probe]])})(params())).toBe('completed')
    } finally {configureBriefTurnContext(null)}
    const execution=contexts[0]?.executionContext
    // A system execution keyed by the approval: no attended principal is fabricated.
    expect(execution?.identity).toEqual({kind:'system', purpose:'session_resume', jobId:'approved-invocation'})
    expect(execution?.ownership).toEqual({kind:'workspace', workspaceId:session.workspaceId})
    expect(execution?.security.access).toMatchObject({userId:session.userId, assistantId:assistant.id, clearance:'internal'})
    expect(contexts[0]?.authority).toBe(execution?.security.authority)
    // The Brief runs on that same execution and freezes its approval job's basis.
    expect(brief).toHaveBeenCalledOnce(); expect(brief.mock.calls[0]![0]).toBe(execution)
    expect(workBasis.put).toHaveBeenCalledWith(expect.objectContaining({kind:'job', workId:'approved-invocation'}))
    expect(String(configs[0]?.runtimeSystemContext)).toContain('<brief>Fictional accepted rules</brief>')
  })
  it('prepares its roster through the owner capability port with the exact suspended tool on its execution', async () => {
    const executed:Array<import('@use-brian/agent-runtime/tools/types.js').ToolContext>=[]
    const connector=buildTool({name:'connectorSend', description:'Fictional connector action', inputSchema:z.object({value:z.string()}),
      isReadOnly:false, isConcurrencySafe:false, async execute(_input, context) {executed.push(context); return {data:'Fictional connector result'}}})
    surface.composeResume.mockImplementation(async (options: {tools: Map<string, unknown>; suspendedToolName: string}) => {
      expect(held).not.toBeNull()
      if (options.suspendedToolName===connector.name) options.tools.set(connector.name, connector)
      return {enrichConfirmation: async (_name: string, input: unknown) => input, unavailable: [], searchableSources: []}
    })
    const stores={connectorStore:{} as never, settingsStore:{} as never}
    expect(await replay({capabilityStores:stores})(params({suspendedToolName:connector.name}))).toBe('completed')
    expect(surface.composeResume).toHaveBeenCalledOnce()
    const options=surface.composeResume.mock.calls[0]![0]
    expect(options).toMatchObject({suspendedToolName:'connectorSend', userId:session.userId, assistantId:assistant.id,
      connectorStore:stores.connectorStore, settingsStore:stores.settingsStore, assistantTeamId:session.workspaceId})
    expect(options.executionContext.identity).toEqual({kind:'system', purpose:'session_resume', jobId:'approved-invocation'})
    // The activated tool ran once, bound to that same execution, and its outcome reached the model.
    expect(executed).toHaveLength(1); expect(executed[0]?.executionContext).toBe(options.executionContext)
    expect(JSON.stringify(providerRequests[0]?.messages)).toContain('Fictional connector result')
  })
  it('binds its reply to the durable completion header and never replays a committed continuation (8277)', async () => {
    const {storedCompletions}=await import('../../turn/__tests__/fixtures/stored-publication.js')
    const {committedTurnCompletion}=await import('../../db/conversation-publication-recovery.js')
    storedCompletions.length=0
    expect(await replay()(params())).toBe('completed')
    expect(storedCompletions).toEqual([expect.objectContaining({lane:'resume',input:{kind:'approval',ref:'approved-invocation'},assistantId:assistant.id})])
    expect(vi.mocked(committedTurnCompletion)).toHaveBeenCalledWith(expect.objectContaining({sessionId:session.id,input:{kind:'approval',ref:'approved-invocation'}}))
    // A restart after a committed reply (lost acknowledgement or lost resume-point delete).
    vi.mocked(committedTurnCompletion).mockResolvedValueOnce({operationId:'x'} as never)
    effectCount=0; providerRequests=[]; vi.mocked(mocks.addMessage).mockClear()
    expect(await replay()(params())).toBe('completed')
    expect(effectCount).toBe(0); expect(providerRequests).toEqual([]); expect(mocks.addMessage).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'completed',expect.any(String))
  })
  it('mirrors turn_started, snapshots and turn_completed on the session bus for a personal session', async () => {
    const personal={...session,visibility:'personal'}
    mocks.session.mockResolvedValue(personal)
    const events:Array<{kind:string;payload:Record<string,unknown>}>=[]
    expect(await replay({publishSessionEvent:event => {events.push(structuredClone(event) as never)}})(params())).toBe('completed')
    const kinds=events.map(event => event.kind)
    expect(kinds[0]).toBe('turn_started')
    expect(kinds.at(-1)).toBe('turn_completed')
    expect(kinds.filter(kind => kind==='turn_stream').length).toBeGreaterThan(0)
    expect(events[0]?.payload).toEqual({senderUserId:session.userId,assistantId:assistant.id,turnId:'public-resume-token-1'})
    expect(events.find(event => event.kind==='turn_stream'&&event.payload.text==='Fictional resumed answer')?.payload)
      .toMatchObject({turnId:'public-resume-token-1',senderUserId:session.userId,assistantId:assistant.id})
    // An ordinary completion carries no reason, as on the web path.
    expect(events.at(-1)?.payload).toEqual({senderUserId:session.userId,turnId:'public-resume-token-1'})
  })
  it('announces a reclaimed stale predecessor before its own start, as web and channel do', async () => {
    mocks.session.mockResolvedValue({...session,visibility:'personal'})
    mocks.recovered.mockReturnValueOnce({turnId:'c'.repeat(64),reason:'stalled_reclaimed'})
    const events:Array<{kind:string;payload:Record<string,unknown>}>=[]
    expect(await replay({publishSessionEvent:event => {events.push(structuredClone(event) as never)}})(params())).toBe('completed')
    expect(events.slice(0,2)).toEqual([
      {kind:'turn_completed',sessionId:session.id,payload:{senderUserId:null,turnId:'c'.repeat(64),reason:'stalled_reclaimed'}},
      {kind:'turn_started',sessionId:session.id,payload:{senderUserId:session.userId,assistantId:assistant.id,turnId:'public-resume-token-1'}}])
  })
  it('publishes the abnormal reason when a personal resume fails after the exact-owner release', async () => {
    mocks.session.mockResolvedValue({...session,visibility:'personal'})
    mocks.live.mockResolvedValue({...access,clearance:'public'})
    const events:Array<{kind:string;payload:Record<string,unknown>}>=[]
    await expect(replay({publishSessionEvent:event => {events.push(structuredClone(event) as never)}})(params()))
      .rejects.toMatchObject({code:'session_resume_authority_unavailable'})
    expect(events.map(event => event.kind)).toEqual(['turn_started','turn_completed'])
    expect(events[1]?.payload).toEqual({senderUserId:session.userId,turnId:'public-resume-token-1',reason:'failed'})
  })
  it('refuses a queued approval when the stored session belongs to a successor assistant', async () => {
    held='other-owner'
    const result=replay()(params())
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledTimes(1))
    mocks.session.mockResolvedValue({...session,assistantId:'successor-assistant'})
    mocks.assistant.mockResolvedValue({...assistant,id:'successor-assistant'})
    await mocks.release(session.id,'completed','other-owner')
    await expect(result).rejects.toMatchObject({code:'session_resume_authority_unavailable'})
    expect(effectCount).toBe(0); expect(mocks.live).not.toHaveBeenCalled(); expect(providerRequests).toEqual([])
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','resume-token-1')
  })
  it.each([{channelId:'different-destination'},{anchorKind:'doc_thread',anchorRef:'different-anchor'},{visibility:'personal'}])('refuses queued destination/kind drift %j', async change => {
    held='other-owner'
    const result=replay()(params())
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledTimes(1))
    mocks.session.mockResolvedValue({...session,...change})
    await mocks.release(session.id,'completed','other-owner')
    await expect(result).rejects.toMatchObject({code:'session_resume_authority_unavailable'})
    expect(effectCount).toBe(0); expect(mocks.live).not.toHaveBeenCalled(); expect(mocks.billing).not.toHaveBeenCalled()
    expect(mocks.addMessage).not.toHaveBeenCalled(); expect(providerRequests).toEqual([])
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','resume-token-1')
  })
  it('revalidates a narrowed original authority after waiting for its slot', async () => {
    held='other-owner'
    const result=replay()(params())
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledTimes(1))
    mocks.live.mockResolvedValue({...access,clearance:'public'})
    await mocks.release(session.id,'completed','other-owner')
    await expect(result).rejects.toMatchObject({code:'session_resume_authority_unavailable'})
    expect(effectCount).toBe(0); expect(mocks.addMessage).not.toHaveBeenCalled(); expect(providerRequests).toEqual([])
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'failed','resume-token-1')
  })
  it('pins the approved checkpoint input while queued', async () => {
    held='other-owner'
    const saved=params(), result=replay()(saved)
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledTimes(1))
    saved.approvalId='different-approval'
    saved.suspendedToolInput={value:'different input'}
    await mocks.release(session.id,'completed','other-owner')
    expect(await result).toBe('completed')
    expect(effectCount).toBe(1); expect(receipts.has('approved-invocation')).toBe(true)
  })
  it('consumes a vanished queued session and settles as completed', async () => {
    held='other-owner'
    const result=replay()(params())
    await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledTimes(1))
    mocks.session.mockResolvedValue(null)
    await mocks.release(session.id,'completed','other-owner')
    expect(await result).toBe('completed'); expect(effectCount).toBe(0)
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,'completed','resume-token-1')
  })
  it('performs no continuation work when the slot wait refuses', async () => {
    mocks.claim.mockResolvedValue(null); mocks.wait.mockResolvedValue(false)
    await expect(replay()(params())).rejects.toMatchObject({code:'room_turn_wait_timeout'})
    expect(mocks.live).not.toHaveBeenCalled(); expect(mocks.history).not.toHaveBeenCalled()
    expect(effectCount).toBe(0); expect(mocks.billing).not.toHaveBeenCalled(); expect(mocks.addMessage).not.toHaveBeenCalled()
    expect(mocks.release).not.toHaveBeenCalled()
  })
  it('settles a preparation authority refusal without executing the approved action', async () => {
    mocks.live.mockResolvedValue({...access,clearance:'public'})
    await expect(replay()(params())).rejects.toMatchObject({code:'session_resume_authority_unavailable'})
    expect(effectCount).toBe(0); expect(providerRequests).toEqual([])
    expect(mocks.release).toHaveBeenCalledWith(session.id,'failed','resume-token-1')
  })
  it('honors Stop during preparation and consumes the continuation without executing its action', async () => {
    const gate=deferred<string|null>(),resolveKey=vi.fn(() => gate.promise)
    const result=replay({resolveWorkspaceByoGeminiKey:resolveKey,buildWorkspaceProvider:() => provider})(params({selectedLegacyByo:true}))
    await vi.waitFor(() => expect(resolveKey).toHaveBeenCalled())
    expect(abortLocalTurn(session.id,held!)).toBe(true)
    gate.resolve('fixture-key')
    expect(await result).toBe('completed')
    expect(effectCount).toBe(0); expect(mocks.history).not.toHaveBeenCalled(); expect(providerRequests).toEqual([])
    expect(mocks.addMessage).not.toHaveBeenCalled(); expect(mocks.billing).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledWith(session.id,'stopped_by_user','resume-token-1')
    expect(abortLocalTurn(session.id,'resume-token-1')).toBe(false)
  })
  it('honors Stop while worker rehydration is pending before replaying the approved action', async () => {
    const gate=deferred<{respawned:number;notificationsReady:number}>()
    const rehydrate=vi.fn(() => gate.promise)
    const result=replay({workerManager:{setPersistence:vi.fn(),rehydrate} as never,workerRunsStore:{} as never})(params())
    await vi.waitFor(() => expect(rehydrate).toHaveBeenCalled())
    expect(abortLocalTurn(session.id,held!)).toBe(true)
    gate.resolve({respawned:0,notificationsReady:0})
    expect(await result).toBe('completed')
    expect(effectCount).toBe(0); expect(mocks.history).not.toHaveBeenCalled(); expect(providerRequests).toEqual([])
    expect(mocks.addMessage).not.toHaveBeenCalled(); expect(mocks.billing).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledWith(session.id,'stopped_by_user','resume-token-1')
  })
  it('refuses lease loss during preparation without consuming the approved continuation', async () => {
    const gate=deferred<string|null>(),resolveKey=vi.fn(() => gate.promise)
    const result=replay({resolveWorkspaceByoGeminiKey:resolveKey,buildWorkspaceProvider:() => provider})(params({selectedLegacyByo:true}))
    await vi.waitFor(() => expect(resolveKey).toHaveBeenCalled())
    const previousTouches=mocks.touch.mock.calls.length
    mocks.touch.mockResolvedValue({held:false,cancelRequested:false})
    await vi.waitFor(() => expect(mocks.touch.mock.calls.length).toBeGreaterThan(previousTouches))
    gate.resolve('fixture-key')
    await expect(result).rejects.toMatchObject({code:'turn_lease_lost',retrySafe:false})
    expect(effectCount).toBe(0); expect(mocks.addMessage).not.toHaveBeenCalled(); expect(providerRequests).toEqual([])
    expect(mocks.release).toHaveBeenCalledWith(session.id,'failed','resume-token-1')
  })
  it('retains ownership until usage settlement finishes', async () => {
    const gate=deferred<void>()
    mocks.usage.mockImplementationOnce(() => gate.promise)
    const result=replay()(params())
    await vi.waitFor(() => expect(mocks.usage).toHaveBeenCalledTimes(1))
    expect(held).toBe('resume-token-1'); expect(mocks.release).not.toHaveBeenCalled()
    gate.resolve()
    expect(await result).toBe('completed'); expect(held).toBeNull()
  })
  it('releases the original owner on real provider failure without repeating the approved action, leaving a user-visible outcome', async () => {
    providerFailure=new Error('Fictional provider failure')
    await expect(replay()(params())).rejects.toThrow('Fictional provider failure')
    expect(effectCount).toBe(1); expect(mocks.usage).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledWith(session.id,'failed','resume-token-1')
    // No model output; the terminal failure is recorded once, under the held lease, as a closing row.
    const assistantRows=mocks.addMessage.mock.calls.map(([row]) => row).filter(row => row.role==='assistant')
    expect(assistantRows).toEqual([expect.objectContaining({content:[{type:'text',text:RESUME_FAILED_TEXT}],senderAssistantId:assistant.id})])
  })
  it('records no failure outcome after Stop or a refused authority', async () => {
    afterSpend=async()=>{abortLocalTurn(session.id,held!)}
    expect(await replay()(params())).toBe('completed')
    expect(mocks.addMessage).not.toHaveBeenCalledWith(expect.objectContaining({role:'assistant'}))
    vi.clearAllMocks(); mocks.addMessage.mockImplementation(async () => undefined); afterSpend=undefined
    mocks.live.mockResolvedValue(access); mocks.session.mockResolvedValue(session); mocks.assistant.mockResolvedValue(assistant)
    afterSpend=async()=>{mocks.live.mockResolvedValue({...access,clearance:'public'})}
    await expect(replay()(params())).rejects.toBeDefined()
    expect(mocks.addMessage).not.toHaveBeenCalledWith(expect.objectContaining({role:'assistant'}))
  })
  it('releases on publication failure and preserves uncertain-effect withholding', async () => {
    mocks.addMessage.mockImplementation(async row => {if (row.role==='assistant') throw new Error('Fictional persistence failure')})
    await expect(replay()(params())).rejects.toThrow('Fictional persistence failure')
    expect(effectCount).toBe(1); expect(mocks.release).toHaveBeenCalledWith(session.id,'failed','resume-token-1')
    expect(mocks.usage).toHaveBeenCalledTimes(1)
  })
  it.each(['stop','authority','lease_lost'] as const)('settles original incurred usage once after %s without replaying its approved action', async kind => {
    afterSpend=async()=>{
      if(kind==='stop')abortLocalTurn(session.id,held!)
      else if(kind==='authority')mocks.live.mockResolvedValue({...access,clearance:'public'})
      else{const previous=mocks.touch.mock.calls.length;mocks.touch.mockResolvedValue({held:false,cancelRequested:false});await vi.waitFor(()=>expect(mocks.touch.mock.calls.length).toBeGreaterThan(previous))}
    }
    const run=replay()(params())
    if(kind==='stop')expect(await run).toBe('completed')
    else await expect(run).rejects.toBeDefined()
    expect(effectCount).toBe(1);expect(mocks.usage).toHaveBeenCalledTimes(1)
    expect(mocks.usage).toHaveBeenCalledWith(expect.objectContaining({userId:'workspace-payer',actorUserId:session.userId,inputTokens:2,outputTokens:3}))
    expect(mocks.addMessage).not.toHaveBeenCalledWith(expect.objectContaining({role:'assistant'}))
    expect(mocks.release).toHaveBeenLastCalledWith(session.id,kind==='stop'?'stopped_by_user':'failed','resume-token-1')
  })
  // M5Q-14: a lock-conflict abort (40P01 deadlock_detected, 40001) rolls back the
  // whole write transaction, so the owner re-enters that write under the same
  // lease and completion identity instead of ending the turn with RESUME_FAILED_TEXT.
  const deadlock=() => Object.assign(new Error('deadlock detected'), {code:'40P01'})
  it.each(['40P01','40001'])('retries the outcome write after %s on the first attempt and continues once', async code => {
    let failed=0
    mocks.addMessage.mockImplementation(async row => {
      expect(held).not.toBeNull()
      if (row.role==='system'&&failed++===0) throw Object.assign(new Error('transient lock conflict'), {code})
      return undefined
    })
    expect(await replay()(params())).toBe('completed')
    const rows=mocks.addMessage.mock.calls.map(([row]) => row)
    expect(rows.filter(row => row.role==='system')).toHaveLength(2)
    expect(rows.filter(row => row.role==='assistant')).toEqual([expect.objectContaining({content:[{type:'text',text:'Fictional resumed answer'}]})])
    expect(effectCount).toBe(1); expect(providerRequests).toHaveLength(1)
    expect(mocks.release.mock.calls.map(call => [call[1],call[2]])).toEqual([['completed','resume-token-1']])
  })
  it('retries a deadlocked reply publication with the same completion identity and publishes it once', async () => {
    const {storedCompletions}=await import('../../turn/__tests__/fixtures/stored-publication.js')
    storedCompletions.length=0
    let failed=0
    mocks.addMessage.mockImplementation(async row => {
      if (row.role==='assistant'&&failed++===0) throw deadlock()
      return undefined
    })
    const events:Array<{kind:string;payload:Record<string,unknown>}>=[]
    expect(await replay({publishSessionEvent:event => {events.push(structuredClone(event) as never)}})(params())).toBe('completed')
    const replies=mocks.addMessage.mock.calls.map(([row]) => row).filter(row => row.role==='assistant')
    expect(replies).toHaveLength(2)
    expect(replies.every(row => JSON.stringify(row.content)===JSON.stringify([{type:'text',text:'Fictional resumed answer'}]))).toBe(true)
    expect(storedCompletions).toEqual([expect.objectContaining({lane:'resume',input:{kind:'approval',ref:'approved-invocation'}})])
    expect(effectCount).toBe(1); expect(providerRequests).toHaveLength(1)
    // One owner lifecycle: one start and an ordinary completion, no failure in between.
    expect(events.filter(event => event.kind==='turn_started')).toHaveLength(1)
    expect(events.at(-1)).toMatchObject({kind:'turn_completed'}); expect(events.at(-1)?.payload.reason).toBeUndefined()
  })
  it('stops after the bounded attempts and then records the failure outcome once', async () => {
    mocks.addMessage.mockImplementation(async row => {if (row.role==='system') throw deadlock()})
    await expect(replay()(params())).rejects.toMatchObject({code:'40P01'})
    const rows=mocks.addMessage.mock.calls.map(([row]) => row)
    expect(rows.filter(row => row.role==='system')).toHaveLength(RESUME_WRITE_ATTEMPTS)
    expect(rows.filter(row => row.role==='assistant')).toEqual([expect.objectContaining({content:[{type:'text',text:RESUME_FAILED_TEXT}]})])
    expect(effectCount).toBe(1); expect(providerRequests).toEqual([])
    expect(mocks.release).toHaveBeenCalledWith(session.id,'failed','resume-token-1')
  })
  it('never retries a write that is not a lock-conflict abort', async () => {
    mocks.addMessage.mockImplementation(async row => {if (row.role==='system') throw Object.assign(new Error('Fictional constraint'), {code:'23505'})})
    await expect(replay()(params())).rejects.toMatchObject({code:'23505'})
    expect(mocks.addMessage.mock.calls.filter(([row]) => row.role==='system')).toHaveLength(1)
  })
  it('withholds an uncertain approved-tool result and releases the owner', async () => {
    const uncertain=buildTool({name:'fixtureSend',description:'Fictional uncertain action',inputSchema:z.object({value:z.string()}),
      isReadOnly:false,isConcurrencySafe:false,async execute() {effectCount++;mocks.live.mockResolvedValue({...access,clearance:'public'});return {data:'Possibly sent'}}})
    const error=await replay({tools:new Map([[uncertain.name,uncertain]])})(params()).catch(caught => caught)
    expect(error).toBeInstanceOf(AuthorityChangedError)
    expect(error).toMatchObject({operationMayHaveExecuted:true,retrySafe:false})
    expect(effectCount).toBe(1); expect(providerRequests).toEqual([]); expect(mocks.addMessage).not.toHaveBeenCalled()
    expect(mocks.release).toHaveBeenCalledWith(session.id,'failed','resume-token-1')
  })
})
