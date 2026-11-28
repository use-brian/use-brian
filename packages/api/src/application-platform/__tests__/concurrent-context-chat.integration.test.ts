/** [COMP:api/native-chat-read-cost] Concurrent mounted Chat with real workers and verified private context. */
import { AsyncLocalStorage } from 'node:async_hooks'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { monitorEventLoopDelay, performance } from 'node:perf_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import express, { type Express } from 'express'
import pg from 'pg'
import request from 'supertest'
import { expect, it, vi } from 'vitest'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { wrapLog } from '@use-brian/agent-runtime/providers/wrappers.js'
import type { BootResult } from '../../boot.js'
import { connectBootstrap } from '../../__tests__/fixtures/bootstrap-role.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createDbFileStore } from '../../db/file-store.js'
import { createDbWorkspaceFilesStore } from '../../db/workspace-files-store.js'
import { openContextChatSession, seedContextChatMemory } from './fixtures/context-chat-memory.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

const providerState = vi.hoisted(() => ({ provider: null as LLMProvider | null }))
vi.mock('../../boot/providers.register.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../boot/providers.register.js')>()
  return { ...original, async registerProviders(...args: Parameters<typeof original.registerProviders>) {
    const registered = await original.registerProviders(...args)
    if (!providerState.provider) throw new Error('Missing deterministic provider')
    registered.configuredProviders.setStaticProvider('gemini', true)
    args[0].late.provider = providerState.provider
    return { ...registered, provider: providerState.provider }
  } }
})

const secret = 'fictional-context-load-secret'
const reference = 'fictional-working-release-checklist.txt'
const fileCount = 24
const sharedSkill = 'fixture-shared-inventory'
const lockIntervalMs = 50
const fixtureSlotHeader = 'x-brian-fixture-slot'
type Fixture = Awaited<ReturnType<typeof persistentContextFixture>>
type Session = Awaited<ReturnType<typeof openContextChatSession>>
type Actor = { userId: string; fact: string }
type Driver = { count: number; elapsedMs: number; maxMs: number }
type ProviderTiming = { provider_trace_id: string; provider_stream_ordinal: number; provider_phase: string }
type Turn = {
  slot: number; sessionId: string; question: string; attachmentId: string; answer: string
  inputs: string[]; active: boolean; driver: Driver; lockSamples: number; lockEvents: Record<string, number>
  blockingOperations: Record<string, number>; lockedRelations: Record<string, number>
  providerTimings: ProviderTiming[]
  timings?: Record<string, number>
}
type Physical = {
  slot: number; firstTextMs?: number; doneMs?: number; completionMs: number; status: number
  terminal: string[]; text: string
}

const currentTurn = new AsyncLocalStorage<Turn>()
const activeTurns = new Map<number, Turn>()
const provider: LLMProvider = {
  name: 'concurrent-context-fixture', models: ['fixture'],
  async *stream() {
    yield { type: 'message_start', model: 'fixture' }
    yield { type: 'text_delta', text: 'Fictional background classification' }
    yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
  },
  createSession(options) {
    const send = wrapLog()(async function* ({ messages }) {
      const input = JSON.stringify({ options, messages })
      const tracked = currentTurn.getStore()
      const turn = tracked ?? [...activeTurns.values()].find(candidate => candidate.active
        && (input.includes(candidate.question) || input.includes('fixture_attachment_lookup_' + candidate.slot)))
      yield { type: 'message_start', model: 'fixture' }
      if (turn?.active && (turn.inputs.length > 0 || input.includes(turn.question))) {
        turn.inputs.push(input)
        const discover = options.tools?.some(tool => tool.name === 'readChatHistory')
        if (discover || turn.inputs.length === 2) {
          const id = (discover ? 'fixture_context_lookup_' : 'fixture_attachment_lookup_') + turn.slot
          yield { type: 'tool_use_start', id, name: discover ? 'readChatHistory' : 'readFileContent' }
          yield { type: 'tool_use_delta', id, input: JSON.stringify(discover ? {} : { fileId: turn.attachmentId }) }
          yield { type: 'tool_use_end', id }
          yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
          return
        }
        yield { type: 'text_delta', text: turn.answer }
      } else {
        yield { type: 'text_delta', text: 'Fictional maintenance reply' }
      }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    })
    return { send: messages => send({ model: options.model, systemPrompt: options.systemPrompt, messages }) }
  },
}

function readWidths() {
  const parts = (process.env.BRIAN_CONTEXT_CHAT_LOAD_WIDTHS ?? '1,2,4').split(',')
  if (!parts.every(part => /^[124]$/.test(part)) || new Set(parts).size !== parts.length) {
    throw new Error('Expected distinct fixture widths from 1, 2, and 4')
  }
  return parts.map(Number)
}

function connectTracing(app: Express, active: Map<number, Turn>) {
  const tracing = express()
  let requests = 0, peak = 0
  tracing.use((req, res, next) => {
    const turn = active.get(Number(req.get(fixtureSlotHeader)))
    if (!turn || req.method !== 'POST' || req.path !== '/api/chat') return next()
    ++requests
    peak = Math.max(requests, peak)
    const complete = () => {
      res.off('finish', complete)
      res.off('close', complete)
      --requests
    }
    res.once('finish', complete)
    res.once('close', complete)
    currentTurn.run(turn, next)
  })
  tracing.use(app)
  return { app: tracing, reset: () => { peak = 0 }, peak: () => peak }
}

function traceDriver(active: Map<number, Turn>) {
  const pending = new Map<number, Turn[]>()
  const lastTurnByPid = new Map<number, Turn>()
  const original = pg.Client.prototype.query
  const log = console.log.bind(console)
  const debug = console.debug.bind(console)
  const timings = vi.spyOn(console, 'log').mockImplementation((...args: unknown[]) => {
    if (typeof args[0] === 'string') {
      for (const turn of active.values()) {
        const marker = `[chat] turn timings session ${turn.sessionId} `
        if (args[0].startsWith(marker)) {
          turn.timings = Object.fromEntries([...args[0].slice(marker.length).matchAll(/\b([a-z_]+)=(\d+)/g)]
            .map(([, key, value]) => [key, Number(value)]))
        }
      }
    }
    log(...args)
  })
  const providerLogs = vi.spyOn(console, 'debug').mockImplementation((...args: unknown[]) => {
    const turn = currentTurn.getStore()
    if (turn?.active && typeof args[0] === 'string' && args[0].startsWith('{"message":"[stream] ')) {
      turn.providerTimings.push(JSON.parse(args[0]) as ProviderTiming)
    }
    debug(...args)
  })
  let workerCalls = 0
  const queries = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
    const turn = currentTurn.getStore()
    const pid = (this as pg.Client & { processID?: number }).processID ?? 0
    if (!turn?.active) {
      lastTurnByPid.delete(pid)
      if (active.size && typeof args[0] === 'string' && args[0].startsWith('SELECT public.compile_conversation_record_page(')) {
        ++workerCalls
      }
      return Reflect.apply(original, this, args)
    }
    const queue = pending.get(pid) ?? []
    if (pid) {
      lastTurnByPid.set(pid, turn)
      pending.set(pid, queue)
      queue.push(turn)
    }
    ++turn.driver.count
    const started = performance.now()
    const completed = () => {
      const elapsed = performance.now() - started
      turn.driver.elapsedMs += elapsed
      turn.driver.maxMs = Math.max(turn.driver.maxMs, elapsed)
      const index = queue.indexOf(turn)
      if (index >= 0) queue.splice(index, 1)
      if (queue.length === 0) pending.delete(pid)
    }
    const callback = args.at(-1)
    if (typeof callback === 'function') args[args.length - 1] = (...values: unknown[]) => { completed(); callback(...values) }
    try {
      const result = Reflect.apply(original, this, args)
      if (result && typeof result.then === 'function' && typeof callback !== 'function') {
        return result.then((value: unknown) => { completed(); return value }, (error: unknown) => { completed(); throw error })
      }
      return result
    } catch (error) {
      completed()
      throw error
    }
  } as typeof original)
  return { pending, lastTurnByPid, reset: () => { workerCalls = 0; lastTurnByPid.clear() }, workerCalls: () => workerCalls,
    restore: () => { queries.mockRestore(); timings.mockRestore(); providerLogs.mockRestore() } }
}

// Classify on the database side. SQL text, role names and backend PIDs stay out of the receipt.
const operation = (query: 'waiting.query' | 'blocker.query') => `CASE
  WHEN ${query} LIKE '%lock_native_session_context_publication(%' THEN 'publication_lock'
  WHEN ${query} LIKE '%read_native_memory_query_projection(%' THEN 'memory_projection'
  WHEN ${query} LIKE '%capture_native_prompt_memory_sections(%' THEN 'prompt_memory'
  WHEN ${query} LIKE '%read_native_memory_query_metadata(%' THEN 'memory_metadata'
  WHEN ${query} LIKE '%capture_conversation_evidence(%' THEN 'conversation_evidence'
  WHEN ${query} LIKE '%capture_conversation_preparation(%' THEN 'conversation_preparation'
  WHEN ${query} LIKE '%capture_conversation_query(%' OR ${query} LIKE '%capture_native_turn_conversation_record(%' THEN 'conversation_read'
  WHEN ${query} LIKE '%capture_native_turn_%transcript%' OR ${query} LIKE '%read_private_transcript_%' THEN 'private_transcript'
  WHEN ${query} LIKE '%read_session_authority_facts(%' OR ${query} LIKE '%native_session_turn_publication_%' THEN 'session_authority'
  WHEN ${query} LIKE '%native_session_release_turn(%' THEN 'turn_release'
  WHEN ${query} LIKE '%native_session_turn_transition(%' OR ${query} LIKE '%record_native_turn_candidate(%' THEN 'turn_lifecycle'
  WHEN ${query} LIKE '%capture_native_turn_conversation_%' OR ${query} LIKE '%admit_native_turn_conversation_%' THEN 'conversation_record'
  WHEN ${query} LIKE '%publish_native_session_message_batch(%' OR ${query} LIKE '%record_native_turn_completion(%' THEN 'reply_publication'
  WHEN ${query} LIKE 'SET CONSTRAINTS ALL IMMEDIATE%' THEN 'publication_constraints'
  WHEN ${query} LIKE '%read_external_source_dependencies(%' THEN 'external_ancestry'
  WHEN ${query} LIKE '%workspace_files%' THEN 'workspace_file'
  WHEN ${query} LIKE '%application_field_observations%' OR ${query} LIKE '%application_field_resources%' THEN 'field_observation'
  WHEN ${query} LIKE '%workspaces%FOR SHARE%' OR ${query} LIKE '%workspaces%FOR UPDATE%' THEN 'workspace_lock'
  WHEN ${query} LIKE '%compile_conversation_record_page(%' THEN 'worker_conversion'
  WHEN ${query} LIKE '%enroll_existing_conversation_records(%' THEN 'worker_enrollment'
  WHEN ${query} LIKE 'COMMIT%' THEN 'commit'
  WHEN ${query} LIKE 'BEGIN%' THEN 'begin'
  ELSE 'other' END`

async function observeLocks(observer: pg.Client, driver: ReturnType<typeof traceDriver>, stop: AbortSignal) {
  const { pending, lastTurnByPid } = driver
  let samples = 0, maxGapMs = 0, previous = performance.now(), pollsWithBackends = 0
  while (!stop.aborted) {
    await delay(lockIntervalMs, undefined, { signal: stop }).catch(error => {
      if (!stop.aborted) throw error
    })
    if (stop.aborted) break
    const now = performance.now()
    maxGapMs = Math.max(maxGapMs, now - previous)
    previous = now
    ++samples
    const active = new Map([...pending].map(([pid, queue]) => [pid, queue[0]] as const))
    if (!active.size) continue
    ++pollsWithBackends
    const { rows } = await observer.query<{ pid: number; wait_event: string; operation: string; relations: string[];
      blockers: { pid: number; operation: string; role: string; phase: string }[] }>(`WITH waiters AS MATERIALIZED (
      SELECT pid,query,wait_event FROM pg_stat_activity
      WHERE datid=(SELECT oid FROM pg_database WHERE datname=current_database())
      AND pid=ANY($1::integer[]) AND state='active' AND wait_event_type='Lock'
    ) SELECT waiting.pid,waiting.wait_event,${operation('waiting.query')} AS operation,
      ARRAY(SELECT DISTINCT c.relname::text FROM pg_locks l JOIN pg_class c ON c.oid=l.relation
        WHERE l.pid=waiting.pid AND l.granted AND l.mode<>'AccessShareLock' AND l.relation=ANY(ARRAY[
          'public.workspaces'::regclass,'public.sessions'::regclass,'public.conversation_envelopes'::regclass,
          'public.memories'::regclass,'public.application_query_domains'::regclass,
          'public.application_field_resources'::regclass,'public.application_field_observations'::regclass])) AS relations,
      ARRAY(SELECT json_build_object('pid',pid,'operation',${operation('blocker.query')},
        'role',CASE WHEN blocker.usename='app_user' THEN 'app' WHEN blocker.usename IS NULL THEN 'unknown' ELSE 'system' END,
        'phase',CASE WHEN blocker.state='active' THEN 'active' WHEN blocker.state LIKE 'idle in transaction%' THEN 'transaction' ELSE 'other' END)
        FROM (SELECT DISTINCT unnest(pg_blocking_pids(waiting.pid)) AS pid LIMIT 8) blocked_by
        LEFT JOIN pg_stat_activity blocker USING (pid)) AS blockers
    FROM waiters waiting`, [[...active.keys()]])
    for (const { pid, wait_event, operation, blockers, relations } of rows) {
      const turn = active.get(pid)
      if (!turn?.active || pending.get(pid)?.[0] !== turn) continue
      ++turn.lockSamples
      turn.lockEvents[wait_event] = (turn.lockEvents[wait_event] ?? 0) + 1
      for (const relation of relations) turn.lockedRelations[relation] = (turn.lockedRelations[relation] ?? 0) + 1
      if (!blockers.length) {
        const key = operation + ' <- cleared'
        turn.blockingOperations[key] = (turn.blockingOperations[key] ?? 0) + 1
      }
      for (const blocker of blockers) {
        const blockerTurn = lastTurnByPid.get(blocker.pid)
        const owner = blockerTurn?.active ? 'slot ' + blockerTurn.slot : blocker.role
        const key = operation + ' <- ' + owner + ' ' + blocker.phase + ' ' + blocker.operation
        turn.blockingOperations[key] = (turn.blockingOperations[key] ?? 0) + 1
      }
    }
  }
  return { intervalMs: lockIntervalMs, samples, pollsWithBackends, maxGapMs }
}

async function send(app: Express, fixture: Fixture, session: Session, turn: Turn): Promise<Physical> {
  const events: string[] = [], chunks: string[] = []
  let firstTextMs: number | undefined, doneMs: number | undefined, buffer = ''
  const start = performance.now()
  turn.active = true
  try {
    const response = await request(app).post('/api/chat')
      .set('Authorization', 'Bearer ' + session.token).set(fixtureSlotHeader, String(turn.slot))
      .send({ sessionId: session.session.id, workspaceId: fixture.workspaceId, assistantId: fixture.assistantId,
        appOrigin: 'chat', model: 'pro', message: turn.question, fileIds: [turn.attachmentId] })
      .buffer(true).parse((stream, done) => {
        stream.setEncoding('utf8')
        stream.on('data', (text: string) => {
          buffer += text
          const frames = buffer.split(/\r?\n\r?\n/)
          buffer = frames.pop() ?? ''
          for (const frame of frames) {
            const event = /^event: (.+)\r?$/m.exec(frame)?.[1]?.trim()
            if (event === 'text_delta') {
              firstTextMs ??= performance.now() - start
              const data = frame.split(/\r?\n/).filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n')
              try { chunks.push(JSON.parse(data).text) } catch { events.push('malformed_text') }
            } else if (event === 'done') {
              doneMs ??= performance.now() - start
              events.push('done')
            } else if (event === 'error') events.push('error')
          }
        })
        stream.on('end', () => done(null, null))
        stream.on('error', done)
      })
    return { slot: turn.slot, firstTextMs, doneMs, completionMs: performance.now() - start, status: response.status,
      terminal: events, text: chunks.join('') }
  } finally { turn.active = false }
}

async function seedUsers(f: Fixture, count: number, added: string[]): Promise<Actor[]> {
  const actors: Actor[] = []
  for (let slot = 1; slot <= count; slot++) {
    const userId = slot === 1 ? f.ownerId : randomUUID()
    if (slot !== 1) {
      await f.pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
      added.push(userId)
      await f.pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",
        [f.workspaceId, userId])
    }
    const fact = `The fixture badge for reader ${slot} is painted shade ${slot * 197}.`
    if (slot === 1) await seedContextChatMemory(f, true, secret, fact)
    else {
      await f.memory(fact, userId)
      for (let index = 1; index < 8; index++) await f.memory(`Fictional retained reader ${slot} detail ${index}`, userId)
    }
    actors.push({ userId, fact })
  }
  return actors
}

async function seedFiles(f: Fixture) {
  await createDbCapabilityStore().grant({ assistantId: f.assistantId, capability: 'files', grantedByUserId: f.ownerId })
  const store = createDbWorkspaceFilesStore()
  for (let i = 0; i < fileCount; i++) {
    const name = i === fileCount - 1 ? reference : `fictional-work-reference-${i}.txt`
    await store.create(f.ownerId, {
      workspaceId: f.workspaceId, path: '/' + name, parentPath: '/', name, mime: 'text/plain', sizeBytes: 21 + i,
      storageUri: 'fixture://' + name, summary: `Fictional workplace reference ${i}`, createdByUserId: f.ownerId, sensitivity: 'internal',
    })
  }
}

it.skipIf(process.env.BRIAN_CONTEXT_CHAT_LOAD !== '1')('reopens concurrent workers-on Chat turns with exact private context', async () => {
  const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
  await assertLocalFixture()
  expect(process.env.PG_POOL_MAX).toBe('4')
  const widths = readWidths(), reports: unknown[] = [], addedUsers: string[] = []
  const active = activeTurns
  let boot: BootResult | undefined, fixture: Fixture | undefined, observer: pg.Client | undefined
  let workload: Record<string, number> = {}
  providerState.provider = provider
  try {
    const { bootOpenApi } = await import('../../boot.js')
    boot = await bootOpenApi({ env: { JWT_SECRET: secret, NODE_ENV: 'test',
      API_URL: 'http://127.0.0.1:4000', APP_URL: 'http://127.0.0.1:3003' },
    runWorkers: true, startLocalSubscriptionProvider: false })
    const f = fixture = await persistentContextFixture('internal')
    await f.pool.query("UPDATE workspaces SET plan='pro', department_read_v2=true WHERE id=$1", [f.workspaceId])
    const actors = await seedUsers(f, Math.max(...widths), addedUsers)
    await seedFiles(f)
    await f.pool.query(`WITH skill AS (
      INSERT INTO workspace_skills(workspace_id,author_id,slug,name,description,content,sensitivity,state,activated_at)
      VALUES($1,$2,$3,'Fixture inventory','Count fixture items','Count the fixture items.','internal','active',now())
      RETURNING id
    ) INSERT INTO workspace_skill_enablement(workspace_skill_id,assistant_id,enabled_by_user_id)
      SELECT id,$4,$2 FROM skill`, [f.workspaceId, f.ownerId, sharedSkill, f.assistantId])
    workload = (await f.pool.query<{ memoryRows: number; liveMemoryRows: number; derivationEdges: number; files: number }>(`SELECT
      (SELECT count(*)::int FROM memories WHERE workspace_id=$1) AS "memoryRows",
      (SELECT count(*)::int FROM memories WHERE workspace_id=$1 AND valid_to IS NULL) AS "liveMemoryRows",
      (SELECT count(*)::int FROM scope_derivation_sources WHERE workspace_id=$1) AS "derivationEdges",
      (SELECT count(*)::int FROM workspace_files WHERE workspace_id=$1) AS files`, [f.workspaceId])).rows[0]
    expect(workload).toMatchObject({ memoryRows: 208 + (actors.length - 1) * 8,
      liveMemoryRows: actors.length * 8, derivationEdges: 65925, files: fileCount })

    observer = await connectBootstrap()
    await observer.query("SET statement_timeout='1500ms'")
    const tracing = connectTracing(boot.app, active), driver = traceDriver(active)
    const seenProviderTraces = new Set<string>()
    let observedWork = 0
    try {
      for (const width of widths) {
        const participants = actors.slice(0, width)
        const sessions = await Promise.all(participants.map(actor => openContextChatSession(f, secret, actor.userId)))
        const prior = new Map<number, string>()
        for (const phase of ['first', 'follow-up'] as const) {
          const attachments = await Promise.all(sessions.map(async ({ session }, index) => {
            const content = `The private fictional note for ${phase} reader ${index + 1} gives window ${(index + 1) * 271}.`
            const file = await createDbFileStore().cache({
              sessionId: session.id, workspaceId: f.workspaceId, assistantId: f.assistantId,
              userId: participants[index].userId, fileName: 'private-launch-note.txt', mimeType: 'text/plain',
              content, sizeBytes: Buffer.byteLength(content),
            })
            return { file, content }
          }))
          const turns: Turn[] = sessions.map(({ session }, index) => ({
            slot: index + 1, sessionId: session.id, attachmentId: attachments[index].file.id,
            question: `For fixture reader ${index + 1}'s ${phase} launch, read my note and tell me its window, badge shade and checklist.`,
            answer: `Fictional verified launch answer for ${phase} reader ${index + 1}.`,
            active: false, inputs: [], driver: { count: 0, elapsedMs: 0, maxMs: 0 }, lockSamples: 0, lockEvents: {},
            blockingOperations: {}, lockedRelations: {}, providerTimings: [],
          }))
          tracing.reset()
          driver.reset()
          for (const turn of turns) active.set(turn.slot, turn)
          const stop = new AbortController(), loop = monitorEventLoopDelay({ resolution: lockIntervalMs })
          const locks = observeLocks(observer, driver, stop.signal)
          // Attach a rejection handler immediately, but still propagate a failed observation below.
          void locks.catch(() => {})
          loop.enable()
          const startedAt = new Date().toISOString()
          const started = performance.now()
          const results = await Promise.allSettled(turns.map((turn, index) => send(tracing.app, f, sessions[index], turn)))
          const waveMs = performance.now() - started
          const finishedAt = new Date().toISOString()
          loop.disable()
          stop.abort()
          const lockObserver = await locks
          const workerCalls = driver.workerCalls()
          observedWork += workerCalls
          active.clear()
          const turnReports = turns.map((turn, index) => {
            const result = results[index]
            const actual = result.status === 'fulfilled' ? result.value : undefined
            const inputChecks = {
              tookToolRound: turn.inputs.length === 3,
              memory: !turn.inputs[0]?.includes(participants[index].fact) && Boolean(turn.inputs[1]?.includes(participants[index].fact)),
              files: !turn.inputs[0]?.includes(reference) && Boolean(turn.inputs[1]?.includes(reference)),
              skill: !turn.inputs[0]?.includes(sharedSkill) && Boolean(turn.inputs[1]?.includes(sharedSkill)),
              attachment: turn.inputs[0]?.includes(turn.attachmentId) && turn.inputs[2]?.includes(attachments[index].content) || false,
              retainedHistory: phase === 'first' || (!turn.inputs[0]?.includes(prior.get(turn.slot)!) && Boolean(turn.inputs[1]?.includes(prior.get(turn.slot)!))),
              isolation: turn.inputs.every(input => actors.every((actor, other) => other === index || !input.includes(actor.fact))
                && attachments.every((attachment, other) => other === index || !input.includes(attachment.content))),
            }
            return {
              slot: turn.slot, firstTextMs: actual?.firstTextMs ?? null, doneMs: actual?.doneMs ?? null,
              completionMs: actual?.completionMs ?? null, httpStatus: actual?.status ?? null,
              sseVerified: Boolean(actual && actual.status === 200 && actual.firstTextMs !== undefined
                && actual.doneMs !== undefined && actual.firstTextMs <= actual.doneMs && actual.doneMs <= actual.completionMs
                && actual.terminal.length === 1 && actual.terminal[0] === 'done' && actual.text === turn.answer),
              inputsVerified: Object.values(inputChecks).every(Boolean), inputChecks, providerRounds: turn.inputs.length,
              reopened: false, providerTraceVerified: false, driverQueries: turn.driver, lockSamples: turn.lockSamples, lockEvents: turn.lockEvents,
              turnTimings: turn.timings ?? null, blockingOperations: turn.blockingOperations, lockedRelations: turn.lockedRelations,
            }
          })
          reports.push({ width, phase, startedAt, finishedAt, waveMs, peakRequests: tracing.peak(),
            workerConversionCalls: workerCalls, lockObserver, eventLoopDelayP95Ms: loop.percentile(95) / 1e6, turns: turnReports })
          await boot.ctx.analytics.flush()
          for (const [index, turn] of turns.entries()) {
            const reopened = await request(boot.app).get('/api/sessions/' + turn.sessionId + '/messages')
              .set('Authorization', 'Bearer ' + sessions[index].token)
            const messages = reopened.body
            const last = Array.isArray(messages) ? messages.at(-1) : undefined
            turnReports[index].reopened = reopened.status === 200 && last?.role === 'assistant'
              && JSON.stringify(last.content) === JSON.stringify([{ type: 'text', text: turn.answer }])
              && turns.every(other => other === turn || !JSON.stringify(messages).includes(other.answer))
            const { rows: [analytics] } = await f.pool.query<{ trace: string }>(`SELECT metadata->>'provider_trace_id' AS trace
              FROM analytics_events WHERE session_id=$1 AND event_name='turn_timings' ORDER BY created_at DESC LIMIT 1`, [turn.sessionId])
            const ordinals = turn.providerTimings.map(timing => timing.provider_stream_ordinal)
            turnReports[index].providerTraceVerified = /^pt-[0-9a-f-]{36}$/.test(analytics?.trace ?? '')
              && !seenProviderTraces.has(analytics.trace) && ordinals.length === 3
              && ordinals.every((value, index) => Number.isInteger(value) && value > (ordinals[index - 1] ?? 0))
              && turn.providerTimings.every(timing => timing.provider_trace_id === analytics.trace && timing.provider_phase === 'loop')
            if (analytics?.trace) seenProviderTraces.add(analytics.trace)
            prior.set(turn.slot, turn.answer)
          }
          expect.soft(tracing.peak(), `overlap for width ${width}, ${phase}`).toBe(width)
          for (const turn of turnReports) {
            expect.soft(turn, `width ${width}, ${phase}, slot ${turn.slot}`)
              .toMatchObject({ sseVerified: true, inputsVerified: true, reopened: true, providerTraceVerified: true, turnTimings: expect.any(Object) })
          }
        }
      }
      expect(observedWork, 'real conversion worker calls during measured waves').toBeGreaterThan(0)
    } finally { driver.restore() }
  } finally {
    try {
      const output = process.env.BRIAN_CONTEXT_CHAT_LOAD_OUTPUT
      if (output) await writeFile(output, JSON.stringify({ schema: 1, workers: true, poolSize: 4, widths, workload, waves: reports }, null, 2), { mode: 0o600 })
    } finally {
      try {
        await observer?.end()
        await boot?.ctx.analytics.flush()
        if (fixture) {
          await fixture.cleanup()
          if (addedUsers.length) await fixture.pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [addedUsers])
        }
      } finally { await boot?.shutdown() }
    }
  }
}, 240_000)
