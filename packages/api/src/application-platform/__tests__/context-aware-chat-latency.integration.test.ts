/** [COMP:api/native-chat-read-cost] Full-context send, durable reply and follow-up. */
import { randomUUID } from 'node:crypto'
import { performance } from 'node:perf_hooks'
import { writeFile } from 'node:fs/promises'
import request from 'supertest'
import { afterAll, beforeAll, expect, it, vi } from 'vitest'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { createTokens } from '../../auth/jwt.js'
import type { BootResult } from '../../boot.js'
import { withTableTriggersSuspended } from '../../__tests__/fixtures/bootstrap-role.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { createDbFileStore } from '../../db/file-store.js'
import { createMemory } from '../../db/memories.js'
import { createPersonalWebSession } from '../../db/sessions.js'
import { createDbWorkspaceFilesStore } from '../../db/workspace-files-store.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'

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
type Fixture = Awaited<ReturnType<typeof persistentContextFixture>>

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
        if (requestedFileId) {
          const fileId = requestedFileId
          requestedFileId = undefined
          const id = 'fixture_file_lookup'
          yield { type: 'message_start', model: 'fixture' }
          yield { type: 'tool_use_start', id, name: 'readFileContent' }
          yield { type: 'tool_use_delta', id, input: JSON.stringify({ fileId }) }
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

async function openSession({ ownerId, assistantId, workspaceId }: Fixture) {
  const device = await authSessionStore.create(ownerId, {
    deviceLabel: 'Fictional budget fixture', userAgent: null, ipAddress: null,
  })
  if (!device) throw new Error('Could not create fixture session')
  const session = await createPersonalWebSession({ assistantId, userId: ownerId, workspaceId,
    channelType: 'web', channelId: randomUUID(), appOrigin: 'chat' },
    { actorUserId: ownerId, authSessionId: device.id, authVersion: device.authVersion })
  return { session, deviceId: device.id, token: createTokens(ownerId, secret, device).accessToken }
}

async function seedMemory(f: Fixture, dense: boolean) {
  const { workspaceId, assistantId, ownerId } = f
  const sourceSession = await openSession(f)
  const linkedIds: string[] = []
  const fact = await f.memory(colorFact, ownerId)
  for (const summary of ['Unlinked fixture fact A', 'Unlinked fixture fact B', 'Unlinked fixture fact C']) {
    await f.memory(summary, ownerId)
  }
  const setup = await f.pool.connect()
  try {
    await setup.query('BEGIN')
    for (let linked = dense ? 0 : 200; linked < 204; linked++) {
      const memory = await createMemory({
        workspaceId, assistantId, userId: ownerId, createdByUserId: ownerId, sourceSessionId: sourceSession.session.id,
        summary: 'Synthetic memory from an unrelated personal conversation ' + linked, sensitivity: 'internal',
      }, undefined, setup)
      linkedIds.push(memory.id)
    }
    await setup.query('COMMIT')
  } catch (error) {
    await setup.query('ROLLBACK')
    throw error
  } finally {
    setup.release()
  }
  if (!dense) return fact.id
  {
    await f.pool.query(`WITH snapshots AS (
      INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,
        sensitivity,compartments,project_ids,source_policy_revision)
      SELECT workspace_id,'memory',id,scope_version::text,'fixture:synthetic-linked-memory',user_id,assistant_id,
        sensitivity,compartments,project_ids,1 FROM memories WHERE id=ANY($1::uuid[])
      RETURNING id,workspace_id,resource_id
    ) INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
      SELECT d.workspace_id,d.id,'memory',m.id,m.scope_version::text
      FROM snapshots d JOIN unnest($2::uuid[],$3::uuid[]) edge(target,source) ON edge.target=d.resource_id
      JOIN memories m ON m.id=edge.source`,
    [ [linkedIds[0], linkedIds[71], linkedIds[95], linkedIds[201]],
      [linkedIds[0], linkedIds[71], linkedIds[95], linkedIds[201], linkedIds[201]],
      [linkedIds[160], linkedIds[161], linkedIds[162], linkedIds[163], linkedIds[164]] ])
  }
  const supersessionStarts = linkedIds.slice(0, 114)
  await f.pool.query('UPDATE memories SET valid_to=now() WHERE id=ANY($1::uuid[])', [linkedIds.slice(0, 200)])
  const heads = (await f.pool.query<{ id: string }>(`SELECT id FROM memories WHERE workspace_id=$1
    AND valid_to IS NULL ORDER BY source_session_id NULLS LAST,id`, [workspaceId])).rows.map(row => row.id)
  expect(heads).toHaveLength(8)
  const connectedEnds = supersessionStarts.map((_, index) => {
    if (index < 30) return linkedIds[index + 1]
    if (index === 30) return heads[0]
    if (index < 71) return linkedIds[71 + index % 43]
    return heads[1 + index % 7]
  })
  await f.pool.query(`UPDATE memories m SET superseded_by=edges.successor
    FROM unnest($1::uuid[],$2::uuid[]) AS edges(predecessor,successor) WHERE m.id=edges.predecessor`,
  [supersessionStarts, connectedEnds])
  const supersessionShape = (await f.pool.query(`SELECT count(*)::int AS items,
    count(source_session_id)::int AS linked, count(superseded_by)::int AS superseded,
    count(*) FILTER (WHERE valid_to IS NULL)::int AS current FROM memories WHERE workspace_id=$1`, [workspaceId])).rows[0]
  expect(supersessionShape).toEqual({ items: 208, linked: 204, superseded: 114, current: 8 })
  {
    const bulk = await f.pool.connect()
    try {
      await bulk.query('BEGIN')
      await bulk.query("SET LOCAL statement_timeout='120s'")
      // Fixture-only unrelated roots shape table density and index pages. The
      // eight live Memory heads and their five reachable edges are genuine.
      await withTableTriggersSuspended(bulk, ['scope_derivations', 'scope_derivation_sources'], async () => {
        await bulk.query(`WITH roots AS (
          INSERT INTO scope_derivations(workspace_id,resource_kind,resource_id,resource_version,producer,user_id,assistant_id,
            sensitivity,compartments,project_ids,source_policy_revision)
          SELECT $1,'session_message',md5('fictional-unrelated-target:'||root)::uuid,'1',
            'fixture:unrelated-graph-density',$2,$3,'internal','{}','{}',1
          FROM generate_series(1,1030) root RETURNING workspace_id,id
        ) INSERT INTO scope_derivation_sources(workspace_id,derivation_id,source_kind,source_id,source_version)
          SELECT workspace_id,id,'session_message',md5('fictional-unrelated-source:'||edge)::uuid,'1'
          FROM roots CROSS JOIN generate_series(1,64) edge`, [workspaceId, ownerId, assistantId])
      })
      await bulk.query('COMMIT')
    } catch (error) {
      await bulk.query('ROLLBACK')
      throw error
    } finally {
      bulk.release()
    }
    const density = (await f.pool.query(`SELECT count(*)::int AS edges,count(*) FILTER(WHERE source_kind='memory')::int AS memory_edges
      FROM scope_derivation_sources WHERE workspace_id=$1`, [workspaceId])).rows[0]
    expect(density).toEqual({ edges: 65925, memory_edges: 5 })
  }
  return fact.id
}

it.each(['sparse', 'dense'] as const)('finishes two context-aware turns within five seconds each with %s history', async history => {
  const f = await persistentContextFixture('internal')
  try {
    const { workspaceId, assistantId, ownerId } = f
    await f.pool.query("UPDATE workspaces SET plan='pro', department_read_v2=true WHERE id=$1", [workspaceId])
    const factId = await seedMemory(f, history === 'dense')
    await createDbCapabilityStore().grant({ assistantId, capability: 'files', grantedByUserId: ownerId })
    await createDbWorkspaceFilesStore().create(ownerId, { workspaceId, path: '/' + reference,
      parentPath: '/', name: reference, mime: 'text/plain', sizeBytes: 10, storageUri: 'fixture://' + reference,
      summary: 'Fictional release reference', createdByUserId: ownerId, sensitivity: 'internal' })
    const { session, token, deviceId } = await openSession(f)
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
      expect(providerInputs).toHaveLength(turn === 0 ? 2 : 1)
      expect(providerInputs[0]).toContain(colorFact)
      expect(providerInputs[0]).toContain(reference)
      if (turn === 0) {
        expect(providerInputs[0]).toContain(attachment.id)
        expect(providerInputs[1]).toContain(attachmentText)
      }
      if (turn > 0) expect(providerInputs[0]).toContain(replies[turn - 1])
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
