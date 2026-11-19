/**
 * [COMP:api/pending-questions-resume] Approval card restore after a killed turn,
 * at the real boundary (m2-completion "Kill and restart mid-turn reclaims as
 * stalled_reclaimed"; M5 browser qualification restart run). A real web turn
 * suspends on a confirmation in an independent process, which is killed with
 * SIGKILL while it waits. The production sweeper reclaims the dead lease
 * (`stalled_reclaimed`). With no turn running, `GET /api/sessions/:id/pending`
 * must restore the card from the session's resume point, answering it through
 * the approvals route must enqueue the Path B resume, and the resumed turn must
 * run the approved tool and publish its continuation exactly once.
 * Spec: docs/architecture/engine/askquestion-suspend-resume.md → "Generic tool-confirmation recovery".
 */
import { randomUUID } from 'node:crypto'
import { fork, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'
import { buildTool } from '@use-brian/agent-runtime/tools/types.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const { runSessionResume, tryResolveLiveToolApproval } = await import('../chat.js')
const { createSessionResumeReplay } = await import('../session-resume-replay.js')
const { sessionQuestionRoutes } = await import('../sessions-questions.js')
const { approvalsRoutes } = await import('../approvals.js')
const { createTokens } = await import('../../auth/jwt.js')
const { getAppPool, getPool } = await import('../../db/client.js')
const { authSessionStore } = await import('../../db/auth-session-store.js')
const { createPersonalWebSession, getSessionMessages } = await import('../../db/sessions.js')
const { createPendingApprovalsStore } = await import('../../db/pending-approvals-store.js')
const { createDbSessionResumeStore } = await import('../../db/session-resume-store.js')
const { createDbJobStore } = await import('../../db/job-store.js')
const { createStuckSessionSweeper } = await import('../../scheduling/stuck-session-sweeper.js')
const { createDbConnectorStore } = await import('../../db/connector-store.js')
const { createDbMcpSettingsStore } = await import('../../db/mcp-settings-store.js')
const { createDbAssistantConnectorStore } = await import('../../db/assistant-connector-store.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')

afterAll(async () => { await getAppPool().end(); await getPool().end() })

const secret = 'fictional-approval-restore-secret'
const worker = fileURLToPath(new URL('./fixtures/approval-suspend-worker.ts', import.meta.url))
const require = createRequire(import.meta.url)

/** Runs the suspending turn in its own process and SIGKILLs it once the checkpoint committed. */
function suspendAndKill(command: object, directory: string): Promise<{ pid: number }> {
  return (async () => {
    const path = join(directory, `${randomUUID()}.json`)
    await writeFile(path, JSON.stringify(command), { mode: 0o600 })
    return new Promise((resolve, reject) => {
      const child: ChildProcess = fork(worker, [path], { execArgv: ['--import', require.resolve('tsx')], stdio: ['ignore', 'pipe', 'pipe', 'ipc'] })
      let output = '', suspended: { pid: number } | undefined
      const timeout = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`Approval worker timed out: ${output.slice(-4000)}`)) }, 90_000)
      child.stdout?.on('data', chunk => { output += chunk }); child.stderr?.on('data', chunk => { output += chunk })
      child.on('message', (message: { event: string; pid: number; status?: number; body?: string; message?: string }) => {
        if (message.event === 'suspended') { suspended = { pid: message.pid }; child.kill('SIGKILL') }
        else if (message.event === 'response') output += `\n[unexpected response ${message.status}] ${message.body}`
        else if (message.event === 'error') output += `\n[worker error] ${message.message}`
      })
      child.once('error', error => { clearTimeout(timeout); reject(error) })
      child.once('exit', (code, signal) => {
        clearTimeout(timeout)
        if (suspended && signal === 'SIGKILL') resolve(suspended)
        else reject(new Error(`Approval worker exited ${code ?? signal} before suspending: ${output.slice(-6000)}`))
      })
    })
  })()
}

function provider(text: string, sends: { count: number }): LLMProvider {
  const chunks: StreamChunk[] = [{ type: 'message_start', model: 'fixture' },
    ...text.split(' ').map((word, i) => ({ type: 'text_delta' as const, text: (i ? ' ' : '') + word })),
    { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 5, outputTokens: 5 } }]
  return { name: 'fictional-restore', models: ['fixture'], stream: async function* () { yield* chunks },
    createSession() { return { send() { sends.count++; return (async function* () { yield* chunks })() } } } }
}
const text = (row: { content: unknown }) => (row.content as Array<{ type: string; text?: string }>)
  .filter(block => block.type === 'text').map(block => block.text).join('')

describe.sequential('[COMP:api/pending-questions-resume] approval card restore after a killed turn', () => {
  // `swept`: the production sweeper reclaims the dead lease before the user returns
  // (the reclaimed-turn rule restores the card). `unswept`: the kill-to-reclaim
  // window. The dead token is still current, so the running-token rule shows the
  // card; the resume owner reclaims the stale lease itself at its claim.
  it.each(['swept', 'unswept'] as const)('restores the %s killed turn\'s card, enqueues the resume on answer and completes the resumed turn once', async (window) => {
    const f = await persistentContextFixture('confidential')
    const directory = await mkdtemp(join(tmpdir(), 'brian-approval-restore-'))
    const counter = `approval_counter_${randomUUID().replaceAll('-', '')}`
    try {
      await f.pool.query(`CREATE TABLE ${counter}(calls integer NOT NULL);INSERT INTO ${counter} VALUES(0)`)
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional restore browser', userAgent: null, ipAddress: null }))!
      const session = await createPersonalWebSession({
        assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat',
      }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
      const token = createTokens(f.ownerId, secret, device).accessToken

      // 1. The suspending web turn, killed while it waits for the decision.
      await suspendAndKill({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId, token, secret, counter }, directory)
      const approvals = await f.pool.query<{ id: string; status: string; kind: string; token: string | null }>(
        `SELECT id, status, kind, approval_payload->>'turnLeaseToken' AS token FROM pending_approvals WHERE blocking_session_id=$1`, [session.id])
      expect(approvals.rows).toHaveLength(1)
      const approval = approvals.rows[0]!
      expect(approval).toMatchObject({ status: 'pending', kind: 'tool_invocation' })
      const point = await f.pool.query<{ approvalId: string }>('SELECT approval_id AS "approvalId" FROM session_resume_points WHERE session_id=$1', [session.id])
      expect(point.rows).toEqual([{ approvalId: approval.id }])
      const leased = await f.pool.query<{ status: string; token: string | null }>('SELECT status, turn_lease_token::text AS token FROM sessions WHERE id=$1', [session.id])
      expect(leased.rows[0]).toMatchObject({ status: 'running', token: approval.token })

      // 2. Nothing heart-beats the dead lease after the kill. `swept`: it goes stale and the
      // production sweeper reclaims it. `unswept`: it is still running under the dead token.
      const leaseState = () => f.pool.query<{ status: string; token: string | null; reason: string | null }>(
        'SELECT status, turn_lease_token::text AS token, turn_end_reason AS reason FROM sessions WHERE id=$1', [session.id])
      const ageDeadLease = () => f.pool.query("UPDATE sessions SET turn_heartbeat_at=clock_timestamp()-interval '10 minutes' WHERE id=$1", [session.id])
      if (window === 'swept') {
        await ageDeadLease()
        await createStuckSessionSweeper({ publishDraftTurnCompleted: () => {} }).tick()
        expect((await leaseState()).rows[0]).toEqual({ status: 'timeout', token: null, reason: 'stalled_reclaimed' })
      } else {
        expect((await leaseState()).rows[0]).toEqual({ status: 'running', token: approval.token, reason: null })
      }

      // 3. A restarted process: no live resolver, the durable stores only.
      const approvalsStore = createPendingApprovalsStore()
      const sessionResumeStore = createDbSessionResumeStore()
      const jobStore = createDbJobStore()
      const resumeDeps = { approvalsStore, sessionResumeStore, jobStore, tryResolveLive: tryResolveLiveToolApproval }
      const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/api/sessions', sessionQuestionRoutes({ approvalsStore, resumeDeps }))
      app.use('/api/approvals', approvalsRoutes({ approvalsStore, resumeDeps, workspaceStore: {} as never, bridgeDeps: {} as never,
        emailReviewContext: async () => null }))

      const restored = await request(app).get(`/api/sessions/${session.id}/pending`).expect(200)
      expect(restored.body.toolConfirmation).toMatchObject({ approvalId: approval.id, toolName: 'fictionalApprovalEffect', input: { note: 'fictional' } })
      expect(JSON.stringify(restored.body)).not.toContain(approval.token!)

      // 4. Answering the restored card enqueues the Path B resume (no live resolver exists here).
      const answered = await request(app).post(`/api/approvals/${approval.id}/respond`).send({ decision: 'approved' }).expect(200)
      expect(answered.body).toMatchObject({ kind: 'tool_invocation', status: 'approved', resume: { kind: 'enqueued' } })
      const job = await jobStore.get(answered.body.resume.jobId)
      expect(job?.state?.resume).toEqual({ sessionId: session.id, approvalId: approval.id })
      // A decided card is no longer offered.
      expect((await request(app).get(`/api/sessions/${session.id}/pending`).expect(200)).body.toolConfirmation).toBeNull()
      // `unswept`: by the time the poll worker claims the job the dead lease has gone stale
      // (time passing, modelled by aging its heartbeat), and no sweeper has run.
      if (window === 'unswept') {
        await ageDeadLease()
        expect((await leaseState()).rows[0]).toEqual({ status: 'running', token: approval.token, reason: null })
      }

      // 5. The poll worker's resume handler runs the job: the approved tool once, one continuation.
      const sends = { count: 0 }
      const events: Array<{ kind: string; payload?: Record<string, unknown> }> = []
      const tool = buildTool({ name: 'fictionalApprovalEffect', description: 'Record one fictional approved effect',
        inputSchema: z.object({ note: z.string() }).strict(), isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: true,
        async execute() { await getPool().query(`UPDATE ${counter} SET calls=calls+1`); return { data: { recorded: true } } } })
      const replay = createSessionResumeReplay({ provider: provider('The fictional effect is recorded after your approval.', sends),
        tools: new Map([[tool.name, tool]]),
        capabilityStores: { connectorStore: createDbConnectorStore(null), settingsStore: createDbMcpSettingsStore(),
          assistantConnectorStore: createDbAssistantConnectorStore() },
        systemPrompt: 'Fictional fixture.', resolveWorkspaceCustomLlm: null, resolveWorkspaceByoGeminiKey: null, buildWorkspaceProvider: null,
        publishSessionEvent: event => { events.push(structuredClone(event) as never) } })
      const resume = job!.state!.resume!
      const before = (await getSessionMessages(session.id, { excludeHeld: true })).length
      await expect(runSessionResume({ sessionResumeStore, pendingApprovalsStore: approvalsStore, replay }, resume)).resolves.toEqual({ status: 'completed' })
      expect((await f.pool.query(`SELECT calls FROM ${counter}`)).rows[0].calls).toBe(1)
      const rows = await getSessionMessages(session.id, { excludeHeld: true })
      expect(rows.length).toBeGreaterThan(before)
      expect(text(rows.at(-1)!)).toBe('The fictional effect is recorded after your approval.')
      expect(events.map(event => event.kind)).toContain('turn_started')
      expect(events.at(-1)).toMatchObject({ kind: 'turn_completed' })
      expect(events.at(-1)?.payload?.reason).toBeUndefined()
      if (window === 'unswept') {
        // The resume owner reclaimed the dead turn itself and announced it first, with the dead turn's id.
        expect(events[0]).toMatchObject({ kind: 'turn_completed', payload: { reason: 'stalled_reclaimed', turnId: expect.stringMatching(/^[a-f0-9]{64}$/) } })
        expect(events[1]).toMatchObject({ kind: 'turn_started' })
        expect(events[0]!.payload!.turnId).not.toBe(events[1]!.payload!.turnId)
      } else {
        expect(events[0]).toMatchObject({ kind: 'turn_started' })
      }
      // The resumed owner released its own lease; nothing holds the session.
      expect((await leaseState()).rows[0]).toMatchObject({ token: null })
      expect((await leaseState()).rows[0]!.status).not.toBe('running')
      expect(await sessionResumeStore.getBySessionId(session.id)).toBeNull()

      // 6. A second fire of the same job is a no-op: no tool, no model call, no row.
      const sendsAfterFirst = sends.count, rowsAfterFirst = rows.length
      await expect(runSessionResume({ sessionResumeStore, pendingApprovalsStore: approvalsStore, replay }, resume))
        .resolves.toEqual({ status: 'skipped', reason: 'resume_point_missing' })
      expect((await f.pool.query(`SELECT calls FROM ${counter}`)).rows[0].calls).toBe(1)
      expect(sends.count).toBe(sendsAfterFirst)
      expect((await getSessionMessages(session.id, { excludeHeld: true })).length).toBe(rowsAfterFirst)
      expect((await request(app).get(`/api/sessions/${session.id}/pending`).expect(200)).body.toolConfirmation).toBeNull()
    } finally {
      await f.pool.query(`DROP TABLE IF EXISTS ${counter}`)
      await rm(directory, { recursive: true, force: true })
      await f.cleanup()
    }
  }, 180_000)

  /**
   * A killed suspended web turn whose card was answered in a restarted process,
   * with the sweeper never running: the dead lease still holds the session.
   */
  async function answeredKilledTurn(f: Awaited<ReturnType<typeof persistentContextFixture>>, directory: string, counter: string) {
    await f.pool.query(`CREATE TABLE ${counter}(calls integer NOT NULL);INSERT INTO ${counter} VALUES(0)`)
    await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
    const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional restore browser', userAgent: null, ipAddress: null }))!
    const session = await createPersonalWebSession({
      assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat',
    }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
    await suspendAndKill({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
      token: createTokens(f.ownerId, secret, device).accessToken, secret, counter }, directory)
    const approval = (await f.pool.query<{ id: string; token: string }>(
      `SELECT id, approval_payload->>'turnLeaseToken' AS token FROM pending_approvals WHERE blocking_session_id=$1`, [session.id])).rows[0]!
    const approvalsStore = createPendingApprovalsStore(), sessionResumeStore = createDbSessionResumeStore(), jobStore = createDbJobStore()
    const resumeDeps = { approvalsStore, sessionResumeStore, jobStore, tryResolveLive: tryResolveLiveToolApproval }
    const app = express(); app.use(express.json()); app.use((req, _res, next) => {
      req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
    })
    app.use('/api/sessions', sessionQuestionRoutes({ approvalsStore, resumeDeps }))
    app.use('/api/approvals', approvalsRoutes({ approvalsStore, resumeDeps, workspaceStore: {} as never, bridgeDeps: {} as never,
      emailReviewContext: async () => null }))
    // The running-token rule shows the card while the dead token is still current.
    expect((await request(app).get(`/api/sessions/${session.id}/pending`).expect(200)).body.toolConfirmation)
      .toMatchObject({ approvalId: approval.id })
    const answered = await request(app).post(`/api/approvals/${approval.id}/respond`).send({ decision: 'approved' }).expect(200)
    expect(answered.body.resume).toMatchObject({ kind: 'enqueued' })
    const resume = (await jobStore.get(answered.body.resume.jobId))!.state!.resume!
    const leaseState = async () => (await f.pool.query<{ status: string; token: string | null; reason: string | null }>(
      'SELECT status, turn_lease_token::text AS token, turn_end_reason AS reason FROM sessions WHERE id=$1', [session.id])).rows[0]!
    const calls = async () => (await f.pool.query<{ calls: number }>(`SELECT calls FROM ${counter}`)).rows[0]!.calls
    const events: Array<{ kind: string; payload?: Record<string, unknown> }> = []
    const sends = { count: 0 }
    const tool = buildTool({ name: 'fictionalApprovalEffect', description: 'Record one fictional approved effect',
      inputSchema: z.object({ note: z.string() }).strict(), isReadOnly: false, isConcurrencySafe: false, requiresConfirmation: true,
      async execute() { await getPool().query(`UPDATE ${counter} SET calls=calls+1`); return { data: { recorded: true } } } })
    const replay = (resumeSlotWait: { staleAfterMs: number; pollMs: number; timeoutMs?: number }) => createSessionResumeReplay({
      provider: provider('The fictional effect is recorded after your approval.', sends), tools: new Map([[tool.name, tool]]),
      capabilityStores: { connectorStore: createDbConnectorStore(null), settingsStore: createDbMcpSettingsStore(),
        assistantConnectorStore: createDbAssistantConnectorStore() },
      systemPrompt: 'Fictional fixture.', resolveWorkspaceCustomLlm: null, resolveWorkspaceByoGeminiKey: null, buildWorkspaceProvider: null,
      publishSessionEvent: event => { events.push(structuredClone(event) as never) }, resumeSlotWait })
    const run = (wait: Parameters<typeof replay>[0]) => runSessionResume({ sessionResumeStore, pendingApprovalsStore: approvalsStore, replay: replay(wait) }, resume)
    return { session, approval, sessionResumeStore, leaseState, calls, events, sends, run }
  }

  it('reclaims its own predecessor lease the moment it goes stale, without a sweep, and completes once', async () => {
    const f = await persistentContextFixture('confidential')
    const directory = await mkdtemp(join(tmpdir(), 'brian-approval-restore-'))
    const counter = `approval_counter_${randomUUID().replaceAll('-', '')}`
    try {
      const t = await answeredKilledTurn(f, directory, counter)
      // The job fires while the dead lease is still fresh (its last heartbeat is now).
      await f.pool.query('UPDATE sessions SET turn_heartbeat_at=clock_timestamp() WHERE id=$1', [t.session.id])
      const started = Date.now()
      let settled = false
      const resumed = t.run({ staleAfterMs: 3_000, pollMs: 200 }).finally(() => { settled = true })
      await new Promise(resolve => setTimeout(resolve, 1_500))
      // Fresh: the resume waits, nothing is reclaimed and nothing runs.
      expect(settled).toBe(false)
      expect(await t.leaseState()).toEqual({ status: 'running', token: t.approval.token, reason: null })
      expect(await t.calls()).toBe(0); expect(t.events).toEqual([])
      await expect(resumed).resolves.toEqual({ status: 'completed' })
      expect(Date.now() - started).toBeGreaterThanOrEqual(2_500)
      // Reclaimed through the sweeper's classification, announced before the resumed turn.
      expect(t.events[0]).toMatchObject({ kind: 'turn_completed', payload: { reason: 'stalled_reclaimed', turnId: expect.stringMatching(/^[a-f0-9]{64}$/) } })
      expect(t.events[1]).toMatchObject({ kind: 'turn_started' })
      expect(t.events.at(-1)).toMatchObject({ kind: 'turn_completed' }); expect(t.events.at(-1)?.payload?.reason).toBeUndefined()
      expect(await t.calls()).toBe(1)
      expect(text((await getSessionMessages(t.session.id, { excludeHeld: true })).at(-1)!)).toBe('The fictional effect is recorded after your approval.')
      expect((await t.leaseState()).status).not.toBe('running')
      expect(await t.sessionResumeStore.getBySessionId(t.session.id)).toBeNull()
      const sendsAfterFirst = t.sends.count
      await expect(t.run({ staleAfterMs: 3_000, pollMs: 200 })).resolves.toEqual({ status: 'skipped', reason: 'resume_point_missing' })
      expect(await t.calls()).toBe(1); expect(t.sends.count).toBe(sendsAfterFirst)
    } finally {
      await f.pool.query(`DROP TABLE IF EXISTS ${counter}`)
      await rm(directory, { recursive: true, force: true })
      await f.cleanup()
    }
  }, 180_000)

  // Fail closed: a live holder of the predecessor lease, or a lease the resume point
  // does not name (stale under the resume's window, fresh under the claim's own), is
  // never reclaimed; the resume keeps waiting and refuses at its bound with no effect.
  it.each(['live predecessor holder', 'unnamed lease'] as const)('keeps waiting on a %s and fails closed at its bound', async (holder) => {
    const f = await persistentContextFixture('confidential')
    const directory = await mkdtemp(join(tmpdir(), 'brian-approval-restore-'))
    const counter = `approval_counter_${randomUUID().replaceAll('-', '')}`
    let heartbeat: ReturnType<typeof setInterval> | undefined
    try {
      const t = await answeredKilledTurn(f, directory, counter)
      const otherToken = randomUUID()
      if (holder === 'live predecessor holder') {
        const beat = () => f.pool.query('UPDATE sessions SET turn_heartbeat_at=clock_timestamp() WHERE id=$1', [t.session.id])
        await beat(); heartbeat = setInterval(() => { void beat() }, 300)
      } else {
        await f.pool.query("UPDATE sessions SET turn_lease_token=$2, turn_heartbeat_at=clock_timestamp()-interval '10 seconds' WHERE id=$1",
          [t.session.id, otherToken])
      }
      const expectedToken = holder === 'live predecessor holder' ? t.approval.token : otherToken
      await expect(t.run({ staleAfterMs: 3_000, pollMs: 200, timeoutMs: 6_000 })).rejects.toMatchObject({ code: 'room_turn_wait_timeout' })
      expect(await t.leaseState()).toEqual({ status: 'running', token: expectedToken, reason: null })
      expect(await t.calls()).toBe(0); expect(t.sends.count).toBe(0); expect(t.events).toEqual([])
      expect(await t.sessionResumeStore.getBySessionId(t.session.id)).toMatchObject({ approvalId: t.approval.id })
    } finally {
      if (heartbeat) clearInterval(heartbeat)
      await f.pool.query(`DROP TABLE IF EXISTS ${counter}`)
      await rm(directory, { recursive: true, force: true })
      await f.cleanup()
    }
  }, 180_000)
})
