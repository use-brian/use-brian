/**
 * Task guardrail tool tests — the assistant-facing half of the gate, plus the
 * `saveTask` admission wiring on the assistant lane.
 *
 * Spec: docs/architecture/features/task-guardrails.md
 */

import { describe, it, expect, vi } from 'vitest'
import { createTaskGuardrailTools, type TaskGuardrailStore } from '../guardrail-tools.js'
import { createTaskTools } from '../tools.js'
import type { TaskAdmissionPort } from '../admission.js'
import type { TaskRecord, TaskStore } from '../types.js'

const ctx = {
  assistantId: 'assistant_1',
  userId: 'user_1',
  sessionId: 'session_1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'c_1',
  workspaceId: 'workspace_1',
  abortSignal: new AbortController().signal,
} as never

const TASK_ID = '11111111-1111-1111-1111-111111111111'
const RULE_ID = '22222222-2222-2222-2222-222222222222'

function makeGuardrailStore(over: Partial<TaskGuardrailStore> = {}): TaskGuardrailStore {
  return {
    rejectTask: vi.fn(async () => ({
      title: 'List tasks',
      tombstoneId: 'tomb-1',
      proposedRuleId: null,
      proposedRuleClause: null,
    })),
    createRule: vi.fn(async (input) => ({
      id: RULE_ID,
      workspaceId: input.workspaceId,
      status: input.status,
      effect: input.effect,
      predicate: input.predicate,
      nlClause: input.nlClause,
      reason: input.reason,
      origin: 'user' as const,
      createdAt: new Date(),
    })),
    listRules: vi.fn(async () => []),
    deleteRule: vi.fn(async () => true),
    ...over,
  }
}

describe('[COMP:tasks/guardrail-tools] rejectTask', () => {
  it('records the rejection and tells the user the lesson stuck', async () => {
    const store = makeGuardrailStore()
    const { rejectTask } = createTaskGuardrailTools(store)
    const res = await rejectTask.execute({ id: TASK_ID, reason: 'not a work item' }, ctx)

    expect(store.rejectTask).toHaveBeenCalledWith({
      workspaceId: 'workspace_1',
      userId: 'user_1',
      taskId: TASK_ID,
      reason: 'not a work item',
    })
    expect(res.isError).toBeFalsy()
    expect(res.data).toContain('no longer be created')
  })

  it('surfaces a proposed rule as something to ASK about, not as done', async () => {
    // A wrong auto-rule suppresses a category of real work invisibly, so the
    // tool result must make the "not active yet" state unmissable.
    const store = makeGuardrailStore({
      rejectTask: vi.fn(async () => ({
        title: 'List tasks',
        tombstoneId: 'tomb-3',
        proposedRuleId: RULE_ID,
        proposedRuleClause: "Don't create tasks from slack_thread mentioning list / tasks.",
      })),
    })
    const { rejectTask } = createTaskGuardrailTools(store)
    const res = await rejectTask.execute({ id: TASK_ID, reason: 'noise' }, ctx)

    expect(res.data).toContain('NOT active yet')
    expect(res.data).toContain('ask the user')
  })

  it('errors when the task is not found', async () => {
    const store = makeGuardrailStore({ rejectTask: vi.fn(async () => null) })
    const { rejectTask } = createTaskGuardrailTools(store)
    const res = await rejectTask.execute({ id: TASK_ID, reason: 'noise' }, ctx)
    expect(res.isError).toBe(true)
    const data = String(res.data)
    // The `taskNotFoundMessage` shape: name the id, explain supersession
    // (every task update mints a new id), name the discovery tool, forbid the
    // blind retry — and say the tombstone was NOT written.
    expect(data).toContain(TASK_ID)
    expect(data).toContain('NEW id')
    expect(data).toContain('listTasks')
    expect(data).toContain('no tombstone was written')
    expect(data).toContain('Do NOT retry this exact id')
  })

  it('requires a workspace', async () => {
    const { rejectTask } = createTaskGuardrailTools(makeGuardrailStore())
    const res = await rejectTask.execute(
      { id: TASK_ID, reason: 'noise' },
      { ...(ctx as any), workspaceId: null },
    )
    expect(res.isError).toBe(true)
    const data = String(res.data)
    // A gate names the missing surface AND the remedy — never just "not
    // available in this context".
    expect(data).toContain('not bound to one')
    expect(data).toContain('Studio')
    expect(data).toContain('will keep failing')
  })

  it('rejects a reason too short to teach anything', () => {
    const parsed = (createTaskGuardrailTools(makeGuardrailStore()).rejectTask as any).inputSchema.safeParse(
      { id: TASK_ID, reason: 'x' },
    )
    expect(parsed.success).toBe(false)
  })
})

describe('[COMP:tasks/guardrail-tools] saveTaskRule', () => {
  it('stores both the predicate and the user\'s own sentence', async () => {
    const store = makeGuardrailStore()
    const { saveTaskRule } = createTaskGuardrailTools(store)
    const res = await saveTaskRule.execute(
      {
        effect: 'deny',
        when: { source_kinds: ['slack_thread'], title_matches: ['standup'] },
        nl_clause: "Don't create tasks from standup chatter",
      },
      ctx,
    )

    expect(res.isError).toBeFalsy()
    const call = (store.createRule as any).mock.calls[0][0]
    expect(call.predicate).toEqual({
      source_kinds: ['slack_thread'],
      title_matches: ['standup'],
    })
    expect(call.nlClause).toBe("Don't create tasks from standup chatter")
    expect(call.status).toBe('active')
  })

  it('refuses a deny rule with no conditions — it would block every task', async () => {
    const store = makeGuardrailStore()
    const { saveTaskRule } = createTaskGuardrailTools(store)
    const res = await saveTaskRule.execute({ effect: 'deny', when: {} }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toContain('at least one condition')
    expect(store.createRule).not.toHaveBeenCalled()
  })

  it('refuses a require rule with no requirements', async () => {
    const store = makeGuardrailStore()
    const { saveTaskRule } = createTaskGuardrailTools(store)
    const res = await saveTaskRule.execute(
      { effect: 'require', when: { source_kinds: ['slack_thread'] } },
      ctx,
    )
    expect(res.isError).toBe(true)
    expect(store.createRule).not.toHaveBeenCalled()
  })

  it('honors activate:false by saving the rule disabled', async () => {
    const store = makeGuardrailStore()
    const { saveTaskRule } = createTaskGuardrailTools(store)
    await saveTaskRule.execute(
      { effect: 'deny', when: { title_matches: ['standup'] }, activate: false },
      ctx,
    )
    expect((store.createRule as any).mock.calls[0][0].status).toBe('disabled')
  })
})

describe('[COMP:tasks/guardrail-tools] listTaskRules / deleteTaskRule', () => {
  it('says duplicate suppression still applies when there are no rules', async () => {
    const { listTaskRules } = createTaskGuardrailTools(makeGuardrailStore())
    const res = await listTaskRules.execute({}, ctx)
    expect(res.data).toContain('always on')
  })

  it('flags proposed rules as not enforcing', async () => {
    const store = makeGuardrailStore({
      listRules: vi.fn(async () => [
        {
          id: RULE_ID,
          workspaceId: 'workspace_1',
          status: 'proposed' as const,
          effect: 'deny' as const,
          predicate: { title_matches: ['standup'] },
          nlClause: 'No standup tasks',
          reason: null,
          origin: 'proposed' as const,
          createdAt: new Date(),
        },
      ]),
    })
    const { listTaskRules } = createTaskGuardrailTools(store)
    const res = await listTaskRules.execute({}, ctx)
    expect(res.data).toContain('not enforcing until activated')
  })

  it('errors when deleting a rule that is not there', async () => {
    const store = makeGuardrailStore({ deleteRule: vi.fn(async () => false) })
    const { deleteTaskRule } = createTaskGuardrailTools(store)
    const res = await deleteTaskRule.execute({ id: RULE_ID }, ctx)
    expect(res.isError).toBe(true)
    const data = String(res.data)
    // Rule ids are STABLE (no supersession), so the copy must not blame an
    // edit — it points at listTaskRules and closes the retry.
    expect(data).toContain(RULE_ID)
    expect(data).toContain('listTaskRules')
    expect(data).toContain('never superseded')
    expect(data).toContain('Do NOT retry this exact id')
  })
})

// ── saveTask on the assistant lane ───────────────────────────────────────────

describe('[COMP:tasks/admission] saveTask — assistant lane gate', () => {
  function makeStore(): TaskStore & { rows: TaskRecord[] } {
    const rows: TaskRecord[] = []
    return {
      rows,
      async create(params: Parameters<TaskStore['create']>[0]) {
        const now = new Date()
        const row: TaskRecord = {
          id: `00000000-0000-0000-0000-00000000000${rows.length + 1}`,
          workspaceId: params.workspaceId,
          title: params.title,
          status: params.status ?? 'todo',
          assigneeId: params.assigneeId ?? null,
          due: params.due ?? null,
          tags: params.tags ?? [],
          parentId: params.parentId ?? null,
          externalRef: params.externalRef ?? {},
          attributes: params.attributes ?? {},
          createdAt: now,
          updatedAt: now,
        }
        rows.push(row)
        return { ...row }
      },
      getById: async () => null,
      list: async () => [],
      update: async () => null,
    } as unknown as TaskStore & { rows: TaskRecord[] }
  }

  function port(over: Partial<TaskAdmissionPort> = {}): TaskAdmissionPort {
    return {
      listActiveRules: async () => [],
      findSimilarTombstones: async () => [],
      findSimilarTasks: async () => [],
      recordCandidate: async () => {},
      ...over,
    }
  }

  it('refuses a duplicate and explains which task blocked it', async () => {
    const store = makeStore()
    const { saveTask } = createTaskTools(store, {
      admission: port({
        findSimilarTasks: async () => [
          { id: 'task-existing', title: 'Integrate Shopify', similarity: 0.95 },
        ],
      }),
    })
    const res = await saveTask.execute({ title: 'integrate shopify' }, ctx)

    expect(store.rows).toHaveLength(0)
    // NOT an error — the model must relay this, not retry it.
    expect(res.isError).toBeFalsy()
    expect(res.data).toContain('duplicates the open task')
    expect(res.data).toContain('task-existing')
  })

  it('creates a near-duplicate anyway but warns about the similar task', async () => {
    const store = makeStore()
    const { saveTask } = createTaskTools(store, {
      admission: port({
        findSimilarTasks: async () => [
          { id: 'task-7', title: 'Resolve GitHub 401', similarity: 0.7 },
        ],
      }),
    })
    const res = await saveTask.execute({ title: 'Fix the GitHub 401 error' }, ctx)

    expect(store.rows).toHaveLength(1)
    expect(res.data).toContain('Created task')
    expect(res.data).toContain('task-7')
  })

  it('honors override_guardrail when the user insists after being told', async () => {
    const store = makeStore()
    const findSimilarTasks = vi.fn(async () => [
      { id: 'task-existing', title: 'Integrate Shopify', similarity: 1 },
    ])
    const { saveTask } = createTaskTools(store, { admission: port({ findSimilarTasks }) })
    const res = await saveTask.execute(
      { title: 'integrate shopify', override_guardrail: true },
      ctx,
    )

    expect(store.rows).toHaveLength(1)
    expect(res.data).toContain('Created task')
    expect(findSimilarTasks).not.toHaveBeenCalled()
  })

  it('behaves exactly as before when no admission port is wired', async () => {
    const store = makeStore()
    const { saveTask } = createTaskTools(store)
    const res = await saveTask.execute({ title: 'anything at all' }, ctx)
    expect(store.rows).toHaveLength(1)
    expect(res.data).toContain('Created task')
  })
})
