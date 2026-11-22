import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock } from '@use-brian/agent-runtime/providers/types.js'
import type { AccessCeiling } from '@use-brian/agent-runtime/security/access-ceiling.js'
import { AuthorityChangedError, createAuthorityLease } from '../../context-scope/authority-lease.js'
import { DeliveryAudienceUnverifiedError } from '../../context-scope/delivery-authority.js'
import type { TurnLoopResult } from '../../turn/kernel.js'
import { openAssistantTurn, type AssistantTurn } from '../../turn/kernel.js'
vi.mock('../../turn/lease.js',async importOriginal=>({...await importOriginal<typeof import('../../turn/lease.js')>(),
 takeTurnLease:async()=>({taken:true,token:'fixture-token'}),
 registerTurnAbort:vi.fn(),unregisterTurnAbort:vi.fn(),startLeaseHeartbeat:()=>()=>{},releaseTurn:async()=>true,
}))
// The owner's stored writer: a single row is one `addSessionMessage` inside the adapter bracket.
// The durable stored writer and completion reconciliation stay off any database (8277).
vi.mock('../../db/conversation-store.js', async importOriginal => (await import('../../turn/__tests__/fixtures/stored-publication.js')).storedPublicationModule(await importOriginal()))
vi.mock('../../db/conversation-publication-recovery.js', async importOriginal => (await import('../../turn/__tests__/fixtures/stored-publication.js')).completionRecoveryModule(await importOriginal()))
vi.mock('../../db/sessions.js',async importOriginal=>({...await importOriginal<typeof import('../../db/sessions.js')>(),
 addSessionMessage:async(row:{sessionId:string;role:string;content:unknown})=>({id:'fixture-row',sessionId:row.sessionId,role:row.role,
  content:row.content,sequenceNum:1,createdAt:new Date()}),
}))
/** The reply through the owner's one publication path (no store, no SQL). */
function publishReply(owner:AssistantTurn,row:ContentBlock[],execute=<T,>(operation:()=>Promise<T>)=>operation()){
 return owner.publish({disposition:'reply',rows:[{role:'assistant',content:row}],write:{scope:{} as never},execute})
}
const owners:AssistantTurn[]=[]
async function replyOwner(abortController=new AbortController()){
 const owner=await openAssistantTurn({sessionId:'fixture-session',policy:{admission:'personal'},abortController})
 owners.push(owner);return owner
}
afterEach(async()=>{for(const owner of owners.splice(0))await owner.finish()})

const ceiling: AccessCeiling = { workspaceId: 'workspace', userId: 'actor', clearance: 'internal',
  compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: ['assistant'] }
const content: ContentBlock[] = [{ type: 'text', text: 'Hello.' }]
const completed: TurnLoopResult = { selection: { kind: 'text', text: 'Hello.' }, finalText: null, aborted: false }

describe('[COMP:api/chat-post-reply] completed reply authority refusal', async () => {
  it('announces text completion once without claiming a saved reply or hiding a later failure', async () => {
    const boundary = await replyOwner(), announce = vi.fn()
    boundary.announceTextCompletion(announce)
    expect(boundary.isPublishedReply()).toBe(false)
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
    boundary.beginFinalization(completed, false)
    boundary.announceTextCompletion(announce)
    expect(announce).toHaveBeenCalledOnce()
    expect(boundary.completion).toMatchObject({ state: 'unpublished', durable: false, publishedReply: false })
    await publishReply(boundary, content)
    expect(boundary.isPublishedReply()).toBe(true)
    expect(boundary.completion).toMatchObject({ state: 'committed', durable: false, publishedReply: true })
    await expect(publishReply(boundary, content)).rejects.toThrow('already published')
  })
  it('announces text completion only for successful live text and does not imply publication', async () => {
    const abort = new AbortController(), boundary = await replyOwner(abort)
    expect(boundary.beginFinalization(completed, false)).toBe(true)
    expect(boundary.isPublishedReply()).toBe(false)
    expect(boundary.beginFinalization(completed, true)).toBe(false)
    expect(boundary.beginFinalization({ ...completed, aborted: true }, false)).toBe(false)
    expect(boundary.beginFinalization({ ...completed, selection: { kind: 'empty', reason: 'tools_only' } }, false)).toBe(false)
    abort.abort()
    expect(boundary.beginFinalization(completed, false)).toBe(false)
  })

  it('does not start locking source reads or inference before publication commits', async () => {
    let publish!: () => void
    const pending = new Promise<void>(resolve => { publish = resolve })
    const events: string[] = []
    const owner = await replyOwner()
    const result = owner.afterReplyPublication(() => pending, async () => {
      events.push('inference')
      events.push('persist')
      return 7
    })
    await Promise.resolve()
    expect(events).toEqual([])
    publish()
    await expect(result).resolves.toBe(7)
    expect(events).toEqual(['inference', 'persist'])
  })

  it('does not start follow-up work when publication fails', async () => {
    const failure = new Error('Fictional publication failure'), persist = vi.fn()
    const owner = await replyOwner()
    await expect(owner.afterReplyPublication(async () => { throw failure }, async () => {
      persist()
    })).rejects.toBe(failure)
    expect(persist).not.toHaveBeenCalled()
  })
  it('retains the saved reply while refusing follow-up effects under a changed policy', async () => {
    let policyCurrent = true
    const authority = createAuthorityLease(ceiling, async () => ceiling, async () => policyCurrent)
    const boundary = await replyOwner()
    boundary.beginFinalization(completed, false)
    const saved: ContentBlock[][] = []
    await publishReply(boundary, content, operation => authority.execute(async () => { saved.push(content); return operation() }))
    await authority.assertCurrent()
    expect(boundary.isPublishedReply()).toBe(true)
    policyCurrent = false
    const followUp = vi.fn()
    let failure: unknown
    try { await authority.execute(followUp) } catch (error) { failure = error }
    expect(followUp).not.toHaveBeenCalled()
    expect(saved).toEqual([content])
    expect(boundary.notice(failure)).toMatchObject({ code: 'post_reply_authority_changed' })
    policyCurrent = true
    await expect(authority.assertCurrent()).rejects.toBeInstanceOf(AuthorityChangedError)
  })

  it('does not certify publication when authority changes during the save', async () => {
    let policyCurrent = true
    const authority = createAuthorityLease(ceiling, async () => ceiling, async () => policyCurrent)
    const boundary = await replyOwner()
    boundary.beginFinalization(completed, false)
    let failure: unknown
    try {
      await publishReply(boundary, content, operation => authority.execute(async () => { policyCurrent = false; return operation() }))
      await authority.assertCurrent()
    } catch (error) { failure = error }
    expect(failure).toMatchObject({ operationMayHaveExecuted: true })
    // An uncertain commit is recorded as such; the owner never replays the reply.
    expect(boundary.completion.state).toBe('uncertain')
    await expect(publishReply(boundary, content)).rejects.toThrow('already published')
    expect(boundary.notice(failure)).toBeNull()
    expect(boundary.isPublishedReply()).toBe(false)
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
  })

  it.each<{ row: ContentBlock[] }>([
    { row: [] }, { row: [{ type: 'text', text: '  ' }] },
    { row: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tool-1', name: 'search', input: {} }] },
  ])('does not certify empty content or narration alongside a tool call: $row', async ({ row }) => {
    const boundary = await replyOwner()
    boundary.beginFinalization(completed, false)
    await publishReply(boundary, row)
    expect(boundary.isPublishedReply()).toBe(false)
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
  })

  it('requires successful loop completion and a published final reply', async () => {
    const boundary = await replyOwner()
    await publishReply(boundary, content)
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
    for (const [result, providerFailed] of [
      [{ ...completed, aborted: true }, false],
      [completed, true],
      [{ ...completed, selection: { kind: 'empty', reason: 'tools_only' } }, false],
      [{ ...completed, selection: { kind: 'question', question: {} } }, false],
    ] as [TurnLoopResult, boolean][]) {
      const owner = await replyOwner()
      owner.beginFinalization(result, providerFailed)
      await publishReply(owner, content)
      expect(owner.isPublishedReply()).toBe(false)
      expect(owner.notice(new AuthorityChangedError())).toBeNull()
    }
  })

  it('preserves uncertain operations, audience refusals, other errors and late cancellation', async () => {
    const abort = new AbortController(), boundary = await replyOwner(abort)
    boundary.beginFinalization(completed, false)
    await publishReply(boundary, content)
    for (const error of [new AuthorityChangedError(true), new DeliveryAudienceUnverifiedError(),
      new Error('database failure'), { reason: 'authority_changed' }]) {
      expect(boundary.notice(error)).toBeNull()
    }
    expect(boundary.notice(new AuthorityChangedError())).not.toBeNull()
    abort.abort()
    expect(boundary.isPublishedReply()).toBe(false)
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
  })
})

// Exercise the actual route boundary with a delayed/failed release and a late
// follow-up error. No provider or database boundary is needed for these states.
const route = readFileSync(new URL('../chat.ts', import.meta.url), 'utf8')
const metadataStart = route.indexOf('      // Metadata has its own durable, freshly authorized worker.')
const metadataScheduling = route.slice(metadataStart, route.indexOf('      if (shouldTitle) {', metadataStart))
function titleScheduling(accepted: boolean, failure?: Error) {
  const enqueue = vi.fn(async () => { if (failure) throw failure; return accepted })
  const readTitle = vi.fn(async () => null)
  const scope = {
    programmatic: undefined, pageBoundTurn: false,
    options: { enqueueSessionTitleJob: enqueue }, nativeTranscriptAuthority: {}, turnOwner: { released: true, isPublishedReply: () => true },
    postReply: { isPublishedReply: () => true },
    classifySession: () => ({ anchor: { kind: 'none' }, transport: 'web', lane: 'conversation' }),
    session: { id: 'session', assistantId: 'assistant' }, assistant: { id: 'assistant' }, roomResponseGroupContext: null, docToolsTurn: true, docWrittenPageIds: new Set(),
    pinSessionTitleClaims: () => ({ userId: 'actor' }), req: {}, storedUserMsg: { id: 'message' },
    isAuthorityChangedError: (error: unknown) => error instanceof AuthorityChangedError,
    isDeliveryAudienceUnverifiedError: () => false, readSessionTitle: readTitle, isPlaceholderTitle: () => false,
    storedUserSource: { resourceKind: 'session_message' },
    preparedHistory: { readTurnCount: vi.fn(async () => 1) }, dbMessages: [],
    authority: { execute: (fn: () => unknown) => fn() }, countSessionTurns: vi.fn(async () => 2),
  }
  const code = ts.transpileModule(`return (async () => { ${metadataScheduling}; return { titleQueued, shouldTitle }; })();`,
    { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return { enqueue, readTitle, scope, run: () => new Function(...Object.keys(scope), code)(...Object.values(scope)) }
}

describe('[COMP:api/chat-post-reply] durable title scheduling', () => {
  it('queues ordinary Chat even when page tools are available, without reading title history inline', async () => {
    const test = titleScheduling(true)
    await expect(test.run()).resolves.toEqual({ titleQueued: true, shouldTitle: false })
    expect(test.enqueue).toHaveBeenCalledOnce()
    expect(test.readTitle).not.toHaveBeenCalled()
  })
  it('retains the original inline path when no durable job was accepted', async () => {
    const test = titleScheduling(false)
    await expect(test.run()).resolves.toEqual({ titleQueued: false, shouldTitle: true })
    expect(test.readTitle).toHaveBeenCalledOnce()
  })
  it('does not queue a turn that still owes document effects', async () => {
    const test = titleScheduling(true)
    test.scope.docWrittenPageIds.add('page')
    await expect(test.run()).resolves.toEqual({ titleQueued: false, shouldTitle: true })
    expect(test.enqueue).not.toHaveBeenCalled()
  })
  it('retains inline titles for a different answering assistant', async () => {
    const test = titleScheduling(true)
    test.scope.assistant.id = 'other-assistant'
    await expect(test.run()).resolves.toEqual({ titleQueued: false, shouldTitle: true })
    expect(test.enqueue).not.toHaveBeenCalled()
    expect(test.readTitle).toHaveBeenCalledOnce()
  })
  it('propagates authority loss instead of starting an inline fallback', async () => {
    const failure = new AuthorityChangedError(), test = titleScheduling(false, failure)
    await expect(test.run()).rejects.toBe(failure)
    expect(test.readTitle).not.toHaveBeenCalled()
  })
})

// Read complete AST statements from the actual foreground settlement block.
// There is also an earlier deterministic-return finish; text indexOf selected
// that unrelated branch and produced a syntactically broken stitched function.
const settlementTree = ts.createSourceFile('chat.ts', route, ts.ScriptTarget.Latest, true)
let releaseBlock = '', catchBlock = ''
const isFinish = (node: ts.Node) => ts.isExpressionStatement(node) && ts.isAwaitExpression(node.expression)
  && ts.isCallExpression(node.expression.expression) && node.expression.expression.expression.getText(settlementTree) === 'ownedTurn.finish'
function findSettlement(node: ts.Node) {
  if (ts.isBlock(node)) {
    const start = node.statements.findIndex(isFinish)
    const end = node.statements.findIndex(statement => ts.isVariableStatement(statement)
      && statement.declarationList.declarations.some(declaration => declaration.name.getText(settlementTree) === 'nudgeModel'))
    if (start >= 0 && end > start) releaseBlock = node.statements.slice(start, end).map(statement => statement.getText(settlementTree)).join('\n')
  }
  if (ts.isIfStatement(node) && node.expression.getText(settlementTree).replace(/\s/g, '') === 'sessionIdForError&&userIdForError'
    && node.thenStatement.getText(settlementTree).includes('await turnOwner?.finish')) catchBlock = node.getText(settlementTree)
  ts.forEachChild(node, findSettlement)
}
findSettlement(settlementTree)
if (!releaseBlock || !catchBlock) throw new Error('Missing actual foreground settlement boundaries')
function routeBoundary(released: boolean, grouped = false, writtenPages: string[] = []) {
  const events: string[] = []
  const bus: unknown[] = []
  const turnOwner = { released: false, isPublishedReply: () => true, finish: vi.fn(async () => { turnOwner.released = released; return released }) }
  const releaseTurn = turnOwner.finish
  const scope = {
    programmatic: undefined,
    session: { id: 'session' }, user: { id: 'actor' }, turnOwner, ownedTurn: turnOwner,
    activeResolvers: new Map(), abortRegistryToken: null,
    unregisterTurnAbort: vi.fn(), roomTurnAddressers: new Map(), approvalResolverIndex: new Map(),
    turnPolicy: { liveFollow: true }, isBackgroundTurn: true, clientGone: true,
    publishSessionEvent: (event: unknown) => bus.push(event),
    docCtx: false, docToolsTurn: true, docWrittenPageIds: new Set(writtenPages), roomResponseGroupContext: grouped ? {} : null,
    postReply: { isPublishedReply: () => true }, turnInboxHandle: { close: vi.fn() },
    sendEvent: (name: string) => events.push(name), turnTiming: { add: vi.fn(), snapshot: () => ({ total_ms: 10 }) },
    sessionIdForError: 'session', userIdForError: 'actor', postReplyNotice: {}, recoveryDelivered: false, stoppedByUser: false, err: new Error('late metadata failure'),
  }
  const code = ts.transpileModule(`return (async () => {
    let turnCompletionPublished = false;
    ${releaseBlock}
    const tokenAfterRelease = turnOwner.released ? null : 'lease';
    ${catchBlock}
    return { tokenAfterRelease };
  })();`, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText
  return { events, bus, releaseTurn, run: () => new Function(...Object.keys(scope), code)(...Object.values(scope)) }
}
describe('[COMP:api/chat-post-reply] foreground route boundary', () => {
  it('announces one completion after release and never repeats it on a late metadata failure', async () => {
    const test = routeBoundary(true)
    expect(await test.run()).toEqual({ tokenAfterRelease: null })
    expect(test.events).toEqual(['reply_complete'])
    expect(test.bus).toHaveLength(1)
  })
  it('retains cleanup ownership and withholds readiness when release fails', async () => {
    const test = routeBoundary(false)
    expect(await test.run()).toEqual({ tokenAfterRelease: 'lease' })
    expect(test.events).toEqual([])
    expect(test.releaseTurn).toHaveBeenCalledTimes(2)
  })
  it('keeps actual page authoring pending while allowing ordinary chats with page capabilities', async () => {
    const test = routeBoundary(true, false, ['page'])
    await test.run()
    expect(test.events).toEqual([])
  })
  it('keeps a multi-assistant response group on its existing full completion boundary', async () => {
    const test = routeBoundary(true, true)
    await test.run()
    expect(test.events).toEqual([])
  })
})


describe('[COMP:api/chat-post-reply] nonblocking commitment analysis', () => {
  const start = route.indexOf('            const stateJobKind = classifySession(session)')
  const end = route.indexOf('            // Source-authority reads lock rows too.', start)
  const body = ts.transpileModule(route.slice(start, end), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText
  const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor
  function setup() {
    const events: string[] = []
    const scope = {
    programmatic: undefined,
      classifySession: () => ({ anchor: { kind: 'none' }, transport: 'web', lane: 'conversation' }),
      session: { id: 'session', assistantId: 'assistant' }, assistant: { id: 'assistant' }, user: { id: 'actor' },
      nativeTranscriptAuthority: {}, roomResponseGroupContext: null, docToolsTurn: false, docWrittenPageIds: new Set(),
      executionContext: {identity: {kind: 'attended', principal: {kind: 'workspace_member', authenticationKind: 'native_session'}}},
      options: { enqueueSessionStateJob: vi.fn(async () => { events.push('enqueue'); return true }), analytics: {logEvent: vi.fn()} },
      turnOwner: { isPublishedReply: () => true }, publishReply: vi.fn(async () => { events.push('saved') }), postReply: { isPublishedReply: () => true },
      lastAssistantMessageId: 'reply', storedUserMsg: { id: 'question' }, req: {}, pinSessionTitleClaims: () => ({ userId: 'actor' }),
      isAuthorityChangedError: () => false, isDeliveryAudienceUnverifiedError: () => false,
      console: { warn: vi.fn() },
    }
    const run = () => new AsyncFunction(...Object.keys(scope), body)(...Object.values(scope))
    return { scope, events, run }
  }
  it('returns after saving and enqueueing without waiting for the worker model', async () => {
    const f = setup(); await f.run()
    expect(f.events).toEqual(['saved', 'enqueue'])
    expect(f.scope.options.enqueueSessionStateJob).toHaveBeenCalledWith(expect.objectContaining({ userMessageId: 'question', assistantMessageId: 'reply' }))
  })
  it('never enqueues failed publication and never falls back to blocking inference on queue failure', async () => {
    const f = setup(); f.scope.publishReply.mockRejectedValue(new Error('save failed'))
    await expect(f.run()).rejects.toThrow('save failed')
    expect(f.scope.options.enqueueSessionStateJob).not.toHaveBeenCalled()
    f.scope.publishReply.mockResolvedValue();f.scope.options.enqueueSessionStateJob.mockRejectedValue(new Error('queue unavailable'))
    await f.run()
    expect(f.scope.options.analytics.logEvent).toHaveBeenLastCalledWith(expect.objectContaining({eventName:'session_state_diff_enqueue_failed'}))
  })
})
