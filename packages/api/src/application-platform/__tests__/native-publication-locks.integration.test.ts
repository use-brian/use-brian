/** Native publication lock ordering on ordinary owner and app roles. [COMP:api/native-turn-frame] */
import { afterAll, describe, expect, it } from 'vitest'
import { ContextScopeAccumulator } from '@use-brian/agent-runtime/security/context-scope.js'
import { boundScopeSource, boundScopeSources } from '@use-brian/agent-runtime/security/source-evidence.js'
import type { ScopeSource } from '@use-brian/agent-runtime/security/derived-scope.js'
import type { LLMProvider } from '@use-brian/agent-runtime/providers/types.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { getAppPool, getPool, rollbackAndRelease } from '../../db/client.js'
import { publishNativeSessionMessageBatch, readAdmittedSessionQuery } from '../../db/conversation-store.js'
import { withSessionMessagePublication } from '../../db/session-context-revisions.js'
import { addSessionMessage, claimTurnLeaseOutcome, createWorkspaceChatSession, findOrCreateSession, releaseTurnOutcome, type Session } from '../../db/sessions.js'
import { pinVerifiedChannelPublication, readVerifiedChannelEnvelope } from '../../db/verified-channel-record.js'
import { prepareAttendedRecordTitle } from '../../routes/attended-session-title.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'
import type { PoolClient } from 'pg'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

function gate() {
  let open!: () => void
  const ready = new Promise<void>(resolve => { open = resolve })
  return { ready, open }
}

type Fixture = Awaited<ReturnType<typeof persistentContextFixture>>

async function turn(f: Fixture, session: Session, actor: Fixture['firstId'], text: string) {
  const input = await addSessionMessage({ sessionId: session.id, role: 'user', senderUserId: actor,
    content: [{ type: 'text', text }], scope: f.envelope })
  const createAuthority = async () => ({ execution: await f.execution(actor, session), accumulator: new ContextScopeAccumulator() })
  const authority = await createAuthority()
  const read = async () => readAdmittedSessionQuery({ sessionId: session.id, throughSequence: input.sequenceNum,
    authority: await createAuthority() })
  const query = await read()
  const sources = [...boundScopeSources(query)]
  const publish = (reply: string, hold?: (client: PoolClient) => Promise<void>,
    { turnToken, foreignSource }: { turnToken?: string; foreignSource?: ScopeSource } = {}) => {
    const publishedSources = foreignSource ? [...sources, foreignSource] : sources
    return withSessionMessagePublication(authority, publishedSources, async client => {
      const saved = await publishNativeSessionMessageBatch({ sessionId: session.id, authority, derivationTarget: f.envelope,
        derivation: { producer: 'fixture:publication-locks', sources: publishedSources },
        messages: [{ role: 'assistant', content: [{ type: 'text', text: reply }] }] }, client)
      await hold?.(client)
      return saved
    }, { turnToken })
  }
  return { authority, input, read, publish }
}

async function blockedBy(f: Fixture, pid: number) {
  const { rows } = await f.pool.query<{ blocked: number }>(`SELECT count(*)::int AS blocked
    FROM pg_catalog.pg_stat_activity a WHERE a.datname=current_database() AND $1=ANY(pg_blocking_pids(a.pid))`, [pid])
  return rows[0].blocked
}

describe.sequential('[COMP:api/native-turn-frame] workspace publication lock compatibility', () => {
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it('admits another session read while retaining same-session isolation and publication ordering', async () => {
    const f = await persistentContextFixture('internal')
    const written = gate(), release = gate()
    const pending: Promise<unknown>[] = []
    let firstPid = 0
    try {
      const other = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.secondId,
        workspaceId: f.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
      const first = await turn(f, f.session, f.firstId, 'Fictional first input')
      const second = await turn(f, other, f.secondId, 'Fictional independent input')
      const firstReply = first.publish('Fictional first reply', async client => {
        firstPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        written.open()
        await release.ready
      }, { foreignSource: boundScopeSource(second.input)! })
      pending.push(firstReply)
      await Promise.race([written.ready, firstReply])
      expect(firstPid).toBeGreaterThan(0)

      const secondHistory = second.read()
      pending.push(secondHistory)
      await expect(secondHistory).resolves.toMatchObject({ history: [{ id: second.input.id }] })

      const sameHistory = first.read()
      pending.push(sameHistory)
      await expect.poll(() => blockedBy(f, firstPid), { timeout: 3000 }).toBe(1)

      const secondReply = second.publish('Fictional independently owned reply', undefined,
        { foreignSource: boundScopeSource(first.input)! })
      pending.push(secondReply)
      await expect.poll(() => blockedBy(f, firstPid), { timeout: 3000 }).toBe(2)
      release.open()
      await expect(firstReply).resolves.toHaveLength(1)
      await expect(sameHistory).resolves.toMatchObject({ history: [{ id: first.input.id }] })
      await expect(secondReply).resolves.toHaveLength(1)
      const { rows } = await f.pool.query(`SELECT session_id,count(*)::int AS assistant_count FROM session_messages
        WHERE session_id=ANY($1::uuid[]) AND role='assistant' GROUP BY session_id`, [[f.session.id, other.id]])
      expect(rows).toEqual(expect.arrayContaining([
        { session_id: f.session.id, assistant_count: 1 }, { session_id: other.id, assistant_count: 1 },
      ]))
    } finally {
      release.open()
      await Promise.allSettled(pending)
      await f.cleanup()
    }
  }, 30_000)

  it('blocks an actual grant downgrade until publication settles and then refuses the old authority', async () => {
    const f = await persistentContextFixture('internal')
    const written = gate(), release = gate()
    const pending: Promise<unknown>[] = []
    let publishPid = 0
    try {
      const lane = await turn(f, f.session, f.firstId, 'Fictional input before a clearance change')
      const reply = lane.publish('Fictional reply authorized before the change', async client => {
        publishPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        written.open()
        await release.ready
      })
      pending.push(reply)
      await Promise.race([written.ready, reply])
      const downgrade = f.pool.query("UPDATE assistants SET clearance='public' WHERE id=$1 RETURNING clearance", [f.assistantId])
      pending.push(downgrade)
      await expect.poll(() => blockedBy(f, publishPid), { timeout: 3000 }).toBe(1)
      release.open()
      await expect(reply).resolves.toHaveLength(1)
      await expect(downgrade).resolves.toMatchObject({ rows: [{ clearance: 'public' }] })
      await expect(lane.authority.execution.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
      await expect(lane.publish('Fictional stale publication')).rejects.toMatchObject({ reason: 'authority_changed' })
      const { rows } = await f.pool.query("SELECT count(*)::int AS assistant_count FROM session_messages WHERE session_id=$1 AND role='assistant'", [f.session.id])
      expect(rows).toEqual([{ assistant_count: 1 }])
    } finally {
      release.open()
      await Promise.allSettled(pending)
      await f.cleanup()
    }
  }, 30_000)

  it('claims and releases an independent turn while fencing the publishing session by its original token', async () => {
    const f = await persistentContextFixture('internal')
    const written = gate(), release = gate()
    const pending: Promise<unknown>[] = []
    let publishPid = 0
    try {
      const other = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.secondId,
        workspaceId: f.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
      const lane = await turn(f, f.session, f.firstId, 'Fictional leased publication input')
      const first = (await claimTurnLeaseOutcome(f.session.id, f.assistantId))!
      const reply = lane.publish('Fictional leased reply', async client => {
        publishPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        written.open()
        await release.ready
      }, { turnToken: first.token })
      pending.push(reply)
      await Promise.race([written.ready, reply])

      const second = (await claimTurnLeaseOutcome(other.id, f.assistantId))!
      expect(second.token).not.toBe(first.token)
      await expect(releaseTurnOutcome(other.id, 'completed', second.token))
        .resolves.toEqual({ turnId: second.turnId, reason: 'completed' })

      const staleRelease = releaseTurnOutcome(f.session.id, 'completed', second.token)
      pending.push(staleRelease)
      await expect.poll(() => blockedBy(f, publishPid), { timeout: 3000 }).toBe(1)
      release.open()
      await expect(reply).resolves.toHaveLength(1)
      await expect(staleRelease).resolves.toBeNull()
      await expect(claimTurnLeaseOutcome(f.session.id, f.assistantId)).resolves.toBeNull()
      await expect(releaseTurnOutcome(f.session.id, 'completed', first.token))
        .resolves.toEqual({ turnId: first.turnId, reason: 'completed' })
    } finally {
      release.open()
      await Promise.allSettled(pending)
      await f.cleanup()
    }
  }, 30_000)

  it('orders native title publication before taking the title session row', async () => {
    const f = await persistentContextFixture('internal')
    const written = gate(), release = gate()
    const pending: Promise<unknown>[] = []
    let publishPid = 0
    try {
      const other = await createWorkspaceChatSession({ assistantId: f.assistantId, starterUserId: f.secondId,
        workspaceId: f.workspaceId, effectiveClearance: 'internal', authenticatedHuman: true })
      await addSessionMessage({ sessionId: other.id, role: 'user', senderUserId: f.secondId,
        content: [{ type: 'text', text: 'Title this fictional research conversation' }], scope: f.envelope })
      const device = (await authSessionStore.create(f.secondId,
        { deviceLabel: 'Fictional title test browser', userAgent: null, ipAddress: null }))!
      const titleAuthority = { execution: await f.execution(f.secondId, other), accumulator: new ContextScopeAccumulator() }
      const title = await prepareAttendedRecordTitle(titleAuthority,
        { userId: f.secondId, sessionId: device.id, authVersion: device.authVersion })
      const expectedTitle = 'Fictional research conversation'
      const provider: LLMProvider = { name: 'fictional-title', models: ['fixture'],
        createSession() { throw new Error('Expected one stateless title request') },
        async *stream() {
          yield { type: 'message_start', model: 'fixture' }
          yield { type: 'text_delta', text: expectedTitle }
          yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 6, outputTokens: 4 } }
        },
      }
      const lane = await turn(f, f.session, f.firstId, 'Fictional input before title publication')
      const reply = lane.publish('Fictional reply while another title waits', async client => {
        publishPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        written.open()
        await release.ready
      })
      pending.push(reply)
      await Promise.race([written.ready, reply])
      const titleResult = title.generate(provider, 'fixture')
      pending.push(titleResult)
      await expect.poll(() => blockedBy(f, publishPid), { timeout: 3000 }).toBe(1)

      // A publisher may need this foreign session as a source. The queued title
      // writer must hold neither the session row nor its conflicting write lock.
      await expect(f.pool.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE NOWAIT', [other.id]))
        .resolves.toMatchObject({ rows: [{ id: other.id }] })
      release.open()
      await expect(reply).resolves.toHaveLength(1)
      await expect(titleResult).resolves.toMatchObject({ title: expectedTitle, written: true })
      await expect(f.pool.query('SELECT scope_revision_id FROM session_title_heads WHERE session_id=$1', [other.id]))
        .resolves.toMatchObject({ rows: [{ scope_revision_id: expect.any(String) }] })
    } finally {
      release.open()
      await Promise.allSettled(pending)
      await f.cleanup()
    }
  }, 30_000)

  it('queues a verified authored append before locking its integration and destination', async () => {
    const f = await persistentContextFixture('internal')
    const written = gate(), release = gate()
    const pending: Promise<unknown>[] = []
    const ingress = await f.pool.connect()
    let publishPid = 0
    try {
      const channelId = crypto.randomUUID(), integrationId = crypto.randomUUID()
      await f.pool.query("INSERT INTO channels(id,workspace_id,channel_type,display_name) VALUES($1,$2,'telegram','Fictional append channel')",
        [channelId, f.workspaceId])
      await f.pool.query("INSERT INTO channel_integrations(id,channel_id,channel_type,credentials) VALUES($1,$2,'telegram',$3)",
        [integrationId, channelId, Buffer.from('fixture-no-secret')])
      await f.pool.query('INSERT INTO channel_assistants(channel_id,assistant_id) VALUES($1,$2)', [channelId, f.assistantId])
      const session = await findOrCreateSession({ assistantId: f.assistantId, userId: f.secondId,
        channelType: 'telegram', channelId: '15550008334' })
      const lease = (await claimTurnLeaseOutcome(session.id, f.assistantId))!
      const address = { session, workspaceId: f.workspaceId, assistantId: f.assistantId, userId: f.secondId,
        member: true, room: false, integrationId }
      const floor = (await readVerifiedChannelEnvelope(address))!
      const lane = await turn(f, f.session, f.firstId, 'Fictional input before verified append')
      const reply = lane.publish('Fictional reply while verified append waits', async client => {
        publishPid = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0].pid
        written.open()
        await release.ready
      })
      pending.push(reply)
      await Promise.race([written.ready, reply])

      await ingress.query('BEGIN')
      const pinned = pinVerifiedChannelPublication(ingress, { address, version: floor.version }, lease.token)
      pending.push(pinned)
      await expect.poll(() => blockedBy(f, publishPid), { timeout: 3000 }).toBe(1)
      await expect(f.pool.query('SELECT id FROM channels WHERE id=$1 FOR UPDATE NOWAIT', [channelId]))
        .resolves.toMatchObject({ rows: [{ id: channelId }] })
      await expect(f.pool.query('SELECT id FROM sessions WHERE id=$1 FOR UPDATE NOWAIT', [session.id]))
        .resolves.toMatchObject({ rows: [{ id: session.id }] })

      release.open()
      await expect(reply).resolves.toHaveLength(1)
      await expect(pinned).resolves.toEqual(floor)
      const stored = await addSessionMessage({ sessionId: session.id, role: 'user', senderUserId: f.secondId,
        content: [{ type: 'text', text: 'Fictional verified input' }], scope: { ...f.envelope, userId: f.secondId,
          sensitivity: floor.cap, compartments: floor.compartments, projectIds: floor.projects } }, ingress)
      await ingress.query('COMMIT')
      await expect(f.pool.query('SELECT id FROM session_messages WHERE session_id=$1', [session.id]))
        .resolves.toMatchObject({ rows: [{ id: stored.id }] })
    } finally {
      release.open()
      await Promise.allSettled(pending)
      await rollbackAndRelease(ingress)
      await f.cleanup()
    }
  }, 30_000)

  it('refuses revoked or absent session authority and owner-role calls at the lock boundary', async () => {
    const f = await persistentContextFixture('internal')
    const client = await getAppPool().connect()
    const revoker = await f.pool.connect()
    const lock = 'SELECT lock_native_session_context_publication($1,$2) AS scope'
    let revokedPublication: Promise<unknown> | undefined
    try {
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true)", [f.firstId])
      await expect(client.query(lock, [f.workspaceId, f.session.id])).resolves.toMatchObject({ rows: [{ scope: { workspaceId: f.workspaceId } }] })
      await client.query('ROLLBACK')

      await revoker.query('BEGIN')
      const { rows: [owner] } = await revoker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')
      await revoker.query('SELECT id FROM workspaces WHERE id=$1 FOR UPDATE', [f.workspaceId])
      await revoker.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.firstId])
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true)", [f.firstId])
      revokedPublication = client.query(lock, [f.workspaceId, f.session.id])
      const refusal = expect(revokedPublication).rejects.toMatchObject({ code: '42501', message: 'scope_operation_denied' })
      await expect.poll(() => blockedBy(f, owner.pid), { timeout: 3000 }).toBe(1)
      await revoker.query('COMMIT')
      await refusal
      await client.query('ROLLBACK')

      for (const actor of [f.firstId, f.secondId]) {
        await client.query('BEGIN')
        await client.query("SELECT set_config('app.current_user_id',$1,true)", [actor])
        await expect(client.query(lock, [f.workspaceId, actor === f.firstId ? f.session.id : crypto.randomUUID()]))
          .rejects.toMatchObject({ code: '42501', message: 'scope_operation_denied' })
        await client.query('ROLLBACK')
      }
      await expect(f.pool.query(lock, [f.workspaceId, f.session.id])).rejects.toMatchObject({ code: '42501', message: 'scope_operation_denied' })
    } finally {
      await rollbackAndRelease(revoker)
      await revokedPublication?.catch(() => undefined)
      await rollbackAndRelease(client)
      await f.cleanup()
    }
  }, 30_000)

  it('authenticates the installed writer order and refuses a changed room writer on portable restore', async () => {
    const { currentReleaseSource } = await import(new URL('../../../scripts/conversation-store/installation-release.mjs', import.meta.url).href)
    const client = await getPool().connect()
    try {
      const head = (await client.query('SELECT name FROM public._migrations ORDER BY name COLLATE "C" DESC LIMIT 1')).rows[0].name
      const profile = await currentReleaseSource(head)
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      const result = await client.query(profile.sql)
      expect((Array.isArray(result) ? result.at(-1) : result)?.rows[0])
        .toMatchObject({ functions: profile.functions, witness_current: true })
      await client.query(profile.cleanup)
      // The verifier also uses ON COMMIT DROP scratch tables.
      await client.query('COMMIT')
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      const signature = 'public.lock_shared_room_resume_evidence(uuid,uuid,uuid,uuid,text,uuid,uuid,jsonb,boolean)'
      const definition: string = (await client.query('SELECT pg_get_functiondef($1::regprocedure) AS definition', [signature])).rows[0].definition
      const altered = definition.replace('native-session-publication:', 'fixture-independent-lock:')
      expect(altered).not.toBe(definition)
      await client.query(altered)
      await expect(client.query(profile.sql)).rejects.toThrow('installation_shared_room_resume_evidence_changed')
    } finally { await rollbackAndRelease(client) }
  }, 45_000)
})
