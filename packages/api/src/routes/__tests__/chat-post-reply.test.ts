import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { describe, expect, it, vi } from 'vitest'
import type { AccessCeiling, ContentBlock } from '@use-brian/core'
import { AuthorityChangedError, createAuthorityLease } from '../../context-scope/authority-lease.js'
import { DeliveryAudienceUnverifiedError } from '../../context-scope/delivery-authority.js'
import type { TurnLoopResult } from '../../turn/kernel.js'
import { createChatPostReplyBoundary, afterReplyPublication } from '../chat-post-reply.js'

const ceiling: AccessCeiling = { workspaceId: 'workspace', userId: 'actor', clearance: 'internal',
  compartments: [], mutationCompartments: [], projectIds: [], visibilityAssistantIds: ['assistant'] }
const content: ContentBlock[] = [{ type: 'text', text: 'Hello.' }]
const completed: TurnLoopResult = { selection: { kind: 'text', text: 'Hello.' }, finalText: null, aborted: false }

describe('[COMP:api/chat-post-reply] completed reply authority refusal', () => {
  it('announces text completion only for successful live text and does not imply publication', () => {
    const boundary = createChatPostReplyBoundary(), abort = new AbortController()
    expect(boundary.beginFinalization(completed, false, abort.signal)).toBe(true)
    expect(boundary.isPublishedReply()).toBe(false)
    expect(boundary.beginFinalization(completed, true, abort.signal)).toBe(false)
    expect(boundary.beginFinalization({ ...completed, aborted: true }, false, abort.signal)).toBe(false)
    expect(boundary.beginFinalization({ ...completed, selection: { kind: 'empty', reason: 'tools_only' } }, false, abort.signal)).toBe(false)
    abort.abort()
    expect(boundary.beginFinalization(completed, false, abort.signal)).toBe(false)
  })

  it('does not start locking source reads or inference before publication commits', async () => {
    let publish!: () => void
    const pending = new Promise<void>(resolve => { publish = resolve })
    const events: string[] = []
    const result = afterReplyPublication(() => pending, async () => {
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
    await expect(afterReplyPublication(async () => { throw failure }, async () => {
      persist()
    })).rejects.toBe(failure)
    expect(persist).not.toHaveBeenCalled()
  })
  it('retains the saved reply while refusing follow-up effects under a changed policy', async () => {
    let policyCurrent = true
    const authority = createAuthorityLease(ceiling, async () => ceiling, async () => policyCurrent)
    const boundary = createChatPostReplyBoundary()
    boundary.beginFinalization(completed, false, new AbortController().signal)
    const saved: ContentBlock[][] = []
    await authority.execute(async () => { saved.push(content) })
    await authority.assertCurrent()
    boundary.recordPublishedReply(content)
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
    const boundary = createChatPostReplyBoundary()
    boundary.beginFinalization(completed, false, new AbortController().signal)
    let failure: unknown
    try {
      await authority.execute(async () => { policyCurrent = false })
      await authority.assertCurrent()
      boundary.recordPublishedReply(content)
    } catch (error) { failure = error }
    expect(failure).toMatchObject({ operationMayHaveExecuted: true })
    expect(boundary.notice(failure)).toBeNull()
    expect(boundary.isPublishedReply()).toBe(false)
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
  })

  it.each<{ row: ContentBlock[] }>([
    { row: [] }, { row: [{ type: 'text', text: '  ' }] },
    { row: [{ type: 'text', text: 'Checking.' }, { type: 'tool_use', id: 'tool-1', name: 'search', input: {} }] },
  ])('does not certify empty content or narration alongside a tool call: $row', ({ row }) => {
    const boundary = createChatPostReplyBoundary()
    boundary.beginFinalization(completed, false, new AbortController().signal)
    boundary.recordPublishedReply(row)
    expect(boundary.isPublishedReply()).toBe(false)
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
  })

  it('requires successful loop completion and a published final reply', () => {
    const boundary = createChatPostReplyBoundary()
    boundary.recordPublishedReply(content)
    expect(boundary.notice(new AuthorityChangedError())).toBeNull()
    for (const [result, providerFailed] of [
      [{ ...completed, aborted: true }, false],
      [completed, true],
      [{ ...completed, selection: { kind: 'empty', reason: 'tools_only' } }, false],
      [{ ...completed, selection: { kind: 'question', question: {} } }, false],
    ] as [TurnLoopResult, boolean][]) {
      boundary.beginFinalization(result, providerFailed, new AbortController().signal)
      boundary.recordPublishedReply(content)
      expect(boundary.isPublishedReply()).toBe(false)
      expect(boundary.notice(new AuthorityChangedError())).toBeNull()
    }
  })

  it('preserves uncertain operations, audience refusals, other errors and late cancellation', () => {
    const boundary = createChatPostReplyBoundary(), abort = new AbortController()
    boundary.beginFinalization(completed, false, abort.signal)
    boundary.recordPublishedReply(content)
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
    options: { enqueueSessionTitleJob: enqueue }, nativeTranscriptAuthority: {}, turnReleased: true,
    postReply: { isPublishedReply: () => true },
    classifySession: () => ({ anchor: { kind: 'none' }, transport: 'web', lane: 'conversation' }),
    session: { id: 'session', assistantId: 'assistant' }, assistant: { id: 'assistant' }, roomResponseGroupContext: null, docToolsTurn: true, docWrittenPageIds: new Set(),
    pinSessionTitleClaims: () => ({ userId: 'actor' }), req: {}, storedUserMsg: { id: 'message' },
    isAuthorityChangedError: (error: unknown) => error instanceof AuthorityChangedError,
    isDeliveryAudienceUnverifiedError: () => false, readSessionTitle: readTitle, isPlaceholderTitle: () => false,
    attendedSessionTurnCount: vi.fn(async () => 1), dbMessages: [],
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

const releaseBlock = route.slice(route.indexOf('      // Release the lease we took at claim time'),
  route.indexOf('      // Memory nudge: judge utility'))
const catchBlock = route.slice(route.indexOf('      if (sessionIdForError && userIdForError) {'),
  route.indexOf('      // Only log if we have at least user context'))
function routeBoundary(released: boolean, grouped = false, writtenPages: string[] = []) {
  const events: string[] = []
  const bus: unknown[] = []
  const releaseTurn = vi.fn(async () => released)
  const scope = {
    session: { id: 'session' }, user: { id: 'actor' }, releaseTurn,
    activeResolvers: new Map(), abortRegistryToken: null,
    unregisterTurnAbort: vi.fn(), roomTurnAddressers: new Map(), approvalResolverIndex: new Map(),
    turnPolicy: { liveFollow: true }, isBackgroundTurn: true, clientGone: true,
    publishSessionEvent: (event: unknown) => bus.push(event),
    docCtx: false, docToolsTurn: true, docWrittenPageIds: new Set(writtenPages), roomResponseGroupContext: grouped ? {} : null,
    postReply: { isPublishedReply: () => true }, turnInboxHandle: { close: vi.fn() },
    sendEvent: (name: string) => events.push(name), turnTiming: { add: vi.fn(), snapshot: () => ({ total_ms: 10 }) },
    sessionIdForError: 'session', userIdForError: 'actor', postReplyNotice: {}, recoveryDelivered: false,
  }
  const code = ts.transpileModule(`return (async () => {
    let turnLeaseToken = 'lease', turnReleased = false, turnCompletionPublished = false;
    ${releaseBlock}
    const tokenAfterRelease = turnLeaseToken;
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
