import { describe, it, expect } from 'vitest'
import {
  deriveTaskActions,
  taskLifecycleToDispatchEvent,
  type TaskLifecycleEvent,
} from '../task-event-trigger.js'
import { matchesEvent } from '../event-trigger.js'
import type { EventSubscription } from '../types.js'

function created(overrides: Partial<TaskLifecycleEvent> = {}): TaskLifecycleEvent {
  return {
    workspaceId: 'ws1',
    taskId: 't1',
    kind: 'created',
    title: 'Ship the report',
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
    ...overrides,
  }
}

function updated(overrides: Partial<TaskLifecycleEvent> = {}): TaskLifecycleEvent {
  return {
    workspaceId: 'ws1',
    taskId: 't2',
    kind: 'updated',
    title: 'Ship the report',
    status: 'todo',
    previousStatus: 'todo',
    tags: [],
    previousTags: [],
    assigneeId: null,
    previousAssigneeId: null,
    due: null,
    parentId: null,
    changedFields: ['title'],
    actorId: 'user1',
    ...overrides,
  }
}

const taskSub = (match?: EventSubscription['match']): EventSubscription => ({
  source: { type: 'task' },
  match,
})

describe('[COMP:workflow/task-event-trigger] deriveTaskActions', () => {
  it('a create is exactly [created]', () => {
    expect(deriveTaskActions(created())).toEqual(['created'])
  })

  it('every update carries updated', () => {
    expect(deriveTaskActions(updated())).toEqual(['updated'])
  })

  it('todo → done is completed', () => {
    const actions = deriveTaskActions(updated({ previousStatus: 'todo', status: 'done' }))
    expect(actions).toContain('completed')
    expect(actions).toContain('updated')
  })

  it('in_progress → blocked is blocked', () => {
    expect(
      deriveTaskActions(updated({ previousStatus: 'in_progress', status: 'blocked' })),
    ).toContain('blocked')
  })

  it('done → todo is reopened', () => {
    expect(
      deriveTaskActions(updated({ previousStatus: 'done', status: 'todo' })),
    ).toContain('reopened')
  })

  it('done → blocked is BOTH reopened and blocked — no facet is shadowed', () => {
    const actions = deriveTaskActions(updated({ previousStatus: 'done', status: 'blocked' }))
    expect(actions).toContain('reopened')
    expect(actions).toContain('blocked')
  })

  it('done → archived is neither completed nor reopened', () => {
    const actions = deriveTaskActions(updated({ previousStatus: 'done', status: 'archived' }))
    expect(actions).toEqual(['updated'])
  })

  it('assignee set (null → user) is assigned; reassignment too; unassign is not', () => {
    expect(
      deriveTaskActions(updated({ assigneeId: 'u2', previousAssigneeId: null })),
    ).toContain('assigned')
    expect(
      deriveTaskActions(updated({ assigneeId: 'u3', previousAssigneeId: 'u2' })),
    ).toContain('assigned')
    expect(
      deriveTaskActions(updated({ assigneeId: null, previousAssigneeId: 'u2' })),
    ).not.toContain('assigned')
  })

  it('a tag ADDED is tagged; removal-only is not', () => {
    expect(
      deriveTaskActions(updated({ tags: ['a', 'b'], previousTags: ['a'] })),
    ).toContain('tagged')
    expect(
      deriveTaskActions(updated({ tags: ['a'], previousTags: ['a', 'b'] })),
    ).not.toContain('tagged')
  })

  it('a compound write (complete + tag) carries every facet', () => {
    const actions = deriveTaskActions(
      updated({
        previousStatus: 'todo',
        status: 'done',
        tags: ['done-this-week'],
        previousTags: [],
      }),
    )
    expect(actions).toEqual(expect.arrayContaining(['completed', 'tagged', 'updated']))
  })
})

describe('[COMP:workflow/task-event-trigger] taskLifecycleToDispatchEvent', () => {
  it('normalizes a create: full tag set, id-less task source, title as text', () => {
    const ev = taskLifecycleToDispatchEvent(created())
    expect(ev.source).toEqual({ type: 'task' })
    expect(ev.channelId).toBe('created')
    expect(ev.actions).toEqual(['created'])
    expect(ev.text).toBe('Ship the report')
    expect(ev.tags).toEqual(['triage']) // appearance set on create = every tag
    expect(ev.isBot).toBe(false)
    expect(ev.payload.taskId).toBe('t1')
    expect(ev.payload.action).toBe('created')
  })

  it('primary channelId follows precedence — completed beats tagged', () => {
    const ev = taskLifecycleToDispatchEvent(
      updated({
        previousStatus: 'todo',
        status: 'done',
        tags: ['x'],
        previousTags: [],
      }),
    )
    expect(ev.channelId).toBe('completed')
    expect(ev.actions).toEqual(expect.arrayContaining(['completed', 'tagged', 'updated']))
  })

  it('event tags carry only the ADDED set on update — appearance semantics', () => {
    const ev = taskLifecycleToDispatchEvent(
      updated({ tags: ['old', 'new'], previousTags: ['old'] }),
    )
    expect(ev.tags).toEqual(['new'])
    expect(ev.payload.tags).toEqual(['old', 'new']) // payload keeps the full set
    expect(ev.payload.tagsAdded).toEqual(['new'])
  })

  it('the current assignee rides mentions', () => {
    const ev = taskLifecycleToDispatchEvent(updated({ assigneeId: 'u9' }))
    expect(ev.mentions).toEqual(['u9'])
  })

  it('a system write is bot-authored', () => {
    const ev = taskLifecycleToDispatchEvent(created({ writtenBy: 'system' }))
    expect(ev.isBot).toBe(true)
  })

  it('due serializes to ISO in the payload', () => {
    const due = new Date('2026-07-10T09:00:00Z')
    const ev = taskLifecycleToDispatchEvent(created({ due }))
    expect(ev.payload.due).toBe('2026-07-10T09:00:00.000Z')
  })

  it('routing-tag subscription: fires on create-with-tag and tag-appearance, not on unrelated edits', () => {
    const sub = taskSub({ inChannels: ['created', 'tagged'], tags: ['triage'] })

    // created carrying the tag → fires
    expect(matchesEvent(taskLifecycleToDispatchEvent(created()), sub)).toBe(true)
    // tag added later → fires
    expect(
      matchesEvent(
        taskLifecycleToDispatchEvent(updated({ tags: ['triage'], previousTags: [] })),
        sub,
      ),
    ).toBe(true)
    // unrelated edit of an already-tagged task → the appearance set is empty → no fire
    expect(
      matchesEvent(
        taskLifecycleToDispatchEvent(
          updated({ tags: ['triage'], previousTags: ['triage'], changedFields: ['title'] }),
        ),
        sub,
      ),
    ).toBe(false)
    // created WITHOUT the tag → no fire
    expect(
      matchesEvent(taskLifecycleToDispatchEvent(created({ tags: [] })), sub),
    ).toBe(false)
  })

  it('completed subscription fires via the action SET even when tagged is the same write', () => {
    const sub = taskSub({ inChannels: ['completed'] })
    const ev = taskLifecycleToDispatchEvent(
      updated({ previousStatus: 'todo', status: 'done', tags: ['x'], previousTags: [] }),
    )
    expect(matchesEvent(ev, sub)).toBe(true)
  })

  it('default fromBots=false filters assistant-created tasks; opting in fires', () => {
    const ev = taskLifecycleToDispatchEvent(created({ writtenBy: 'system' }))
    expect(matchesEvent(ev, taskSub({ inChannels: ['created'] }))).toBe(false)
    expect(
      matchesEvent(ev, taskSub({ inChannels: ['created'], fromBots: true })),
    ).toBe(true)
  })
})
