import { describe, it, expect, vi } from 'vitest'
import {
  registerSchedulerResolver,
  tryResolveSchedulerConfirmation,
  unregisterSchedulerResolver,
} from '../confirmation-registry.js'

/**
 * [COMP:api/scheduler-confirmation-registry]
 *
 * The registry is a process-global map shared across every user/channel in the
 * one apps/api process. Resolution must be owner-guarded so a co-tenant who
 * learns a toolCallId cannot approve/deny another user's parked job action
 * (cross-tenant — 2026-06-02 audit finding #6).
 */
describe('[COMP:api/scheduler-confirmation-registry] owner-guarded resolution', () => {
  const mkResolver = () => ({ resolve: vi.fn() }) as never as { resolve: ReturnType<typeof vi.fn> } & Parameters<typeof registerSchedulerResolver>[1]

  it('resolves when no guard is supplied (callers that pre-scope by other means)', () => {
    const r = mkResolver()
    registerSchedulerResolver('t1', r, { userId: 'uA', channelType: 'telegram', channelId: '111' })
    expect(tryResolveSchedulerConfirmation('t1', 'allow')).toBe(true)
    expect(r.resolve).toHaveBeenCalledWith('t1', 'allow')
  })

  it('resolves when the guard matches the recorded owner', () => {
    const r = mkResolver()
    registerSchedulerResolver('t2', r, { userId: 'uA', channelType: 'telegram', channelId: '111' })
    expect(tryResolveSchedulerConfirmation('t2', 'allow', { userId: 'uA' })).toBe(true)
    expect(r.resolve).toHaveBeenCalled()
  })

  it('does NOT resolve when a guarded field mismatches (cross-tenant attempt)', () => {
    const r = mkResolver()
    registerSchedulerResolver('t3', r, { userId: 'uA', channelType: 'telegram', channelId: '111' })
    expect(tryResolveSchedulerConfirmation('t3', 'allow', { userId: 'uB' })).toBe(false)
    expect(tryResolveSchedulerConfirmation('t3', 'allow', { channelType: 'telegram', channelId: '222' })).toBe(false)
    expect(r.resolve).not.toHaveBeenCalled()
    // the legitimate owner still resolves
    expect(tryResolveSchedulerConfirmation('t3', 'allow', { channelType: 'telegram', channelId: '111' })).toBe(true)
    expect(r.resolve).toHaveBeenCalledTimes(1)
  })

  it('fails closed when a guarded field is provided but the entry recorded no owner', () => {
    const r = mkResolver()
    registerSchedulerResolver('t4', r) // owner omitted → null fields
    expect(tryResolveSchedulerConfirmation('t4', 'allow', { userId: 'uA' })).toBe(false)
    expect(r.resolve).not.toHaveBeenCalled()
    // an unguarded caller can still resolve it
    expect(tryResolveSchedulerConfirmation('t4', 'allow')).toBe(true)
  })

  it('returns false for an unknown toolCallId and after unregister', () => {
    const r = mkResolver()
    registerSchedulerResolver('t5', r, { userId: 'uA', channelType: 'web', channelId: 'c' })
    unregisterSchedulerResolver('t5')
    expect(tryResolveSchedulerConfirmation('t5', 'allow', { userId: 'uA' })).toBe(false)
    expect(tryResolveSchedulerConfirmation('does-not-exist', 'allow')).toBe(false)
  })
})
