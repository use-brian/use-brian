import { describe, it, expect, vi, afterEach } from 'vitest'
import { maybeHandleChannelDeferredConfirmation, type DeferredChannelScope } from '../channel-deferred-confirmations.js'
import { bindSchedulerConfirmationDelivery, clearSchedulerConfirmationDelivery, registerSchedulerResolver, unregisterSchedulerResolver } from '../../scheduling/confirmation-registry.js'
import type { DeferredConfirmationStore } from '../../db/deferred-confirmation-store.js'
const scope: DeferredChannelScope = { workspaceId: 'ws', assistantId: 'asst', userId: 'actor', integrationId: 'integration', channelType: 'slack', channelId: 'channel', threadId: 'thread' }
const dispose: (() => void)[] = []
afterEach(() => { dispose.splice(0).forEach(fn => fn()); unregisterSchedulerResolver('call') })
function fixture() {
  const resolver = { resolve: vi.fn() }
  registerSchedulerResolver('call', resolver as never, scope)
  bindSchedulerConfirmationDelivery('call', scope, false)
  dispose.push(() => clearSchedulerConfirmationDelivery('call'))
  const store = { findByToolCallId: vi.fn(async () => ({ ...scope, status: 'pending', expiresAt: new Date(Date.now() + 60_000) })), markResolved: vi.fn() } as unknown as DeferredConfirmationStore
  return { resolver, store, params: { scope, event: { kind: 'action' as const, data: 'mcp_confirm:call:allow' }, store, authorized: vi.fn(async () => true) } }
}
describe('scoped deferred confirmations', () => {
  it('resolves only once with the registry actor guard', async () => {
    const { params, resolver, store } = fixture()
    expect(await maybeHandleChannelDeferredConfirmation(params)).toBe('Allowed')
    expect(await maybeHandleChannelDeferredConfirmation(params)).toContain('unavailable')
    expect(resolver.resolve).toHaveBeenCalledExactlyOnceWith('call', 'allow')
    expect(store.markResolved).toHaveBeenCalledWith('call', 'allow')
  })
  it.each(['workspaceId', 'assistantId', 'userId', 'integrationId', 'channelType', 'channelId', 'threadId'] as const)('rejects wrong %s', async (key) => {
    const { params, resolver } = fixture()
    expect(await maybeHandleChannelDeferredConfirmation({ ...params, scope: { ...scope, [key]: 'other' } })).toContain('unavailable')
    expect(resolver.resolve).not.toHaveBeenCalled()
  })
  it('rejects revoked authorization, persistence escalation and absent delivery provenance', async () => {
    const { params, resolver } = fixture()
    params.authorized.mockResolvedValue(false)
    expect(await maybeHandleChannelDeferredConfirmation(params)).toContain('not authorized')
    expect(await maybeHandleChannelDeferredConfirmation({ ...params, event: { kind: 'action', data: 'mcp_confirm:call:always_allow' } })).toContain('Persistent')
    dispose.splice(0).forEach(fn => fn())
    expect(await maybeHandleChannelDeferredConfirmation(params)).toContain('unavailable')
    expect(resolver.resolve).not.toHaveBeenCalled()
  })
  it('leaves ordinary text and other callback surfaces untouched', async () => {
    const { params, resolver } = fixture()
    expect(await maybeHandleChannelDeferredConfirmation({ ...params, event: { kind: 'text', text: 'hello' } })).toBeNull()
    expect(await maybeHandleChannelDeferredConfirmation({ ...params, event: { kind: 'action', data: 'wq:token:0' } })).toBeNull()
    expect(resolver.resolve).not.toHaveBeenCalled()
  })
  it('supports unambiguous keywords only in the exact delivery thread', async () => {
    const { params, resolver } = fixture()
    expect(await maybeHandleChannelDeferredConfirmation({ ...params, scope: { ...scope, threadId: undefined }, event: { kind: 'text', text: 'yes' } })).toBeNull()
    expect(await maybeHandleChannelDeferredConfirmation({ ...params, event: { kind: 'text', text: 'yes' } })).toBe('Allowed')
    expect(resolver.resolve).toHaveBeenCalledOnce()
  })
})

describe('message-bound callback thread recovery', () => {
  function threadedFixture() {
    const f = fixture()
    const deliveryScope = { ...scope, channelType: 'feishu', threadId: 'actual-root' }
    registerSchedulerResolver('call', f.resolver as never, deliveryScope)
    bindSchedulerConfirmationDelivery('call', { ...deliveryScope, messageId: 'prompt-card' }, false)
    vi.mocked(f.store.findByToolCallId).mockResolvedValue({ ...deliveryScope, status: 'pending', expiresAt: new Date(Date.now() + 60_000) } as never)
    return { ...f, params: { ...f.params, scope: { ...deliveryScope, threadId: 'prompt-card' }, messageId: 'prompt-card' } }
  }
  it('recovers the real thread for an exact source card and resolves once', async () => {
    const { params, resolver, store } = threadedFixture()
    expect(await maybeHandleChannelDeferredConfirmation(params)).toBe('Allowed')
    expect(resolver.resolve).toHaveBeenCalledExactlyOnceWith('call', 'allow')
    expect(store.markResolved).toHaveBeenCalledWith('call', 'allow')
    expect(await maybeHandleChannelDeferredConfirmation(params)).toContain('unavailable')
  })
  it.each(['wrong-card', '', undefined])('does not recover the thread with source %j', async (messageId) => {
    const { params, resolver } = threadedFixture()
    expect(await maybeHandleChannelDeferredConfirmation({ ...params, messageId })).toContain('unavailable')
    expect(resolver.resolve).not.toHaveBeenCalled()
  })
  it.each(['workspaceId', 'assistantId', 'userId', 'integrationId', 'channelType', 'channelId'] as const)('requires matching %s even for the exact source card', async (key) => {
    const { params, resolver } = threadedFixture()
    expect(await maybeHandleChannelDeferredConfirmation({ ...params, scope: { ...params.scope, [key]: 'other' } })).toContain('unavailable')
    expect(resolver.resolve).not.toHaveBeenCalled()
  })
  it('never uses source-message recovery for typed text', async () => {
    const { params, resolver } = threadedFixture()
    expect(await maybeHandleChannelDeferredConfirmation({ ...params, event: { kind: 'text', text: 'yes' } })).toBeNull()
    expect(resolver.resolve).not.toHaveBeenCalled()
    expect(await maybeHandleChannelDeferredConfirmation({ ...params, scope: { ...params.scope, threadId: 'actual-root' }, event: { kind: 'text', text: 'yes' } })).toBe('Allowed')
  })
  it('still checks fresh actor authorization after source-message recovery', async () => {
    const { params, resolver } = threadedFixture()
    params.authorized.mockResolvedValue(false)
    expect(await maybeHandleChannelDeferredConfirmation(params)).toContain('not authorized')
    expect(resolver.resolve).not.toHaveBeenCalled()
  })
})

it('does not resume a deferred tool when cancelled during the durable-row lookup', async () => {
  const { params, resolver, store } = fixture()
  const controller = new AbortController()
  const row = await store.findByToolCallId('call')
  vi.mocked(store.findByToolCallId).mockImplementationOnce(async () => { controller.abort(); return row })
  expect(await maybeHandleChannelDeferredConfirmation({ ...params, abortSignal: controller.signal })).toContain('Stopped')
  expect(resolver.resolve).not.toHaveBeenCalled()
  expect(store.markResolved).not.toHaveBeenCalled()
})
