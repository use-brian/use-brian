/**
 * Accepted Brief grounding and live revision boundaries on a migration-replayed
 * database (project-briefs.md -> "Grounding a turn", "Revision boundaries";
 * plan §7). Execution contexts come from the production resolver and the
 * runs go through the real prepare stage. Runs only through
 * scripts/crm/local-fixture.mjs.
 */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { buildTool, type LLMProvider, type Tool } from '@use-brian/core'
import { z } from 'zod'
import { getAppPool, getPool } from '../../db/client.js'
import { createProjectSharedStore } from '../../db/project-shared-store.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { prepareAssistantRun } from '../../turn/prepare.js'
import { BriefDirectionChangedError, configureBriefTurnContext, createGoalBriefBoundary, resolveBriefTurn } from '../context.js'
import { ensureBrief, inspectBrief, proposeChange, selectDepartmentBriefs } from '../service.js'
import { applyDirection, setBriefSyncClientForTests } from '../publication.js'
import { maintainBriefContext } from '../maintenance.js'
import { actorOf, briefFixture, type BriefFixture } from './fixture.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const pool = getPool()
const q = (sql: string, values: unknown[] = []) => pool.query(sql, values)

async function assistantRow(id: string) {
  return (await q(`SELECT id, workspace_id AS "workspaceId", kind, clearance, compartments, default_compartments AS "defaultCompartments",
    team_scope_mode AS "teamScopeMode", default_workspace_group_id AS "defaultWorkspaceGroupId", project_scope_mode AS "projectScopeMode",
    default_project_id AS "defaultProjectId" FROM assistants WHERE id=$1`, [id])).rows[0]
}

type RunOpts = { userId: string; assistantId?: string; sessionId?: string; shared?: boolean; system?: string; projectId?: string }

async function executionFor(f: BriefFixture, opts: RunOpts) {
  const sessionId = opts.sessionId ?? randomUUID()
  const { executionContext } = await resolveExecutionContextSystem({
    workspaceId: f.workspaceId, userId: opts.userId, assistant: await assistantRow(opts.assistantId ?? f.assistants.brian),
    session: { contextGroupId: null, contextProjectId: opts.projectId ?? f.projectId, contextLockedAt: new Date(),
      ...(opts.shared ? { contextCompartments: [`project:${opts.projectId ?? f.projectId}`] } : {}) } as never,
    identity: opts.system ? { kind: 'system', purpose: 'workflow', jobId: opts.system } : { kind: 'attended', principal: { kind: 'workspace_member', userId: opts.userId } },
    ownership: { kind: 'workspace', workspaceId: f.workspaceId },
    lifecycle: { abortSignal: new AbortController().signal, sessionId, channelType: 'web', channelId: sessionId },
    ...(opts.shared ? { sharedAudience: true } : {}),
  } as never)
  return executionContext
}

const executions: string[] = []
const writeTool = buildTool({ name: 'sendUpdate', description: 'test write', inputSchema: z.object({}).passthrough(), isReadOnly: false,
  async execute() { executions.push('sendUpdate'); return { data: { sent: true } } } })
const readTool = buildTool({ name: 'lookUp', description: 'test read', inputSchema: z.object({}).passthrough(), isReadOnly: true,
  async execute() { return { data: { ok: true } } } })

async function prepare(f: BriefFixture, opts: RunOpts, tools: Tool[] = [writeTool, readTool]) {
  return prepareAssistantRun({
    executionContext: await executionFor(f, opts),
    model: { provider: {} as LLMProvider, model: 'test' },
    candidateTools: new Map(tools.map(t => [t.name, t])),
    bindTools: candidates => candidates,
    trustedContributions: [{ name: 'runtime', content: 'runtime policy' }],
  })
}

const call = (run: Awaited<ReturnType<typeof prepare>>, name: string) => run.tools.get(name)!.execute({} as never, {} as never) as Promise<{ isError?: boolean; data: { error?: string } }>

async function establishedBrief(f: BriefFixture) {
  const lead = actorOf(f, f.people.lead)
  const { bindingId } = await ensureBrief(lead, { kind: 'project', id: f.projectId })
  await applyDirection(lead, bindingId, { change: { sections: { outcome: ['Ship the billing pilot'], rules: ['Finance approves invoices'] } },
    expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
  return { lead, bindingId }
}

describe('[COMP:api/brief-context] Accepted Brief grounding and live revision boundaries', () => {
  beforeAll(() => { configureBriefTurnContext(resolveBriefTurn); setBriefSyncClientForTests(null) })
  afterEach(() => { executions.length = 0 })
  afterAll(async () => { configureBriefTurnContext(null); setBriefSyncClientForTests(undefined); await getAppPool().end(); await pool.end() })

  it('two fresh chats follow the same accepted rules; pending text never appears; a later Apply reaches the next turn', async () => {
    const f = await briefFixture()
    const { lead, bindingId } = await establishedBrief(f)
    await proposeChange(actorOf(f, f.people.member), bindingId, { sections: { rules: ['Pending rule nobody accepted'] } }, { evidence: [{ kind: 'human', passage: 'idea' }] })
    const first = await prepare(f, { userId: f.people.member })
    const second = await prepare(f, { userId: f.people.lead })
    for (const run of [first, second]) {
      expect(run.contributionNames.trusted).toEqual(['runtime', 'brief'])
      expect(run.trustedContext).toContain('Finance approves invoices')
      expect(run.trustedContext).not.toContain('Pending rule nobody accepted')
    }
    const fingerprint = (text: string) => /fingerprint="([a-f0-9]+)"/.exec(text)![1]
    expect(fingerprint(first.trustedContext)).toBe(fingerprint(second.trustedContext))
    // Runtime policy stays first: the Brief is a contribution below it.
    expect(first.trustedContext.indexOf('runtime policy')).toBeLessThan(first.trustedContext.indexOf('<brief'))
    await applyDirection(lead, bindingId, { change: { sections: { decisions: ['Pilot starts with two customers'] } }, expectedDirectionRevision: 1, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    const third = await prepare(f, { userId: f.people.member })
    expect(third.trustedContext).toContain('Pilot starts with two customers')
    expect(fingerprint(third.trustedContext)).not.toBe(fingerprint(first.trustedContext))
  })

  it('a name-only Project home grounds nothing invented; a Project with no Brief contributes nothing', async () => {
    const f = await briefFixture()
    expect((await prepare(f, { userId: f.people.member })).contributionNames.trusted).toEqual(['runtime'])
    await ensureBrief(actorOf(f, f.people.lead), { kind: 'project', id: f.projectId })
    const run = await prepare(f, { userId: f.people.member })
    expect(run.trustedContext).toContain('not established yet')
    expect(run.trustedContext).toContain('Outcome:\n(not established)')
  })

  it('selected Department rules apply only by explicit binding and only where readable; otherwise a nonrevealing prerequisite blocks governed work', async () => {
    const f = await briefFixture()
    const { lead, bindingId } = await establishedBrief(f)
    const finance = await ensureBrief(actorOf(f, f.people.financeLead), { kind: 'department', id: f.finance })
    await applyDirection(actorOf(f, f.people.financeLead), finance.bindingId, { change: { sections: { rules: ['Every invoice needs a PO number'] } },
      expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    // Membership in the Department adds no rule until the owner selects it.
    expect((await prepare(f, { userId: f.people.financeLead })).trustedContext).not.toContain('PO number')
    await selectDepartmentBriefs(lead, bindingId, { departmentBindingIds: [finance.bindingId], expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    // A Finance reader sees the rules in a private Project chat.
    const reader = await prepare(f, { userId: f.people.financeLead })
    expect(reader.trustedContext).toContain('Every invoice needs a PO number')
    expect((await call(reader, 'sendUpdate')).isError).toBeUndefined()
    // A participant without Finance reach gets a prerequisite, not the rules, and governed actions stop.
    const outsider = await prepare(f, { userId: f.people.member })
    expect(outsider.trustedContext).not.toContain('PO number')
    expect(outsider.trustedContext).toContain('Finance approves invoices') // the Project's own rules still apply
    expect(outsider.trustedContext).toContain('A selected Department rule set is not available in this conversation')
    expect((await call(outsider, 'sendUpdate')).data.error).toBe('brief_rules_unavailable')
    expect((await call(outsider, 'lookUp')).data).toEqual({ ok: true })
    expect(executions).toEqual(['sendUpdate'])
    // In a shared Project chat the rules must fit the whole audience: the member cannot read Finance, so even a Finance reader's shared turn omits them.
    const shared = await prepare(f, { userId: f.people.financeLead, shared: true })
    expect(shared.trustedContext).not.toContain('PO number')
    expect(shared.trustedContext).toContain('A selected Department rule set is not available in this conversation')
  })

  it('a direction change refuses the next mutating action unless declared compatible; findings never interrupt; nothing is retried', async () => {
    const f = await briefFixture()
    const { lead, bindingId } = await establishedBrief(f)
    const run = await prepare(f, { userId: f.people.member })
    // Findings-only maintenance does not change the fingerprint.
    await maintainBriefContext(actorOf(f, f.people.member), bindingId, { section: 'findings', items: [{ text: 'A new finding', source: { kind: 'human', passage: 'x' } }] })
    expect((await call(run, 'sendUpdate')).isError).toBeUndefined()
    // Operation uncertainty: a change mid-operation never retries or duplicates it.
    let release!: () => void
    const slow = buildTool({ name: 'slowSend', description: 'slow write', inputSchema: z.object({}).passthrough(), isReadOnly: false,
      async execute() { executions.push('slowSend'); await new Promise<void>(resolve => { release = resolve }); return { data: { sent: true } } } })
    const slowRun = await prepare(f, { userId: f.people.member }, [slow, writeTool])
    const inFlight = call(slowRun, 'slowSend')
    await new Promise(resolve => setTimeout(resolve, 50))
    await applyDirection(lead, bindingId, { change: { sections: { rules: ['Finance approves invoices', 'Legal reviews contracts'] } },
      expectedDirectionRevision: 1, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    release()
    expect((await inFlight).data).toEqual({ sent: true })
    expect(executions.filter(e => e === 'slowSend')).toHaveLength(1)
    // The next affected action on either in-flight turn is refused before it acts.
    expect((await call(slowRun, 'sendUpdate')).data.error).toBe('brief_direction_changed')
    expect((await call(run, 'sendUpdate')).data.error).toBe('brief_direction_changed')
    expect(executions.filter(e => e === 'sendUpdate')).toHaveLength(1)
    // A change the owner declares compatible lets running work continue.
    const fresh = await prepare(f, { userId: f.people.member })
    await applyDirection(lead, bindingId, { change: { sections: { decisions: ['Weekly review'] } }, expectedDirectionRevision: 2, expectedSelectionRevision: 0,
      idempotencyKey: randomUUID(), activeWork: 'continue' })
    expect((await call(fresh, 'sendUpdate')).isError).toBeUndefined()
  })

  it('unattended work freezes its basis: an incompatible change refuses the next step before provider work; other Projects are untouched', async () => {
    const f = await briefFixture()
    const { lead, bindingId } = await establishedBrief(f)
    const job = `run-${randomUUID()}`
    await prepare(f, { userId: f.people.lead, system: job })
    // Another Project's change does not affect this job.
    const other = await createProjectSharedStore().create(f.people.lead, f.workspaceId, { name: 'Other', userIds: [], assistantIds: [f.assistants.brian] })
    const otherBrief = await ensureBrief(lead, { kind: 'project', id: other })
    await applyDirection(lead, otherBrief.bindingId, { change: { sections: { outcome: ['Unrelated'] } }, expectedDirectionRevision: 0, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    await expect(prepare(f, { userId: f.people.lead, system: job })).resolves.toBeDefined()
    await applyDirection(lead, bindingId, { change: { sections: { outcome: ['Changed outcome'] } }, expectedDirectionRevision: 1, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    await expect(prepare(f, { userId: f.people.lead, system: job })).rejects.toBeInstanceOf(BriefDirectionChangedError)
    // A new run starts on the current accepted direction.
    expect((await prepare(f, { userId: f.people.lead, system: `run-${randomUUID()}` })).trustedContext).toContain('Changed outcome')
  })

  it('a Goal keeps its outcome and budget: it blocks on an incompatible change, refreshes on a compatible one, and recaptures when resumed', async () => {
    const f = await briefFixture()
    const { lead, bindingId } = await establishedBrief(f)
    const boundary = createGoalBriefBoundary()
    const goal = { id: randomUUID(), workspaceId: f.workspaceId, contextProjectId: f.projectId }
    await boundary.capture(goal as never)
    expect(await boundary.check(goal as never)).toBe('ok')
    await maintainBriefContext(actorOf(f, f.people.member), bindingId, { section: 'questions', items: [{ text: 'Who signs?', source: { kind: 'human' } }] })
    expect(await boundary.check(goal as never)).toBe('ok')
    await applyDirection(lead, bindingId, { change: { sections: { decisions: ['Compatible addition'] } }, expectedDirectionRevision: 1, expectedSelectionRevision: 0, idempotencyKey: randomUUID(), activeWork: 'continue' })
    expect(await boundary.check(goal as never)).toBe('ok')
    await applyDirection(lead, bindingId, { change: { sections: { outcome: ['A different outcome'] } }, expectedDirectionRevision: 2, expectedSelectionRevision: 0, idempotencyKey: randomUUID() })
    expect(await boundary.check(goal as never)).toBe('changed')
    expect(await boundary.check(goal as never)).toBe('changed') // stays blocked until reviewed
    await boundary.capture(goal as never) // the owner resumes: the goal adopts current direction
    expect(await boundary.check(goal as never)).toBe('ok')
  })

  it('contraction applies immediately: a removed participant or assistant reads no Brief, proposal or grounding', async () => {
    const f = await briefFixture()
    const { bindingId } = await establishedBrief(f)
    const store = createProjectSharedStore()
    await store.removeMember(f.people.lead, f.projectId, { kind: 'user', id: f.people.member })
    await expect(inspectBrief(actorOf(f, f.people.member), { bindingId })).rejects.toMatchObject({ code: 'brief_not_found' })
    await expect(prepare(f, { userId: f.people.member })).rejects.toThrow()
    await store.removeMember(f.people.lead, f.projectId, { kind: 'assistant', id: f.assistants.brian })
    await expect(inspectBrief(actorOf(f, f.people.lead, f.assistants.brian), { bindingId })).rejects.toMatchObject({ code: 'brief_not_found' })
    // The owner without the assistant still reads it.
    expect((await inspectBrief(actorOf(f, f.people.lead), { bindingId })).direction!.rules).toEqual(['Finance approves invoices'])
  })
})
