/**
 * Google Tasks tools — list, get, create, update, and delete tasks.
 *
 * Read tools are concurrency-safe; write tools require confirmation.
 * The `api` callback object is injected by the API layer so core stays
 * free of network/OAuth deps.
 */

import { z } from 'zod'
import { buildTool, type Tool } from '../types.js'
import { type Json, str, asRows, projectList } from './_connector-result.js'

// Google Tasks list endpoints return `{ items: [...] }` with each task
// carrying etag / selfLink / position / links the model never needs. Project
// to the documented fields. See `_connector-result.ts`.
const taskListRow = (t: Json) => ({ id: str(t, 'id'), title: str(t, 'title') })
const taskRow = (t: Json) => ({
  id: str(t, 'id'),
  title: str(t, 'title'),
  status: str(t, 'status'),
  due: str(t, 'due'),
  notes: str(t, 'notes'),
  parent: str(t, 'parent'),
  completed: str(t, 'completed'),
})

export type GoogleTasksApi = {
  listTaskLists(params: { maxResults?: number }): Promise<unknown>

  listTasks(params: {
    taskListId: string
    showCompleted?: boolean
    dueMin?: string
    dueMax?: string
    maxResults?: number
  }): Promise<unknown>

  getTask(taskListId: string, taskId: string): Promise<unknown>

  createTask(taskListId: string, task: {
    title: string
    notes?: string
    due?: string
    parent?: string
  }): Promise<unknown>

  updateTask(taskListId: string, taskId: string, updates: {
    title?: string
    notes?: string
    due?: string
    status?: 'needsAction' | 'completed'
  }): Promise<unknown>

  deleteTask(taskListId: string, taskId: string): Promise<void>
}

export function createGoogleTasksTools(api: GoogleTasksApi): Tool[] {
  const listTaskLists = buildTool({
    name: 'googleTasksListTaskLists',
    description:
      'List all Google Tasks task lists. Returns list IDs and titles. ' +
      'Most users have a single default list with ID "@default".',
    inputSchema: z.object({
      maxResults: z.number().optional().describe('Max lists to return (default 100).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.listTaskLists({ maxResults: input.maxResults })
        return { data: projectList(asRows(((data ?? {}) as Json).items), input.maxResults ?? 100, taskListRow) }
      } catch (err) {
        return { data: `Tasks error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const listTasks = buildTool({
    name: 'googleTasksListTasks',
    description:
      'List tasks in a Google Tasks list. Returns task titles, statuses, due dates, and notes. ' +
      'Use taskListId "@default" for the user\'s default list.',
    inputSchema: z.object({
      taskListId: z.string().describe('Task list ID. Use "@default" for the default list.'),
      showCompleted: z.boolean().optional().describe('Include completed tasks (default false).'),
      dueMin: z.string().optional().describe('Lower bound for due date (RFC 3339, e.g. "2026-04-10T00:00:00Z").'),
      dueMax: z.string().optional().describe('Upper bound for due date (RFC 3339, e.g. "2026-04-20T00:00:00Z").'),
      maxResults: z.number().optional().describe('Max tasks to return (default 100).'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.listTasks({
          taskListId: input.taskListId,
          showCompleted: input.showCompleted,
          dueMin: input.dueMin,
          dueMax: input.dueMax,
          maxResults: input.maxResults,
        })
        return { data: projectList(asRows(((data ?? {}) as Json).items), input.maxResults ?? 100, taskRow) }
      } catch (err) {
        return { data: `Tasks error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const getTask = buildTool({
    name: 'googleTasksGetTask',
    description: 'Get details of a specific Google Task by ID.',
    inputSchema: z.object({
      taskListId: z.string().describe('Task list ID. Use "@default" for the default list.'),
      taskId: z.string().describe('The task ID to fetch.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        const data = await api.getTask(input.taskListId, input.taskId)
        return { data: taskRow((data ?? {}) as Json) }
      } catch (err) {
        return { data: `Tasks error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const createTask = buildTool({
    name: 'googleTasksCreateTask',
    description:
      'Create a new Google Task. ' +
      'Use ISO 8601 date format for due (e.g. "2026-04-15T00:00:00.000Z"). Only the date portion is used. ' +
      'Set parent to another task ID to create a subtask. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      taskListId: z.string().describe('Task list ID. Use "@default" for the default list.'),
      title: z.string().describe('Task title.'),
      notes: z.string().optional().describe('Task notes/description.'),
      due: z.string().optional().describe('Due date (ISO 8601, e.g. "2026-04-15T00:00:00.000Z"). Only the date portion is used.'),
      parent: z.string().optional().describe('Parent task ID — set to create a subtask.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const data = await api.createTask(input.taskListId, {
          title: input.title,
          notes: input.notes,
          due: input.due,
          parent: input.parent,
        })
        return { data: taskRow((data ?? {}) as Json) }
      } catch (err) {
        return { data: `Tasks error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const updateTask = buildTool({
    name: 'googleTasksUpdateTask',
    description:
      'Update an existing Google Task. Only include fields that need to change. ' +
      'Set status to "completed" to mark a task as done, or "needsAction" to re-open it. ' +
      'Always include currentTitle so the user knows which task is being changed. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      taskListId: z.string().describe('Task list ID. Use "@default" for the default list.'),
      taskId: z.string().describe('The task ID to update.'),
      currentTitle: z.string().optional().describe('Current task title — always include for the confirmation prompt.'),
      title: z.string().optional().describe('New task title (only if renaming).'),
      notes: z.string().optional().describe('New task notes/description.'),
      due: z.string().optional().describe('New due date (ISO 8601). Only the date portion is used.'),
      status: z.enum(['needsAction', 'completed']).optional().describe(
        'Task status. Set to "completed" to mark done, "needsAction" to re-open.',
      ),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 15_000,

    async execute(input) {
      try {
        const { taskListId, taskId, currentTitle: _display, ...updates } = input
        const data = await api.updateTask(taskListId, taskId, updates)
        return { data: taskRow((data ?? {}) as Json) }
      } catch (err) {
        return { data: `Tasks error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  const deleteTask = buildTool({
    name: 'googleTasksDeleteTask',
    description:
      'Delete a Google Task by ID. ' +
      'Include the title for the confirmation prompt. ' +
      'Call this tool directly — the user will see an Approve/Deny prompt.',
    inputSchema: z.object({
      taskListId: z.string().describe('Task list ID. Use "@default" for the default list.'),
      taskId: z.string().describe('The task ID to delete.'),
      title: z.string().optional().describe('Task title — include for the confirmation prompt.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: true,
    timeoutMs: 10_000,

    async execute(input) {
      try {
        await api.deleteTask(input.taskListId, input.taskId)
        return { data: `Task ${input.taskId} deleted successfully.` }
      } catch (err) {
        return { data: `Tasks error: ${err instanceof Error ? err.message : String(err)}`, isError: true }
      }
    },
  })

  return [listTaskLists, listTasks, getTask, createTask, updateTask, deleteTask]
}
