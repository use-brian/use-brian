import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ChannelConfirmations, type ChannelInteractionScope } from '../channel-confirmations.js'
import { CONFIRMATION_DECISIONS, type NormalizedConfirmationEvent } from '../confirmation-events.js'
import { createConfirmationResolver, type ConfirmationResolver, type ToolConfirmationRequest } from '../types.js'

const scope: ChannelInteractionScope = {
  channelType: 'slack', integrationId: 'integration', conversationId: 'room', senderId: 'actor', sessionId: 'thread',
}
const request: ToolConfirmationRequest = {
  toolCallId: 'call', toolName: 'tool', serverName: 'server', input: {}, classification: null, description: 'Confirm',
}
const yes: NormalizedConfirmationEvent = { kind: 'text', text: 'yes' }
const click: NormalizedConfirmationEvent = { kind: 'action', data: 'mcp_confirm:call:allow' }
const unavailable = { handled: true, status: 'unavailable' }
const message = { handled: false, status: 'message' }
function resolver(): ConfirmationResolver & { resolve: ReturnType<typeof vi.fn> } {
  return { resolve: vi.fn(), waitForDecision: vi.fn() }
}
beforeEach(() => vi.useFakeTimers())
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.restoreAllMocks() })

describe('ChannelConfirmations', () => {
  describe('native delivery provenance', () => {
    const nativeScope = { ...scope, sessionId: undefined }
    const nativeClick: NormalizedConfirmationEvent = { ...click, sourceMessageId: 'card' }

    it('recovers a missing session only after binding the exact delivery and consumes it once', () => {
      const registry = new ChannelConfirmations(), r = resolver()
      registry.register(scope, request, r)
      expect(registry.handle(nativeScope, nativeClick)).toEqual(unavailable)
      expect(registry.bindMessage(scope, 'call', 'card')).toBe(true)
      expect(registry.handle(nativeScope, click)).toEqual(unavailable)
      expect(registry.handle(nativeScope, nativeClick).status).toBe('resolved')
      expect(registry.handle(nativeScope, nativeClick)).toEqual(unavailable)
      expect(r.resolve).toHaveBeenCalledExactlyOnceWith('call', 'allow', undefined)
      expect(registry.bindMessage(scope, 'call', 'card')).toBe(false)
    })

    it.each(['channelType', 'integrationId', 'conversationId', 'senderId'] as const)('never recovers a different %s', key => {
      const registry = new ChannelConfirmations(), r = resolver()
      registry.register(scope, request, r)
      expect(registry.bindMessage({ ...scope, [key]: 'other' }, 'call', 'card')).toBe(false)
      registry.bindMessage(scope, 'call', 'card')
      expect(registry.handle({ ...nativeScope, [key]: 'other' }, nativeClick)).toEqual(unavailable)
      expect(r.resolve).not.toHaveBeenCalled()
      expect(registry.handle(nativeScope, nativeClick).status).toBe('resolved')
    })

    it('rejects wrong, missing and unbound messages without bypassing session checks', () => {
      const registry = new ChannelConfirmations(), r = resolver()
      registry.register(scope, request, r)
      expect(registry.bindMessage(nativeScope, 'call', 'card')).toBe(false)
      expect(registry.bindMessage(scope, 'wrong-call', 'card')).toBe(false)
      expect(registry.bindMessage(scope, 'call', '  ')).toBe(false)
      registry.bindMessage(scope, 'call', 'card')
      expect(registry.bindMessage(scope, 'call', 'card')).toBe(true)
      expect(registry.bindMessage(scope, 'call', 'replacement')).toBe(false)
      for (const sourceMessageId of ['', 'wrong', undefined]) {
        expect(registry.handle(nativeScope, { ...click, sourceMessageId })).toEqual(unavailable)
      }
      expect(registry.handle(scope, { ...click, sourceMessageId: 'wrong' })).toEqual(unavailable)
      expect(registry.handle(nativeScope, { kind: 'action', data: 'mcp_confirm:wrong:allow', sourceMessageId: 'card' })).toEqual(unavailable)
      expect(registry.handle(nativeScope, { kind: 'decision', toolCallId: 'call', decision: 'allow' })).toEqual(unavailable)
      expect(registry.handle(nativeScope, yes)).toEqual(message)
      expect(r.resolve).not.toHaveBeenCalled()
      expect(registry.handle(nativeScope, nativeClick).status).toBe('resolved')
    })

    it('binds by exact session even when other sessions share a tool id', () => {
      const registry = new ChannelConfirmations(), first = resolver(), second = resolver()
      const otherScope = { ...scope, sessionId: 'other-thread' }
      registry.register(scope, request, first)
      registry.register(otherScope, request, second)
      expect(registry.bindMessage(scope, 'call', 'card')).toBe(true)
      expect(registry.bindMessage(otherScope, 'call', 'other-card')).toBe(true)
      expect(registry.handle(nativeScope, nativeClick).status).toBe('resolved')
      expect(first.resolve).toHaveBeenCalledOnce()
      expect(second.resolve).not.toHaveBeenCalled()
      expect(registry.handle(nativeScope, { ...click, sourceMessageId: 'other-card' }).status).toBe('resolved')
    })

    it('does not bind ambiguous registrations or select among duplicate delivery bindings', () => {
      const registry = new ChannelConfirmations(), r = resolver()
      registry.register(scope, request, r)
      const dispose = registry.register(scope, request, resolver())
      expect(registry.bindMessage(scope, 'call', 'card')).toBe(false)
      dispose()
      registry.bindMessage(scope, 'call', 'card')
      const otherScope = { ...scope, sessionId: 'other-thread' }
      registry.register(otherScope, request, r)
      registry.bindMessage(otherScope, 'call', 'card')
      expect(registry.handle(nativeScope, nativeClick)).toEqual(unavailable)
      expect(r.resolve).not.toHaveBeenCalled()
    })

    it.each(['dispose', 'clear', 'expire'] as const)('drops delivery provenance after %s', operation => {
      const registry = new ChannelConfirmations(), r = resolver()
      const dispose = registry.register(scope, request, r)
      registry.bindMessage(scope, 'call', 'card')
      if (operation === 'dispose') dispose()
      if (operation === 'clear') registry.clear(r)
      if (operation === 'expire') vi.advanceTimersByTime(300_000)
      expect(registry.bindMessage(scope, 'call', 'late-card')).toBe(false)
      registry.register(scope, request, r)
      expect(registry.handle(nativeScope, nativeClick)).toEqual(unavailable)
      registry.clear(r)
    })

    it('delivery provenance does not grant persistent approval', () => {
      const registry = new ChannelConfirmations(), r = resolver()
      registry.register(scope, request, r)
      registry.bindMessage(scope, 'call', 'card')
      expect(registry.handle(nativeScope, { kind: 'action', data: 'mcp_confirm:call:always_allow', sourceMessageId: 'card' })).toEqual(unavailable)
      expect(r.resolve).not.toHaveBeenCalled()
    })
  })

  it('passes text through with no pending prompt but consumes unavailable explicit controls', () => {
    const registry = new ChannelConfirmations()
    for (const text of ['yes', 'always', 'hello']) expect(registry.handle(scope, { kind: 'text', text })).toEqual(message)
    expect(registry.handle(scope, click)).toEqual(unavailable)
  })

  it('old disposers and abort signals cannot remove or deny a later registration', () => {
    const registry = new ChannelConfirmations(), r = resolver(), controller = new AbortController()
    const dispose = registry.register(scope, request, r, controller.signal)
    registry.clear(r)
    registry.register(scope, { ...request, toolCallId: 'later' }, r)
    dispose(); controller.abort()
    expect(r.resolve).not.toHaveBeenCalled()
    expect(registry.handle(scope, click)).toEqual(unavailable)
    expect(registry.handle(scope, yes).status).toBe('resolved')
    expect(r.resolve).toHaveBeenCalledExactlyOnceWith('later', 'allow', undefined)
  })

  it('allows a decision immediately before expiry and never denies it later', () => {
    const registry = new ChannelConfirmations(), r = resolver()
    registry.register(scope, request, r)
    vi.advanceTimersByTime(299_999)
    expect(registry.handle(scope, yes).status).toBe('resolved')
    vi.advanceTimersByTime(1)
    expect(r.resolve).toHaveBeenCalledExactlyOnceWith('call', 'allow', undefined)
  })

  it.each(CONFIRMATION_DECISIONS)('supports %s across all normalized surfaces', decision => {
    for (const event of [
      { kind: 'text', text: ({ allow: ' YES ', deny: 'No', always_allow: 'always allow', always_deny: 'never' })[decision] },
      { kind: 'action', data: `mcp_confirm:call:${decision}` },
      { kind: 'decision', toolCallId: ' call ', decision, comment: ' reason ' },
    ] satisfies NormalizedConfirmationEvent[]) {
      const registry = new ChannelConfirmations(), r = resolver()
      registry.register(scope, { ...request, allowPersistentApproval: true }, r)
      expect(registry.handle(scope, event)).toEqual({ handled: true, status: 'resolved', decision })
      expect(r.resolve).toHaveBeenCalledExactlyOnceWith('call', decision, event.kind === 'decision' ? 'reason' : undefined)
      expect(registry.handle(scope, click)).toEqual(unavailable)
      expect(vi.getTimerCount()).toBe(0)
    }
  })

  it.each(['channelType', 'integrationId', 'conversationId', 'senderId', 'sessionId'] as const)('isolates %s for text, actions and decisions', key => {
    const registry = new ChannelConfirmations(), r = resolver()
    registry.register(scope, request, r)
    for (const event of [yes, click, { kind: 'decision', toolCallId: 'call', decision: 'allow' }] satisfies NormalizedConfirmationEvent[]) {
      expect(registry.handle({ ...scope, [key]: 'other' }, event)).toEqual(event.kind === 'text' ? message : unavailable)
    }
    expect(r.resolve).not.toHaveBeenCalled()
    expect(registry.handle(scope, yes).status).toBe('resolved')
  })

  it('does not infer a thread from an explicit tool id; supports the unthreaded fallback', () => {
    const registry = new ChannelConfirmations(), r = resolver()
    registry.register(scope, request, r)
    expect(registry.handle({ ...scope, sessionId: undefined }, click)).toEqual(unavailable)
    registry.clear(r)
    registry.register({ ...scope, sessionId: undefined }, request, r)
    expect(registry.handle({ ...scope, sessionId: scope.conversationId }, yes).status).toBe('resolved')
  })

  it('never selects arbitrarily among pending text confirmations; explicit ids disambiguate', () => {
    const registry = new ChannelConfirmations(), first = resolver(), second = resolver()
    registry.register(scope, request, first)
    registry.register(scope, { ...request, toolCallId: 'second' }, second)
    for (const text of ['yes', 'always', 'no', 'new question']) expect(registry.handle(scope, { kind: 'text', text })).toEqual(unavailable)
    expect(first.resolve).not.toHaveBeenCalled()
    expect(second.resolve).not.toHaveBeenCalled()
    expect(registry.handle(scope, click).status).toBe('resolved')
    expect(second.resolve).not.toHaveBeenCalled()
    expect(registry.handle(scope, yes).status).toBe('resolved')
  })

  it('rejects even explicit ids when duplicate pending registrations are ambiguous', () => {
    const registry = new ChannelConfirmations(), first = resolver(), second = resolver()
    registry.register(scope, request, first)
    const dispose = registry.register(scope, request, second)
    expect(registry.handle(scope, click)).toEqual(unavailable)
    expect(first.resolve).not.toHaveBeenCalled()
    expect(second.resolve).not.toHaveBeenCalled()
    dispose()
    expect(registry.handle(scope, click).status).toBe('resolved')
  })

  it('other senders and integrations do not create ambiguity or receive decisions', () => {
    const registry = new ChannelConfirmations(), first = resolver(), other = resolver()
    registry.register(scope, request, first)
    registry.register({ ...scope, senderId: 'other' }, request, other)
    registry.register({ ...scope, integrationId: 'other' }, request, other)
    registry.register({ ...scope, sessionId: 'other' }, request, other)
    expect(registry.handle(scope, yes).status).toBe('resolved')
    expect(first.resolve).toHaveBeenCalledOnce()
    expect(other.resolve).not.toHaveBeenCalled()
  })

  it.each([undefined, false])('rejects persistent decisions when capability is %s without consuming pending state', allowPersistentApproval => {
    const registry = new ChannelConfirmations(), r = resolver()
    registry.register(scope, { ...request, allowPersistentApproval }, r)
    for (const decision of ['always_allow', 'always_deny']) {
      for (const event of [
        { kind: 'text', text: decision === 'always_allow' ? 'always' : 'never' },
        { kind: 'action', data: `mcp_confirm:call:${decision}` },
        { kind: 'decision', toolCallId: 'call', decision },
      ] satisfies NormalizedConfirmationEvent[]) expect(registry.handle(scope, event)).toEqual(unavailable)
    }
    expect(r.resolve).not.toHaveBeenCalled()
    expect(registry.handle(scope, click).status).toBe('resolved')
  })

  it('snapshots scope, tool id and persistent capability at registration', () => {
    const registry = new ChannelConfirmations(), r = resolver(), mutableScope = { ...scope }, mutableRequest = { ...request }
    registry.register(mutableScope, mutableRequest, r)
    mutableScope.senderId = 'intruder'
    mutableRequest.toolCallId = 'replacement'
    mutableRequest.allowPersistentApproval = true
    expect(registry.handle(scope, { kind: 'text', text: 'always' })).toEqual(unavailable)
    expect(registry.handle(scope, click).status).toBe('resolved')
    expect(r.resolve).toHaveBeenCalledExactlyOnceWith('call', 'allow', undefined)
  })

  it.each([
    { kind: 'action', data: null }, { kind: 'action', data: 'mcp_confirm:call:bogus' },
    { kind: 'action', data: 'mcp_confirm:call:allow:extra' }, { kind: 'action', data: 'mcp_confirm::allow' },
    { kind: 'action', data: 'other:call:allow' }, { kind: 'action', data: 'mcp_confirm:stale:allow' },
    { kind: 'decision', toolCallId: 'call', decision: 'bogus' },
    { kind: 'decision', toolCallId: 123, decision: 'allow' },
    { kind: 'decision', toolCallId: 'call', decision: 'allow', comment: {} },
  ] satisfies NormalizedConfirmationEvent[])('rejects malformed/stale event %j without consuming the request', event => {
    const registry = new ChannelConfirmations(), r = resolver()
    registry.register(scope, request, r)
    expect(registry.handle(scope, event)).toEqual(unavailable)
    expect(r.resolve).not.toHaveBeenCalled()
    expect(registry.handle(scope, click).status).toBe('resolved')
  })

  it('denies unrelated text but lets it continue as a new message', () => {
    const registry = new ChannelConfirmations(), r = resolver()
    registry.register(scope, request, r)
    expect(registry.handle(scope, { kind: 'text', text: 'new question' })).toEqual({ handled: false, status: 'resolved', decision: 'deny' })
    expect(r.resolve).toHaveBeenCalledExactlyOnceWith('call', 'deny', undefined)
    expect(registry.handle(scope, yes)).toEqual(message)
  })

  it.each(['click-first', 'text-first'] as const)('consumes synchronously against reentrancy and replay (%s)', order => {
    const registry = new ChannelConfirmations(), r = resolver()
    const events = order === 'click-first' ? [click, yes] : [yes, click]
    registry.register(scope, request, r)
    r.resolve.mockImplementation(() => expect(registry.handle(scope, click)).toEqual(unavailable))
    expect(registry.handle(scope, events[0]!).status).toBe('resolved')
    registry.handle(scope, events[1]!)
    expect(r.resolve).toHaveBeenCalledOnce()
  })

  it.each(['dispose', 'clear', 'resolve', 'abort', 'expire'] as const)('cleans timers and abort listeners on %s', operation => {
    const registry = new ChannelConfirmations(), r = resolver(), controller = new AbortController()
    const remove = vi.spyOn(controller.signal, 'removeEventListener')
    const dispose = registry.register(scope, request, r, controller.signal)
    if (operation === 'dispose') dispose()
    if (operation === 'clear') registry.clear(r)
    if (operation === 'resolve') registry.handle(scope, click)
    if (operation === 'abort') controller.abort()
    if (operation === 'expire') vi.advanceTimersByTime(300_000)
    expect(remove).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
    const count = operation === 'dispose' || operation === 'clear' ? 0 : 1
    expect(r.resolve).toHaveBeenCalledTimes(count)
    dispose(); registry.clear(r); controller.abort(); vi.advanceTimersByTime(600_000)
    expect(r.resolve).toHaveBeenCalledTimes(count)
    expect(registry.handle(scope, click)).toEqual(unavailable)
  })

  it('denies a pre-aborted registration once without attaching listeners or timers', () => {
    const registry = new ChannelConfirmations(), r = resolver(), controller = new AbortController()
    controller.abort()
    const add = vi.spyOn(controller.signal, 'addEventListener')
    const dispose = registry.register(scope, request, r, controller.signal)
    dispose()
    expect(add).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
    expect(r.resolve).toHaveBeenCalledExactlyOnceWith('call', 'deny')
    expect(registry.handle(scope, yes)).toEqual(message)
  })

  it('expires idle requests exactly at the deadline and releases an actual suspended resolver', async () => {
    const registry = new ChannelConfirmations(), r = createConfirmationResolver()
    registry.register(scope, request, r)
    const outcome = r.waitForDecision('call', 600_000)
    vi.advanceTimersByTime(299_999)
    expect(registry.handle(scope, { kind: 'action', data: 'mcp_confirm:unknown:allow' })).toEqual(unavailable)
    vi.advanceTimersByTime(1)
    await expect(outcome).resolves.toEqual({ decision: 'deny' })
    expect(registry.handle(scope, click)).toEqual(unavailable)
  })

  it.each(['handle', 'register'] as const)('prunes expired entries on %s with an injected clock', operation => {
    let now = 0
    const registry = new ChannelConfirmations(() => now), r = resolver()
    registry.register(scope, request, r)
    now = 300_000
    if (operation === 'register') registry.register(scope, { ...request, toolCallId: 'new' }, resolver())
    else expect(registry.handle(scope, click)).toEqual(unavailable)
    expect(r.resolve).toHaveBeenCalledExactlyOnceWith('call', 'deny')
    expect(registry.handle(scope, click)).toEqual(unavailable)
  })

  it('clear removes every registration for only the supplied resolver', () => {
    const registry = new ChannelConfirmations(), first = resolver(), second = resolver()
    registry.register(scope, request, first)
    registry.register({ ...scope, senderId: 'other' }, request, first)
    registry.register(scope, { ...request, toolCallId: 'second' }, second)
    registry.clear(first)
    expect(first.resolve).not.toHaveBeenCalled()
    expect(registry.handle(scope, click)).toEqual(unavailable)
    expect(registry.handle(scope, yes).status).toBe('resolved')
    expect(second.resolve).toHaveBeenCalledExactlyOnceWith('second', 'allow', undefined)
  })

  it('removes state before a resolver throws', () => {
    const registry = new ChannelConfirmations(), r = resolver(), controller = new AbortController()
    registry.register(scope, request, r, controller.signal)
    r.resolve.mockImplementation(() => { throw new Error('resolver failure') })
    expect(() => registry.handle(scope, click)).toThrow('resolver failure')
    controller.abort()
    expect(registry.handle(scope, click)).toEqual(unavailable)
    expect(r.resolve).toHaveBeenCalledOnce()
    expect(vi.getTimerCount()).toBe(0)
  })
})
