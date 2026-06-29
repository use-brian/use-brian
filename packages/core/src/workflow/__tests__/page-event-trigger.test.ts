import { describe, it, expect, vi } from 'vitest'

import {
  PAGE_EVENT_ROOT,
  pageLifecycleToDispatchEvent,
  createPageLifecycleTrigger,
  type PageLifecycleEvent,
} from '../page-event-trigger.js'
import {
  matchesEvent,
  createWorkflowEventDispatcher,
  type EventTriggeredWorkflow,
  type WorkflowEventInput,
} from '../event-trigger.js'
import type { EventSubscription } from '../types.js'

// ── Fixtures ────────────────────────────────────────────────────────────

const PARENT = '11111111-1111-1111-1111-111111111111'
const PAGE = '22222222-2222-2222-2222-222222222222'

/** A page created under a watched parent. */
const created: PageLifecycleEvent = {
  workspaceId: 'ws1',
  pageId: PAGE,
  parentId: PARENT,
  title: 'Q3 launch checklist',
  actorId: 'user-1',
  action: 'created',
}

/** A subscription watching a page by its own id. */
const watch = (
  pageId: string,
  match?: EventSubscription['match'],
): EventSubscription => ({ source: { type: 'page', pageId }, match })

// ── Normalizer ──────────────────────────────────────────────────────────

describe('[COMP:workflow/page-event-trigger] pageLifecycleToDispatchEvent', () => {
  it('targets the destination parent for a created page', () => {
    const ev = pageLifecycleToDispatchEvent(created)
    // Watched page = the parent (you watch a parent to hear about new children).
    expect(ev.source).toEqual({ type: 'page', pageId: PARENT })
    expect(ev.channelId).toBe('created')
    expect(ev.text).toBe('Q3 launch checklist')
    expect(ev.actorId).toBe('user-1')
    expect(ev.isBot).toBe(false)
    // The payload still carries the page that actually changed.
    expect(ev.payload).toEqual({
      action: 'created',
      pageId: PAGE,
      parentId: PARENT,
      title: 'Q3 launch checklist',
      actorId: 'user-1',
    })
  })

  it('targets the destination parent for a moved page', () => {
    const ev = pageLifecycleToDispatchEvent({ ...created, action: 'moved' })
    expect(ev.source).toEqual({ type: 'page', pageId: PARENT })
    expect(ev.channelId).toBe('moved')
  })

  it('targets the page itself for an updated page', () => {
    const ev = pageLifecycleToDispatchEvent({ ...created, action: 'updated' })
    // Watched page = the page that changed (you watch a page to hear about its
    // own updates), NOT its parent.
    expect(ev.source).toEqual({ type: 'page', pageId: PAGE })
    expect(ev.channelId).toBe('updated')
  })

  it('uses the PAGE_EVENT_ROOT sentinel for a created root page', () => {
    const ev = pageLifecycleToDispatchEvent({ ...created, parentId: null })
    expect(ev.source).toEqual({ type: 'page', pageId: PAGE_EVENT_ROOT })
    expect(ev.payload.parentId).toBeNull()
  })

  it('marks a system / automated write as a bot event (self-loop guard input)', () => {
    const ev = pageLifecycleToDispatchEvent({ ...created, isSystem: true })
    expect(ev.isBot).toBe(true)
  })
})

// ── Matching ────────────────────────────────────────────────────────────

describe('[COMP:workflow/page-event-trigger] matchesEvent (page source)', () => {
  it('a parent watcher catches children created/moved under it', () => {
    const createdEv = pageLifecycleToDispatchEvent(created)
    const movedEv = pageLifecycleToDispatchEvent({ ...created, action: 'moved' })
    expect(matchesEvent(createdEv, watch(PARENT))).toBe(true)
    expect(matchesEvent(movedEv, watch(PARENT))).toBe(true)
  })

  it('a parent watcher does NOT catch the parent\'s own update via a child', () => {
    // An update to a CHILD of PARENT targets the child, not PARENT.
    const childUpdated = pageLifecycleToDispatchEvent({
      ...created,
      action: 'updated',
    })
    expect(matchesEvent(childUpdated, watch(PARENT))).toBe(false)
    expect(matchesEvent(childUpdated, watch(PAGE))).toBe(true)
  })

  it('a page watcher catches its own update', () => {
    const updated = pageLifecycleToDispatchEvent({ ...created, action: 'updated' })
    expect(matchesEvent(updated, watch(PAGE))).toBe(true)
  })

  it('rejects a different watched id', () => {
    const ev = pageLifecycleToDispatchEvent(created)
    expect(matchesEvent(ev, watch('99999999-9999-9999-9999-999999999999'))).toBe(false)
  })

  it('rejects a connector subscription for a page event (type mismatch)', () => {
    const ev = pageLifecycleToDispatchEvent(created)
    expect(
      matchesEvent(ev, {
        source: { type: 'connector', connectorInstanceId: PARENT, provider: 'github' },
      }),
    ).toBe(false)
  })

  it('filters by lifecycle action via inChannels', () => {
    const createdEv = pageLifecycleToDispatchEvent(created)
    expect(matchesEvent(createdEv, watch(PARENT, { inChannels: ['created'] }))).toBe(true)
    expect(matchesEvent(createdEv, watch(PARENT, { inChannels: ['moved'] }))).toBe(false)
  })

  it('filters by page title via keywords and acting user via fromActors', () => {
    const ev = pageLifecycleToDispatchEvent(created)
    expect(matchesEvent(ev, watch(PARENT, { keywords: ['launch'] }))).toBe(true)
    expect(matchesEvent(ev, watch(PARENT, { keywords: ['invoice'] }))).toBe(false)
    expect(matchesEvent(ev, watch(PARENT, { fromActors: ['user-1'] }))).toBe(true)
    expect(matchesEvent(ev, watch(PARENT, { fromActors: ['user-2'] }))).toBe(false)
  })

  it('hides system writes unless fromBots opts in (self-loop guard)', () => {
    const systemEv = pageLifecycleToDispatchEvent({ ...created, isSystem: true })
    expect(matchesEvent(systemEv, watch(PARENT))).toBe(false)
    expect(matchesEvent(systemEv, watch(PARENT, { fromBots: true }))).toBe(true)
  })
})

// ── Dispatch end-to-end ──────────────────────────────────────────────────

describe('[COMP:workflow/page-event-trigger] createPageLifecycleTrigger', () => {
  it('dispatches a created page and seeds input.trigger / input.event', async () => {
    const started: Array<{ workflowId: string; input: WorkflowEventInput }> = []
    const wf: EventTriggeredWorkflow = {
      workflowId: 'wf-1',
      workspaceId: 'ws1',
      sources: [watch(PARENT, { inChannels: ['created'] })],
    }
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [wf],
      startWorkflowRun: async ({ workflowId, input }) => {
        started.push({ workflowId, input })
      },
    })

    await createPageLifecycleTrigger(dispatcher)(created)

    expect(started).toHaveLength(1)
    const { trigger: t, event } = started[0].input
    expect(t.sourceType).toBe('page')
    expect(t.provider).toBe('page')
    expect(t.pageId).toBe(PARENT) // the watched page
    expect(t.channelId).toBe('created')
    expect(event.pageId).toBe(PAGE) // the page that changed
    expect(event.action).toBe('created')
  })

  it('does not start a run when the action filter excludes the event', async () => {
    const start = vi.fn(async () => {})
    const dispatcher = createWorkflowEventDispatcher({
      findEventTriggeredWorkflows: async () => [
        { workflowId: 'wf-1', workspaceId: 'ws1', sources: [watch(PARENT, { inChannels: ['moved'] })] },
      ],
      startWorkflowRun: start,
    })
    await createPageLifecycleTrigger(dispatcher)(created)
    expect(start).not.toHaveBeenCalled()
  })
})
