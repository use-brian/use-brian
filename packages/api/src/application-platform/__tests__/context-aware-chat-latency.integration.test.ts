/** [COMP:api/native-chat-read-cost] Full-context send, durable reply and follow-up. */
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import pg from 'pg'
import request from 'supertest'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import type { BootResult } from '../../boot.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createDbFileStore } from '../../db/file-store.js'
import { createDbWorkspaceFilesStore } from '../../db/workspace-files-store.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'
import { openContextChatSession, seedContextChatMemory } from './fixtures/context-chat-memory.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

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

const secret = 'fictional-context-budget-secret'
const colorFact = 'Fixture permanent badge color is ultraviolet'
const reference = 'fictional-release-checklist.txt'
let boot: BootResult
let answer: string
let providerInputs: string[] = []
let requestedFileId: string | undefined
type Sample = { firstTextMs: number; completionMs: number }
const measurements: Record<string, Sample[]> = {}
let beforeOutput: (() => Promise<void>) | undefined

beforeAll(async () => {
  providerState.provider = {
    name: 'context-cost', models: ['fixture'],
    async *stream() {
      yield { type: 'message_start', model: 'fixture' }
      yield { type: 'text_delta', text: 'Fictional classifier reply' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    },
    createSession(options) {
      return { async *send(messages) {
        providerInputs.push(JSON.stringify({ options, messages }))
        const discover = options.tools?.some(tool => tool.name === 'requestConversationContext')
        if (discover || requestedFileId) {
          const fileId = requestedFileId
          if (!discover) requestedFileId = undefined
          const id = discover ? 'fixture_context_lookup' : 'fixture_file_lookup'
          yield { type: 'message_start', model: 'fixture' }
          yield { type: 'tool_use_start', id, name: discover ? 'requestConversationContext' : 'readFileContent' }
          yield { type: 'tool_use_delta', id, input: JSON.stringify(discover ? {} : { fileId }) }
          yield { type: 'tool_use_end', id }
          yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
          return
        }
        await beforeOutput?.()
        yield { type: 'message_start', model: 'fixture' }
        yield { type: 'text_delta', text: answer }
        yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
      } }
    },
  }
  const { bootOpenApi } = await import('../../boot.js')
  boot = await bootOpenApi({ env: { JWT_SECRET: secret, NODE_ENV: 'test',
    API_URL: 'http://127.0.0.1:4000', APP_URL: 'http://127.0.0.1:3003' },
    runWorkers: false, startLocalSubscriptionProvider: false })
})
afterAll(async () => {
  await boot?.shutdown()
  const output = process.env.BRIAN_CONTEXT_CHAT_COST_OUTPUT
  if (output) await writeFile(output, JSON.stringify(measurements), { mode: 0o600 })
})

it.each(['sparse', 'dense'] as const)('finishes two context-aware turns within five seconds each with %s history', async history => {
  const f = await persistentContextFixture('internal')
  try {
    const { workspaceId, assistantId, ownerId } = f
    await f.pool.query("UPDATE workspaces SET plan='pro', department_read_v2=true WHERE id=$1", [workspaceId])
    const factId = await seedContextChatMemory(f, history === 'dense', secret, colorFact)
    await createDbCapabilityStore().grant({ assistantId, capability: 'files', grantedByUserId: ownerId })
    await createDbWorkspaceFilesStore().create(ownerId, { workspaceId, path: '/' + reference,
      parentPath: '/', name: reference, mime: 'text/plain', sizeBytes: 10, storageUri: 'fixture://' + reference,
      summary: 'Fictional release reference', createdByUserId: ownerId, sensitivity: 'internal' })
    const { session, token, deviceId } = await openContextChatSession(f, secret)
    const attachmentText = 'The fictional launch window opens on Thursday.'
    const attachment = await createDbFileStore().cache({
      sessionId: session.id, workspaceId, assistantId, userId: ownerId, fileName: 'launch-note.txt',
      mimeType: 'text/plain', content: attachmentText, sizeBytes: Buffer.byteLength(attachmentText),
    })
    const replies = ['Ultraviolet, with the release checklist for Thursday.', 'The checklist still specifies ultraviolet.']
    const questions = ['Read the launch note. Which day, badge color and checklist are we using?', 'Remind me why those go together.']
    const samples: Sample[] = []
    for (const [turn, message] of questions.entries()) {
      answer = replies[turn]!
      providerInputs = []
      requestedFileId = turn === 0 ? attachment.id : undefined
      let body = '', firstTextMs: number | undefined
      const start = performance.now()
      await request(boot.app).post('/api/chat').set('Authorization', 'Bearer ' + token)
        .send({ sessionId: session.id, assistantId, workspaceId, appOrigin: 'chat', model: 'pro', message,
          ...(turn === 0 ? { fileIds: [attachment.id] } : {}) })
        .buffer(true).parse((stream, done) => {
          stream.on('data', (chunk: Buffer) => {
            body += chunk.toString()
            if (firstTextMs === undefined && /(?:^|\n)event: text_delta\r?\ndata: [^\n]+\r?\n\r?\n/.test(body)) {
              firstTextMs = performance.now() - start
            }
          })
          stream.on('end', () => done(null, body))
          stream.on('error', done)
        }).expect(200)
      const completionMs = performance.now() - start
      expect(body).toContain('event: done')
      expect(body).not.toContain('event: error')
      expect(body).toContain('event: text_delta\ndata: ' + JSON.stringify({ text: answer }))
      if (firstTextMs === undefined) throw new Error('Missing first text frame')
      samples.push({ firstTextMs, completionMs })
      expect(providerInputs).toHaveLength(turn === 0 ? 3 : 2)
      expect(providerInputs[0]).not.toContain(colorFact)
      expect(providerInputs[0]).not.toContain(reference)
      expect(providerInputs[1]).toContain(colorFact)
      expect(providerInputs[1]).toContain(reference)
      if (turn === 0) {
        expect(providerInputs[0]).toContain(attachment.id)
        expect(providerInputs[2]).toContain(attachmentText)
      }
      if (turn > 0) expect(providerInputs[1]).toContain(replies[turn - 1])
      const reopened = await request(boot.app).get('/api/sessions/' + session.id + '/messages')
        .set('Authorization', 'Bearer ' + token).expect(200)
      expect(reopened.body.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: answer }] })
    }
    // The immediate in-process provider adds no deliberate wait. HTTP through
    // stream closure is a conservative upper bound including durable completion.
    measurements[history] = samples
    console.info('[context-aware-chat]', history, 'completion_ms', samples.map(sample => Math.round(sample.completionMs)))
    // M7 checks the destination on each frame and fresh source rights at
    // dispatch and publication. Change each after the provider has its input.
    answer = 'Fictional reply subject to withdrawal'
    providerInputs = []
    beforeOutput = history === 'dense' ? async () => {
      await f.pool.query('UPDATE memories SET scope_held=true WHERE workspace_id=$1 AND id=$2', [workspaceId, factId])
    } : async () => { expect(await authSessionStore.revokeForUser(ownerId, deviceId)).toBe(true) }
    const response = await request(boot.app).post('/api/chat').set('Authorization', 'Bearer ' + token)
      .send({ sessionId: session.id, assistantId, workspaceId, appOrigin: 'chat', model: 'pro',
        message: 'What is the current permanent badge color?' }).expect(200)
    expect(providerInputs.some(input => input.includes(colorFact))).toBe(true)
    expect(response.text).toContain('event: error')
    if (history === 'sparse') expect(response.text).not.toContain(answer)
    const stored = await f.pool.query(
      'SELECT id FROM session_messages WHERE session_id=$1 AND content @> $2::jsonb',
      [session.id, JSON.stringify([{ type: 'text', text: answer }])],
    )
    expect(stored.rows).toEqual([])
    for (const sample of samples) expect(sample.completionMs).toBeLessThanOrEqual(5000)
  } finally {
    beforeOutput = undefined
    requestedFileId = undefined
    await boot.ctx.analytics.flush()
    await f.cleanup()
  }
}, 120_000)

it.each(['native_proof','ancestry'] as const)('reports a PostgreSQL proof timeout in %s during paired prompt preparation', async phase => {
  const f = await persistentContextFixture('internal')
  try {
    await f.pool.query("UPDATE workspaces SET plan='pro', department_read_v2=true WHERE id=$1", [f.workspaceId])
    // The packed reader falls back when its metadata bound exceeds 100 roots.
    for (let index = 0; index < 101; index++) await f.memory(`Fictional retained context ${index}`, f.ownerId)
    const { session, token } = await openContextChatSession(f, secret)
    const requestText = 'What is the retained context for this request?'
    const originalQuery = pg.Client.prototype.query
    let pairedClient: pg.Client | undefined
    let observedSqlstate: unknown
    let timedProofs = 0
    const ancestryBatches: number[] = []
    providerInputs = []
    const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      // Only the actual paired SQL and its following application-role proof
      // participate. All other checkout, storage, and delivery operations run normally.
      const run = (queryArgs: unknown[]) => Reflect.apply(originalQuery, this, queryArgs)
      const [sql, params] = args
      if (typeof sql !== 'string') return run(args)
      if (sql.includes("SELECT 'ranked' AS cohort,value,ordinality FROM read_native_memory_query_projection")) pairedClient = this
      const kinds = Array.isArray(params) ? params[1] : undefined
      const memoryBatch = sql.includes('FROM read_external_source_dependencies($1,$2,$3,$4)')
        && Array.isArray(kinds) && kinds.length > 0 && kinds.every(kind => kind === 'memory')
      if (memoryBatch) ancestryBatches.push(kinds.length)
      const chosen = phase === 'native_proof' ? this === pairedClient && sql === 'SELECT capture_conversation_evidence($1,$2) AS value'
        : memoryBatch && kinds.length === 100
      if (!chosen || timedProofs) return run(args)
      timedProofs++
      const interrupted = (async () => {
        await run([phase === 'native_proof' ? "SET LOCAL statement_timeout='25ms'" : "SET statement_timeout='25ms'"])
        try {
          return await run([`WITH pause AS MATERIALIZED (SELECT $1::uuid AS workspace_id,pg_sleep(0.2))
            SELECT protected.* FROM pause CROSS JOIN LATERAL (${sql.replace('$1', 'pause.workspace_id')}) protected`, params])
        } catch (error) {
          observedSqlstate = (error as { code?: unknown }).code
          throw error
        } finally {
          if (phase === 'ancestry') await run(['RESET statement_timeout'])
        }
      })()
      const callback = args.at(-1)
      if (typeof callback === 'function') {
        void interrupted.then(result => callback(null, result), error => callback(error))
        return undefined
      }
      return interrupted
    } as typeof originalQuery)
    let response
    try {
      response = await request(boot.app).post('/api/chat').set('Authorization', 'Bearer ' + token)
        .send({ sessionId: session.id, assistantId: f.assistantId, workspaceId: f.workspaceId, appOrigin: 'chat', model: 'pro', message: requestText })
        .expect(200)
    } finally { spy.mockRestore() }
    expect(observedSqlstate).toBe('57014')
    expect(timedProofs).toBe(1)
    if (phase === 'ancestry') expect(ancestryBatches).toEqual([100])
    expect(providerInputs).toHaveLength(1)
    expect(providerInputs[0]).toContain(requestText)
    expect(providerInputs[0]).not.toContain('Fictional retained context')
    const errors = [...response.text.matchAll(/^event: error\r?\ndata: ([^\r\n]+)/gm)].map(frame => JSON.parse(frame[1]))
    expect(errors).toEqual([{ code: 'context_verification_unavailable',
      error: 'We couldn’t finish checking the context for this reply.', retrySafe: false, turnId: expect.stringMatching(/^[0-9a-f]{64}$/) }])
    expect(response.text).not.toMatch(/statement_timeout|57014|capture_conversation_evidence|event: text_delta|event: done/)
    const messages = await request(boot.app).get('/api/sessions/' + session.id + '/messages')
      .set('Authorization', 'Bearer ' + token).expect(200)
    expect(messages.body.map((message: { role: string }) => message.role)).toEqual(['user'])
    expect(messages.body[0].content).toEqual([{ type: 'text', text: requestText }])
    expect((await f.pool.query('SELECT status FROM sessions WHERE id=$1', [session.id])).rows).toEqual([{ status: 'failed' }])
    await boot.ctx.analytics.flush()
    const { rows } = await f.pool.query(`SELECT metadata FROM analytics_events WHERE session_id=$1 AND event_name='chat_route_error'`, [session.id])
    expect(rows).toEqual([{ metadata: { error_type: 'ContextVerificationUnavailableError', error_message: 'context_verification_unavailable',
      verification_failure: 'statement_timeout', verification_phase: phase, verification_sqlstate_class: '57', stage: 'post_session' } }])
  } finally {
    await boot.ctx.analytics.flush()
    await f.cleanup()
  }
}, 120_000)

it('delivers a private chat reply with both a CRM self profile and an offered skill revision', async () => {
  const f = await persistentContextFixture()
  try {
    const { workspaceId, assistantId, ownerId } = f
    await f.pool.query("UPDATE workspaces SET plan='pro', department_read_v2=true WHERE id=$1", [workspaceId])
    const person = await f.pool.query<{ id: string }>(
      `INSERT INTO entities(workspace_id,kind,display_name,attributes,user_id,created_by_user_id,source)
       VALUES($1,'person','Fictional Profile','{"self":true,"profile":{"name":"Fictional Profile"}}',$2,$2,'manual') RETURNING id`,
      [workspaceId, ownerId],
    )
    await f.pool.query('UPDATE users SET entity_id=$1 WHERE id=$2', [person.rows[0].id, ownerId])
    const skill = await f.pool.query<{ id: string }>(
      `INSERT INTO workspace_skills(workspace_id,author_id,slug,name,description,content,sensitivity,state,activated_at)
       VALUES($1,$2,'fixture-inventory','Fixture inventory','Count fictional widgets','Count the widgets in the fixture.','internal','active',now()) RETURNING id`,
      [workspaceId, ownerId],
    )
    async function greet() {
      const { session, token } = await openContextChatSession(f, secret)
      providerInputs = []
      const response = await request(boot.app).post('/api/chat').set('Authorization', 'Bearer ' + token)
        .send({ workspaceId, assistantId, sessionId: session.id, appOrigin: 'chat', message: 'hi' })
        .expect(200)
      const reopened = await request(boot.app).get('/api/sessions/' + session.id + '/messages')
        .set('Authorization', 'Bearer ' + token).expect(200)
      return { stream: response.text, messages: reopened.body }
    }

    answer = 'Hello from the fixture.'
    for (const enabled of [false, true]) {
      if (enabled) await f.pool.query(
        'INSERT INTO workspace_skill_enablement(workspace_skill_id,assistant_id,enabled_by_user_id) VALUES($1,$2,$3)',
        [skill.rows[0].id, assistantId, ownerId],
      )
      const { stream, messages } = await greet()
      expect(stream).toContain('event: done')
      expect(providerInputs).toHaveLength(2)
      expect(providerInputs[0]).not.toContain('fixture-inventory')
      expect(providerInputs[1].includes('fixture-inventory')).toBe(enabled)
      expect(messages.at(-1)).toMatchObject({ role: 'assistant', content: [{ type: 'text', text: answer }] })
    }

    // Replacing the revision after model dispatch invalidates durable
    // publication, even while the original chat audience is still authorized.
    beforeOutput = async () => {
      await f.pool.query('UPDATE workspace_skills SET content=$2 WHERE id=$1', [skill.rows[0].id, 'Revised fixture instructions.'])
    }
    const { stream, messages } = await greet()
    expect(providerInputs[1]).toContain('fixture-inventory')
    expect(stream).toContain('event: error')
    expect(stream).not.toContain('event: done')
    expect(messages.map((row: { role: string }) => row.role)).toEqual(['user'])
  } finally {
    beforeOutput = undefined
    await boot.ctx.analytics.flush()
    await f.cleanup()
  }
}, 60_000)
