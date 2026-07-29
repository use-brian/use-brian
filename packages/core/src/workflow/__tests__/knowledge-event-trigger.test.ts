import { describe, it, expect, vi } from 'vitest'
import {
  KNOWLEDGE_LIFECYCLE_ACTIONS,
  knowledgeLifecycleToDispatchEvent,
  createKnowledgeLifecycleTrigger,
  type KnowledgeLifecycleEvent,
} from '../knowledge-event-trigger.js'
import { matchesEvent } from '../event-trigger.js'
import type { EventSubscription } from '../types.js'

function entry(overrides: Partial<KnowledgeLifecycleEvent> = {}): KnowledgeLifecycleEvent {
  return {
    workspaceId: 'ws1',
    entryId: 'k1',
    action: 'updated',
    path: 'products/vault',
    title: 'Vault fee structure',
    tags: ['pricing', 'product'],
    sensitivity: 'internal',
    sourceId: 'src1',
    actorId: 'user1',
    ...overrides,
  }
}

const sub = (match?: EventSubscription['match']): EventSubscription => ({
  source: { type: 'knowledge' },
  ...(match ? { match } : {}),
})

describe('[COMP:workflow/knowledge-event-trigger] knowledgeLifecycleToDispatchEvent', () => {
  it('maps the entry onto the matchable axes', () => {
    const e = knowledgeLifecycleToDispatchEvent(entry())
    expect(e.workspaceId).toBe('ws1')
    expect(e.source).toEqual({ type: 'knowledge' })
    // Title is the keyword haystack; the action is the inChannels axis.
    expect(e.text).toBe('Vault fee structure')
    expect(e.channelId).toBe('updated')
    expect(e.tags).toEqual(['pricing', 'product'])
    expect(e.actorId).toBe('user1')
  })

  it('is single-facet: no action set, so inChannels falls back to the singleton', () => {
    // Unlike a task write (which can be `completed` AND `tagged`), a KB write
    // is exactly one action. Leaving `actions` absent is what makes
    // matchesEvent use [channelId].
    expect(knowledgeLifecycleToDispatchEvent(entry()).actions).toBeUndefined()
  })

  it('carries a pointer, never the entry body', () => {
    const { payload } = knowledgeLifecycleToDispatchEvent(entry())
    expect(payload).toEqual({
      entryId: 'k1',
      action: 'updated',
      path: 'products/vault',
      title: 'Vault fee structure',
      tags: ['pricing', 'product'],
      sensitivity: 'internal',
      sourceId: 'src1',
      actorId: 'user1',
    })
    // The body is deliberately absent — a step re-reads the entry under its
    // own clearance rather than receiving content it may not be cleared for.
    expect(payload).not.toHaveProperty('content')
    expect(payload).not.toHaveProperty('summary')
  })

  it('marks an assistant write as bot-authored, a mirrored human commit as not', () => {
    expect(knowledgeLifecycleToDispatchEvent(entry({ writtenBy: 'system' })).isBot).toBe(true)
    expect(knowledgeLifecycleToDispatchEvent(entry({ writtenBy: 'user' })).isBot).toBe(false)
    // Default (the sync worker mirroring a push) is a user write.
    expect(knowledgeLifecycleToDispatchEvent(entry()).isBot).toBe(false)
  })

  it('exposes every lifecycle action', () => {
    expect([...KNOWLEDGE_LIFECYCLE_ACTIONS]).toEqual(['created', 'updated', 'deleted'])
    for (const action of KNOWLEDGE_LIFECYCLE_ACTIONS) {
      expect(knowledgeLifecycleToDispatchEvent(entry({ action })).channelId).toBe(action)
    }
  })
})

describe('[COMP:workflow/knowledge-event-trigger] matching', () => {
  it('an id-less subscription fires on any KB event in the workspace', () => {
    expect(matchesEvent(knowledgeLifecycleToDispatchEvent(entry()), sub())).toBe(true)
  })

  it('does not cross source kinds', () => {
    const e = knowledgeLifecycleToDispatchEvent(entry())
    expect(matchesEvent(e, { source: { type: 'task' } })).toBe(false)
  })

  it('inChannels selects the lifecycle action', () => {
    const updatedEvent = knowledgeLifecycleToDispatchEvent(entry({ action: 'updated' }))
    const deletedEvent = knowledgeLifecycleToDispatchEvent(entry({ action: 'deleted' }))
    expect(matchesEvent(updatedEvent, sub({ inChannels: ['deleted'] }))).toBe(false)
    expect(matchesEvent(deletedEvent, sub({ inChannels: ['deleted'] }))).toBe(true)
  })

  it('keywords match the entry title', () => {
    const e = knowledgeLifecycleToDispatchEvent(entry())
    expect(matchesEvent(e, sub({ keywords: ['fee structure'] }))).toBe(true)
    expect(matchesEvent(e, sub({ keywords: ['deployment'] }))).toBe(false)
  })

  it('tags match the entry frontmatter tags', () => {
    const e = knowledgeLifecycleToDispatchEvent(entry())
    expect(matchesEvent(e, sub({ tags: ['pricing'] }))).toBe(true)
    expect(matchesEvent(e, sub({ tags: ['security'] }))).toBe(false)
  })

  it('the self-loop guard: an assistant write needs an explicit fromBots opt-in', () => {
    // This is the whole reason the producer distinguishes writtenBy: a
    // KB-maintenance workflow that writes the KB must not wake itself.
    const assistantWrite = knowledgeLifecycleToDispatchEvent(entry({ writtenBy: 'system' }))
    expect(matchesEvent(assistantWrite, sub())).toBe(false)
    expect(matchesEvent(assistantWrite, sub({ inChannels: ['updated'] }))).toBe(false)
    expect(matchesEvent(assistantWrite, sub({ fromBots: true }))).toBe(true)
  })

  it('a human commit mirrored by the sync worker still fires a default subscription', () => {
    const syncWrite = knowledgeLifecycleToDispatchEvent(entry({ actorId: null }))
    expect(matchesEvent(syncWrite, sub())).toBe(true)
  })
})

describe('[COMP:workflow/knowledge-event-trigger] createKnowledgeLifecycleTrigger', () => {
  it('normalizes and dispatches', async () => {
    const dispatch = vi.fn().mockResolvedValue(undefined)
    const trigger = createKnowledgeLifecycleTrigger({ dispatch })
    await trigger(entry({ action: 'created' }))
    expect(dispatch).toHaveBeenCalledTimes(1)
    expect(dispatch.mock.calls[0][0]).toMatchObject({
      workspaceId: 'ws1',
      source: { type: 'knowledge' },
      channelId: 'created',
    })
  })
})
