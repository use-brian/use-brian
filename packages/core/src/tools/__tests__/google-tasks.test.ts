import { describe, it, expect, vi } from 'vitest'
import { z } from 'zod'
import { createGoogleTasksTools, type GoogleTasksApi } from '../base/google-tasks.js'

// ── Helpers ──────────────────────────────────────────────────

const ctx = {
  userId: 'test-user',
  assistantId: 'test-assistant',
  sessionId: 'test-session',
  appId: 'test',
  channelType: 'web' as const,
  channelId: 'test-channel',
  abortSignal: new AbortController().signal,
}

function mockApi(overrides?: Partial<GoogleTasksApi>): GoogleTasksApi {
  return {
    listTaskLists: vi.fn().mockResolvedValue([]),
    listTasks: vi.fn().mockResolvedValue([]),
    getTask: vi.fn().mockResolvedValue({ id: 'task1', title: 'Test Task', status: 'needsAction' }),
    createTask: vi.fn().mockResolvedValue({ id: 'task-new', title: 'New Task', status: 'needsAction' }),
    updateTask: vi.fn().mockResolvedValue({ id: 'task1', title: 'Updated', status: 'completed' }),
    deleteTask: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  }
}

// ── Tests ────────────────────────────────────────────────────

describe('[COMP:tools/google-tasks] Google Tasks tools', () => {
  it('creates all 6 tasks tools', () => {
    const tools = createGoogleTasksTools(mockApi())
    expect(tools).toHaveLength(6)
    expect(tools.map((t) => t.name).sort()).toEqual([
      'googleTasksCreateTask',
      'googleTasksDeleteTask',
      'googleTasksGetTask',
      'googleTasksListTaskLists',
      'googleTasksListTasks',
      'googleTasksUpdateTask',
    ])
  })

  // ── Classification guards ──────────────────────────────────

  it('read tools have isReadOnly and isConcurrencySafe set', () => {
    const tools = createGoogleTasksTools(mockApi())
    const readTools = tools.filter((t) =>
      ['googleTasksListTaskLists', 'googleTasksListTasks', 'googleTasksGetTask'].includes(t.name),
    )
    expect(readTools).toHaveLength(3)
    for (const tool of readTools) {
      expect(tool.isReadOnly).toBe(true)
      expect(tool.isConcurrencySafe).toBe(true)
    }
  })

  it('write tools have requiresConfirmation set', () => {
    const tools = createGoogleTasksTools(mockApi())
    const writeTools = tools.filter((t) =>
      ['googleTasksCreateTask', 'googleTasksUpdateTask', 'googleTasksDeleteTask'].includes(t.name),
    )
    expect(writeTools).toHaveLength(3)
    for (const tool of writeTools) {
      expect(tool.requiresConfirmation).toBe(true)
    }
  })

  it('tool descriptions must NOT say "Requires confirmation" (causes double-confirm)', () => {
    const tools = createGoogleTasksTools(mockApi())
    for (const tool of tools) {
      expect(tool.description).not.toMatch(/[Rr]equires confirmation/)
    }
  })

  // ── Schema guards ──────────────────────────────────────────

  it('updateTask inputSchema includes status with enum values', () => {
    const tools = createGoogleTasksTools(mockApi())
    const updateTool = tools.find((t) => t.name === 'googleTasksUpdateTask')!
    const schema = updateTool.inputSchema as z.ZodObject<Record<string, z.ZodTypeAny>>
    const shape = schema.shape

    expect(shape.status).toBeDefined()

    const innerDef = (shape.status as z.ZodOptional<z.ZodEnum<[string, ...string[]]>>)._def
    expect(innerDef.typeName).toBe('ZodOptional')
    const enumDef = (innerDef.innerType as z.ZodEnum<[string, ...string[]]>)._def
    expect(enumDef.typeName).toBe('ZodEnum')
    expect(enumDef.values).toEqual(['needsAction', 'completed'])
  })

  it('updateTask description mentions completing tasks', () => {
    const tools = createGoogleTasksTools(mockApi())
    const updateTool = tools.find((t) => t.name === 'googleTasksUpdateTask')!
    expect(updateTool.description).toMatch(/completed/)
  })

  // ── Argument passthrough ───────────────────────────────────

  it('listTaskLists passes maxResults through to API', async () => {
    const api = mockApi()
    const tools = createGoogleTasksTools(api)
    const tool = tools.find((t) => t.name === 'googleTasksListTaskLists')!

    await tool.execute({ maxResults: 5 }, ctx)

    expect(api.listTaskLists).toHaveBeenCalledWith({ maxResults: 5 })
  })

  it('listTasks passes all params through to API', async () => {
    const api = mockApi()
    const tools = createGoogleTasksTools(api)
    const tool = tools.find((t) => t.name === 'googleTasksListTasks')!

    await tool.execute({
      taskListId: '@default',
      showCompleted: true,
      dueMin: '2026-04-01T00:00:00Z',
      dueMax: '2026-04-30T00:00:00Z',
      maxResults: 10,
    }, ctx)

    expect(api.listTasks).toHaveBeenCalledWith({
      taskListId: '@default',
      showCompleted: true,
      dueMin: '2026-04-01T00:00:00Z',
      dueMax: '2026-04-30T00:00:00Z',
      maxResults: 10,
    })
  })

  it('getTask passes taskListId and taskId through to API', async () => {
    const api = mockApi()
    const tools = createGoogleTasksTools(api)
    const tool = tools.find((t) => t.name === 'googleTasksGetTask')!

    await tool.execute({ taskListId: '@default', taskId: 'task-123' }, ctx)

    expect(api.getTask).toHaveBeenCalledWith('@default', 'task-123')
  })

  it('createTask passes all fields through to API', async () => {
    const api = mockApi()
    const tools = createGoogleTasksTools(api)
    const tool = tools.find((t) => t.name === 'googleTasksCreateTask')!

    await tool.execute({
      taskListId: '@default',
      title: 'Buy groceries',
      notes: 'Milk, eggs, bread',
      due: '2026-04-15T00:00:00.000Z',
      parent: 'parent-task-1',
    }, ctx)

    expect(api.createTask).toHaveBeenCalledWith('@default', {
      title: 'Buy groceries',
      notes: 'Milk, eggs, bread',
      due: '2026-04-15T00:00:00.000Z',
      parent: 'parent-task-1',
    })
  })

  it('updateTask passes only changed fields through to API', async () => {
    const api = mockApi()
    const tools = createGoogleTasksTools(api)
    const tool = tools.find((t) => t.name === 'googleTasksUpdateTask')!

    await tool.execute({
      taskListId: '@default',
      taskId: 'task-123',
      status: 'completed',
    }, ctx)

    expect(api.updateTask).toHaveBeenCalledWith('@default', 'task-123', {
      status: 'completed',
    })
  })

  it('deleteTask passes taskListId and taskId through to API', async () => {
    const api = mockApi()
    const tools = createGoogleTasksTools(api)
    const tool = tools.find((t) => t.name === 'googleTasksDeleteTask')!

    await tool.execute({
      taskListId: '@default',
      taskId: 'task-123',
      title: 'Old task',
    }, ctx)

    expect(api.deleteTask).toHaveBeenCalledWith('@default', 'task-123')
  })

  // ── Error handling ─────────────────────────────────────────

  it('returns isError when API throws', async () => {
    const api = mockApi({
      listTasks: vi.fn().mockRejectedValue(new Error('Tasks API error (401): Unauthorized')),
    })
    const tools = createGoogleTasksTools(api)
    const tool = tools.find((t) => t.name === 'googleTasksListTasks')!

    const result = await tool.execute({ taskListId: '@default' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.data).toContain('Tasks error:')
    expect(result.data).toContain('Unauthorized')
  })

  it('handles non-Error throws gracefully', async () => {
    const api = mockApi({
      getTask: vi.fn().mockRejectedValue('string error'),
    })
    const tools = createGoogleTasksTools(api)
    const tool = tools.find((t) => t.name === 'googleTasksGetTask')!

    const result = await tool.execute({ taskListId: '@default', taskId: 'x' }, ctx)

    expect(result.isError).toBe(true)
    expect(result.data).toContain('string error')
  })
})
