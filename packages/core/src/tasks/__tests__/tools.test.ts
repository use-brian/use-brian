import { describe, it, expect } from 'vitest'
import { buildCitationIndex } from '@use-brian/shared'
import { createTaskTools, type TaskToolEvent } from '../tools.js'
import type { TaskRecord, TaskStore } from '../types.js'

// The real store persists provenance (source*, mig 316/334) but does NOT
// project it back on reads — `TaskRecord` is deliberately a compact,
// model-facing shape. The fake keeps it so a test can assert what `create` was
// actually asked to write.
type FakeRow = TaskRecord & {
  sourceEpisodeId?: string | null
  sourceStartMs?: number | null
}

function makeFakeStore(): TaskStore & {
  rows: FakeRow[]
  createDependsOn: Array<readonly string[] | undefined>
  updateDependsOn: Array<readonly string[] | undefined>
} {
  const rows: FakeRow[] = []
  const createDependsOn: Array<readonly string[] | undefined> = []
  const updateDependsOn: Array<readonly string[] | undefined> = []
  let nextId = 100
  const store: TaskStore & {
    rows: FakeRow[]
    createDependsOn: Array<readonly string[] | undefined>
    updateDependsOn: Array<readonly string[] | undefined>
  } = {
    rows,
    createDependsOn,
    updateDependsOn,
    async create(params) {
      createDependsOn.push(params.dependsOn)
      // Mirror DB trigger semantics — reject cross-workspace parent.
      if (params.parentId) {
        const parent = rows.find((r) => r.id === params.parentId)
        if (!parent || parent.workspaceId !== params.workspaceId) {
          throw new Error('parent_id must reference a task in the same workspace')
        }
      }
      const now = new Date()
      const row: FakeRow = {
        id: `00000000-0000-0000-0000-${String(nextId++).padStart(12, '0')}`,
        workspaceId: params.workspaceId,
        title: params.title,
        status: params.status ?? 'todo',
        assigneeId: params.assigneeId ?? null,
        due: params.due ?? null,
        tags: params.tags ?? [],
        parentId: params.parentId ?? null,
        externalRef: params.externalRef ?? {},
        attributes: params.attributes ?? {},
        sourceEpisodeId: params.sourceEpisodeId ?? null,
        sourceStartMs: params.sourceStartMs ?? null,
        createdAt: now,
        updatedAt: now,
      }
      rows.push(row)
      return { ...row }
    },
    async getById(_ctx, id) {
      const row = rows.find((r) => r.id === id)
      return row ? { ...row } : null
    },
    async list(ctx, filters) {
      let filtered = rows.filter((r) => r.workspaceId === ctx.workspaceId)
      if (filters.assigneeId) filtered = filtered.filter((r) => r.assigneeId === filters.assigneeId)
      if (filters.status) {
        const set = Array.isArray(filters.status) ? filters.status : [filters.status]
        filtered = filtered.filter((r) => set.includes(r.status))
      } else if (!filters.includeArchived) {
        filtered = filtered.filter((r) => r.status !== 'archived')
      }
      if (filters.tag) filtered = filtered.filter((r) => r.tags.includes(filters.tag!))
      if (filters.parentId) filtered = filtered.filter((r) => r.parentId === filters.parentId)
      if (filters.dueBefore) filtered = filtered.filter((r) => r.due !== null && r.due < filters.dueBefore!)
      if (filters.dueAfter) filtered = filtered.filter((r) => r.due !== null && r.due > filters.dueAfter!)
      return filtered.slice(0, filters.limit ?? 25).map((r) => ({
        id: r.id, workspaceId: r.workspaceId, title: r.title, status: r.status,
        assigneeId: r.assigneeId, due: r.due, tags: r.tags, parentId: r.parentId,
        attributes: r.attributes,
        updatedAt: r.updatedAt,
      }))
    },
    async update(_userId, id, fields) {
      updateDependsOn.push(fields.dependsOn)
      const row = rows.find((r) => r.id === id)
      if (!row) return null
      if (fields.title !== undefined) row.title = fields.title
      if (fields.status !== undefined) row.status = fields.status
      if (fields.assigneeId !== undefined) row.assigneeId = fields.assigneeId
      if (fields.due !== undefined) row.due = fields.due
      if (fields.tags !== undefined) row.tags = fields.tags
      if (fields.parentId !== undefined) {
        if (fields.parentId !== null) {
          const parent = rows.find((r) => r.id === fields.parentId)
          if (!parent || parent.workspaceId !== row.workspaceId) {
            throw new Error('parent_id must reference a task in the same workspace')
          }
        }
        row.parentId = fields.parentId
      }
      if (fields.externalRef !== undefined) row.externalRef = fields.externalRef
      if (fields.attributes !== undefined) row.attributes = fields.attributes
      row.updatedAt = new Date()
      return { ...row }
    },
  }
  return store
}

const ctx = {
  assistantId: 'assistant_1',
  userId: 'user_1',
  sessionId: 'session_1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'c_1',
  workspaceId: 'workspace_1',
  abortSignal: new AbortController().signal,
}

const ctxNoWorkspace = { ...ctx, workspaceId: null }

const UUID_A = '11111111-1111-1111-1111-111111111111'
const UUID_B = '22222222-2222-2222-2222-222222222222'

// ── The source moment (migration 338) ────────────────────────────────────
//
// `saveTask` is ONE object shared by chat, the callee executor, and workflows.
// The recording fill widens it with a `source_moment` input; the whole design
// rests on that widening being invisible everywhere else.

describe('[COMP:tasks/tools] saveTask source moment', () => {
  const INDEX = buildCitationIndex(
    [
      { segmentIndex: 0, startMs: 0, endMs: 30_000, speaker: 'Ken' },
      { segmentIndex: 38, startMs: 2_800_000, endMs: 2_900_000, speaker: 'Priya' },
    ],
    2_900_000,
  )

  it('does not expose source_moment on a surface that has no recording', () => {
    // The load-bearing assertion: a user in chat saying "remind me to call the
    // bank" must not be shown a field for a moment in a recording that does not
    // exist — an irrelevant optional field is an invitation to invent a value.
    // Asserted through the schema's observable behaviour (an unknown key is
    // stripped) rather than its internals, which is what the model actually
    // experiences as the contract.
    const { saveTask } = createTaskTools(makeFakeStore())
    const parsed = saveTask.inputSchema.safeParse({ title: 'Call the bank', source_moment: '[0:47:21]' })
    expect(parsed.success).toBe(true)
    expect(parsed.success && 'source_moment' in parsed.data).toBe(false)
  })

  it('exposes source_moment only when the fill passes a citation index', () => {
    const { saveTask } = createTaskTools(makeFakeStore(), { citeSourceMoment: { index: INDEX } })
    const parsed = saveTask.inputSchema.safeParse({ title: 'Ship it', source_moment: '[0:47:21]' })
    expect(parsed.success && 'source_moment' in parsed.data).toBe(true)
  })

  it('stamps the cited moment onto the task', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store, {
      writeSource: 'extracted',
      writeSourceEpisodeId: 'rec-1',
      citeSourceMoment: { index: INDEX },
    })
    const res = await saveTask.execute(
      { title: 'Ship the pricing doc', source_moment: '[0:47:21]' } as never,
      ctx,
    )
    expect(store.rows[0]).toMatchObject({ sourceEpisodeId: 'rec-1', sourceStartMs: 2_841_000 })
    // Echoed back so a model whose moment was dropped can see it.
    expect(res.data).toContain('0:47:21')
  })

  it('keeps the task but drops a moment past the end of the transcript', async () => {
    // The transcript ends at 2,900,000ms. A task is not worth failing over a
    // bad pointer — the same posture as an invented citation on a record field,
    // where the prose survives and only the pointer is refused.
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store, { citeSourceMoment: { index: INDEX } })
    const res = await saveTask.execute(
      { title: 'Follow up', source_moment: '[2:00:00]' } as never,
      ctx,
    )
    expect(res.isError).toBeFalsy()
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0].sourceStartMs).toBeNull()
  })

  it('drops an impossible stamp the same way the record citations do', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store, { citeSourceMoment: { index: INDEX } })
    await saveTask.execute({ title: 'X', source_moment: '[00:85]' } as never, ctx)
    expect(store.rows[0].sourceStartMs).toBeNull()
  })

  it('leaves the moment null when the model omits it', async () => {
    // "Omit it if the transcript does not show the commitment being made" —
    // an uncited action item is still a real action item.
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store, { citeSourceMoment: { index: INDEX } })
    await saveTask.execute({ title: 'Unstamped' } as never, ctx)
    expect(store.rows[0].sourceStartMs).toBeNull()
  })

  it('never stamps a moment on a surface without the widening', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    // Even if a value smuggles through, the un-widened tool must ignore it.
    await saveTask.execute({ title: 'Chat task', source_moment: '[0:47:21]' } as never, ctx)
    expect(store.rows[0].sourceStartMs ?? null).toBeNull()
  })
})

describe('[COMP:tasks/tools] saveTask', () => {
  it('creates a new task with defaults', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    const result = await saveTask.execute({ title: 'Review Q1 plan' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(store.rows).toHaveLength(1)
    expect(store.rows[0]).toMatchObject({
      title: 'Review Q1 plan',
      status: 'todo',
      workspaceId: 'workspace_1',
      assigneeId: null,
      tags: [],
      parentId: null,
    })
  })

  it('emits task_created event with the new task id', async () => {
    const store = makeFakeStore()
    const events: TaskToolEvent[] = []
    const { saveTask } = createTaskTools(store, { onEvent: (e) => events.push(e) })
    await saveTask.execute({ title: 'Ship migration' }, ctx)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ type: 'task_created' })
  })

  it('respects assignee_id, due, tags, status, external_ref', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    const due = '2026-06-01T00:00:00.000Z'
    await saveTask.execute({
      title: 'Ship task',
      assignee_id: UUID_A,
      due,
      tags: ['q1', 'tasks'],
      status: 'in_progress',
      external_ref: { provider: 'linear', id: 'ENG-42', url: 'https://linear.app/x' },
    }, ctx)
    expect(store.rows[0]).toMatchObject({
      assigneeId: UUID_A,
      tags: ['q1', 'tasks'],
      status: 'in_progress',
      externalRef: { provider: 'linear', id: 'ENG-42', url: 'https://linear.app/x' },
    })
    expect(store.rows[0].due).toEqual(new Date(due))
  })

  it('creates a sub-task when parent_id points at a same-workspace parent', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    await saveTask.execute({ title: 'Parent' }, ctx)
    const parentId = store.rows[0].id
    const result = await saveTask.execute({ title: 'Sub', parent_id: parentId }, ctx)
    expect(result.isError).toBeFalsy()
    expect(store.rows[1].parentId).toBe(parentId)
  })

  it('accepts parent_id: null at the schema boundary (no top-level task should be rejected)', () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    // Regression: parent_id was `.optional()` (not `.nullable()`), so a client
    // passing the natural `parent_id: null` for "no parent" hit a hard Zod
    // InputValidationError and had to discover that omitting was the only path.
    // It must now parse cleanly — aligned with updateTask's nullable parent_id.
    const parsed = saveTask.inputSchema.safeParse({ title: 'Top level', parent_id: null })
    expect(parsed.success).toBe(true)
  })

  it('treats parent_id: null as a top-level task', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    const result = await saveTask.execute({ title: 'Top level', parent_id: null }, ctx)
    expect(result.isError).toBeFalsy()
    expect(store.rows[0].parentId).toBeNull()
  })

  it('errors out when workspaceId is absent', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    const result = await saveTask.execute({ title: 'Orphan' }, ctxNoWorkspace)
    expect(result.isError).toBe(true)
    expect(store.rows).toHaveLength(0)
  })
})

describe('[COMP:tasks/tools] due-date validation', () => {
  // Regression for the 2026-06-02 retry storm (session b0903ea6): strict
  // z.string().datetime() accepted ONLY a UTC `Z` suffix, so the offset
  // timestamp the model produces from `userTimezone` was rejected with an
  // uninformative "Invalid datetime" and the model blind-guessed format
  // variants — 8 saveTask calls in one turn. `due` now accepts any
  // zone-qualified ISO-8601 (offset OR Z) or a bare date.
  const accepted = [
    '2026-06-04T09:00:00+08:00', // offset — the model's natural output; was rejected
    '2026-06-04T01:00:00.000Z', // UTC Z
    '2026-06-04T09:00:00.000+08:00', // offset with millis
    '2026-06-04', // bare date ("set the dates for tomorrow")
  ]
  const rejected = [
    '2026-06-04T09:00:00', // zoneless time — ambiguous, must be rejected
    '2026-06-04T09:00', // zoneless, no seconds
    'tomorrow', // natural language
    '2026-13-99', // not a real calendar date
  ]

  it('accepts offset, UTC-Z, and bare-date forms on saveTask', () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    for (const due of accepted) {
      expect(saveTask.inputSchema.safeParse({ title: 'x', due }).success).toBe(true)
    }
  })

  it('rejects zoneless / non-ISO values with an actionable message', () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    for (const due of rejected) {
      const parsed = saveTask.inputSchema.safeParse({ title: 'x', due })
      expect(parsed.success).toBe(false)
      if (!parsed.success) {
        // The message must name the accepted shapes (not bare "Invalid datetime")
        // so the model self-corrects in one retry instead of guessing.
        expect(parsed.error.issues[0].message).toMatch(/offset|UTC|bare date|timezone/i)
      }
    }
  })

  it('stores the correct instant for an offset due (execute path)', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    await saveTask.execute({ title: 'polish workflow interface', due: '2026-06-04T09:00:00+08:00' }, ctx)
    // +08:00 09:00 == 01:00Z — the same instant the incident eventually saved.
    expect(store.rows[0].due).toEqual(new Date('2026-06-04T01:00:00.000Z'))
  })

  it('applies the same rule to updateTask.due and listTasks filters', () => {
    const store = makeFakeStore()
    const { updateTask, listTasks } = createTaskTools(store)
    expect(updateTask.inputSchema.safeParse({ id: UUID_A, due: '2026-06-04T09:00:00+08:00' }).success).toBe(true)
    expect(updateTask.inputSchema.safeParse({ id: UUID_A, due: '2026-06-04T09:00:00' }).success).toBe(false)
    expect(listTasks.inputSchema.safeParse({ due_before: '2026-06-04T09:00:00+08:00' }).success).toBe(true)
    expect(listTasks.inputSchema.safeParse({ due_after: 'tomorrow' }).success).toBe(false)
  })
})

describe('[COMP:tasks/tools] getTask', () => {
  it('returns the full record including external_ref and created_at', async () => {
    const store = makeFakeStore()
    const { saveTask, getTask } = createTaskTools(store)
    await saveTask.execute({
      title: 'Ship',
      external_ref: { provider: 'linear', id: 'ENG-1' },
    }, ctx)
    const id = store.rows[0].id
    const result = await getTask.execute({ id }, ctx)
    expect(result.isError).toBeFalsy()
    const data = result.data as Record<string, unknown>
    expect(data).toMatchObject({
      id, title: 'Ship', status: 'todo',
      external_ref: { provider: 'linear', id: 'ENG-1' },
    })
    expect(data).toHaveProperty('created_at')
  })

  it('returns isError when the task is not found', async () => {
    const store = makeFakeStore()
    const { getTask } = createTaskTools(store)
    const result = await getTask.execute({ id: UUID_A }, ctx)
    expect(result.isError).toBe(true)
  })

  it('errors out when workspaceId is absent', async () => {
    const store = makeFakeStore()
    const { getTask } = createTaskTools(store)
    const result = await getTask.execute({ id: UUID_A }, ctxNoWorkspace)
    expect(result.isError).toBe(true)
  })
})

describe('[COMP:tasks/tools] listTasks', () => {
  async function seed(store: ReturnType<typeof makeFakeStore>) {
    const { saveTask } = createTaskTools(store)
    await saveTask.execute({ title: 'Open A', status: 'todo', tags: ['eng'], assignee_id: UUID_A }, ctx)
    await saveTask.execute({ title: 'In progress', status: 'in_progress', tags: ['eng'] }, ctx)
    await saveTask.execute({ title: 'Done', status: 'done' }, ctx)
    await saveTask.execute({ title: 'Archived', status: 'archived' }, ctx)
  }

  it('excludes archived by default', async () => {
    const store = makeFakeStore()
    await seed(store)
    const { listTasks } = createTaskTools(store)
    const result = await listTasks.execute({}, ctx)
    expect(result.isError).toBeFalsy()
    const data = result.data as Array<{ status: string }>
    expect(data.map((r) => r.status)).not.toContain('archived')
    expect(data).toHaveLength(3)
  })

  it('includes archived when include_archived is true', async () => {
    const store = makeFakeStore()
    await seed(store)
    const { listTasks } = createTaskTools(store)
    const result = await listTasks.execute({ include_archived: true }, ctx)
    const data = result.data as Array<{ status: string }>
    expect(data.map((r) => r.status)).toContain('archived')
  })

  it('filters by status array', async () => {
    const store = makeFakeStore()
    await seed(store)
    const { listTasks } = createTaskTools(store)
    const result = await listTasks.execute({ status: ['todo', 'in_progress'] }, ctx)
    const data = result.data as Array<{ status: string }>
    expect(data.map((r) => r.status).sort()).toEqual(['in_progress', 'todo'])
  })

  it('filters by assignee + tag together', async () => {
    const store = makeFakeStore()
    await seed(store)
    const { listTasks } = createTaskTools(store)
    const result = await listTasks.execute({ assignee_id: UUID_A, tag: 'eng' }, ctx)
    const data = result.data as Array<{ title: string }>
    expect(data).toHaveLength(1)
    expect(data[0].title).toBe('Open A')
  })

  it('returns the compact projection (no external_ref / created_at)', async () => {
    const store = makeFakeStore()
    await seed(store)
    const { listTasks } = createTaskTools(store)
    const result = await listTasks.execute({}, ctx)
    const data = result.data as Array<Record<string, unknown>>
    expect(data[0]).not.toHaveProperty('external_ref')
    expect(data[0]).not.toHaveProperty('created_at')
  })

  it('emits task_listed with result count', async () => {
    const store = makeFakeStore()
    await seed(store)
    const events: TaskToolEvent[] = []
    const { listTasks } = createTaskTools(store, { onEvent: (e) => events.push(e) })
    await listTasks.execute({}, ctx)
    expect(events.find((e) => e.type === 'task_listed')).toMatchObject({
      type: 'task_listed', resultCount: 3,
    })
  })

  it('errors out when workspaceId is absent', async () => {
    const store = makeFakeStore()
    const { listTasks } = createTaskTools(store)
    const result = await listTasks.execute({}, ctxNoWorkspace)
    expect(result.isError).toBe(true)
  })
})

describe('[COMP:tasks/tools] updateTask', () => {
  it('patches only the fields passed', async () => {
    const store = makeFakeStore()
    const { saveTask, updateTask } = createTaskTools(store)
    await saveTask.execute({ title: 'Ship', tags: ['old'], assignee_id: UUID_A }, ctx)
    const id = store.rows[0].id
    await updateTask.execute({ id, title: 'Ship Q1 migration' }, ctx)
    expect(store.rows[0].title).toBe('Ship Q1 migration')
    expect(store.rows[0].tags).toEqual(['old'])
    expect(store.rows[0].assigneeId).toBe(UUID_A)
  })

  it('clears nullable fields when null is passed', async () => {
    const store = makeFakeStore()
    const { saveTask, updateTask } = createTaskTools(store)
    await saveTask.execute({
      title: 'Ship',
      assignee_id: UUID_A,
      due: '2026-06-01T00:00:00.000Z',
    }, ctx)
    const id = store.rows[0].id
    await updateTask.execute({ id, assignee_id: null, due: null }, ctx)
    expect(store.rows[0].assigneeId).toBeNull()
    expect(store.rows[0].due).toBeNull()
  })

  it('errors out when no fields are passed', async () => {
    const store = makeFakeStore()
    const { saveTask, updateTask } = createTaskTools(store)
    await saveTask.execute({ title: 'Ship' }, ctx)
    const id = store.rows[0].id
    const result = await updateTask.execute({ id }, ctx)
    expect(result.isError).toBe(true)
  })

  it('errors out when the task is not found', async () => {
    const store = makeFakeStore()
    const { updateTask } = createTaskTools(store)
    const result = await updateTask.execute({ id: UUID_A, title: 'X' }, ctx)
    expect(result.isError).toBe(true)
  })

  it('errors out when workspaceId is absent', async () => {
    const store = makeFakeStore()
    const { updateTask } = createTaskTools(store)
    const result = await updateTask.execute({ id: UUID_A, title: 'X' }, ctxNoWorkspace)
    expect(result.isError).toBe(true)
  })
})

describe('[COMP:tasks/tools] closeTask + reopenTask', () => {
  it('closeTask sets status to done', async () => {
    const store = makeFakeStore()
    const { saveTask, closeTask } = createTaskTools(store)
    await saveTask.execute({ title: 'Ship' }, ctx)
    const id = store.rows[0].id
    const result = await closeTask.execute({ id }, ctx)
    expect(result.isError).toBeFalsy()
    expect(store.rows[0].status).toBe('done')
  })

  it('reopenTask sets status to todo', async () => {
    const store = makeFakeStore()
    const { saveTask, closeTask, reopenTask } = createTaskTools(store)
    await saveTask.execute({ title: 'Ship' }, ctx)
    const id = store.rows[0].id
    await closeTask.execute({ id }, ctx)
    expect(store.rows[0].status).toBe('done')
    await reopenTask.execute({ id }, ctx)
    expect(store.rows[0].status).toBe('todo')
  })

  it('emits task_updated event for status changes', async () => {
    const store = makeFakeStore()
    const events: TaskToolEvent[] = []
    const { saveTask, closeTask, reopenTask } = createTaskTools(store, { onEvent: (e) => events.push(e) })
    await saveTask.execute({ title: 'Ship' }, ctx)
    const id = store.rows[0].id
    await closeTask.execute({ id }, ctx)
    await reopenTask.execute({ id }, ctx)
    expect(events.filter((e) => e.type === 'task_updated')).toHaveLength(2)
  })

  it('closeTask errors out when workspaceId is absent', async () => {
    const store = makeFakeStore()
    const { closeTask } = createTaskTools(store)
    const result = await closeTask.execute({ id: UUID_B }, ctxNoWorkspace)
    expect(result.isError).toBe(true)
  })
})

describe('[COMP:tasks/tools] tool flags', () => {
  it('listTasks and getTask are read-only and concurrency-safe', () => {
    const { listTasks, getTask } = createTaskTools(makeFakeStore())
    expect(listTasks.isReadOnly).toBe(true)
    expect(listTasks.isConcurrencySafe).toBe(true)
    expect(getTask.isReadOnly).toBe(true)
    expect(getTask.isConcurrencySafe).toBe(true)
  })

  it('write tools are not read-only / concurrency-safe / require-confirmation', () => {
    const { saveTask, updateTask, closeTask, reopenTask } = createTaskTools(makeFakeStore())
    for (const t of [saveTask, updateTask, closeTask, reopenTask]) {
      expect(t.isReadOnly).toBe(false)
      expect(t.isConcurrencySafe).toBe(false)
      expect(t.requiresConfirmation).toBe(false)
    }
  })

  // §17 — every task tool must declare requiresCapability='tasks' so the
  // per-turn filterToolsByCapabilities gate hides the tool from assistants
  // without an active 'tasks' grant. See docs/plans/company-brain.md §17.
  it('all six task tools declare requiresCapability="tasks"', () => {
    const tools = createTaskTools(makeFakeStore())
    for (const tool of [tools.saveTask, tools.getTask, tools.listTasks, tools.updateTask, tools.closeTask, tools.reopenTask]) {
      expect(tool.requiresCapability).toBe('tasks')
    }
  })
})

// User-configurable per-task JSONB — sprint estimation / ordering /
// velocity per `decisions-log.md` 2026-05-14 "SV — Sprint tracking via
// tasks primitive". Schema is freeform; conventional keys are not
// enforced. Carry-forward in supersession mirrors `external_ref`.
describe('[COMP:tasks/tools] attributes (sprint planning)', () => {
  it('saveTask persists attributes and getTask returns them', async () => {
    const store = makeFakeStore()
    const { saveTask, getTask } = createTaskTools(store)
    await saveTask.execute({
      title: 'Ship migration',
      attributes: { estimate_days: 3, estimate_points: 5, order: 1 },
    }, ctx)
    const id = store.rows[0].id
    const result = await getTask.execute({ id }, ctx)
    const data = result.data as Record<string, unknown>
    expect(data.attributes).toEqual({ estimate_days: 3, estimate_points: 5, order: 1 })
  })

  it('listTasks compact projection includes attributes', async () => {
    const store = makeFakeStore()
    const { saveTask, listTasks } = createTaskTools(store)
    await saveTask.execute({ title: 'A', attributes: { estimate_days: 2 } }, ctx)
    const result = await listTasks.execute({}, ctx)
    const rows = result.data as Array<{ attributes: Record<string, unknown> }>
    expect(rows[0].attributes).toEqual({ estimate_days: 2 })
  })

  it('updateTask overwrites the whole attributes object', async () => {
    const store = makeFakeStore()
    const { saveTask, updateTask } = createTaskTools(store)
    await saveTask.execute({
      title: 'A',
      attributes: { estimate_days: 2, order: 1 },
    }, ctx)
    const id = store.rows[0].id
    await updateTask.execute({ id, attributes: { estimate_days: 3 } }, ctx)
    expect(store.rows[0].attributes).toEqual({ estimate_days: 3 })
  })

  it('updateTask leaves attributes untouched when omitted (carry-forward)', async () => {
    const store = makeFakeStore()
    const { saveTask, updateTask } = createTaskTools(store)
    await saveTask.execute({
      title: 'A',
      attributes: { estimate_days: 2 },
    }, ctx)
    const id = store.rows[0].id
    await updateTask.execute({ id, title: 'A — renamed' }, ctx)
    expect(store.rows[0].title).toBe('A — renamed')
    expect(store.rows[0].attributes).toEqual({ estimate_days: 2 })
  })

  it('defaults to empty object when omitted at create time', async () => {
    const store = makeFakeStore()
    const { saveTask, getTask } = createTaskTools(store)
    await saveTask.execute({ title: 'Plain task' }, ctx)
    const id = store.rows[0].id
    const result = await getTask.execute({ id }, ctx)
    const data = result.data as Record<string, unknown>
    expect(data.attributes).toEqual({})
  })
})

// `depends_on` task → task edge wiring. The edge type is in the locked
// vocabulary (`edges.ts:66`, decisions-log 2026-05-14). The tool layer
// threads `depends_on: [uuid]` through to `store.create({ dependsOn })`
// and `store.update(..., { dependsOn })`; the DB layer emits edges
// fire-and-forget via `emitDependsOnEdges`. v1 append-only.
describe('[COMP:tasks/tools] depends_on edge wiring', () => {
  const TARGET_A = '33333333-3333-3333-3333-333333333333'
  const TARGET_B = '44444444-4444-4444-4444-444444444444'

  it('saveTask threads depends_on into the store as dependsOn', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    await saveTask.execute(
      { title: 'Dependent task', depends_on: [TARGET_A, TARGET_B] },
      ctx,
    )
    expect(store.createDependsOn).toHaveLength(1)
    expect(store.createDependsOn[0]).toEqual([TARGET_A, TARGET_B])
  })

  it('saveTask without depends_on leaves dependsOn undefined', async () => {
    const store = makeFakeStore()
    const { saveTask } = createTaskTools(store)
    await saveTask.execute({ title: 'Plain' }, ctx)
    expect(store.createDependsOn[0]).toBeUndefined()
  })

  it('updateTask threads depends_on through fields.dependsOn', async () => {
    const store = makeFakeStore()
    const { saveTask, updateTask } = createTaskTools(store)
    await saveTask.execute({ title: 'A' }, ctx)
    const id = store.rows[0].id
    await updateTask.execute({ id, depends_on: [TARGET_A] }, ctx)
    expect(store.updateDependsOn[0]).toEqual([TARGET_A])
  })

  it('updateTask without depends_on leaves fields.dependsOn undefined', async () => {
    const store = makeFakeStore()
    const { saveTask, updateTask } = createTaskTools(store)
    await saveTask.execute({ title: 'A' }, ctx)
    const id = store.rows[0].id
    await updateTask.execute({ id, title: 'A — renamed' }, ctx)
    expect(store.updateDependsOn[0]).toBeUndefined()
  })
})

// ── Bulk pair (tasks-operator-surface §6 Phase 4) ────────────────────────
//
// Filter-scoped mass mutation: "clean up my tasks" as one confirmed call.
// The safety posture IS the contract here: confirmation-gated, capability-
// gated, empty-filter rejected, workspace required.

describe('[COMP:tasks/tools-bulk] bulkUpdateTasks / archiveTasks', () => {
  it('are confirmation-gated and capability-gated', () => {
    const { bulkUpdateTasks, archiveTasks } = createTaskTools(makeFakeStore())
    expect(bulkUpdateTasks.requiresConfirmation).toBe(true)
    expect(archiveTasks.requiresConfirmation).toBe(true)
    expect(bulkUpdateTasks.requiresCapability).toBe('tasks')
    expect(archiveTasks.requiresCapability).toBe('tasks')
  })

  it('rejects an empty filter (would sweep the whole backlog) and an empty set', () => {
    const { bulkUpdateTasks } = createTaskTools(makeFakeStore())
    expect(
      bulkUpdateTasks.inputSchema.safeParse({ filter: {}, set: { status: 'archived' } }).success,
    ).toBe(false)
    expect(
      bulkUpdateTasks.inputSchema.safeParse({ filter: { status: 'todo' }, set: {} }).success,
    ).toBe(false)
    expect(
      bulkUpdateTasks.inputSchema.safeParse({ filter: { status: 'todo' }, set: { status: 'archived' } }).success,
    ).toBe(true)
  })

  it('errors without a workspace', async () => {
    const { archiveTasks } = createTaskTools(makeFakeStore())
    const result = await archiveTasks.execute({ filter: { status: 'todo' } }, ctxNoWorkspace)
    expect(result.isError).toBe(true)
  })

  it('updates only the rows matching the filter (incl. the unassigned + staleness post-filters)', async () => {
    const store = makeFakeStore()
    const { saveTask, bulkUpdateTasks } = createTaskTools(store)
    await saveTask.execute({ title: 'Stale unassigned' }, ctx)
    await saveTask.execute({ title: 'Stale but assigned' }, ctx)
    await saveTask.execute({ title: 'Fresh unassigned' }, ctx)
    store.rows[1].assigneeId = '33333333-3333-3333-3333-333333333333'
    // Backdate the first two past the cutoff; keep the third fresh.
    store.rows[0].updatedAt = new Date('2026-06-01T00:00:00Z')
    store.rows[1].updatedAt = new Date('2026-06-01T00:00:00Z')
    store.rows[2].updatedAt = new Date('2026-07-21T00:00:00Z')

    const result = await bulkUpdateTasks.execute(
      {
        filter: { status: 'todo', unassigned: true, updated_before: '2026-06-22T00:00:00Z' },
        set: { status: 'archived' },
      },
      ctx,
    )
    expect(result.isError).toBeUndefined()
    expect(String(result.data)).toContain('Updated 1 task(s)')
    expect(store.rows[0].status).toBe('archived')
    expect(store.rows[1].status).toBe('todo')
    expect(store.rows[2].status).toBe('todo')
  })

  it('merges a priority set into each row\'s attributes without clobbering siblings', async () => {
    const store = makeFakeStore()
    const { saveTask, bulkUpdateTasks } = createTaskTools(store)
    await saveTask.execute({ title: 'A', attributes: { estimate_days: 3, priority: 'low' } }, ctx)
    await bulkUpdateTasks.execute(
      { filter: { status: 'todo' }, set: { priority: 'urgent' } },
      ctx,
    )
    expect(store.rows[0].attributes).toEqual({ estimate_days: 3, priority: 'urgent' })
    // And null clears the key, leaving siblings alone.
    await bulkUpdateTasks.execute(
      { filter: { status: 'todo' }, set: { priority: null } },
      ctx,
    )
    expect(store.rows[0].attributes).toEqual({ estimate_days: 3 })
  })

  it('archiveTasks is the archive shorthand and reports a no-match cleanly', async () => {
    const store = makeFakeStore()
    const { saveTask, archiveTasks } = createTaskTools(store)
    await saveTask.execute({ title: 'Done thing', status: 'done' }, ctx)
    const miss = await archiveTasks.execute({ filter: { status: 'blocked' } }, ctx)
    expect(String(miss.data)).toContain('No tasks match')
    const hit = await archiveTasks.execute({ filter: { status: 'done' } }, ctx)
    expect(String(hit.data)).toContain('Archived 1 task(s)')
    expect(store.rows[0].status).toBe('archived')
  })
})
