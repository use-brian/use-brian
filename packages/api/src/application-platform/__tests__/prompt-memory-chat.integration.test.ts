/** [COMP:api/native-chat-read-cost] Denied automatic Memory through the private Chat receiver. */
import { createRequire } from 'node:module'
import { delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import pg from 'pg'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import type { BootResult } from '../../boot.js'
import { prepareRankedMaskPolicy } from './fixtures/prompt-memory-field-policy.js'

const { assertLocalFixture, cloneLocalFixture, createLocalFixture, cleanRuntimeEnvironment, runCommand } =
  createRequire(import.meta.url)(fileURLToPath(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url)))
await assertLocalFixture()
const runtime = cleanRuntimeEnvironment(process.env)
const migrationDirs = (process.env.MIGRATION_DIRS ?? '').split(delimiter).filter(Boolean)
const migrationLedger = 'SELECT name FROM public._migrations ORDER BY name'
const parent = new pg.Client({ connectionString: process.env.DATABASE_URL })
const expectedMigrations = await (async () => {
  await parent.connect()
  try { return (await parent.query(migrationLedger)).rows }
  finally { await parent.end() }
})()
// The native field contract is database-global. A committed policy must be
// visible through the real route's connections without affecting other suites.
const fixture = process.env.BRIAN_ASSURANCE_TEMPLATE
  ? await cloneLocalFixture(process.env)
  : await createLocalFixture({ pgBin: (await runCommand('pg_config', ['--bindir'], { env: runtime })).trim(),
    migrationDirs, env: runtime })
const savedEnvironment = new Map([...Object.keys(fixture.env), 'BRIAN_ASSURANCE_TEMPLATE'].map(key => [key, process.env[key]]))
let boot: BootResult | undefined
let closePools: (() => Promise<void>) | undefined
async function dispose() {
  try {
    if (boot) await boot.shutdown()
    else await closePools?.()
  } finally {
    try { await fixture.dispose() }
    finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    }
  }
}

const providerState = vi.hoisted(() => ({ provider: null as LLMProvider | null }))
vi.mock('../../boot/providers.register.js', async importOriginal => {
  const original = await importOriginal<typeof import('../../boot/providers.register.js')>()
  return { ...original, async registerProviders(...args: Parameters<typeof original.registerProviders>) {
    const registered = await original.registerProviders(...args)
    if (!providerState.provider) throw new Error('Missing deterministic Memory provider')
    registered.configuredProviders.setStaticProvider('gemini', true)
    args[0].late.provider = providerState.provider
    return { ...registered, provider: providerState.provider }
  } }
})

const { createMemory, persistentContextFixture, openContextChatSession } = await (async () => {
  try {
    Object.assign(process.env, fixture.env)
    delete process.env.BRIAN_ASSURANCE_TEMPLATE
    await assertLocalFixture(fixture.env)
    // Import lazily so module-cached DB pools start on the isolated database.
    const client = await import('../../db/client.js')
    closePools = async () => { await Promise.all([client.getAppPool().end(), client.getPool().end()]) }
    const { createMemory } = await import('../../db/memories.js')
    const { persistentContextFixture } = await import('./fixtures/persistent-context.js')
    const { openContextChatSession } = await import('./fixtures/context-chat-memory.js')
    expect((await client.getPool().query(migrationLedger)).rows).toEqual(expectedMigrations)
    return { createMemory, persistentContextFixture, openContextChatSession }
  } catch (error) {
    try { await dispose() } catch (cleanup) { throw new AggregateError([error, cleanup], 'Private Chat fixture failed') }
    throw error
  }
})()

afterAll(dispose)
describe.sequential('private Chat with independent Memory index masks', () => {
  const foreground: string[] = []
  it.each(['packed', 'scalar'] as const)('delivers private Chat with a denied ranked Memory mask on the %s reader', async reader => {
    const f = await persistentContextFixture('internal')
    const { workspaceId, assistantId, ownerId } = f
    const summary = 'Fictional workspace badge is violet'
    const privateSummary = 'Fictional personal badge is teal'
    const privateField = 'Fictional withheld detail is amber'
    const reply = 'The workspace badge is violet.'
    const secret = 'fictional-memory-mask-chat-secret'
    let restriction: Awaited<ReturnType<typeof prepareRankedMaskPolicy>> | undefined
    try {
      await f.pool.query("UPDATE workspaces SET plan='pro',department_read_v2=true WHERE id=$1", [workspaceId])
      await createMemory({ workspaceId, assistantId, userId: null, createdByUserId: ownerId, scope: 'workspace',
        summary, detail: privateField, sensitivity: 'internal' })
      await f.memory(privateSummary, ownerId)
      if (reader === 'scalar') {
        // Metadata exceeds the packed bound while only two Memories are live.
        const history = await f.pool.connect()
        try {
          await history.query('BEGIN')
          const retiredIds = []
          for (let index = 0; index < 99; index++) {
            const memory = await createMemory({ workspaceId, assistantId, userId: ownerId, createdByUserId: ownerId,
              summary: 'Fictional retired entry ' + index, sensitivity: 'internal' }, undefined, history)
            retiredIds.push(memory.id)
          }
          await history.query('UPDATE memories SET valid_to=now() WHERE workspace_id=$1 AND user_id=$2 AND id=ANY($3::uuid[])',
            [workspaceId, ownerId, retiredIds])
          await history.query('COMMIT')
        } catch (error) {
          await history.query('ROLLBACK')
          throw error
        } finally { history.release() }
      }
      restriction = await prepareRankedMaskPolicy(f)
      await restriction.install()
      if (!boot) providerState.provider = {
        name: 'fictional-memory-mask', models: ['fixture'],
        async *stream() {
          yield { type: 'message_start', model: 'fixture' }
          yield { type: 'text_delta', text: 'Fictional classifier reply' }
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
        },
        createSession(options) {
          return { async *send(messages) {
            foreground.push(JSON.stringify({ options, messages }))
            yield { type: 'message_start', model: 'fixture' }
            if (options.tools?.some(tool => tool.name === 'readChatHistory')) {
              const id = 'fixture-memory-mask-context'
              yield { type: 'tool_use_start', id, name: 'readChatHistory' }
              yield { type: 'tool_use_delta', id, input: '{}' }
              yield { type: 'tool_use_end', id }
              yield { type: 'message_end', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
            } else {
              yield { type: 'text_delta', text: reply }
              yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
            }
          } }
        },
      }
      const { bootOpenApi } = await import('../../boot.js')
      boot ??= await bootOpenApi({ env: { JWT_SECRET: secret, NODE_ENV: 'test', API_URL: 'http://127.0.0.1:4000',
        APP_URL: 'http://127.0.0.1:3003' }, runWorkers: false, startLocalSubscriptionProvider: false })
      // The existing boot retains its registered provider between cases.
      const app = boot.app
      const originalQuery = pg.Client.prototype.query
      let catalogAvailable = true
      let interruptSelection = false
      let selectionSqlstate: unknown
      let packedPacket: unknown
      let scalarReads = 0
      let catalogReads = 0
      const spy = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
        const [sql, params] = args
        const run = (queryArgs: unknown[]) => Reflect.apply(originalQuery, this, queryArgs)
        if (typeof sql === 'string' && sql.includes("read_native_application_field_catalog($1")) {
          catalogReads++
          if (!catalogAvailable) return run(['SELECT NULL::jsonb AS mask'])
        }
        if (typeof sql === 'string' && sql.startsWith('SELECT value FROM read_native_memory_query_projection(')) scalarReads++
        if (interruptSelection && typeof sql === 'string' && sql.startsWith('WITH memory_viewer_rows AS MATERIALIZED')
          && sql.includes("AND scope = 'workspace'")) {
          return (async () => {
            await run(["SET LOCAL statement_timeout='25ms'"])
            try {
              return await run([`WITH pause AS MATERIALIZED (SELECT $1::uuid AS workspace_id,pg_sleep(0.2))
                SELECT protected.* FROM pause CROSS JOIN LATERAL (${sql.replace(/\$1\b/, 'pause.workspace_id')}) protected`, params])
            } catch (error) {
              selectionSqlstate = (error as { code?: unknown }).code
              throw error
            }
          })()
        }
        const result = run(args)
        if (typeof sql !== 'string' || !sql.includes('THEN public.capture_native_prompt_memory_sections_v2(')) return result
        return result.then((packet: { rows: Array<{ value: unknown }> }) => {
          packedPacket = packet.rows[0]?.value
          return packet
        })
      } as typeof originalQuery)
      try {
        const cases = reader === 'scalar' ? ['deliver', 'unverified', 'timeout'] : ['deliver', 'unverified']
        for (const scenario of cases) {
          catalogAvailable = scenario !== 'unverified'
          interruptSelection = scenario === 'timeout'
          foreground.length = 0
          packedPacket = undefined
          scalarReads = catalogReads = 0
          const { session, token } = await openContextChatSession(f, secret)
          const message = 'What color is the workspace badge?'
          const response = await request(app).post('/api/chat').set('Authorization', 'Bearer '+token).send({
            workspaceId, assistantId, sessionId: session.id, appOrigin: 'chat', model: 'standard', message,
          }).expect(200)
          expect(catalogReads).toBe(1)
          if (reader === 'packed') {
            expect(packedPacket).toMatchObject({ kind: 'sections', indexes: {
              ranked: { state: 'denied' }, workspace: { state: 'admitted' },
            } })
            expect(scalarReads).toBe(0)
          } else {
            expect(packedPacket).toMatchObject({ kind: 'unsupported', reason: 'metadata_cohort_bound' })
            expect(scalarReads).toBe(2)
          }
          const reopened = await request(app).get('/api/sessions/'+session.id+'/messages')
            .set('Authorization', 'Bearer '+token).expect(200)
          expect(foreground.join('')).not.toContain(privateField)
          expect(foreground.join('')).not.toContain(privateSummary)
          if (scenario === 'deliver') {
            expect(foreground).toHaveLength(2)
            expect(foreground[1]).toContain('Team: ' + summary)
            expect(foreground[1]).not.toContain('## Memory Index')
            expect(response.text).toContain('event: assistant_message_saved')
            expect(response.text).toContain('event: done')
            expect(response.text).not.toContain('event: error')
            expect(reopened.body.at(-1)).toMatchObject({ role:'assistant', content:[{ type:'text', text:reply }] })
          } else {
            expect(foreground.join('')).not.toContain(summary)
            expect(response.text).toContain('event: error')
            expect(response.text).not.toContain('event: done')
            expect(response.text).not.toContain(reply)
            expect(reopened.body[0]).toMatchObject({ role:'user', content:[{ type:'text', text:message }] })
            expect(JSON.stringify(reopened.body)).not.toContain(reply)
          }
          if (scenario === 'timeout') {
            expect(selectionSqlstate).toBe('57014')
            expect(response.text).toContain('"code":"context_verification_unavailable"')
            expect(response.text).toContain('"retrySafe":false')
            await boot.ctx.analytics.flush()
            const { rows } = await f.pool.query(`SELECT metadata FROM analytics_events
              WHERE session_id=$1 AND event_name='chat_route_error'`, [session.id])
            expect(rows).toMatchObject([{ metadata: { verification_failure:'statement_timeout',
              verification_phase:'prompt_memory_projection', verification_sqlstate_class:'57' } }])
          }
        }
      } finally { spy.mockRestore() }
    } finally {
      try { await boot?.ctx.analytics.flush(); await restriction?.dispose() }
      finally { await f.cleanup() }
    }
  }, 120_000)
})
