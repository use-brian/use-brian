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

// Bounds for the scratch store. Every distinct sessionId that ever touched
// createTask used to pin its task array for the process lifetime — the
// fastest-growing of the unbounded buffers behind the long-running local
// install's memory exhaustion (session-keyed, so it grows with usage, not
// content). Map insertion order doubles as recency: every write re-inserts
// its session, so overflow eviction hits the longest-idle session.
const MAX_SESSIONS = 256
const MAX_TASKS_PER_SESSION = 200

function touchSession(key: string, tasks: Task[]): void {
  sessionTasks.delete(key)
  sessionTasks.set(key, tasks)
  while (sessionTasks.size > MAX_SESSIONS) {
    const oldest = sessionTasks.keys().next().value
    if (oldest === undefined) break
    sessionTasks.delete(oldest)
  }
}

export function _getSessionTasksSize(): number {
  return sessionTasks.size
}

/** Test-only: reset the scratch store between cases. */
export function __resetSessionTasks(): void {
  sessionTasks.clear()
}

// NAMING COLLISION (see updateTaskTool below): this `createTask` and the brain
// `saveTask`/`updateTask` (tools/base -> tasks/tools.ts, gated on the `tasks`
// capability) write to DIFFERENT stores. `createTask` writes a session-only,
// in-memory scratch todo; `saveTask`/`updateTask` write the workspace's shared
// task list. Boot sets this base map FIRST, then the brain tools overwrite by
// name — so in the assembled map `updateTask` is ALWAYS the brain one (there is
// no session `updateTask` the model ever sees). That leaves session `createTask`
// with no session-`updateTask` partner, so its description must be fully
// self-contained about being session scratch. Do NOT rename either tool — the
// names appear in stored session histories. (Rename to `trackSubtask` is a v2
// option once histories can be migrated.)
export const createTaskTool = buildTool({
  name: 'createTask',
  description: 'SESSION-ONLY scratch todo for tracking THIS conversation\'s multi-step work — never the workspace\'s shared task list, and never a durable record. Use for complex requests that need multiple steps within this chat. To create a real task teammates can see, use saveTask (requires the tasks capability). This scratch list lives in memory for the current session only and disappears afterward.',
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
    // Scratch semantics: past the per-session cap the oldest entry falls off.
    // A session juggling 200+ live scratch todos is pathological; losing the
    // stalest one beats pinning them all.
    while (tasks.length > MAX_TASKS_PER_SESSION) tasks.shift()
    touchSession(key, tasks)

    return { data: { id: task.id, subject: task.subject, status: task.status } }
  },
})

// NAMING COLLISION: this base `updateTask` shares its name with the brain
// `updateTask` (tasks/tools.ts, gated on the `tasks` capability). Boot registers
// this base map first, then `.set('updateTask', ...)` the brain tool — so in the
// assembled tool map THIS definition is always overwritten and the model never
// sees it (only the brain `updateTask` survives). It is retained only as the
// partner of the session `createTask` for any call path that constructs the base
// map without the brain tools. Its description still marks the session scope in
// case it ever surfaces. See createTaskTool above for the full collision note.
export const updateTaskTool = buildTool({
  name: 'updateTask',
  description: 'SESSION-ONLY scratch todo update for THIS conversation\'s in-memory task list — never the workspace\'s shared task list. Use to mark a session scratch task as in_progress, completed, or failed. To change a real workspace task teammates can see, use the shared-brain updateTask (available when the tasks capability is granted; it targets a different, durable store).',
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
    // Refresh recency so an actively-updated session isn't the one evicted.
    touchSession(key, tasks)

    return { data: { id: task.id, subject: task.subject, status: task.status, result: task.result } }
  },
})
