import { z } from 'zod'
import { extractCitations, formatStamp, type CitationIndex } from '@use-brian/shared'
import type { AccessContext } from '../security/access-context.js'
import { resolveWriteScope, scopeEvidenceFromRows } from '../security/context-scope.js'
import { buildTool, type Tool, type ToolContext } from '../tools/types.js'
import { tolerantBoolean, tolerantEnumArray, tolerantInt } from '../tools/schema-tolerance.js'
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
import {
  admitTask,
  evaluateTaskMutationPolicy,
  type TaskAdmissionPort,
  type TaskRuleOperation,
} from './admission.js'

/**
 * Tools that let the primary assistant manage workspace-scoped tasks via
 * chat. Eight tools: saveTask, getTask, listTasks, updateTask, closeTask,
 * reopenTask, plus the confirmation-gated bulk pair bulkUpdateTasks /
 * archiveTasks ("clean up my tasks" as one instruction — the agent-native
 * lane of the Tasks operator surface, tasks-operator-surface §6 Phase 4).
 * See docs/architecture/features/tasks.md.
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
  /**
   * Task admission gate (`docs/architecture/features/task-guardrails.md`).
   * When wired, every `saveTask` call runs through `admitTask` on the
   * `assistant` lane before the write: a workspace deny-rule or a previously
   * rejected title refuses the create, a near-duplicate creates it anyway with
   * a warning the model relays.
   *
   * Optional so OSS deployments, tests, and any surface without a guardrail
   * store behave exactly as before — an absent port is "no policy stated",
   * which is not the same as "policy says allow", but is indistinguishable at
   * this layer and is the safe default.
   */
  admission?: TaskAdmissionPort
}

const STATUS_VALUES = [...TASK_STATUSES] as [TaskRecordStatus, ...TaskRecordStatus[]]
const statusEnum = z.enum(STATUS_VALUES)

const idShape = z.string().uuid()
const tagShape = z.array(z.string().min(1).max(64)).max(20)

/**
 * The task body. A conventional `attributes` key, not a column — the v1 schema
 * is frozen against typed scalar fields (tasks.md §1) — but the tools surface
 * it as a first-class field anyway: `attributes` is the USER's free-form bag
 * and `updateTask` replaces it wholesale, so a model asked to write prose
 * "into attributes" either omits it or clobbers the sprint keys beside it.
 * Same 10 000-char ceiling the brain-inbox `/adjust` boundary enforces.
 */
const descriptionShape = z.string().max(10_000)

/**
 * Supersession-aware guidance: every task edit mints a NEW id (bi-temporal
 * supersession), and the dominant prod failure here was the model re-editing
 * with a stale id and retrying it into the 5-strike breaker (11 breaker hits /
 * 43% updateTask failure rate, 2026-07-07 ability audit §2.2). Tell it exactly
 * how to recover and explicitly forbid the retry.
 */
function taskNotFoundMessage(id: string): string {
  return `Task ${id} not found in workspace. If you edited this task earlier, that edit returned a NEW task id (every update supersedes the row) — reuse the id from that result, or call listTasks/getTask to re-resolve. Do NOT retry this exact id.`
}

/**
 * Merge a description into a task's attribute bag without disturbing its
 * siblings (`priority`, `icon`, sprint keys). `null` removes the key — the
 * same merge contract the REST `/adjust` branch honors.
 */
function mergeDescription(
  base: Record<string, unknown> | undefined,
  description: string | null,
): Record<string, unknown> {
  const attrs = { ...(base ?? {}) }
  const trimmed = description?.trim()
  if (trimmed) attrs.description = description
  else delete attrs.description
  return attrs
}

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
  projectIds?: AccessContext['projectIds']
}): AccessContext {
  return {
    workspaceId: context.workspaceId,
    userId: context.userId,
    assistantId: context.assistantId,
    assistantKind: context.assistantKind ?? 'standard',
    clearance: context.clearance,
    compartments: context.compartments,
    projectIds: context.projectIds,
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
  bulkUpdateTasks: Tool
  archiveTasks: Tool
} {
  function accessFor(context: ToolContext): AccessContext {
    return ctxFor({
      userId: context.userId,
      assistantId: context.assistantId,
      workspaceId: context.workspaceId!,
      assistantKind: context.assistantKind,
      clearance: context.clearance,
      compartments: context.compartments,
    })
  }

  function resolveVisibleTask(context: ToolContext, id: string): Promise<TaskRecord | null> {
    const access = accessFor(context)
    return store.resolveById
      ? store.resolveById(access, id)
      : store.getById(access, id)
  }

  async function authorizeDelegatedOperation(
    context: ToolContext,
    operation: TaskRuleOperation,
    input: { taskId?: string; title?: string },
  ): Promise<{ data: string; isError: true } | null> {
    const authority = context.taskAuthority
    if (!authority) return null

    if (!context.workspaceId || new Date(authority.expiresAt).getTime() <= Date.now()) {
      return {
        data: 'This thread no longer has active task authority. Ask the user for a direct instruction before changing a task.',
        isError: true,
      }
    }
    if (!opts?.admission) {
      return {
        data: 'Task mutation policy is unavailable in this runtime, so this delegated thread cannot change tasks. Nothing was changed.',
        isError: true,
      }
    }

    let title = input.title ?? ''
    if (input.taskId) {
      if (authority.taskIds.length === 0) {
        return {
          data: 'This realtime thread target is not bound to any task. Nothing was changed.',
          isError: true,
        }
      }
      const requested = await resolveVisibleTask(context, input.taskId)
      if (!requested || requested.workspaceId !== context.workspaceId) {
        return { data: taskNotFoundMessage(input.taskId), isError: true }
      }
      const boundHeads = await Promise.all(
        authority.taskIds.map((id) => resolveVisibleTask(context, id)),
      )
      if (!boundHeads.some((task) => task?.id === requested.id)) {
        return {
          data: `Task ${input.taskId} is outside this realtime thread target's bound task scope. Nothing was changed.`,
          isError: true,
        }
      }
      title = requested.title
    }

    const rules = await opts.admission.listActiveRules(context.workspaceId)
    const decision = evaluateTaskMutationPolicy(
      {
        operation,
        authority: authority.kind,
        title,
        channelType: authority.channelType,
        channelRef: authority.channelRef,
        threadRef: authority.threadRef,
      },
      rules,
    )
    if (decision.allowed) return null
    return {
      data: `${decision.explanation} Nothing was changed. Ask the user for a direct instruction or add a scoped allow rule.`,
      isError: true,
    }
  }

  const saveTask = buildTool({
    name: 'saveTask',
    requiresCapability: 'tasks',
    description:
      'Create a new task in the current workspace. Tasks are visible to every workspace member — use them for shared work items, not personal reminders (use scheduleJob / trackCommitment for those) and not durable facts (use saveMemory). ' +
      'Returns the new task id (shown in `[brackets]` in the result). To build a parent/child tree, create the parent FIRST, then pass its returned id as `parent_id` on each child — prefer this over creating tasks flat and re-parenting them afterward, because re-parenting via updateTask mutates task ids (see updateTask). Omit `parent_id` (or pass null) for a top-level task. Deleting a parent cascades to its sub-tasks. ' +
      'Status defaults to `todo` if omitted. Use `updateTask` to change a task later, or the `closeTask` / `reopenTask` shortcuts for the common state transition.',
    inputSchema: z.object({
      title: z.string().min(1).max(512).describe('Short, action-oriented title (e.g. "Review Q1 plan", "Ship migration 113").'),
      description: descriptionShape.optional().describe(
        'What the task actually is, written so whoever opens it later can act without reading this conversation: the objective and context, where or how to start, and what result means done. Markdown. Write one whenever the conversation supports it — a bare title makes the reader reconstruct the ask. Ground it in what was said; never invent a target, a tool, or a deadline the user did not give you.',
      ),
      assignee_id: idShape.optional().describe('UUID of a workspace_members row (NOT a user_id). Omit if the task is unassigned. Call `listWorkspaceMembers` to resolve a person named in chat to their member id — usually filled in only when the user has named someone.'),
      due: isoDateOrDateTime.optional().describe('Resolve relative phrases like "Friday" to an absolute value in `userTimezone`: a zone-qualified ISO-8601 timestamp (offset or "Z") or a bare date.'),
      tags: tagShape.optional(),
      parent_id: idShape.nullable().optional().describe('UUID of an existing same-workspace task to nest this one under. Omit or pass null for a top-level task. The DB rejects cross-workspace parents.'),
      status: statusEnum.optional().describe('Defaults to `todo`. Use `archived` instead of deleting.'),
      external_ref: z.record(z.unknown()).optional().describe('Reserved for sync-engine round-tripping ({provider, id, url}). Leave empty unless the user is asking you to mirror an existing Linear/Asana task.'),
      projectId: idShape.nullable().optional().describe('Stable Project id for this task. Omit or pass null for Workspace General. This associates the task only; it never changes the current chat context.'),
      attributes: z.record(z.unknown()).optional().describe('Free-form JSONB for user-defined per-task keys — typically sprint estimation / ordering / velocity (e.g. `estimate_days`, `estimate_points`, `order`). Schema is unvalidated; whatever keys the workspace converges on. Use the `description` field rather than a `description` key here. Whole object overwrites on `updateTask` — read with `getTask` first if you only want to change one key.'),
      depends_on: z.array(idShape).max(50).optional().describe('Task ids this task depends on. Each becomes a task→task `depends_on` graph edge — the daily turn topologically reasons over the dependency graph (A depends_on B means "do B before A"). Same-workspace ids only. v1 limitation: append-only — emits new edges but does not remove existing ones. To restructure a dependency graph, soft-delete (`status: archived`) and re-create.'),
      links: explicitLinksField,
      override_guardrail: tolerantBoolean()
        .optional()
        .describe(
          'Bypass this workspace\'s task guardrails (duplicate suppression, deny rules, previously rejected titles). Only set this after a create was refused, you told the user why, and they said to create it anyway. Never set it pre-emptively.',
        ),
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
      const delegated = await authorizeDelegatedOperation(context, 'create', { title: input.title })
      if (delegated) return delegated

      // Resolve the cited moment through the SAME validator the record's
      // citations use: an impossible stamp (`[00:85]`) or one past the end of
      // the transcript yields nothing, and a task is not worth failing over a
      // bad pointer — drop it and keep the task, exactly as an invented
      // citation on a record field is dropped while the prose survives.
      const moment =
        opts?.citeSourceMoment && typeof input.source_moment === 'string'
          ? (extractCitations(input.source_moment, opts.citeSourceMoment.index)[0] ?? null)
          : null

      // Admission gate — the assistant lane. A `hold` never reaches here: for a
      // task the user asked for directly, a review tray is a non-answer, so
      // `admitTask` collapses it to an allow carrying a warning we append to the
      // result. A `drop` refuses, but returns a plain (non-error) result whose
      // text is written to be read aloud — the model is expected to tell the
      // user which rule or existing task blocked it, not to retry silently.
      let admissionWarning: string | null = null
      if (opts?.admission && input.override_guardrail !== true) {
        const verdict = await admitTask(opts.admission, {
          workspaceId: context.workspaceId!,
          title: input.title,
          due: input.due ? new Date(input.due) : null,
          assigneeId: input.assignee_id ?? null,
          lane: 'assistant',
          sourceEpisodeId: opts.writeSourceEpisodeId ?? null,
          createdByAssistantId: context.assistantId,
        })
        if (!verdict.admitted && verdict.outcome !== 'allow') {
          return { data: verdict.explanation }
        }
        if (verdict.outcome === 'allow' && verdict.warning) {
          admissionWarning = ` (${verdict.warning.explanation})`
        }
      }

      try {
        const writeScope = resolveWriteScope({
          baseCompartments: context.assistantDefaultCompartments,
          baseProjectIds: context.assistantDefaultProjectIds,
          explicitProjectIds: input.projectId ? [input.projectId] : undefined,
          evidence: context.scopeAccumulator ?? {
            sensitivity: context.sensitivity?.max,
            compartments: context.compartmentAccumulator?.compartments,
          },
          compartmentGrant: context.compartments,
          projectGrant: context.projectIds,
        })
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
          attributes:
            input.description !== undefined
              ? mergeDescription(input.attributes, input.description)
              : input.attributes,
          compartments: writeScope.compartments,
          projectIds: writeScope.projectIds,
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
          compartments: writeScope.compartments,
          projectIds: writeScope.projectIds,
        })
        // Echo the moment back when one was kept, so a model that cited a
        // moment the transcript does not contain sees it was dropped.
        const momentNote = moment ? ` @ ${formatStamp(moment.startMs)}` : ''
        return {
          data: `Created task [${task.id}]: ${task.title}${momentNote}${formatLinksSummary(linksSummary)}${admissionWarning ?? ''}`,
        }
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
          projectIds: context.projectIds,
        }),
        input.id,
      )
      if (!task || task.workspaceId !== context.workspaceId) {
        return { data: taskNotFoundMessage(input.id), isError: true }
      }
        return { data: fullRow(task), scopeEvidence: scopeEvidenceFromRows([task]) }
    },
  })

  const listTasks = buildTool({
    name: 'listTasks',
    requiresCapability: 'tasks',
    description:
      'List tasks in the current workspace, filtered by any combination of assignee / status / due range / tag / parent. Returns a compact projection (id, title, status, assignee, due, tags, parent, updated_at). For `external_ref` or `created_at`, use `getTask`. ' +
      'Default excludes archived tasks (set `include_archived: true` to include them). Default limit is 25 (max 100). Status accepts a single value or an array (e.g. `["todo", "in_progress"]`).',
    inputSchema: z.object({
      assignee_id: idShape.optional().describe('workspace_members id — from `listWorkspaceMembers`. For "my tasks" use the row flagged `isCurrentUser: true`; never guess a member id from a name.'),
      // Tolerant because this is the param models serialise loosely — a
      // stringified or comma-joined list reads as neither branch of the union
      // and failed 35 times in production. See `tolerantEnumArray`.
      status: tolerantEnumArray(TASK_STATUSES).optional(),
      due_before: isoDateOrDateTime.optional(),
      due_after: isoDateOrDateTime.optional(),
      tag: z.string().min(1).max(64).optional(),
      projectId: idShape.nullable().optional().describe('Filter by stable Project id, or null for Workspace General.'),
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
          projectIds: context.projectIds,
        }),
        {
          assigneeId: input.assignee_id,
          status: input.status,
          dueBefore: input.due_before ? new Date(input.due_before) : undefined,
          dueAfter: input.due_after ? new Date(input.due_after) : undefined,
          tag: input.tag,
          projectId: input.projectId,
          parentId: input.parent_id,
          includeArchived: input.include_archived,
          limit: input.limit,
        },
      )

      opts?.onEvent?.({ type: 'task_listed', resultCount: rows.length }, eventCtx(context))
        return { data: rows.map(compactRow), scopeEvidence: scopeEvidenceFromRows(rows) }
    },
  })

  async function applyUpdate(
    context: ToolContext,
    id: string,
    fields: Parameters<TaskStore['update']>[2],
    operations: readonly TaskRuleOperation[],
  ): Promise<
    | { data: string; isError: true }
    | { ok: true; record: TaskRecord; changedFields: string[] }
  > {
    const gate = workspaceGate(context.workspaceId)
    if (gate) return gate

    for (const operation of operations) {
      const delegated = await authorizeDelegatedOperation(context, operation, { taskId: id })
      if (delegated) return delegated
    }

    let updated: TaskRecord | null
    try {
      // Assistant-mediated write (incl. interactive chat) — the workflow
      // task-event self-loop guard keys on this (fromBots gate).
      const writeScope = resolveWriteScope({
        baseCompartments: context.assistantDefaultCompartments,
        baseProjectIds: context.assistantDefaultProjectIds,
        evidence: context.scopeAccumulator ?? {
          sensitivity: context.sensitivity?.max,
          compartments: context.compartmentAccumulator?.compartments,
        },
        compartmentGrant: context.compartments,
        projectGrant: context.projectIds,
      })
      updated = await store.update(context.userId, id, fields, {
        writtenBy: 'system',
        scope: {
          compartments: writeScope.compartments,
          projectIds: writeScope.projectIds,
        },
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      if (msg.includes('parent_id must reference a task in the same workspace')) {
        return { data: 'parent_id must reference a task in the same workspace.', isError: true }
      }
      if (msg.includes('invalid input syntax for type uuid')) {
        return { data: `Task id "${id}" is not a UUID, so it cannot match any task. Ids come from listTasks / getTask / a prior save result — never a title. ${taskNotFoundMessage(id)}`, isError: true }
      }
      throw err
    }
    if (!updated) return { data: taskNotFoundMessage(id), isError: true }
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
      description: descriptionShape.nullable().optional().describe(
        'Replace the task body — the objective and context, where or how to start, and what result means done. Markdown. Pass null to clear it. Merged into the task, so sibling attribute keys (priority, icon, sprint fields) survive; this is a full replacement of the body text itself, so include what you want kept.',
      ),
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

      // `attributes` is a whole-object replace, so writing the body alone has to
      // merge onto the row's CURRENT bag — otherwise a one-line description edit
      // silently drops the priority / icon / sprint keys beside it.
      if (input.description !== undefined) {
        const gate = workspaceGate(context.workspaceId)
        if (gate) return gate
        let base = input.attributes
        if (base === undefined) {
          const current = await resolveVisibleTask(context, input.id)
          if (!current || current.workspaceId !== context.workspaceId) {
            return { data: taskNotFoundMessage(input.id), isError: true }
          }
          base = current.attributes
        }
        fields.attributes = mergeDescription(base, input.description)
      }

      const hasFieldChange = Object.keys(fields).length > 0
      const hasLinkChange = (input.links?.length ?? 0) > 0
      const hasCloseChange = (input.closeLinks?.length ?? 0) > 0
      if (!hasFieldChange && !hasLinkChange && !hasCloseChange) {
        return { data: 'Pass at least one field, link, or closeLink to update.', isError: true }
      }

      // Field-only path goes through applyUpdate (handles supersession);
      // links-only path requires the gate check + same task id.
      const writeEdgesAndClose = async (taskId: string): Promise<{ linksMsg: string; closesMsg: string }> => {
        const edgeWriteScope = resolveWriteScope({
          baseCompartments: context.assistantDefaultCompartments,
          baseProjectIds: context.assistantDefaultProjectIds,
          evidence: context.scopeAccumulator,
          compartmentGrant: context.compartments,
          projectGrant: context.projectIds,
        })
        const linksSummary = await applyExplicitLinks({
          entityLinks: opts?.entityLinks,
          workspaceId: context.workspaceId!,
          userId: context.userId,
          assistantId: context.assistantId,
          sourceKind: 'task',
          sourceId: taskId,
          source: 'user',
          links: input.links,
          compartments: edgeWriteScope.compartments,
          projectIds: edgeWriteScope.projectIds,
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
        const operations: TaskRuleOperation[] = []
        if (input.status !== undefined) {
          operations.push(input.status === 'archived' ? 'archive' : 'update_status')
        }
        if (
          Object.keys(fields).some((key) => key !== 'status') ||
          hasLinkChange ||
          hasCloseChange
        ) {
          operations.push('update_details')
        }
        const result = await applyUpdate(context, input.id, fields, [...new Set(operations)])
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
      const delegated = await authorizeDelegatedOperation(context, 'update_details', { taskId: input.id })
      if (delegated) return delegated
      const current = await resolveVisibleTask(context, input.id)
      if (!current || current.workspaceId !== context.workspaceId) {
        return { data: taskNotFoundMessage(input.id), isError: true }
      }
      const { linksMsg, closesMsg } = await writeEdgesAndClose(current.id)
      return { data: `Updated task [${current.id}]${linksMsg}${closesMsg}` }
    },
  })

  const closeTask = buildTool({
    name: 'closeTask',
    requiresCapability: 'tasks',
    description: 'Mark a task as done. Shorthand for `updateTask({id, status: "done"})`. Use `reopenTask` to revert.',
    inputSchema: z.object({ id: idShape }),
    async execute(input, context) {
      const result = await applyUpdate(context, input.id, { status: 'done' }, ['update_status'])
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
      const result = await applyUpdate(context, input.id, { status: 'todo' }, ['update_status'])
      if ('isError' in result) return result
      opts?.onEvent?.({ type: 'task_updated', taskId: result.record.id, fields: ['status'] }, eventCtx(context))
      return { data: `Reopened task [${result.record.id}]: ${result.record.title}` }
    },
  })

  // ── Bulk pair — filter-scoped mass mutation, confirmation-gated ───────
  //
  // The agent-native cleanup lane: "close every stale unassigned todo"
  // becomes one confirmed call instead of N updateTask round-trips. Both
  // tools resolve their filter to at most BULK_CAP live rows via the same
  // access-scoped `store.list` read path `listTasks` uses, then loop the
  // per-row supersession update. `requiresConfirmation: true` (the
  // parent-CASCADE caution in tasks.md) — the user sees the filter + change
  // before anything moves.

  const BULK_CAP = 100

  const bulkFilterSchema = z
    .object({
      status: statusEnum.or(z.array(statusEnum)).optional(),
      assignee_id: idShape.optional(),
      unassigned: tolerantBoolean()
        .optional()
        .describe('Match only tasks with no assignee.'),
      tag: z.string().min(1).max(64).optional(),
      updated_before: isoDateOrDateTime
        .optional()
        .describe('Match tasks last touched BEFORE this instant — the staleness filter (e.g. 30 days ago).'),
      due_before: isoDateOrDateTime.optional(),
      ids: z
        .array(idShape)
        .max(BULK_CAP)
        .optional()
        .describe('Explicit task ids to target (combined with the other filter fields, all must match).'),
    })
    .refine((f) => Object.values(f).some((v) => v !== undefined), {
      message: 'Pass at least one filter field — an empty filter would sweep the whole backlog.',
    })

  type BulkFilter = z.infer<typeof bulkFilterSchema>

  const bulkSetSchema = z
    .object({
      status: statusEnum.optional(),
      assignee_id: idShape.nullable().optional().describe('workspace_members id; null unassigns.'),
      due: isoDateOrDateTime.nullable().optional().describe('null clears the due date.'),
      priority: z
        .enum(['low', 'medium', 'high', 'urgent'])
        .nullable()
        .optional()
        .describe('Merged into `attributes.priority`; null clears it.'),
    })
    .refine((set) => Object.values(set).some((value) => value !== undefined), {
      message: 'Pass at least one field to set.',
    })

  const bulkUpdateSchema = z.object({ filter: bulkFilterSchema, set: bulkSetSchema })
  const archiveTasksSchema = z.object({ filter: bulkFilterSchema })

  /** Resolve a bulk filter to its matching live rows (capped). */
  async function resolveBulkRows(
    context: Parameters<Tool['execute']>[1],
    filter: BulkFilter,
  ): Promise<TaskListRow[]> {
    const statuses = filter.status
    const includeArchived = Array.isArray(statuses)
      ? statuses.includes('archived')
      : statuses === 'archived'
    let rows = await store.list(
      ctxFor({
        userId: context.userId,
        assistantId: context.assistantId,
        workspaceId: context.workspaceId!,
        assistantKind: context.assistantKind,
        clearance: context.clearance,
        compartments: context.compartments,
        projectIds: context.projectIds,
      }),
      {
        assigneeId: filter.assignee_id,
        status: filter.status,
        tag: filter.tag,
        dueBefore: filter.due_before ? new Date(filter.due_before) : undefined,
        includeArchived,
        limit: BULK_CAP,
      },
    )
    if (filter.unassigned) rows = rows.filter((r) => r.assigneeId === null)
    if (filter.updated_before) {
      const cutoff = new Date(filter.updated_before).getTime()
      rows = rows.filter((r) => r.updatedAt.getTime() < cutoff)
    }
    if (filter.ids) {
      const wanted = new Set(filter.ids)
      rows = rows.filter((r) => wanted.has(r.id))
    }
    return rows
  }

  function readableTaskStatus(status: TaskRecordStatus): string {
    const text = status.replace(/_/g, ' ')
    return text.charAt(0).toUpperCase() + text.slice(1)
  }

  function bulkTargetLines(verb: string, rows: TaskListRow[]): string[] {
    if (rows.length === 0) return ['No tasks currently match this filter.']
    const shown = rows.slice(0, 20)
    const lines = [
      `${verb} ${rows.length} task(s):`,
      ...shown.map((row) => `• ${row.title} (${readableTaskStatus(row.status)})`),
    ]
    if (rows.length > shown.length) lines.push(`• ${rows.length - shown.length} more task(s)`)
    return lines
  }

  function bulkChangeLines(set: z.infer<typeof bulkSetSchema>): string[] {
    const lines = ['Changes:']
    if (set.status !== undefined) lines.push(`• Status: ${readableTaskStatus(set.status)}`)
    if (set.assignee_id !== undefined) {
      lines.push(
        set.assignee_id === null
          ? '• Assignee: Unassigned'
          : `• Assignee: workspace member ${set.assignee_id.slice(0, 8)}`,
      )
    }
    if (set.due !== undefined) lines.push(`• Due: ${set.due === null ? 'Clear due date' : set.due}`)
    if (set.priority !== undefined) {
      const priority = set.priority === null
        ? 'Clear priority'
        : set.priority.charAt(0).toUpperCase() + set.priority.slice(1)
      lines.push(`• Priority: ${priority}`)
    }
    return lines
  }

  /** Loop the per-row supersession update over resolved rows. */
  async function applyBulk(
    context: Parameters<Tool['execute']>[1],
    rows: TaskListRow[],
    fieldsFor: (row: TaskListRow) => Parameters<TaskStore['update']>[2],
  ): Promise<{ updated: number; failed: number }> {
    let updated = 0
    let failed = 0
    for (const row of rows) {
      try {
        const writeScope = resolveWriteScope({
          baseCompartments: context.assistantDefaultCompartments,
          baseProjectIds: context.assistantDefaultProjectIds,
          evidence: context.scopeAccumulator ?? {
            sensitivity: context.sensitivity?.max,
            compartments: context.compartmentAccumulator?.compartments,
          },
          compartmentGrant: context.compartments,
          projectGrant: context.projectIds,
        })
        const result = await store.update(context.userId, row.id, fieldsFor(row), {
          writtenBy: 'system',
          scope: {
            compartments: writeScope.compartments,
            projectIds: writeScope.projectIds,
          },
        })
        if (result) {
          updated++
          opts?.onEvent?.(
            { type: 'task_updated', taskId: result.id, fields: Object.keys(fieldsFor(row)) },
            eventCtx(context),
          )
        } else failed++
      } catch {
        failed++
      }
    }
    return { updated, failed }
  }

  function bulkSummary(verb: string, rows: TaskListRow[], updated: number, failed: number): string {
    const lines = rows
      .slice(0, 15)
      .map((r) => `- ${r.title}`)
      .join('\n')
    const more = rows.length > 15 ? `\n…and ${rows.length - 15} more` : ''
    const failNote = failed > 0 ? ` (${failed} failed — every edit mints a new id; re-run listTasks to re-resolve)` : ''
    return `${verb} ${updated} task(s)${failNote}:\n${lines}${more}`
  }

  const bulkUpdateTasks = buildTool({
    name: 'bulkUpdateTasks',
    requiresCapability: 'tasks',
    requiresConfirmation: true,
    description:
      'Update MANY tasks in one confirmed call: everything matching `filter` gets `set` applied (status / assignee / due / priority). The backlog-cleanup verb — e.g. filter `{status: "todo", unassigned: true, updated_before: <30 days ago>}` with set `{status: "archived"}` clears the stale unassigned backlog. ' +
      `Caps at ${BULK_CAP} tasks per call; requires at least one filter field (an empty filter is rejected). For archiving, \`archiveTasks\` is the shorthand. Every update supersedes its row (new task ids).`,
    inputSchema: bulkUpdateSchema,
    async describeConfirmation(input, context) {
      if (!context.workspaceId) return null
      const parsed = bulkUpdateSchema.safeParse(input)
      if (!parsed.success) return null
      const rows = await resolveBulkRows(context, parsed.data.filter)
      return [
        ...bulkTargetLines('Update', rows),
        ...bulkChangeLines(parsed.data.set),
      ]
    },
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      if (context.taskAuthority) {
        return { data: 'Bulk task updates are not available from a realtime thread target. Nothing was changed.', isError: true }
      }
      const rows = await resolveBulkRows(context, input.filter)
      if (rows.length === 0) return { data: 'No tasks match that filter — nothing to update.' }
      const { updated, failed } = await applyBulk(context, rows, (row) => {
        const fields: Parameters<TaskStore['update']>[2] = {}
        if (input.set.status !== undefined) fields.status = input.set.status
        if (input.set.assignee_id !== undefined) fields.assigneeId = input.set.assignee_id
        if (input.set.due !== undefined) fields.due = input.set.due === null ? null : new Date(input.set.due)
        if (input.set.priority !== undefined) {
          const attrs = { ...row.attributes }
          if (input.set.priority === null) delete attrs.priority
          else attrs.priority = input.set.priority
          fields.attributes = attrs
        }
        return fields
      })
      return { data: bulkSummary('Updated', rows, updated, failed) }
    },
  })

  const archiveTasks = buildTool({
    name: 'archiveTasks',
    requiresCapability: 'tasks',
    requiresConfirmation: true,
    description:
      'Archive MANY tasks in one confirmed call — the soft-delete sweep (`status: "archived"`; archived tasks leave every default list but stay recoverable). Shorthand for `bulkUpdateTasks` with `set: {status: "archived"}`. ' +
      `Same filter shape and ${BULK_CAP}-task cap; requires at least one filter field.`,
    inputSchema: archiveTasksSchema,
    async describeConfirmation(input, context) {
      if (!context.workspaceId) return null
      const parsed = archiveTasksSchema.safeParse(input)
      if (!parsed.success) return null
      const rows = await resolveBulkRows(context, parsed.data.filter)
      return [
        ...bulkTargetLines('Archive', rows),
        'Changes:',
        '• Status: Archived',
      ]
    },
    async execute(input, context) {
      const gate = workspaceGate(context.workspaceId)
      if (gate) return gate
      if (context.taskAuthority) {
        return { data: 'Bulk task archiving is not available from a realtime thread target. Nothing was changed.', isError: true }
      }
      const rows = await resolveBulkRows(context, input.filter)
      if (rows.length === 0) return { data: 'No tasks match that filter — nothing to archive.' }
      const { updated, failed } = await applyBulk(context, rows, () => ({ status: 'archived' }))
      return { data: bulkSummary('Archived', rows, updated, failed) }
    },
  })

  return { saveTask, getTask, listTasks, updateTask, closeTask, reopenTask, bulkUpdateTasks, archiveTasks }
}
