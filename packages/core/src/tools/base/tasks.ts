import { z } from 'zod'
import { buildTool } from '../types.js'

/**
 * Task management tools — model tracks multi-step work.
 * Tasks survive compaction and are queryable on resume.
 *
 * At MVP, tasks are stored in-memory per session.
 * Will be DB-backed (tasks table) when connected to the API layer.
 */

type Task = {
  id: string
  subject: string
  description?: string
  status: 'pending' | 'in_progress' | 'completed' | 'failed'
  result?: string
  parentId?: string
  createdAt: Date
}

const sessionTasks = new Map<string, Task[]>()
let taskCounter = 0

export function _getSessionTasksSize(): number {
  return sessionTasks.size
}

export const createTaskTool = buildTool({
  name: 'createTask',
  description: 'Create a task to track multi-step work. Use for complex requests that need multiple steps.',
  inputSchema: z.object({
    subject: z.string().describe('Brief task title'),
    description: z.string().optional().describe('Detailed description of what needs to be done'),
    parentTaskId: z.string().optional().describe('Parent task ID for subtasks'),
  }),
  isConcurrencySafe: true,
  isReadOnly: false,

  async execute(input, context) {
    const key = context.sessionId
    const tasks = sessionTasks.get(key) ?? []
    const task: Task = {
      id: `task_${++taskCounter}`,
      subject: input.subject,
      description: input.description,
      status: 'pending',
      parentId: input.parentTaskId,
      createdAt: new Date(),
    }
    tasks.push(task)
    sessionTasks.set(key, tasks)

    return { data: { id: task.id, subject: task.subject, status: task.status } }
  },
})

export const updateTaskTool = buildTool({
  name: 'updateTask',
  description: 'Update a task status or add results. Use to mark tasks as in_progress, completed, or failed.',
  inputSchema: z.object({
    taskId: z.string().describe('The task ID to update'),
    status: z.enum(['in_progress', 'completed', 'failed']).optional().describe('New status'),
    result: z.string().optional().describe('Result or completion summary'),
  }),
  isConcurrencySafe: true,
  isReadOnly: false,

  async execute(input, context) {
    const key = context.sessionId
    const tasks = sessionTasks.get(key) ?? []
    const task = tasks.find((t) => t.id === input.taskId)

    if (!task) {
      return { data: `Task ${input.taskId} not found`, isError: true }
    }

    if (input.status) task.status = input.status
    if (input.result) task.result = input.result

    return { data: { id: task.id, subject: task.subject, status: task.status, result: task.result } }
  },
})
