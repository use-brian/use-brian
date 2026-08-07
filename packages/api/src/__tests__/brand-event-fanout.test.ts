/**
 * [COMP:api/brand-event-fanout] + [COMP:workflow/brand-event-trigger].
 *
 * Two properties carry real risk here.
 *
 * The event must be a POINTER — id, slug, action, version — and never the
 * record body. A brand record holds unannounced positioning and prohibited
 * claims, and a workflow triggered by a `confidential` brand's approval may
 * belong to an assistant that could not have read that record. A step reads
 * it back through `getBrand` under its own clearance instead.
 *
 * And an assistant-authored write must be marked `isBot`, or a workflow that
 * itself proposes brand edits re-triggers on its own draft write and runs
 * forever. `matchesEvent`'s `fromBots`-defaults-false gate is what stops it,
 * but only if the producer sets the flag.
 *
 * Fixture data is invented.
 */

import { describe, it, expect, vi, afterEach } from 'vitest'
import {
  brandLifecycleToDispatchEvent,
  matchesEvent,
  type BrandLifecycleEvent,
  type DispatchEvent,
  type WorkflowEventDispatcher,
} from '@use-brian/core'
import { setBrandEventDispatcher, publishBrandLifecycle } from '../brand-event-fanout.js'

const EVENT: BrandLifecycleEvent = {
  workspaceId: 'ws1',
  brandId: 'b1',
  action: 'approved',
  slug: 'northwind',
  name: 'Northwind Ferry',
  version: 4,
  actorId: 'user1',
}

afterEach(() => {
  setBrandEventDispatcher(null)
})

describe('[COMP:api/brand-event-fanout] late-bound seam', () => {
  it('is a no-op before a dispatcher is bound', () => {
    expect(() => publishBrandLifecycle(EVENT)).not.toThrow()
  })

  it('dispatches once a dispatcher is bound', async () => {
    const dispatch = vi.fn(async (_ev: DispatchEvent) => {})
    setBrandEventDispatcher({ dispatch } as unknown as WorkflowEventDispatcher)

    publishBrandLifecycle(EVENT)
    await Promise.resolve()

    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0].source).toEqual({ type: 'brand' })
  })

  it('stops dispatching after unbinding with null', async () => {
    const dispatch = vi.fn(async (_ev: DispatchEvent) => {})
    setBrandEventDispatcher({ dispatch } as unknown as WorkflowEventDispatcher)
    setBrandEventDispatcher(null)
    publishBrandLifecycle(EVENT)
    await Promise.resolve()
    expect(dispatch).not.toHaveBeenCalled()
  })

  it('swallows a dispatcher failure so a brand write is never broken by one', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('workflow start failed')
    })
    setBrandEventDispatcher({ dispatch } as unknown as WorkflowEventDispatcher)
    // Approval is a human clicking Approve in Studio; a broken workflow must
    // not make that look like it failed when the version already committed.
    expect(() => publishBrandLifecycle(EVENT)).not.toThrow()
    await Promise.resolve()
    await Promise.resolve()
  })
})

describe('[COMP:workflow/brand-event-trigger] normalization', () => {
  it('carries a pointer payload and never the record body', () => {
    const ev = brandLifecycleToDispatchEvent(EVENT)
    expect(ev.payload).toEqual({
      brandId: 'b1',
      action: 'approved',
      slug: 'northwind',
      name: 'Northwind Ferry',
      version: 4,
      actorId: 'user1',
    })
    expect(JSON.stringify(ev)).not.toContain('record')
  })

  it('routes the action to channelId and the slug to tags', () => {
    const ev = brandLifecycleToDispatchEvent(EVENT)
    expect(ev.channelId).toBe('approved')
    // The slug on `tags` is what lets a multi-brand workspace scope a
    // subscription to one brand without a second source variant.
    expect(ev.tags).toEqual(['northwind'])
    expect(ev.text).toBe('Northwind Ferry')
  })

  it('marks an assistant write as bot-authored and a human write as not', () => {
    expect(brandLifecycleToDispatchEvent({ ...EVENT, writtenBy: 'system' }).isBot).toBe(true)
    expect(brandLifecycleToDispatchEvent({ ...EVENT, writtenBy: 'user' }).isBot).toBe(false)
    // Default is `user`: the write that matters most — approval — is always
    // human.
    expect(brandLifecycleToDispatchEvent(EVENT).isBot).toBe(false)
  })
})

describe('[COMP:workflow/brand-event-trigger] subscription matching', () => {
  const sub = (match?: Record<string, unknown>) =>
    ({ source: { type: 'brand' as const }, match } as never)

  it('matches an id-less brand subscription in the same workspace', () => {
    expect(matchesEvent(brandLifecycleToDispatchEvent(EVENT), sub())).toBe(true)
  })

  it('does not match a different source kind', () => {
    const knowledgeSub = { source: { type: 'knowledge' as const } } as never
    expect(matchesEvent(brandLifecycleToDispatchEvent(EVENT), knowledgeSub)).toBe(false)
  })

  it('scopes by lifecycle action via inChannels', () => {
    const approvedOnly = sub({ inChannels: ['approved'] })
    expect(matchesEvent(brandLifecycleToDispatchEvent(EVENT), approvedOnly)).toBe(true)
    expect(
      matchesEvent(brandLifecycleToDispatchEvent({ ...EVENT, action: 'updated' }), approvedOnly),
    ).toBe(false)
  })

  it('scopes by brand via tags', () => {
    const northwindOnly = sub({ tags: ['northwind'] })
    expect(matchesEvent(brandLifecycleToDispatchEvent(EVENT), northwindOnly)).toBe(true)
    expect(
      matchesEvent(brandLifecycleToDispatchEvent({ ...EVENT, slug: 'other-brand' }), northwindOnly),
    ).toBe(false)
  })

  it('suppresses an assistant-authored write unless the subscription opts in', () => {
    const botEvent = brandLifecycleToDispatchEvent({ ...EVENT, action: 'updated', writtenBy: 'system' })
    // This is the self-loop guard: without it a brand-maintenance workflow
    // re-triggers on the draft it just wrote.
    expect(matchesEvent(botEvent, sub())).toBe(false)
    expect(matchesEvent(botEvent, sub({ fromBots: true }))).toBe(true)
  })
})
