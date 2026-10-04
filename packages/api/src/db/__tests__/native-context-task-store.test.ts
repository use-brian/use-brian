import { afterEach, expect, it, vi } from 'vitest'
import { createWorkflowEventDispatcher, type TaskStore } from '@use-brian/core'
vi.mock('../client.js', () => ({ query: vi.fn(), queryWithRLS: vi.fn() }))
import { query, queryWithRLS } from '../client.js'
import { createDbTaskStore } from '../tasks-store.js'
import { setTaskEventDispatcher } from '../../task-event-fanout.js'
import { _resetCoalescerForTests } from '../../brain-stream/notify.js'

const id = '00000000-0000-4000-8000-000000000001'
afterEach(() => { setTaskEventDispatcher(null); _resetCoalescerForTests(); vi.resetAllMocks() })

it('[COMP:api/task-event-fanout] real setup task writer notifies readers without workflow, waiting-goal or triage automation; ordinary creation still dispatches', async () => {
  // Only the SQL transport is synthetic: use the real store, createTask,
  // lifecycle producer and dispatcher, not a mocked create or publish function.
  vi.mocked(query).mockResolvedValue({ rows: [] } as never)
  vi.mocked(queryWithRLS).mockImplementation((async (_actor: string, sql: string, values: unknown[]) => {
    if (!sql.includes('INSERT INTO tasks')) return { rows: [] }
    return { rows: [{ id, workspaceId: values[0], title: values[1], status: values[2],
      assigneeId: values[3], due: values[4], tags: values[5], parentId: values[6],
      externalRef: JSON.parse(values[7] as string), attributes: JSON.parse(values[8] as string),
      compartments: values[10], projectIds: values[11], sensitivity: values[17],
      userId: values[18], assistantId: values[19], scopeVersion: '1', createdAt: new Date(), updatedAt: new Date() }] }
  }) as typeof queryWithRLS)
  const startWorkflowRun = vi.fn(async () => {})
  const resumeEventWaitingGoal = vi.fn(async () => {})
  const onTaskCreate = vi.fn()
  const findEventTriggeredWorkflows = vi.fn(async () => [{ workflowId: id, workspaceId: id, sources: [{ source: { type: 'task' as const } }] }])
  const findEventWaitingGoals = vi.fn(async () => [{ goalId: id, workspaceId: id, sources: [{ source: { type: 'task' as const } }] }])
  setTaskEventDispatcher(createWorkflowEventDispatcher({ findEventTriggeredWorkflows, startWorkflowRun, findEventWaitingGoals, resumeEventWaitingGoal }))
  const params: Parameters<TaskStore['create']>[0] = {
    userId: id, workspaceId: id, title: 'Explicit setup', status: 'todo',
    visibility: { userId: id, assistantId: id }, sourceSessionId: id,
    access: { userId: id, workspaceId: id, assistantId: id, assistantKind: 'primary', clearance: 'internal' },
  }
  const setup = createDbTaskStore({ creationAutomation: false, onTaskCreate })
  expect(await setup.create(params)).toMatchObject({ id, title: 'Explicit setup', sensitivity: 'internal' })
  await new Promise(resolve => setImmediate(resolve))
  expect(queryWithRLS).toHaveBeenCalledWith(id, expect.stringContaining('INSERT INTO tasks'), expect.arrayContaining([id, 'Explicit setup']))
  const notification = vi.mocked(query).mock.calls.find(([sql]) => sql === 'SELECT pg_notify($1, $2)')
  expect(notification).toBeDefined()
  expect(JSON.parse(String(notification![1]![1]))).toEqual({ workspaceId: id, primitive: 'task', action: 'create', rowId: id })
  expect(onTaskCreate).not.toHaveBeenCalled()
  expect(findEventTriggeredWorkflows).not.toHaveBeenCalled()
  expect(findEventWaitingGoals).not.toHaveBeenCalled()
  expect(startWorkflowRun).not.toHaveBeenCalled()
  expect(resumeEventWaitingGoal).not.toHaveBeenCalled()

  await createDbTaskStore({ onTaskCreate }).create({ ...params, title: 'Ordinary task' })
  await vi.waitFor(() => {
    expect(startWorkflowRun).toHaveBeenCalledOnce()
    expect(resumeEventWaitingGoal).toHaveBeenCalledOnce()
  })
  expect(onTaskCreate).toHaveBeenCalledOnce()
})
