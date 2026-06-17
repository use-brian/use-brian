import { describe, it, expect, afterEach } from 'vitest'
import { createBaseTools, createTaskTool, updateTaskTool, getTimeTool } from '../base/index.js'

const ctx = {
  userId: 'test-user',
  assistantId: 'test-assistant',
  sessionId: 'test-session',
  appId: 'test',
  channelType: 'web',
  channelId: 'test-channel',
  abortSignal: new AbortController().signal,
}

describe('[COMP:tools/base] Base tools', () => {
  // xSearch is conditional on XAI_API_KEY — strip it before each base-set
  // assertion so these tests are deterministic regardless of env.
  const xaiKeyBefore = process.env.XAI_API_KEY
  delete process.env.XAI_API_KEY
  afterEach(() => {
    if (xaiKeyBefore === undefined) delete process.env.XAI_API_KEY
    else process.env.XAI_API_KEY = xaiKeyBefore
  })

  it('createBaseTools returns all 6 tools when XAI_API_KEY is absent', () => {
    const tools = createBaseTools()
    expect(tools.size).toBe(6)
    expect([...tools.keys()].sort()).toEqual([
      'askQuestion', 'createTask', 'getTime', 'updateTask',
      'urlReader', 'webSearch',
    ])
  })

  it('createBaseTools registers xSearch when XAI_API_KEY is set', () => {
    process.env.XAI_API_KEY = 'stub'
    try {
      const tools = createBaseTools()
      expect(tools.size).toBe(7)
      expect(tools.has('xSearch')).toBe(true)
    } finally {
      delete process.env.XAI_API_KEY
    }
  })

  it('getTime tool returns current time', async () => {
    const result = await getTimeTool.execute({}, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data as string).toMatch(/\d{4}/)
  })

  it('getTime tool respects timezone', async () => {
    const result = await getTimeTool.execute({ timezone: 'Asia/Hong_Kong' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data as string).toMatch(/GMT\+8|HKT/)
  })

  it('getTime tool rejects invalid timezone', async () => {
    const result = await getTimeTool.execute({ timezone: 'Invalid/Zone' }, ctx)
    expect(result.isError).toBe(true)
  })

  it('task tools create and update', async () => {
    const createResult = await createTaskTool.execute(
      { subject: 'Plan Tokyo trip', description: 'Research flights and hotels' },
      ctx,
    )
    const task = createResult.data as { id: string; status: string }
    expect(task.status).toBe('pending')

    const updateResult = await updateTaskTool.execute(
      { taskId: task.id, status: 'completed', result: 'Booked everything' },
      ctx,
    )
    const updated = updateResult.data as { status: string; result: string }
    expect(updated.status).toBe('completed')
    expect(updated.result).toBe('Booked everything')
  })
})
