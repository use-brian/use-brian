/**
 * Test-only seeding for the resumable task execution suites. Builds on the
 * Brief fixture (an isolated workspace with a shared Project, a Department,
 * fictional people and two assistants). Fictional identities only; runs only
 * through scripts/crm/local-fixture.mjs.
 */
import { randomUUID } from 'node:crypto'
import type { ExecutionCheckpoint } from '@use-brian/core'
import { getPool } from '../../../db/client.js'
import { createRootExecution, type ExecutionActor } from '../../../db/task-execution-store.js'
import { createTask } from '../../../db/tasks.js'
import { briefFixture, type BriefFixture } from '../../../briefs/__tests__/fixture.js'

export { briefFixture, type BriefFixture }

export const human = (userId: string, origin: ExecutionActor['origin'] = 'ui'): ExecutionActor =>
  ({ kind: 'user', id: userId, origin, humanOrigin: true })
export const assistantActor = (assistantId: string): ExecutionActor =>
  ({ kind: 'assistant', id: assistantId, origin: 'chat', humanOrigin: false })
export const credentialActor = (credentialId: string): ExecutionActor =>
  ({ kind: 'credential', id: credentialId, origin: 'mcp', humanOrigin: false })

/** A confirmed acting goal hosted on a task (the canonical pursuit row). */
export async function confirmedTaskGoal(f: BriefFixture, taskId: string, createdBy: string, opts: { workflowId?: string } = {}) {
  const r = await getPool().query<{ id: string }>(
    `INSERT INTO goals (workspace_id, host_type, host_id, outcome, done_when, means, budget, status, created_by_user_id, confirmed_at)
     VALUES ($1,'task',$2,'Fictional outcome','{"kind":"query","query":{"description":"task complete","predicate":{"hostTaskDone":true}}}'::jsonb,
             $3::jsonb,'{"maxSpend":5,"maxIterations":30}'::jsonb,'active',$4,now()) RETURNING id`,
    [f.workspaceId, taskId, JSON.stringify(opts.workflowId ? { workflowId: opts.workflowId } : {}), createdBy])
  return r.rows[0].id
}

/** An assistant-executed task in the shared Project plus a root execution. */
export async function assistantTaskWithExecution(f: BriefFixture, opts: {
  budget?: { maxSpend: number | null; maxIterations: number | null }
  title?: string
  withGoal?: boolean
  completionEvidence?: string[]
} = {}) {
  const task = await createTask(f.people.lead, {
    workspaceId: f.workspaceId, title: opts.title ?? 'Prepare the fictional vendor summary',
    executorAssistantId: f.assistants.brian, home: { kind: 'project', id: f.projectId },
  })
  const goalId = opts.withGoal === false ? null : await confirmedTaskGoal(f, task.id, f.people.lead)
  const { state } = await createRootExecution({
    workspaceId: f.workspaceId, taskId: task.id, goalId,
    executor: { kind: 'assistant', id: f.assistants.brian }, phase: 'ready',
    plan: { outcome: 'Fictional vendor summary', completionEvidence: opts.completionEvidence ?? ['summary page published'] },
    sourceRefs: [{ kind: 'task', id: task.id }],
    authoringRef: { kind: 'human_assignment', actorUserId: f.people.lead, origin: 'ui', at: new Date().toISOString() },
    budget: opts.budget ?? { maxSpend: 5, maxIterations: 30 },
    enter: { idempotencyKey: `enter:${task.id}`, actor: human(f.people.lead, 'assignment') },
  })
  return { task, goalId, state }
}

/** An in-memory usage ledger keyed by session id (the UsageStore read seam). */
export function fakeUsage(initial: Record<string, number> = {}) {
  const costs = new Map(Object.entries(initial))
  return {
    set(runId: string, usd: number) { costs.set(`workflow_run_${runId}`, usd) },
    store: { getSessionCostUsd: async (sessionId: string) => costs.get(sessionId) ?? 0 },
  }
}

export const evidence = (over: Partial<ExecutionCheckpoint> = {}) => ({
  summary: over.summary ?? 'Fictional factual summary',
  artifacts: over.artifacts ?? [],
  completedEffects: over.completedEffects ?? [],
  uncertainEffects: over.uncertainEffects ?? [],
  checkedResults: over.checkedResults ?? [],
})

export const runId = () => randomUUID()
