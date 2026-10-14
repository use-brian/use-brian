/** Native configuration/event setup shared by the routine PG suites. Fictional data only. */
import { randomUUID } from 'node:crypto'
import { taskLifecycleToDispatchEvent, type WorkflowDefinition } from '@use-brian/core'
import { createDbWorkflowStore, createDbWorkflowRunStore } from '../../db/workflow-store.js'
import { captureAuthoringAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { applyRoutineProposal, prepareRoutineProposal } from '../routine-proposals.js'
import { briefFixture } from '../../briefs/__tests__/fixture.js'
import { createTask } from '../../db/tasks.js'

export async function setup() {
  const f = await briefFixture()
  const userId = f.people.financeLead
  const authority = await captureAuthoringAuthoritySystem({ userId, workspaceId: f.workspaceId, assistantId: f.assistants.brian,
    contextGroupId: f.finance, contextProjectId: null })
  const definition: WorkflowDefinition = { startStepId: 'review', steps: [{ id: 'review', type: 'tool_call', toolName: 'getTask', arguments: {} }] }
  const store = createDbWorkflowStore()
  const workflow = await store.create({ userId, workspaceId: f.workspaceId, name: 'Fictional case summaries', definition,
    contextGroupId: f.finance, contextProjectId: null, authoringAuthority: authority },
    { authoring: { kind: 'internal-human', userId, assistantId: f.assistants.brian } })
  const session = (await authSessionStore.create(userId, { deviceLabel: 'Routine fixture', ipAddress: null, userAgent: null }))!
  const actor = { kind: 'ui' as const, userId, authSessionId: session.id }
  const configuration = {
    definition: { ...definition, defaultExecutor: { kind: 'assistant' as const, assistantId: f.assistants.brian } as NonNullable<WorkflowDefinition['defaultExecutor']>,
      taskIntake: { version: 1 as const, blueprint: { outcome: 'Prepare a fictional case summary', description: 'Summarize the admitted case',
        completionCheck: 'Summary saved', inputs: [{ key: 'case', label: 'Which case?', path: 'event.taskId', required: true }] },
      home: { kind: 'department' as const, id: f.finance }, permittedActions: [] as string[], requiredAccounts: [] as string[] } },
    trigger: { kind: 'event' as const, event: { sources: [{ source: { type: 'task' as const }, match: { inChannels: ['created'] } }] } },
    contextGroupId: f.finance, contextProjectId: null,
  }
  const command = { configuration, expectedRevision: 0, idempotencyKey: randomUUID(), rationale: 'Human-configured case summary work' }
  return { f, store, workflow, actor, command, configuration }
}

export async function activate(s: Awaited<ReturnType<typeof setup>>) {
  const p = await prepareRoutineProposal(s.actor.userId, s.workflow.id, s.command)
  await applyRoutineProposal(s.actor, p.id, { expectedRevision: 0, idempotencyKey: randomUUID() })
}

export async function sourceRun(s: Awaited<ReturnType<typeof setup>>, source?: Awaited<ReturnType<typeof createTask>>) {
  const task = source ?? await createTask(s.actor.userId, { workspaceId: s.f.workspaceId, title: `Fictional case input ${randomUUID()}`,
    home: { kind: 'department', id: s.f.finance }, compartments: [`team:${s.f.finance}`], visibility: { userId: null, assistantId: null } })
  const event = taskLifecycleToDispatchEvent({ workspaceId: task.workspaceId, taskId: task.id, kind: 'created', title: task.title,
    status: task.status, previousStatus: null, tags: task.tags, previousTags: null, assigneeId: task.assigneeId,
    previousAssigneeId: null, due: task.due, parentId: task.parentId, changedFields: [], actorId: s.actor.userId, writtenBy: 'user' })
  const run = await createDbWorkflowRunStore().createRun({ workflowId: s.workflow.id, workspaceId: task.workspaceId,
    triggeredBy: s.actor.userId, triggerKind: 'event', input: { trigger: { sourceType: 'task', provider: 'task',
      channelId: event.channelId, actorId: event.actorId }, event: event.payload } })
  return { task, run }
}
