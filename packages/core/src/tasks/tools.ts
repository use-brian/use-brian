import { z } from 'zod'
import { extractCitations, formatStamp, type CitationIndex } from '@sidanclaw/shared'
import type { AccessContext } from '../security/access-context.js'
import { unionCompartments } from '../security/compartments.js'
import { buildTool, type Tool } from '../tools/types.js'
import { tolerantBoolean, tolerantInt } from '../tools/schema-tolerance.js'
import {
  applyExplicitCloses,
  applyExplicitLinks,
  explicitClosesField,
  explicitLinksField,
  formatClosesSummary,
  formatLinksSummary,
  isoDateOrDateTime,
  type EntityLinksStore,
} from '../entities/index.js'
import {
  TASK_STATUSES,
  type TaskListRow,
  type TaskRecord,
  type TaskRecordStatus,
  type TaskStore,
} from './types.js'

/**
 * Tools that let the primary assistant manage workspace-scoped tasks via
 * chat. Six tools: saveTask, getTask, listTasks, updateTask, closeTask,
 * reopenTask. See docs/architecture/features/tasks.md.
 *
 * Every tool requires `ctx.workspaceId`. Without a workspace there is no
 * place for tasks to live; the tool returns an isError result rather than
 * implicitly creating user-scoped state. The §9 collapse migration
 * guarantees every signed-in user has at least a Personal workspace, so
 * an absent `workspaceId` is a real error path (legacy / system caller).
 */

export type TaskToolEvent =
  | { type: 'task_created'; taskId: string }
  | { type: 'task_updated'; taskId: string; fields: string[] }
  | { type: 'task_listed'; resultCount: number }

/** Subset of ToolContext the analytics callback can use without pulling the full type in. */
type TaskToolEventContext = {
  userId: string
  assistantId: string
  sessionId: string
  channelType: string
}

export type TaskToolOptions = {
  /** Receives every primitive event with the originating tool context. Wire to AnalyticsLogger at boot. */
  onEvent?: (event: TaskToolEvent, ctx: TaskToolEventContext) => void
  /**
   * Edge store for writing `links` rows alongside the task. Optional
   * — when absent the `links` input field is silently dropped. Always
   * inject at API boot. Tasks link as `sourceKind: 'task'` to entities.
   */
  entityLinks?: EntityLinksStore
  /**
   * `source` stamped on tasks this tool creates. Default behavior (absent)
   * is unchanged — the store writes its default `'user'`. The structural-
   * synthesis engine builds these tools with `writeSource: 'extracted'` so
   * synthesis-captured tasks surface in Brain Reviews (`?includeExtracted=true`).
   */
  writeSource?: 'user' | 'extracted'
  /**
   * Extraction provenance anchor stamped on tasks this tool creates —
   * synthesis runs pass their source Episode id (the recording synthesizer's
   * recordingId IS its episode id) so the row back-edges to what it was
   * derived from. Absent for interactive chat, which anchors on the session
   * instead (`context.sessionId`, stamped unconditionally by saveTask).
   */
  writeSourceEpisodeId?: string | null
  /**
   * WIDEN `saveTask` to ask which moment of the source recording the task was
   * committed at (migration 338) — Fathom's lesson: an action item is a pointer
   * INTO the recording, not a detached string.
   *
   * Per-surface on purpose. The moment is per-TASK ("ship the pricing doc" at
   * 47:21, the next item at 1:12:04), so unlike `writeSourceEpisodeId` it
   * cannot be pinned at construction — the model must supply it, which means an
   * input field. `saveTask` is otherwise ONE object shared by chat, the callee
   * executor, and workflows, and a recording-shaped field on all of them would
   * advertise a moment that does not exist to a user saying "remind me to call
   * the bank" — an invitation to invent one. So only the recording
   * synthesizer's own tool map passes this; every other surface's `saveTask` is
   * byte-identical to before. (Precedent: `searchRecording` ships pinned for
   * synthesis and unpinned for brain-MCP — same tool, constructed per surface.)
   *
   * Carries the fill's `CitationIndex` rather than a bare flag so the moment is
   * validated the SAME way a record field's citations are — one rule, one
   * implementation (`extractCitations`), no second opinion about what counts as
   * a real moment.
   */
  citeSourceMoment?: { index: CitationIndex }
}

const STATUS_VALUES = [...TASK_STATUSES] as [TaskRecordStatus, ...TaskRecordStatus[]]
const statusEnum = z.enum(STATUS_VALUES)

const idShape = z.string().uuid()
const tagShape = z.array(z.string().min(1).max(64)).max(20)

function eventCtx(context: { userId: string; assistantId: string; sessionId: string; channelType: string }): TaskToolEventContext {
  return {
    userId: context.userId,
    assistantId: context.assistantId,
    sessionId: context.sessionId,
    channelType: context.channelType,
  }
}

function workspaceGate(workspaceId: string | null | undefined): { data: string; isError: true } | null {
  if (!workspaceId) {
    return {
      data: 'Tasks require a workspace. This assistant is not bound to one — switch to a workspace-scoped chat to manage tasks.',
      isError: true,
    }
  }
  return null
}

function ctxFor(context: {
  userId: string
  assistantId: string
  workspaceId: string
  assistantKind?: AccessContext['assistantKind']
  clearance?: AccessContext['clearance']
  compartments?: AccessContext['compartments']
}): AccessContext {
  return {
    workspaceId: context.workspaceId,
    userId: context.userId,
    assistantId: context.assistantId,
    assistantKind: context.assistantKind ?? 'standard',
    clearance: context.clearance,
    compartments: context.compartments,
  }
}

function compactRow(row: TaskListRow): {
  id: string
  title: string
  status: TaskRecordStatus
  assignee_id: string | null
  due: string | null
  tags: string[]
  parent_id: string | null
  attributes: Record<string, unknown>
  updated_at: string
} {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assignee_id: row.assigneeId,
    due: row.due ? row.due.toISOString() : null,
    tags: row.tags,
    parent_id: row.parentId,
    attributes: row.attributes,
    updated_at: row.updatedAt.toISOString(),
  }
}

function fullRow(row: TaskRecord): {
  id: string
  title: string
  status: TaskRecordStatus
  assignee_id: string | null
  due: string | null
  tags: string[]
  parent_id: string | null
  external_ref: Record<string, unknown>
  attributes: Record<string, unknown>
  created_at: string
  updated_at: string
} {
  return {
    id: row.id,
    title: row.title,
    status: row.status,
    assignee_id: row.assigneeId,
    due: row.due ? row.due.toISOString() : null,
    tags: row.tags,
    parent_id: row.parentId,
    external_ref: row.externalRef,
    attributes: row.attributes,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  }
}

export function createTaskTools(
  store: TaskStore,
  opts?: TaskToolOptions,
): {
  saveTask: Tool
  getTask: Tool
  listTasks: Tool
  updateTask: Tool
  closeTask: Tool
  reopenTask: Tool
} {
  const saveTask = buildTool({
    name: 'saveTask',
    requiresCapability: 'tasks',
    description:
      'Create a new task in the current workspace. Tasks are visible to every workspace member — use them for shared work items, not personal reminders (use scheduleJob / trackCommitment for those) and not durable facts (use saveMemory). ' +
      'Returns the new task id (shown in `[brackets]` in the result). To build a parent/child tree, create the parent FIRST, then pass its returned id as `parent_id` on each child — prefer this over creating tasks flat and re-parenting them afterward, because re-parenting via updateTask mutates task ids (see updateTask). Omit `parent_id` (or pass null) for a top-level task. Deleting a parent cascades to its sub-tasks. ' +
      'Status defaults to `todo` if omitted. Use `updateTask` to change a task later, or the `closeTask` / `reopenTask` shortcuts for the common state transition.',
    inputSchema: z.object({
      title: z.string().min(1).max(512).describe('Short, action-oriented title (e.g. "Review Q1 plan", "Ship migration 113").'),
      assignee_id: idShape.optional().describe('UUID of a workspace_members row (NOT a user_id). Omit if the task is unassigned. Call `listWorkspaceMembers` to resolve a person named in chat to their member id — usually filled in only when the user has named someone.'),
      due: isoDateOrDateTime.optional().describe('Resolve relative phrases like "Friday" to an absolute value in `userTimezone`: a zone-qualified ISO-8601 timestamp (offset or "Z") or a bare date.'),
      tags: tagShape.optional(),
      parent_id: idShape.nullable().optional().describe('UUID of an existing same-workspace task to nest this one under. Omit or pass null for a top-level task. The DB rejects cross-workspace parents.'),
      status: statusEnum.optional().describe('Defaults to `todo`. Use `archived` instead of deleting.'),
      external_ref: z.record(z.unknown()).optional().describe('Reserved for sync-engine round-tripping ({provider, id, url}). Leave empty unless the user is asking you to mirror an existing Linear/Asana task.'),
      attributes: z.record(z.unknown()).optional().describe('Free-form JSONB for user-defined per-task keys — typically sprint estimation / ordering / velocity (e.g. `estimate_days`, `estimate_points`, `order`). Schema is unvalidated; whatever keys the workspace converges on. Whole object overwrites on `updateTask` — read with `getTask` first if you only want to change one key.'),
      depends_on: z.array(idShape).max(50).optional().describe('Task ids this task depends on. Each becomes a task→task `depends_on` graph edge — the daily turn topologically reasons over the dependency graph (A depends_on B means "do B before A"). Same-workspace ids only. v1 limitation: append-only — emits new edges but does not remove existing ones. To restructure a dependency graph, soft-delete (`status: archived`) and re-create.'),
      links: explicitLinksField,
      // Present ONLY on a recording fill's tool map — see `citeSourceMoment`.
      // Spread so every other surface's schema is untouched, not merely
      // "optional there": a field the model cannot use should not be a field
      // the model can see.
      ...(opts?.citeSourceMoment
        ? {
            source_moment: z
              .string()
              .optional()
              .describe(
                'The moment in the recording this task was committed to, copied from the transcript line as `[H:MM:SS]` (e.g. "[0:47:21]"). Copy it — do not calculate it. Omit it if the transcript does not show the commitment being made; never guess a moment.',
              ),
          }
        : {}),
    }),
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      // Resolve the cited moment through the SAME validator the record's
      // citations use: an impossible stamp (`[00:85]`) or one past the end of
      // the transcript yields nothing, and a task is not worth failing over a
      // bad pointer — drop it and keep the task, exactly as an invented
      // citation on a record field is dropped while the prose survives.
      const moment =
        opts?.citeSourceMoment && typeof input.source_moment === 'string'
          ? (extractCitations(input.source_moment, opts.citeSourceMoment.index)[0] ?? null)
          : null

      try {
        const task = await store.create({
          userId: context.userId,
          workspaceId: context.workspaceId!,
          title: input.title,
          status: input.status,
          assigneeId: input.assignee_id ?? null,
          due: input.due ? new Date(input.due) : null,
          tags: input.tags,
          parentId: input.parent_id ?? null,
          externalRef: input.external_ref,
          attributes: input.attributes,
          compartments: unionCompartments(
            context.compartmentAccumulator?.compartments,
            context.assistantDefaultCompartments,
          ),
          source: opts?.writeSource,
          // Provenance anchors (mig 316). Extraction runs (writeSource
          // 'extracted') and the programmatic brain-MCP surface carry a
          // SYNTHETIC context.sessionId (randomUUID, no sessions row) — a
          // real session is only stamped for interactive/workflow chat.
          sourceEpisodeId: opts?.writeSourceEpisodeId ?? null,
          sourceStartMs: moment?.startMs ?? null,
          sourceSessionId:
            opts?.writeSourceEpisodeId || opts?.writeSource === 'extracted' || context.channelType === 'programmatic'
              ? null
              : context.sessionId,
          createdByAssistantId: context.assistantId,
          dependsOn: input.depends_on,
          // Assistant-mediated write (incl. interactive chat) — the workflow
          // task-event self-loop guard keys on this (fromBots gate).
          writtenBy: 'system',
        })
        opts?.onEvent?.({ type: 'task_created', taskId: task.id }, eventCtx(context))
        const linksSummary = await applyExplicitLinks({
          entityLinks: opts?.entityLinks,
          workspaceId: context.workspaceId!,
          userId: context.userId,
          assistantId: context.assistantId,
          sourceKind: 'task',
          sourceId: task.id,
          source: 'user',
          links: input.links,
        })
        // Echo the moment back when one was kept, so a model that cited a
        // moment the transcript does not contain sees it was dropped.
        const momentNote = moment ? ` @ ${formatStamp(moment.startMs)}` : ''
        return { data: `Created task [${task.id}]: ${task.title}${momentNote}${formatLinksSummary(linksSummary)}` }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        if (msg.includes('parent_id must reference a task in the same workspace')) {
          return { data: 'parent_id must reference a task in the same workspace.', isError: true }
        }
        if (msg.includes('foreign key') && msg.includes('assignee')) {
          return { data: 'assignee_id must reference a workspace member of this workspace.', isError: true }
        }
        if (msg.includes('foreign key') && msg.includes('parent')) {
          return { data: `parent_id ${input.parent_id} not found in this workspace.`, isError: true }
        }
        throw err
      }
    },
  })

  const getTask = buildTool({
    name: 'getTask',
    requiresCapability: 'tasks',
    description:
      'Fetch the full task record by id, including external_ref and created_at. Use this when you need details `listTasks` omits — `listTasks` returns a compact projection.',
    inputSchema: z.object({
      id: idShape.describe('Full UUID of the task.'),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const task = await store.getById(
        ctxFor({
          userId: context.userId,
          assistantId: context.assistantId,
          workspaceId: context.workspaceId!,
          assistantKind: context.assistantKind,
          clearance: context.clearance,
          compartments: context.compartments,
        }),
        input.id,
      )
      if (!task || task.workspaceId !== context.workspaceId) {
        return { data: `Task ${input.id} not found in workspace.`, isError: true }
      }
      return { data: fullRow(task) }
    },
  })

  const listTasks = buildTool({
    name: 'listTasks',
    requiresCapability: 'tasks',
    description:
      'List tasks in the current workspace, filtered by any combination of assignee / status / due range / tag / parent. Returns a compact projection (id, title, status, assignee, due, tags, parent, updated_at). For `external_ref` or `created_at`, use `getTask`. ' +
      'Default excludes archived tasks (set `include_archived: true` to include them). Default limit is 25 (max 100). Status accepts a single value or an array (e.g. `["todo", "in_progress"]`).',
    inputSchema: z.object({
      assignee_id: idShape.optional(),
      status: statusEnum.or(z.array(statusEnum)).optional(),
      due_before: isoDateOrDateTime.optional(),
      due_after: isoDateOrDateTime.optional(),
      tag: z.string().min(1).max(64).optional(),
      parent_id: idShape.optional().describe('Pass a parent task id to fetch its sub-tasks.'),
      include_archived: tolerantBoolean().optional().default(false),
      limit: tolerantInt({ min: 1, max: 100 }).optional().default(25),
    }),
    isConcurrencySafe: true,
    isReadOnly: true,
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate

      const rows = await store.list(
        ctxFor({
          userId: context.userId,
          assistantId: context.assistantId,
          workspaceId: context.workspaceId!,
          assistantKind: context.assistantKind,
          clearance: context.clearance,
          compartments: context.compartments,
        }),
        {
          assigneeId: input.assignee_id,
          status: input.status,
          dueBefore: input.due_before ? new Date(input.due_before) : undefined,
          dueAfter: input.due_after ? new Date(input.due_after) : undefined,
          tag: input.tag,
          parentId: input.parent_id,
          includeArchived: input.include_archived,
          limit: input.limit,
        },
      )

      opts?.onEvent?.({ type: 'task_listed', resultCount: rows.length }, eventCtx(context))
      return { data: rows.map(compactRow) }
    },
  })

  async function applyUpdate(
    context: { userId: string; workspaceId?: string | null },
    id: string,
    fields: Parameters<TaskStore['update']>[2],
  ): Promise<
    | { data: string; isError: true }
    | { ok: true; record: TaskRecord; changedFields: string[] }
  > {
    const gate = workspaceGate(context.workspaceId)
    if (gate) return gate

    let updated: TaskRecord | null
    try {
      // Assistant-mediated write (incl. interactive chat) — the workflow
      // task-event self-loop guard keys on this (fromBots gate).
      updated = await store.update(context.userId, id, fields, { writtenBy: 'system' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('parent_id must reference a task in the same workspace')) {
        return { data: 'parent_id must reference a task in the same workspace.', isError: true }
      }
      if (msg.includes('invalid input syntax for type uuid')) {
        return { data: `Task ${id} not found in workspace.`, isError: true }
      }
      throw err
    }
    if (!updated) {
      // Supersession-aware guidance: every task edit mints a NEW id
      // (bi-temporal supersession), and the dominant prod failure here was
      // the model re-editing with a stale id and retrying it into the
      // 5-strike breaker (11 breaker hits / 43% updateTask failure rate,
      // 2026-07-07 ability audit §2.2). Tell it exactly how to recover and
      // explicitly forbid the retry.
      return {
        data:
          `Task ${id} not found in workspace. If you edited this task earlier, that edit returned a NEW task id (every update supersedes the row) — reuse the id from that result, or call listTasks/getTask to re-resolve. Do NOT retry this exact id.`,
        isError: true,
      }
    }
    return { ok: true, record: updated, changedFields: Object.keys(fields) }
  }

  const updateTask = buildTool({
    name: 'updateTask',
    requiresCapability: 'tasks',
    description:
      'Patch fields on an existing task. Pass only the fields you want to change. To clear a nullable field (assignee_id, due, parent_id), pass `null` explicitly — omitting a key leaves it unchanged. ' +
      'Use `closeTask` / `reopenTask` for the common status transitions; use `updateTask` for everything else (rename, reassign, retag, due-date change, re-parent). ' +
      'Pass `links` to ADD task→entity relationship edges (e.g. mark this task as `mentioned` on a deal). Additive; pass at least one field or one link.',
    inputSchema: z.object({
      id: idShape,
      title: z.string().min(1).max(512).optional(),
      status: statusEnum.optional(),
      assignee_id: idShape.nullable().optional().describe('workspace_members id — call `listWorkspaceMembers` to resolve a name. Pass null to unassign.'),
      due: isoDateOrDateTime.nullable().optional(),
      tags: tagShape.optional(),
      parent_id: idShape.nullable().optional().describe('Re-parent under another same-workspace task, or pass null to detach to top-level. Re-parenting works, but updateTask returns a NEW task id (bi-temporal supersession) — use the id from the result for any further edits to this task. When building a fresh tree, prefer setting parent_id on saveTask at creation time instead.'),
      external_ref: z.record(z.unknown()).optional(),
      attributes: z.record(z.unknown()).optional().describe('Free-form JSONB (sprint estimation / ordering / velocity). Whole object overwrites — read with `getTask` first if only changing one key.'),
      depends_on: z.array(idShape).max(50).optional().describe('Task ids this task depends on. v1 limitation: **append-only** — adds new `depends_on` edges from the supersession row but does not remove existing ones. Omit to leave the dependency graph unchanged.'),
      links: explicitLinksField,
      closeLinks: explicitClosesField,
    }),
    async execute(input, context) {
      const fields: Parameters<TaskStore['update']>[2] = {}
      if (input.title !== undefined) fields.title = input.title
      if (input.status !== undefined) fields.status = input.status
      if (input.assignee_id !== undefined) fields.assigneeId = input.assignee_id
      if (input.due !== undefined) fields.due = input.due === null ? null : new Date(input.due)
      if (input.tags !== undefined) fields.tags = input.tags
      if (input.parent_id !== undefined) fields.parentId = input.parent_id
      if (input.external_ref !== undefined) fields.externalRef = input.external_ref
      if (input.attributes !== undefined) fields.attributes = input.attributes
      if (input.depends_on !== undefined) fields.dependsOn = input.depends_on

      const hasFieldChange = Object.keys(fields).length > 0
      const hasLinkChange = (input.links?.length ?? 0) > 0
      const hasCloseChange = (input.closeLinks?.length ?? 0) > 0
      if (!hasFieldChange && !hasLinkChange && !hasCloseChange) {
        return { data: 'Pass at least one field, link, or closeLink to update.', isError: true }
      }

      // Field-only path goes through applyUpdate (handles supersession);
      // links-only path requires the gate check + same task id.
      const writeEdgesAndClose = async (taskId: string): Promise<{ linksMsg: string; closesMsg: string }> => {
        const linksSummary = await applyExplicitLinks({
          entityLinks: opts?.entityLinks,
          workspaceId: context.workspaceId!,
          userId: context.userId,
          assistantId: context.assistantId,
          sourceKind: 'task',
          sourceId: taskId,
          source: 'user',
          links: input.links,
        })
        const closesSummary = await applyExplicitCloses({
          entityLinks: opts?.entityLinks,
          userId: context.userId,
          sourceKind: 'task',
          sourceId: taskId,
          closes: input.closeLinks,
        })
        return {
          linksMsg: formatLinksSummary(linksSummary),
          closesMsg: formatClosesSummary(closesSummary),
        }
      }

      if (hasFieldChange) {
        const result = await applyUpdate(context, input.id, fields)
        if ('isError' in result) return result
        opts?.onEvent?.({ type: 'task_updated', taskId: result.record.id, fields: result.changedFields }, eventCtx(context))
        const { linksMsg, closesMsg } = await writeEdgesAndClose(result.record.id)
        return {
          data: `Updated task [${result.record.id}]: ${result.record.title}${linksMsg}${closesMsg}`,
        }
      }

      // Links/closes-only path: gate + write edges against the existing task id.
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      const { linksMsg, closesMsg } = await writeEdgesAndClose(input.id)
      return { data: `Updated task [${input.id}]${linksMsg}${closesMsg}` }
    },
  })

  const closeTask = buildTool({
    name: 'closeTask',
    requiresCapability: 'tasks',
    description: 'Mark a task as done. Shorthand for `updateTask({id, status: "done"})`. Use `reopenTask` to revert.',
    inputSchema: z.object({ id: idShape }),
    async execute(input, context) {
      const result = await applyUpdate(context, input.id, { status: 'done' })
      if ('isError' in result) return result
      opts?.onEvent?.({ type: 'task_updated', taskId: result.record.id, fields: ['status'] }, eventCtx(context))
      return { data: `Closed task [${result.record.id}]: ${result.record.title}` }
    },
  })

  const reopenTask = buildTool({
    name: 'reopenTask',
    requiresCapability: 'tasks',
    description: 'Reopen a closed task — sets status back to `todo`. Shorthand for `updateTask({id, status: "todo"})`.',
    inputSchema: z.object({ id: idShape }),
    async execute(input, context) {
      const result = await applyUpdate(context, input.id, { status: 'todo' })
      if ('isError' in result) return result
      opts?.onEvent?.({ type: 'task_updated', taskId: result.record.id, fields: ['status'] }, eventCtx(context))
      return { data: `Reopened task [${result.record.id}]: ${result.record.title}` }
    },
  })

  return { saveTask, getTask, listTasks, updateTask, closeTask, reopenTask }
}
