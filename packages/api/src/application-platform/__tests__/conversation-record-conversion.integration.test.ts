/** [COMP:api/conversation-record-conversion] Native bounded exact-copy receiving proof. */
import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import * as jitter from '@use-brian/core/scheduling/jitter.js'
import pg from 'pg'
import { persistentContextFixture } from './fixtures/persistent-context.js'
import { addSessionMessage, createWorkspaceChatSession } from '../../db/sessions.js'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { captureNativeConversationRecord } from '../../db/conversation-record.js'
import { readNativeConversationHistory } from '../../db/chat-presentation.js'
import { readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { writeSessionContextRevision } from '../../db/session-context-revisions.js'
import { startConversationRecordConversionWorker } from '../../workers/conversation-record-conversion.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
let example: Awaited<ReturnType<typeof persistentContextFixture>>

beforeAll(async () => { example = await persistentContextFixture('internal') })
afterAll(async () => {
  await example?.cleanup()
  await Promise.all([pool.end(), getAppPool().end()])
})

async function drain(byteLimit = 4194304) {
  const enrolled = await pool.query<{ count: number }>('SELECT public.enroll_existing_conversation_records(32) AS count')
  expect(enrolled.rows[0]!.count).toBeLessThanOrEqual(32)
  for (let i = 0; i < 64; i++) {
    const { value } = (await pool.query<{ value: {state: string; bytes?:number; units?:number} }>(
      'SELECT public.compile_conversation_record_page(16,$1) AS value', [byteLimit])).rows[0]!
    if (value.state === 'idle') return
    if (['cleanup', 'busy', 'superseded'].includes(value.state)) continue
    expect(value.state).toBe('committed')
    expect(value.bytes).toBeLessThanOrEqual(byteLimit)
  }
  throw new Error('Fixture conversion did not settle within the expected page budget')
}

const exact = async (sessionId: string, viewer: string, recipe: string, through: number | null = null, topic: number | null = null) =>
  (await pool.query(`SELECT public.read_compiled_conversation_payload(e,0,$2,$3,false,$4,$5) AS payload
    FROM public.conversation_envelopes e WHERE e.session_id=$1`, [sessionId,through,topic,viewer,recipe])).rows[0]?.payload

async function actor(userId: string) {
  const device = await authSessionStore.create(userId, { deviceLabel: 'Fictional conversion check', userAgent: null, ipAddress: null })
  if (!device) throw new Error('Failed to create test credential')
  return { userId, authVersion: device.authVersion, authSessionId: device.id }
}

describe('[COMP:api/conversation-record-conversion] compiled record candidates', () => {
  it('orders multiple bounded pages and resumes after an uncommitted page is lost', async () => {
    const room = example.session
    const owner = await actor(example.ownerId)
    let annotationParentId: string | undefined
    for (let index = 0; index < 40; index++) {
      const message = await addSessionMessage({ sessionId: room.id, role: index % 2 === 0 ? 'user' : 'assistant',
        content: [{ type: 'text', text: `Fictional ordered message ${index}` }], scope: example.envelope })
      if (index === 38) annotationParentId = message.id
    }
    if (!annotationParentId) throw new Error('Missing topic annotation parent')
    const authority = { execution: await example.execution(), accumulator: new ContextScopeAccumulator() }
    const input = await readAdmittedSessionQuery({ authority, sessionId: room.id, throughSequence: 40, topicThroughSequence: 38 })
    const annotation = await writeSessionContextRevision({ authority, sessionId: room.id, parentId: annotationParentId, kind: 'message_annotation',
      content: { topicLabel: 'Fictional exact compiled topic', topicConfidence: 0.9, replyToText: null },
      derivation: { producer: 'fixture:record-conversion', sources: boundScopeSources(input) } })
    expect(annotation).not.toBeNull()
    const selection = { workspaceId: example.workspaceId, sessionId: room.id, afterSequence: 0, throughSequence: 40, topicThroughSequence: 40 }
    const ordinaryModel = await captureNativeConversationRecord(owner, selection)
    expect(ordinaryModel.manifest.annotationCount).toBe(1)
    const ordinaryHistory = await readNativeConversationHistory(owner, room.id)
    expect(await exact(room.id,example.ownerId,'visual_rows_v1')).toBeNull()
    const lost = new pg.Client({ connectionString: process.env.DATABASE_URL })
    await lost.connect()
    await lost.query('BEGIN')
    await lost.query('SELECT public.compile_conversation_record_page(16,4194304)')
    await lost.end()
    expect(await exact(room.id,example.ownerId,'visual_rows_v1')).toBeNull()
    await drain()
    const copy = await exact(room.id,example.ownerId,'visual_rows_v1')
    expect(copy?.rows).toHaveLength(40)
    expect((await exact(room.id,example.ownerId,'dialogue_text_v1',40,40))?.manifest).toEqual(ordinaryModel.manifest)
    const rowSelector = 'public.conversation_record_rows(public.conversation_envelopes,integer,integer,boolean,uuid,boolean)'
    const original = (await pool.query<{ sql: string }>('SELECT pg_get_functiondef($1::regprocedure) AS sql', [rowSelector])).rows[0]!.sql
    const blocked = original.replace(/LANGUAGE sql([\s\S]*?)AS \$function\$[\s\S]*\$function\$/, 'LANGUAGE plpgsql$1AS $function$ BEGIN RAISE EXCEPTION \'ordinary_record_rows_read\'; END $function$')
    expect(blocked).not.toBe(original)
    await pool.query(blocked)
    try {
      // These are normal authenticated APIs. Barring the source reader proves
      // that either hot path would fail if it tried to reread original rows.
      expect(await captureNativeConversationRecord(owner, selection)).toEqual(ordinaryModel)
      expect(await readNativeConversationHistory(owner, room.id)).toEqual(ordinaryHistory)
      await expect(captureNativeConversationRecord(owner, { ...selection, topicThroughSequence: 38 })).rejects.toThrow('ordinary_record_rows_read')
    } finally {
      await pool.query(original)
    }
    const shorterTopic = { ...selection, topicThroughSequence: 38 }
    const ordinaryShorter = await captureNativeConversationRecord(owner, shorterTopic)
    expect(ordinaryShorter.manifest.annotationCount).toBe(0)
    await drain()
    expect((await exact(room.id,example.ownerId,'dialogue_text_v1',40,38))?.manifest).toEqual(ordinaryShorter.manifest)
    await expect(queryWithRLS(example.ownerId,`SELECT public.read_compiled_conversation_payload(e,0,NULL,NULL,false,$2,'visual_rows_v1')
       FROM public.conversation_envelopes e WHERE e.session_id=$1`,[room.id,example.ownerId])).rejects.toMatchObject({code:'42501'})
    await pool.query('UPDATE public.session_messages SET scope_held=true WHERE session_id=$1 AND sequence_num=2',[room.id])
    expect(await exact(room.id,example.ownerId,'visual_rows_v1')).toBeNull()
    await drain()
    expect((await exact(room.id,example.ownerId,'visual_rows_v1'))?.rows).toHaveLength(39)
  })

  it('matches the model manifest only for the current requested viewer variant and exact bounds', async () => {
    const room = await createWorkspaceChatSession({ assistantId: example.assistantId, starterUserId: example.ownerId,
      workspaceId: example.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
    await addSessionMessage({ sessionId: room.id, role:'assistant', content:[{type:'text',text:'Fictional model selection'}], scope:example.envelope })
    await drain()
    const compiled = await exact(room.id,example.firstId,'dialogue_text_v1',1,1)
    const current = (await pool.query(`SELECT public.project_conversation_record(e,0,1,1,false,$2) AS payload
      FROM public.conversation_envelopes e WHERE e.session_id=$1`,[room.id,example.firstId])).rows[0]!.payload
    expect(compiled).toEqual(current)
    expect(await exact(room.id,example.firstId,'dialogue_text_v1',1,0)).toBeNull()
    expect(await exact(room.id,randomUUID(),'unknown',1,1)).toBeNull()
    const pageIdentity = async () => (await pool.query(`SELECT coalesce(jsonb_agg(jsonb_build_array(xmin::text,original_digest)
      ORDER BY record_after),'[]') AS prefix FROM public.native_conversation_conversion_inputs
      WHERE record_session_id=$1 AND record_recipe='visual_rows_v1' AND record_through=1`, [room.id])).rows[0]!.prefix
    const initialPage = await pageIdentity()
    expect(initialPage).toHaveLength(1)
    await addSessionMessage({ sessionId: room.id, role:'user', content:[{type:'text',text:'Fictional appended input'}], scope:example.envelope })
    expect(await exact(room.id,example.firstId,'dialogue_text_v1',1,1)).toBeNull()
    await drain()
    expect(await pageIdentity()).toEqual(initialPage)
    expect((await exact(room.id,example.firstId,'dialogue_text_v1',2,2))?.rows).toHaveLength(2)
  })

  it('compiles sparse high sequences and preserves ordinary reads when an actual row exceeds the page budget', async () => {
    const createRoom = () => createWorkspaceChatSession({ assistantId: example.assistantId, starterUserId: example.ownerId,
      workspaceId: example.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
    const sparse = await createRoom()
    const message = await addSessionMessage({ sessionId: sparse.id, role: 'assistant',
      content: [{ type: 'text', text: 'Fictional retained high-sequence message' }], scope: example.envelope })
    await pool.query('UPDATE public.session_messages SET sequence_num=9000 WHERE id=$1', [message.id])
    await drain()
    expect((await exact(sparse.id,example.ownerId,'visual_rows_v1'))?.rows.map((row: { sequence_num: number }) => row.sequence_num)).toEqual([9000])
    expect((await exact(sparse.id,example.ownerId,'dialogue_text_v1',9000,9000))?.rows).toHaveLength(1)

    const large = await createRoom()
    const payload = Array.from({ length: 100 }, () => randomUUID()).join(' ')
    const owner = await actor(example.ownerId)
    await addSessionMessage({ sessionId: large.id, role: 'assistant', content: [{ type: 'text', text: payload }], scope: example.envelope })
    const selection = { workspaceId: example.workspaceId, sessionId: large.id, afterSequence: 0, throughSequence: 1, topicThroughSequence: 1 }
    const ordinary = await captureNativeConversationRecord(owner, selection)
    await drain(1024)
    expect(await exact(large.id,example.ownerId,'visual_rows_v1')).toBeNull()
    expect(await exact(large.id,example.ownerId,'dialogue_text_v1',1,1)).toBeNull()
    expect(await captureNativeConversationRecord(owner, selection)).toEqual(ordinary)
    expect((await readNativeConversationHistory(owner, large.id)).at(-1)?.content).toEqual([{ type: 'text', text: payload }])
    const receipt = await pool.query(`SELECT count(*)::integer AS pages FROM public.native_conversation_conversion_pages
      WHERE after_cursor->>'disposition'='source_row_oversized'`)
    expect(receipt.rows[0]!.pages).toBeGreaterThan(0)
    expect((await pool.query('SELECT public.compile_conversation_record_page(16,1024) AS value')).rows[0]!.value.state).toBe('idle')
  })

  it('runs an enrolled page in the real worker and resumes an appended suffix after restart', async () => {
    const room = await createWorkspaceChatSession({ assistantId: example.assistantId, starterUserId: example.ownerId,
      workspaceId: example.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
    const append = (text: string) => addSessionMessage({ sessionId: room.id, role: 'assistant',
      content: [{ type: 'text', text }], scope: example.envelope })
    await append('Fictional worker startup')
    for (const expectedRows of [1, 2]) {
      const worker = await startConversationRecordConversionWorker()
      if (!worker) throw new Error('Installed conversion worker did not start')
      try {
        await expect.poll(async () => (await exact(room.id, example.ownerId, 'visual_rows_v1'))?.rows?.length,
          { timeout: 7500, interval: 100 }).toBe(expectedRows)
      } finally {
        await worker.stop()
      }
      if (expectedRows === 1) await append('Fictional appended suffix after the worker stopped')
    }
  }, 20_000)

  it('compiles ready records while a locked envelope backs off and later advances its committed cursor', async () => {
    await drain()
    const createRoom = () => createWorkspaceChatSession({ assistantId: example.assistantId, starterUserId: example.ownerId,
      workspaceId: example.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
    const blocked = await createRoom(), ready = await createRoom()
    await pool.query('DELETE FROM public.conversation_envelopes WHERE session_id=$1', [blocked.id])
    await addSessionMessage({ sessionId: ready.id, role: 'assistant', scope: example.envelope,
      content: [{ type: 'text', text: 'Fictional ready record during backfill contention' }] })
    const saved = (await pool.query<{ after_session_id: string | null; complete: boolean }>(
      'SELECT after_session_id,complete FROM public.conversation_envelope_backfill_checkpoint')).rows[0]!
    const cursor = (await pool.query<{ cursor: string | null }>(
      'SELECT id AS cursor FROM public.sessions WHERE id<$1 ORDER BY id DESC LIMIT 1', [blocked.id])).rows[0]?.cursor ?? null
    await pool.query('UPDATE public.conversation_envelope_backfill_checkpoint SET after_session_id=$1,complete=false', [cursor])
    const locker = await pool.connect()
    const attempts: number[] = []
    let enrollments = 0
    let now = 0
    const scheduled: { tick?: () => void | Promise<void> } = {}
    // Drive the existing scheduler callback with a controlled clock while
    // keeping the real transaction deadline, row locks and worker queries.
    const clock = vi.spyOn(performance, 'now').mockImplementation(() => now)
    const scheduler = vi.spyOn(jitter, 'startJitteredInterval').mockImplementation(callback => {
      scheduled.tick = callback
      return { _initialTimeout: null, _interval: null, _stopped: false, _ticking: false }
    })
    const query = pg.Client.prototype.query
    const observer = vi.spyOn(pg.Client.prototype, 'query').mockImplementation(function (this: pg.Client, ...args: unknown[]) {
      const [statement, binds] = args
      if (typeof statement === 'string' && Array.isArray(binds)) {
        if (statement.startsWith('SELECT public.advance_conversation_envelope_backfill($1)')) attempts.push(Number(binds[0]))
        if (statement === 'SELECT public.enroll_existing_conversation_records($1)') enrollments++
      }
      return Reflect.apply(query, this, args)
    } as typeof query)
    let worker: Awaited<ReturnType<typeof startConversationRecordConversionWorker>> = null
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT id FROM public.sessions WHERE id=$1 FOR UPDATE', [blocked.id])
      worker = await startConversationRecordConversionWorker()
      expect(worker).not.toBeNull()
      const tick = scheduled.tick
      if (!tick) throw new Error('Conversion worker did not schedule its callback')
      await tick()
      expect((await exact(ready.id, example.ownerId, 'visual_rows_v1'))?.rows).toHaveLength(1)
      for (let n = 0; n < 5; n++) {
        now += 2000
        await tick()
      }
      expect(attempts).toEqual([32, 16, 8, 4, 2, 1])
      const duringCooldown = enrollments
      for (let n = 0; n < 2; n++) {
        now += 2000
        await tick()
      }
      expect(enrollments).toBe(duringCooldown + 2)
      expect(attempts).toEqual([32, 16, 8, 4, 2, 1])
      expect((await pool.query('SELECT after_session_id FROM public.conversation_envelope_backfill_checkpoint')).rows[0]!.after_session_id).toBe(cursor)
      await locker.query('COMMIT')
      now += 60_000
      await tick()
      expect((await pool.query('SELECT 1 FROM public.conversation_envelopes WHERE session_id=$1', [blocked.id])).rowCount).toBe(1)
    } finally {
      await locker.query('ROLLBACK').catch(() => {})
      locker.release()
      await worker?.stop()
      observer.mockRestore()
      scheduler.mockRestore()
      clock.mockRestore()
      await pool.query('UPDATE public.conversation_envelope_backfill_checkpoint SET after_session_id=$1,complete=$2',
        [saved.after_session_id, saved.complete])
    }
  })
})
