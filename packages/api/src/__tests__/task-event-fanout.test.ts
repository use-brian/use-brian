import { describe, it, expect, vi, afterEach } from 'vitest'
import type { DispatchEvent, TaskLifecycleEvent, WorkflowEventDispatcher } from '@sidanclaw/core'
import { setTaskEventDispatcher, publishTaskLifecycle } from '../task-event-fanout.js'

const EVENT: TaskLifecycleEvent = {
  workspaceId: 'ws1',
  taskId: 't1',
  kind: 'created',
  title: 'Triage the Acme ticket',
  status: 'todo',
  previousStatus: null,
  tags: ['triage'],
  previousTags: null,
  assigneeId: null,
  previousAssigneeId: null,
  due: null,
  parentId: null,
  changedFields: [],
  actorId: 'user1',
  writtenBy: 'user',
}

afterEach(() => {
  // Reset the module-local binding so cases don't leak into each other.
  setTaskEventDispatcher(null)
})

describe('[COMP:api/task-event-fanout] late-bound task-lifecycle seam', () => {
  it('is a no-op before a dispatcher is bound', () => {
    expect(() => publishTaskLifecycle(EVENT)).not.toThrow()
  })

  it('dispatches the converted DispatchEvent once a dispatcher is bound', async () => {
    const dispatch = vi.fn(async (_ev: DispatchEvent) => {})
    setTaskEventDispatcher({ dispatch } as unknown as WorkflowEventDispatcher)

    publishTaskLifecycle(EVENT)
    await Promise.resolve() // let the fire-and-forget settle

    expect(dispatch).toHaveBeenCalledTimes(1)
    const ev = dispatch.mock.calls[0][0]
    expect(ev.source).toEqual({ type: 'task' })
    expect(ev.channelId).toBe('created')
    expect(ev.tags).toEqual(['triage'])
    expect(ev.payload.taskId).toBe('t1')
  })

  it('stops dispatching after unbinding with null', async () => {
    const dispatch = vi.fn(async () => {})
    setTaskEventDispatcher({ dispatch } as unknown as WorkflowEventDispatcher)
    setTaskEventDispatcher(null)

    publishTaskLifecycle(EVENT)
    await Promise.resolve()

    expect(dispatch).not.toHaveBeenCalled()
  })

  it('swallows a dispatcher rejection so a task write never fails', async () => {
    const dispatch = vi.fn(async () => {
      throw new Error('dispatcher down')
    })
    setTaskEventDispatcher({ dispatch } as unknown as WorkflowEventDispatcher)

    expect(() => publishTaskLifecycle(EVENT)).not.toThrow()
    await Promise.resolve()
    expect(dispatch).toHaveBeenCalledTimes(1)
  })
})
