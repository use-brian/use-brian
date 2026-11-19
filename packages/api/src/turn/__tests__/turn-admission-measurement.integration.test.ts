/**
 * [COMP:api/turn-kernel] One-request admission measurement (M2 re-measurement of
 * the 2026-11-16 one-turn baseline: 38 audience checks, 8.22 s admission).
 *
 * Drives one real web chat request per scenario through `chatRoutes` on the
 * disposable ordinary-owner PostgreSQL fixture with the per-turn SQL recorder on,
 * then attributes the request's statements by owner frame and its audience checks
 * by frame and call site. It measures and records only: no budget is asserted and
 * nothing is tuned here (plan "Milestone discipline", M6 owns tuning). The
 * provider is deterministic with zero network latency, so times are application
 * overhead on a small fixture, not the baseline's development-data turn.
 *
 * Output: `BRIAN_TURN_ADMISSION_OUTPUT` (JSON; default `$TMPDIR/brian-turn-admission.json`)
 * plus one `turn-admission` console line per scenario. Spec: docs/architecture/engine/turn-kernel.md
 * "Per-turn SQL accounting phases".
 */
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { LLMProvider, StreamChunk } from '@use-brian/agent-runtime/providers/types.js'

// Passthrough: record each request ledger identity the web adapter opens.
const ledgers = vi.hoisted(() => ({ ids: [] as string[], deliveries: [] as { type: string; admissions: number; kernelAdmissions: number; hostSinkAudienceChecks: number }[] }))
vi.mock('../kernel.js', async original => {
  const actual = await original<typeof import('../kernel.js')>()
  return { ...actual,
    openTurnSqlScope: () => { const scope = actual.openTurnSqlScope(); ledgers.ids.push(scope.sqlTurnId); return scope },
    openAssistantTurn: async (...args: Parameters<typeof actual.openAssistantTurn>) => {
      const owner = await actual.openAssistantTurn(...args), run = owner.run.bind(owner)
      owner.run = params => {
        let admissions = 0
        const sink = params.sink
        return run({ ...params, sink: { ...sink,
          onOutputAuthorityTiming: ms => { admissions++; sink.onOutputAuthorityTiming?.(ms) },
          onEvent: async (event, provenance) => {
            const kernelAdmissions = admissions, beforeSink = audience.calls.length
            admissions = 0
            await sink.onEvent?.(event, provenance)
            const hostSinkAudienceChecks = audience.calls.slice(beforeSink).filter(call => call.kind === 'adapter_check' && call.frame === 'output_admission').length
            ledgers.deliveries.push({ type: event.type, admissions: kernelAdmissions + hostSinkAudienceChecks, kernelAdmissions, hostSinkAudienceChecks })
          },
        } })
      }
      return owner
    },
  }
})
// Passthrough: observe every timed web audience check (`turnTiming.time('audience_check')`,
// the counter the baseline's 38 checks came from) with its frame and the adapter
// call site that invoked it. Nothing about the check itself is replaced.
type AudienceCall = { at: number; frame: string | null; site: string | null; kind: 'adapter_check' | 'output_frame' }
const audience = vi.hoisted(() => ({ calls: [] as AudienceCall[], start: 0 }))
function site(): string | null {
  // The innermost chat.ts frame is the timed check itself; the next is its caller.
  const lines = (new Error().stack ?? '').split('\n').map(entry => entry.match(/routes\/chat\.ts:(\d+)/)?.[1]).filter(Boolean) as string[]
  return lines[1] ?? lines[0] ?? null
}
vi.mock('../../routes/turn-timings.js', async original => {
  const actual = await original<typeof import('../../routes/turn-timings.js')>()
  const { currentTurnFrame } = await import('../../db/turn-sql-accounting.js')
  return { ...actual, createTurnTiming: (...args: Parameters<typeof actual.createTurnTiming>) => {
    const timing = actual.createTurnTiming(...args), time = timing.time.bind(timing), add = timing.add.bind(timing)
    const record = (kind: AudienceCall['kind']) => audience.calls.push({ at: performance.now() - audience.start,
      frame: currentTurnFrame()?.frameId ?? null, site: site(), kind })
    // An adapter check (`assertDeliveryAudience`) is timed; the kernel's per-frame
    // output admission reports through the sink's `onOutputAuthorityTiming` add.
    // Same accounting as the original `time` (one `add` per call), without
    // re-entering the observed `add` below.
    timing.time = async (counter, fn) => {
      if (counter !== 'audience_check') return time(counter, fn)
      record('adapter_check'); const at = performance.now()
      try { return await fn() } finally { add(counter, performance.now() - at) }
    }
    timing.add = (counter, ms) => { if (counter === 'audience_check') record('output_frame'); return add(counter, ms) }
    return timing
  } }
})

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

const { chatRoutes } = await import('../../routes/chat.js')
const { getAppPool, getPool } = await import('../../db/client.js')
const { authSessionStore } = await import('../../db/auth-session-store.js')
const { createPersonalWebSession, addSessionMessage } = await import('../../db/sessions.js')
const { createDbMemoryStore } = await import('../../db/memory-store.js')
const { createDbCapabilityStore } = await import('../../db/capability-store.js')
const { createPendingApprovalsStore } = await import('../../db/pending-approvals-store.js')
const { readTurnSqlLedger, setTurnSqlRecording } = await import('../../db/turn-sql-accounting.js')
const { persistentContextFixture } = await import('../../application-platform/__tests__/fixtures/persistent-context.js')

type FrameSummary = { frameId: string; parentFrameId: string | null; statements: number; control: number; elapsedMs: number }
const results: unknown[] = []

describe.sequential('[COMP:api/turn-kernel] one-request admission measurement', () => {
  afterAll(async () => {
    // The fixture passes only a clean environment (TMPDIR included), so the default lands there.
    await writeFile(process.env.BRIAN_TURN_ADMISSION_OUTPUT ?? join(tmpdir(), 'brian-turn-admission.json'), JSON.stringify({
      node: process.version, provider: 'deterministic, zero network latency', recorder: 'BRIAN turn SQL ledger (foreground statements by owner frame)',
      limitation: 'Small disposable fixture; foreground statements only (nested SQL inside functions is not counted). Times are not comparable to the development-data baseline.',
      results,
    }, null, 2))
    setTurnSqlRecording(undefined)
    await getAppPool().end(); await getPool().end()
  })

  // Sample 0 of each scenario is a warm-up; later samples are the warm figures.
  const scenarios = (['empty-private', 'populated-private', 'shared-room'] as const).flatMap(scenario => [0, 1, 2].map(sample => ({ scenario, sample })))
  it.each(scenarios)('$scenario / sample $sample', async ({ scenario, sample }) => {
    setTurnSqlRecording(true)
    const f = await persistentContextFixture('confidential')
    try {
      const device = (await authSessionStore.create(f.ownerId, { deviceLabel: 'Fictional measurement browser', userAgent: null, ipAddress: null }))!
      const session = scenario === 'shared-room' ? f.session : await createPersonalWebSession({
        assistantId: f.assistantId, userId: f.ownerId, workspaceId: f.workspaceId, channelType: 'web', channelId: randomUUID(), appOrigin: 'chat',
      }, { actorUserId: f.ownerId, authSessionId: device.id, authVersion: device.authVersion })
      if (scenario === 'populated-private') await addSessionMessage({ sessionId: session.id, role: 'user',
        content: [{ type: 'text', text: 'Remember the amber notebook.' }], senderUserId: f.ownerId, scope: { ...f.envelope, userId: f.ownerId } })
      await f.pool.query("UPDATE workspaces SET plan='pro' WHERE id=$1", [f.workspaceId])
      const reply = 'The amber notebook is ready for the fictional discussion.'
      const chunks: StreamChunk[] = [{ type: 'message_start', model: 'fixture' },
        ...reply.split(' ').map((word, i) => ({ type: 'text_delta' as const, text: (i ? ' ' : '') + word })),
        { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 10, outputTokens: 20 } }]
      const provider: LLMProvider = { name: 'fictional-measurement', models: ['fixture'],
        stream: async function* () { yield* chunks },
        createSession() { return { send() { return (async function* () { yield* chunks })() } } } }
      const app = express(); app.use(express.json()); app.use((req, _res, next) => {
        req.userId = f.ownerId; req.authSessionId = device.id; req.authVersion = device.authVersion; next()
      })
      app.use('/chat', chatRoutes({ provider, systemPrompt: 'Continue the fictional conversation.', tools: new Map(),
        memoryStore: createDbMemoryStore(), capabilityStore: createDbCapabilityStore(), pendingApprovalsStore: createPendingApprovalsStore() }))
      const turnTimings: Record<string, number> = {}, originalLog = console.log.bind(console)
      const timingSpy = vi.spyOn(console, 'log').mockImplementation((...values: unknown[]) => {
        for (const value of values) if (typeof value === 'string' && value.startsWith(`[chat] turn timings session ${session.id} `)) {
          for (const match of value.matchAll(/\b([a-z_]+)=(\d+(?:\.\d+)?)/g)) turnTimings[match[1]!] = Number(match[2])
        } else originalLog(value)
      })
      ledgers.ids.length = 0; ledgers.deliveries.length = 0; audience.calls.length = 0; audience.start = performance.now()
      let response
      try {
        response = await request(app).post('/chat').send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId,
          message: 'Which notebook did we choose earlier?', mode: 'default', model: 'pro' }).buffer(true).parse((res, done) => {
          let body = ''; res.on('data', (chunk: Buffer) => { body += chunk.toString() }); res.on('end', () => done(null, body)); res.on('error', done)
        })
      } finally { timingSpy.mockRestore() }
      const elapsedMs = performance.now() - audience.start
      expect(response.status).toBe(200)
      expect(String(response.body)).not.toContain('event: error')
      const outputFrames = String(response.body).split(/\r?\n\r?\n/).filter(frame => /^event: text_delta\r?$/m.test(frame)).length
      const textDeliveries = ledgers.deliveries.filter(event => event.type === 'text_delta')
      expect(outputFrames).toBeGreaterThan(0)
      expect(textDeliveries).toHaveLength(outputFrames)
      // Each received text frame is dispatched immediately after exactly one
      // real admission. Other protected engine events and finalization retain
      // their own checks and are reported separately rather than subtracted.
      expect(textDeliveries.every(event => event.admissions === 1)).toBe(true)
      expect(ledgers.ids).toHaveLength(1)
      const ledger = readTurnSqlLedger(ledgers.ids[0]!)!
      expect(ledger).toBeDefined()
      expect(ledger.overflow).toEqual({ statements: 0, fingerprints: 0, frames: 0 })
      const frames = new Map<string, FrameSummary>()
      for (const statement of ledger.statements) {
        const key = `${statement.parentFrameId ?? '-'}>${statement.frameId}`
        const entry = frames.get(key) ?? { frameId: statement.frameId, parentFrameId: statement.parentFrameId, statements: 0, control: 0, elapsedMs: 0 }
        entry.statements++; if (statement.control) entry.control++; entry.elapsedMs += statement.elapsedMs
        frames.set(key, entry)
      }
      // The adapter frame split at the owner's first admission statement.
      const firstAdmission = ledger.statements.find(statement => statement.frameId === 'admission')?.seq ?? Infinity
      const adapter = ledger.statements.filter(statement => statement.frameId === 'adapter')
      const auditByKey = (calls: AudienceCall[]) => Object.entries(calls.reduce<Record<string, number>>((n, call) => {
        const key = `${call.kind}@chat.ts:${call.site ?? '?'}[${call.frame ?? 'none'}]`; n[key] = (n[key] ?? 0) + 1; return n }, {}))
        .sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count }))
      const admissionMs = turnTimings.admission_ms ?? null
      const metrics = {
        scenario, sample, warmup: sample === 0, elapsedMs: Math.round(elapsedMs),
        admissionMs, audienceCheckCount: turnTimings.audience_check_count ?? 0, audienceCheckMs: turnTimings.audience_check_ms ?? 0,
        audienceCallsObserved: audience.calls.length,
        outputFrames, outputFrameAdmissions: textDeliveries.reduce((count, event) => count + event.admissions, 0),
        outputAdmissionSequence: ledgers.deliveries,
        audienceCallsDuringAdmission: admissionMs === null ? null : audience.calls.filter(call => call.at <= admissionMs).length,
        audienceCalls: auditByKey(audience.calls),
        audienceSequence: audience.calls.map(call => ({ ...call, at: Math.round(call.at) })),
        sql: { statements: ledger.totals.statements, control: ledger.totals.control, elapsedMs: Math.round(ledger.totals.elapsedMs),
          adapterBeforeOwner: adapter.filter(statement => statement.seq < firstAdmission).length,
          adapterAfterOwner: adapter.filter(statement => statement.seq > firstAdmission).length,
          frames: [...frames.values()].map(frame => ({ ...frame, elapsedMs: Math.round(frame.elapsedMs) })) },
        turnTimings,
      }
      results.push(metrics)
      console.info('turn-admission', JSON.stringify(metrics))
    } finally { setTurnSqlRecording(undefined); await f.cleanup() }
  }, 120_000)
})
