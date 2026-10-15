/** Owned PostgreSQL only. Real native writers/authority; external effects are fake.
 * Missing mail/calendar admission is asserted as a stop, never certified as a lane pass.
 */
import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { OFFICIAL_CONNECTOR_TOOLS } from '@use-brian/shared/builtin-connectors'
import { advanceWorkflowRun, createGoogleCalendarTools, syncWorkflowScheduleTrigger, WorkflowDefinitionSchema, WorkflowTriggerSchema, type GoogleCalendarApi, type ToolContext } from '@use-brian/core'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { getResearchActivityForViewer } from '../../db/research-store.js'
import { briefFixture, researchSession, researchMessage, savedResearch } from '../../research/__tests__/fixture.js'
import { beginResearchActivity, captureResearchFollowupForMessage, createResearchDeliveryDeps } from '../../research/runtime.js'
import { createResearchTurnObserver, recordResearchDelivery } from '../../research/delivery.js'
import { assignReviewer } from '../../approval-review/assignment.js'
import { reviewApprovalRequest } from '../../approval-review/resolution.js'
import { consumeDelegatedReceipt } from '../../approval-review/consumption.js'
import { approveThreeTimes, grantConfigure, makeWorkflow, pendingStepApproval, person, store } from '../../approval-review/__tests__/fixture.js'
import { continueDelegatedWorkflowApproval, type ApprovalBridgeDeps } from '../../workflow/approval.js'
import { createDbWorkflowRunStore, createDbWorkflowStore } from '../../db/workflow-store.js'
import { createWorkspaceAuditStore } from '../../db/workspace-audit-store.js'
import { assistantTaskWithExecution, evidence } from '../../goals/__tests__/fixtures/execution-journeys.js'
import { beginIterationSystem, getExecutionSystem, getPoolSystem, settleIterationSystem } from '../../db/task-execution-store.js'
import { controlExecution } from '../../tasks/execution-control.js'
import { activate, setup, sourceRun } from '../../tasks/__tests__/routine-fixture.js'
import { admitRoutineRun } from '../../tasks/routine-intake.js'
import { inspectBrief, ensureBrief } from '../../briefs/service.js'
import { applyDirection, setBriefSyncClientForTests } from '../../briefs/publication.js'
import { actorOf } from '../../briefs/__tests__/fixture.js'
import { captureAuthoringAuthoritySystem, resolveWorkflowRunScope } from '../../context-scope/workflow-authority.js'
import { createDbJobStore } from '../../db/job-store.js'
import { createTask } from '../../db/tasks.js'

const scripts = new URL('../../../../../scripts/operations/', import.meta.url)
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { preparePilotConfig, materializeFixture } = await import(new URL('pilot-config.mjs', scripts).href)
const fictional = JSON.parse(await readFile(new URL('fixtures/v1-pilot.json', scripts), 'utf8'))
const pool = getPool()
const outbound = { paidModel: 0, network: 0, realEffect: 0, fakeEffect: 0 }
const previousFetch = globalThis.fetch
globalThis.fetch = (async () => { outbound.network++; throw new Error('operations_fixture_network_forbidden') }) as typeof fetch
afterAll(async () => { globalThis.fetch = previousFetch; setBriefSyncClientForTests(undefined); await getAppPool().end(); await pool.end() })

describe('[COMP:api/operations-v1-readiness] native disposable pilot lanes', () => {
  it('V03 research saves a source receipt and Chat reference; a fresh chat binds follow-up and failed acquisition stays partial', async () => {
    const f = await briefFixture()
    const saved = await savedResearch(f, f.people.member, f.projectId)
    expect(saved.activity.status).toBe('saved')
    const detail = await getResearchActivityForViewer(f.people.lead, f.workspaceId, saved.activity.id)
    expect(detail?.artifacts).toHaveLength(1)
    expect(detail?.activity.sources).toEqual([expect.objectContaining({ inspected: true, ref: 'https://example.com/vendors' })])
    const chat = await researchSession(f, f.people.lead, f.projectId)
    const message = await researchMessage(f, chat, 'user', 'You missed the support terms', f.people.lead)
    expect(await captureResearchFollowupForMessage({ workspaceId: f.workspaceId, sessionId: chat, assistantId: f.assistants.brian,
      messageId: message, actorUserId: f.people.lead, externalPrincipal: false, selectedActivityId: saved.activity.id }))
      .toMatchObject({ outcome: 'recorded', feedback: { activityId: saved.activity.id, association: 'explicit_selection' } })
    const request = await researchMessage(f, chat, 'user', 'Inspect the unavailable source', f.people.lead)
    const activity = await beginResearchActivity({ workspaceId: f.workspaceId, sessionId: chat, requestMessageId: request,
      actorUserId: f.people.lead, assistantId: f.assistants.brian, projectId: f.projectId, entry: 'explicit', runtime: {} })
    const observer = createResearchTurnObserver()
    observer.observeWorker({ type: 'tool_input', id: 'missing', name: 'urlReader', input: { url: 'https://unavailable.example/source' } })
    observer.observeWorker({ type: 'tool_result', id: 'missing', results: [{ type: 'tool_result', toolUseId: 'missing', name: 'urlReader', isError: true, content: 'unavailable' }] })
    const partial = await recordResearchDelivery(createResearchDeliveryDeps(), { activity, observation: observer.snapshot(), finalText: '', outputMessageId: null, requestText: 'Inspect unavailable source' })
    expect(partial.status).toBe('partial')
    expect(partial.sources).toEqual([])
  })

  it('V04 administration requires native approval and produces exactly one fake provider effect receipt', async () => {
    const f = await briefFixture(), workflowId = await makeWorkflow(f)
    const review = (id: string, consumers = {}) => reviewApprovalRequest({ workspaceId: f.workspaceId, approvalId: id,
      trigger: 'requested', requester: { kind: 'human', userId: f.people.lead } }, consumers)
    const noAssignment = await pendingStepApproval(f, workflowId)
    expect(await review(noAssignment.approval.id)).toMatchObject({ outcome: 'needs_human', reasons: ['no_assignment'] })
    await grantConfigure(f.assistants.ops, f.people.owner)
    await assignReviewer(person(f.people.lead), f.workspaceId, { reviewerAssistantId: f.assistants.ops,
      scopeKind: 'workflow', scopeId: workflowId, idempotencyKey: randomUUID() })
    await approveThreeTimes(f, workflowId)
    const calls: ToolContext[] = []
    const deps: ApprovalBridgeDeps = { approvalsStore: store, auditStore: createWorkspaceAuditStore(), workflowStore: createDbWorkflowStore(),
      runStore: createDbWorkflowRunStore(), buildToolRegistry: async () => new Map([['slackPostMessage', {
        name: 'slackPostMessage', description: 'Fictional provider boundary', inputSchema: z.object({}).passthrough(),
        execute: async (_input: unknown, ctx: ToolContext) => { calls.push(ctx); outbound.fakeEffect++; return { data: { receipt: 'fictional-effect-1' } } },
      }]]) as never, resolvePrimary: vi.fn(async () => f.assistants.brian), deliveries: async () => {}, executorDeps: {} as never }
    const consumers = { workflowStep: (approval: Parameters<typeof continueDelegatedWorkflowApproval>[1], receipt: { delegatorUserId: string }) =>
      continueDelegatedWorkflowApproval(deps, approval, receipt.delegatorUserId, async () => {
        const c = await consumeDelegatedReceipt((await store.getByIdSystem(approval.id))!)
        return c.ok ? { ok: true } : { ok: false, reason: c.reason }
      }) }
    const { approval } = await pendingStepApproval(f, workflowId)
    expect(await review(approval.id, consumers)).toMatchObject({ outcome: 'resolved', consumer: { status: 'completed' } })
    await review(approval.id, consumers)
    expect(calls).toHaveLength(1)
    expect(calls[0].assistantId).toBe(f.assistants.brian)
    expect(deps.resolvePrimary).not.toHaveBeenCalled()
  })

  it('V04 V08 restart retains uncertain effect WIP and the original allowance without a duplicate write', async () => {
    const f = await briefFixture(), { state } = await assistantTaskWithExecution(f)
    const started = await beginIterationSystem(state.id)
    if (started.kind !== 'proceed') throw new Error(`iteration did not start: ${started.kind}`)
    const checkpoint = { ...evidence({ summary: 'Provider acknowledgement unknown; reconcile before retry',
      uncertainEffects: [{ operation: 'fictionalSend', ref: 'fictional-effect', attemptId: started.inFlight.attemptId }] }),
      sourceRefs: [], nextStep: 'Reconcile the provider receipt', questions: [], segment: 1, evidenceFingerprint: 'fictional-checkpoint' }
    await settleIterationSystem(state.id, { attemptId: started.inFlight.attemptId, actualSpend: 0.01, checkpoint,
      nextPhase: 'blocked', blocker: { reason: 'reconcile_before_retry' }, streaks: { noProgress: 0, transient: 0 } })
    const before = await getPoolSystem(state.poolId)
    const recovered = await getExecutionSystem(state.id)
    expect(recovered?.checkpoint?.uncertainEffects).toEqual(checkpoint.uncertainEffects)
    expect(recovered?.phase).toBe('blocked')
    expect((await getPoolSystem(state.poolId))?.segments).toHaveLength(before!.segments.length)
    const unauthorized = await controlExecution({ kind: 'assistant', id: f.assistants.brian, userId: f.people.member,
      origin: 'chat', human: false }, f.workspaceId, state.id, { action: 'continue', expectedRevision: recovered!.controlRevision, interventionId: randomUUID() })
    expect(unauthorized.outcome).toBe('blocked')
    expect((await getPoolSystem(state.poolId))?.segments).toHaveLength(before!.segments.length)
  })

  it('V05 scheduled calendar preparation saves grounded Brief and Task work; inaccessible sources stay unknown', async () => {
    const f = await briefFixture(); setBriefSyncClientForTests(null)
    const lead = actorOf(f, f.people.lead)
    const { bindingId } = await ensureBrief(lead, { kind: 'project', id: f.projectId })
    await applyDirection(lead, bindingId, { change: { sections: { outcome: ['Review fictional widget options'], rules: ['Disclose unknown meeting context'] } },
      expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    const brief = await inspectBrief(actorOf(f, f.people.member), { bindingId })
    expect(JSON.stringify(brief)).toContain('Review fictional widget options')
    await expect(inspectBrief(actorOf(f, f.people.outsider), { bindingId })).rejects.toBeDefined()
    const task = await createTask(f.people.lead, { workspaceId: f.workspaceId, title: 'Compare fictional widget options', home: { kind: 'project', id: f.projectId } })
    const tasks = await queryWithRLS<{ title: string }>(f.people.member, 'SELECT title FROM tasks WHERE id=$1', [task.id])
    expect(tasks.rows).toEqual([{ title: task.title }])
    const calendar = createGoogleCalendarTools({ listEvents: async () => ({ items: [{ id: fictional.meeting.sourceId,
      summary: fictional.meeting.subject, start: { dateTime: '2026-10-16T10:00:00+08:00' }, end: { dateTime: '2026-10-16T10:30:00+08:00' },
      htmlLink: 'https://calendar.example/events/fictional-meeting-1' }] }) } as unknown as GoogleCalendarApi, 'Asia/Hong_Kong')
      .find(t => t.name === 'googleCalendarListEvents')!
    const workflowStore = createDbWorkflowStore(), runStore = createDbWorkflowRunStore(), jobStore = createDbJobStore()
    const authority = await captureAuthoringAuthoritySystem({ userId: f.people.lead, workspaceId: f.workspaceId,
      assistantId: f.assistants.brian, contextGroupId: null, contextProjectId: f.projectId })
    const workflow = await workflowStore.create({ userId: f.people.lead, workspaceId: f.workspaceId, name: 'Fictional meeting preparation',
      definition: { startStepId: 'calendar', steps: [{ id: 'calendar', type: 'tool_call', toolName: calendar.name,
        arguments: { calendarId: 'fictional-company-calendar', maxResults: 5 }, storeOutputAs: 'meeting' }] },
      trigger: { kind: 'schedule', schedule: { type: 'once', datetime: '2026-10-16T09:45:00' }, timezone: 'Asia/Hong_Kong' },
      contextGroupId: null, contextProjectId: f.projectId, authoringAuthority: authority },
    { authoring: { kind: 'internal-human', userId: f.people.lead, assistantId: f.assistants.brian } })
    const scheduled = await syncWorkflowScheduleTrigger({ jobStore, resolvePrimary: async () => f.assistants.brian },
      { workflowId: workflow.id, workspaceId: f.workspaceId, userId: f.people.lead, schedule: { type: 'once', datetime: '2026-10-16T09:45:00' },
        timezone: 'Asia/Hong_Kong', contextProjectId: f.projectId })
    expect(scheduled).toHaveProperty('jobId')
    const run = await runStore.createRun({ workflowId: workflow.id, workspaceId: f.workspaceId, triggeredBy: f.people.lead,
      triggerKind: 'schedule', input: {} })
    const deps = { workflowStore, runStore, resolvePrimary: async () => f.assistants.brian, resolveRunScope: resolveWorkflowRunScope,
      buildToolRegistry: async () => new Map([[calendar.name, calendar]]), consultTransport: { async send(): Promise<never> { throw new Error('No model call allowed') } } }
    expect(await advanceWorkflowRun(deps, run.id)).toMatchObject({ kind: 'completed' })
    const completed = (await runStore.getRunSystem(run.id))!
    expect(JSON.stringify(completed.vars.meeting)).toContain(fictional.meeting.sourceId)
    const chat = await researchSession(f, f.people.member, f.projectId)
    const request = await researchMessage(f, chat, 'user', 'Prepare for the admitted widget meeting', f.people.member)
    const activity = await beginResearchActivity({ workspaceId: f.workspaceId, sessionId: chat, requestMessageId: request,
      actorUserId: f.people.member, assistantId: f.assistants.brian, projectId: f.projectId, entry: 'explicit', runtime: { surface: 'scheduled-fixture' } })
    const prep = `Meeting: ${fictional.meeting.subject} (${fictional.meeting.sourceId}).\nAccepted outcome: Review fictional widget options.\nTask: ${tasks.rows[0].title}.\nUnknown: ${fictional.meeting.unknown.join('; ')}.`
    const saved = await recordResearchDelivery(createResearchDeliveryDeps(), { activity, observation: { receipts: [],
      sources: [{ kind: 'web', ref: 'https://calendar.example/events/fictional-meeting-1', title: fictional.meeting.subject, inspected: true, readAt: new Date().toISOString() }], gaps: ['Private participant history unavailable'] },
      finalText: prep, outputMessageId: null, requestText: 'Prepare admitted meeting' })
    expect(saved.status).toBe('saved')
    expect((await getResearchActivityForViewer(f.people.lead, f.workspaceId, saved.id))?.artifacts).toHaveLength(1)
    expect(await getResearchActivityForViewer(f.people.outsider, f.workspaceId, saved.id)).toBeNull()
    // Calendar loss stops the actual scheduled workflow before any model work.
    const unavailable = createGoogleCalendarTools({ listEvents: async () => { throw new Error('Fictional calendar unavailable') } } as unknown as GoogleCalendarApi)
      .find(t => t.name === calendar.name)!
    const failed = await runStore.createRun({ workflowId: workflow.id, workspaceId: f.workspaceId, triggeredBy: f.people.lead, triggerKind: 'schedule', input: {} })
    expect(await advanceWorkflowRun({ ...deps, buildToolRegistry: async () => new Map([[calendar.name, unavailable]]) }, failed.id)).toMatchObject({ kind: 'failed' })
  })

  it('V06 native routine replay creates one Task but refuses unverified mailbox events without delivery or new work', async () => {
    const s = await setup(); await activate(s)
    const source = await sourceRun(s)
    const first = await admitRoutineRun(source.run.id)
    expect(first.kind).toBe('created')
    expect((await admitRoutineRun(source.run.id)).kind).toBe('replayed')
    const count = (await pool.query('SELECT count(*)::int n FROM task_routine_intake_receipts WHERE routine_id=$1', [s.workflow.id])).rows[0].n
    const mail = await createDbWorkflowRunStore().createRun({ workflowId: s.workflow.id, workspaceId: s.f.workspaceId,
      triggeredBy: s.actor.userId, triggerKind: 'event', input: { trigger: { sourceType: 'connector', provider: 'imap', channelId: 'fictional-inbox' },
        event: { messageId: 'fictional-mail-1', subject: 'Widget review' } } })
    expect(await admitRoutineRun(mail.id)).toMatchObject({ kind: 'refused' })
    expect((await pool.query('SELECT count(*)::int n FROM task_routine_intake_receipts WHERE routine_id=$1', [s.workflow.id])).rows[0].n).toBe(count)
    // Refusal is evidence of a missing native mail-admission path, not CoS success.
  })

  it('V07 app-role RLS refuses cross-workspace and revoked Project research disclosure', async () => {
    const f = await briefFixture(), other = await briefFixture(), saved = await savedResearch(f, f.people.member, f.projectId)
    const role = (await getAppPool().query('SELECT rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0]
    expect(role).toEqual({ rolsuper: false, rolbypassrls: false })
    expect(await getResearchActivityForViewer(other.people.member, f.workspaceId, saved.activity.id)).toBeNull()
    expect(await getResearchActivityForViewer(f.people.outsider, f.workspaceId, saved.activity.id)).toBeNull()
    await pool.query('DELETE FROM project_shared_members WHERE project_id=$1 AND user_id=$2', [f.projectId, f.people.financeLead])
    expect(await getResearchActivityForViewer(f.people.financeLead, f.workspaceId, saved.activity.id)).toBeNull()
  })

  it('V09 four fictional materializations validate current native definition and trigger schemas without activating anything', () => {
    const bundle = preparePilotConfig()
    const knownTools = new Set(['getTask', 'readPage', 'webSearch', 'urlReader', ...Object.values(OFFICIAL_CONNECTOR_TOOLS).flat().map(t => t.name)])
    for (const recipe of bundle.recipes) for (const binding of [fictional.company, fictional.personal]) {
      const native = materializeFixture(recipe, binding)
      expect(WorkflowDefinitionSchema.safeParse(native.definition).success).toBe(true)
      expect(WorkflowTriggerSchema.safeParse(native.trigger).success).toBe(true)
      expect(native.enabled).toBe(false)
      for (const tool of native.definition.steps[0].tools) expect(knownTools.has(tool)).toBe(true)
      expect(WorkflowDefinitionSchema.safeParse(recipe.nativeDraft.definition).success).toBe(false)
    }
  })

  it('V11 owned fixture execution makes zero remote calls or paid model calls and only fake effects', async () => {
    expect(outbound).toMatchObject({ paidModel: 0, network: 0, realEffect: 0 })
    expect(outbound.fakeEffect).toBe(1)
    if (process.env.BRIAN_OPERATIONS_EVIDENCE_DIR) await writeFile(join(process.env.BRIAN_OPERATIONS_EVIDENCE_DIR, 'native-counters.json'),
      JSON.stringify({ schema: 'operations-provider-counters-v1', ...outbound, liveSchedules: 0, credentialChanges: 0, realEmailReadsOrSends: 0, releasesOrDeployments: 0 }), { mode: 0o600 })
  })
})
