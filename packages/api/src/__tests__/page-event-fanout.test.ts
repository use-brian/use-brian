import { describe, it, expect, vi, afterEach } from 'vitest'
import type { DispatchEvent, PageLifecycleEvent, WorkflowEventDispatcher } from '@sidanclaw/core'
import { setPageEventDispatcher, publishPageLifecycle } from '../page-event-fanout.js'

const EVENT: PageLifecycleEvent = {
  workspaceId: 'ws1',
  pageId: 'p1',
  parentId: 'parent1',
  title: 'Spec',
  actorId: 'user1',
  action: 'created',
}

afterEach(() => {
  // Reset the module-local binding so cases don't leak into each other.
  setPageEventDispatcher(null)
})

describe('[COMP:api/page-event-fanout] late-bound page-lifecycle seam', () => {
  it('is a no-op before a dispatcher is bound', () => {
    // No throw, no dispatch — nothing is wired yet.
    expect(() => publishPageLifecycle(EVENT)).not.toThrow()
  })

  it('dispatches the converted DispatchEvent once a dispatcher is bound', async () => {
    const dispatch = vi.fn(async (_ev: DispatchEvent) => {})
    setPageEventDispatcher({ dispatch } as unknown as WorkflowEventDispatcher)

    publishPageLifecycle(EVENT)
    await Promise.resolve() // let the fire-and-forget settle

    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0][0]
    // action='created' → watched page is the destination parent.
    expect(ev.source).toEqual({ type: 'page', pageId: 'parent1' })
    expect(ev.channelId).toBe('created')
    expect(ev.payload.pageId).toBe('p1')
  })

  it('stops dispatching after unbinding with null', async () => {
    const dispatch = vi.fn(async () => {})
    setPageEventDispatcher({ dispatch } as unknown as WorkflowEventDispatcher)
    setPageEventDispatcher(null)

    publishPageLifecycle(EVENT)
    await Promise.resolve()

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('swallows a dispatcher rejection so a page write never fails', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('dispatcher down')
    })
    setPageEventDispatcher({ dispatch } as unknown as WorkflowEventDispatcher)

    expect(() => publishPageLifecycle(EVENT)).not.toThrow()
    await Promise.resolve()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
