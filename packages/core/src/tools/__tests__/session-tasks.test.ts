import { describe, it, expect, beforeEach } from 'vitest'
import {
  createTaskTool,
  updateTaskTool,
  _getSessionTasksSize,
  __resetSessionTasks,
} from '../base/tasks.js'

function ctx(sessionId: string) {
  return {
    userId: 'test-user',
    assistantId: 'test-assistant',
    sessionId,
    appId: 'test',
    channelType: 'web',
    channelId: 'test-channel',
    abortSignal: new AbortController().signal,
  }
}

async function create(sessionId: string, subject = 'work'): Promise<string> {
  const result = await createTaskTool.execute({ subject }, ctx(sessionId))
  return (result.data as { id: string }).id
}

describe('[COMP:tools/session-tasks] Session scratch-task store', () => {
  beforeEach(() => {
    __resetSessionTasks()
  })

  it('create + update roundtrip within one session', async () => {
    const id = await create('s-roundtrip', 'step one')
    const updated = await updateTaskTool.execute(
      { taskId: id, status: 'completed', result: 'done' },
      ctx('s-roundtrip'),
    )
    expect(updated.isError).toBeFalsy()
    expect(updated.data).toMatchObject({ id, status: 'completed', result: 'done' })
  })

  it('updateTask on an unknown session does not materialize an entry', async () => {
    const result = await updateTaskTool.execute({ taskId: 'task_999999' }, ctx('s-ghost'))
    expect(result.isError).toBe(true)
    expect(_getSessionTasksSize()).toBe(0)
  })

  it('caps sessions at 256, evicting the longest-idle session first', async () => {
    const firstId = await create('s-0')
    for (let i = 1; i <= 256; i++) await create(`s-${i}`)
    expect(_getSessionTasksSize()).toBe(256)
    // s-0 was the oldest untouched session — its scratch list is gone.
    const evicted = await updateTaskTool.execute({ taskId: firstId }, ctx('s-0'))
    expect(evicted.isError).toBe(true)
  })

  it('a write refreshes session recency, so active sessions survive overflow', async () => {
    const activeId = await create('s-active')
    for (let i = 1; i <= 255; i++) await create(`s-${i}`) // store now full (256)
    // Touch the oldest session, making s-1 the eviction candidate instead.
    await updateTaskTool.execute({ taskId: activeId, status: 'in_progress' }, ctx('s-active'))
    await create('s-overflow')
    const active = await updateTaskTool.execute({ taskId: activeId }, ctx('s-active'))
    expect(active.isError).toBeFalsy()
  })

  it('caps tasks per session at 200, dropping the stalest scratch entry', async () => {
    const ids: string[] = []
    for (let i = 0; i < 205; i++) ids.push(await create('s-busy', `todo ${i}`))
    // The five oldest fell off; the newest 200 are still addressable.
    const dropped = await updateTaskTool.execute({ taskId: ids[0] }, ctx('s-busy'))
    expect(dropped.isError).toBe(true)
    const kept = await updateTaskTool.execute({ taskId: ids[204] }, ctx('s-busy'))
    expect(kept.isError).toBeFalsy()
    const boundary = await updateTaskTool.execute({ taskId: ids[5] }, ctx('s-busy'))
    expect(boundary.isError).toBeFalsy()
  })
})
