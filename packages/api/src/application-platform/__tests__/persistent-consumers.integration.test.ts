import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { boundScopeSources, executionToolContext, type ScopeSource } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { addSessionMessage, getSessionMessages, toStampedMessages } from '../../db/sessions.js'
import { createDbSessionStateStore } from '../../db/session-state-store.js'
import { createDbEpisodicStore } from '../../db/episodic-store.js'
import { writeSessionContextRevision, sessionContextGeneration, bindSessionContextRetainedAuthority } from '../../db/session-context-revisions.js'
import { assertSourceModelInputAuthority } from '../model-source-authority.js'
import { persistentContextFixture } from './fixtures/persistent-context.js'
import { persistentSourceFixture } from './fixtures/persistent-source.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe.sequential('[COMP:api/application-persistence] actual transcript persistence and replay', () => {
  let fixture: Awaited<ReturnType<typeof persistentContextFixture>> | undefined
  let independent: Awaited<ReturnType<typeof persistentSourceFixture>> | undefined
  afterEach(async () => { await independent?.cleanup(); independent = undefined; await fixture?.cleanup(); fixture = undefined })
  afterAll(async () => { await getAppPool().end(); await getPool().end() })

  it('holds uncertified historical commitments before actual store retrieval and key computation', async () => {
    fixture = await persistentContextFixture()
    const f = fixture
    // Owner setup represents pre-handoff historical plaintext, not a current
    // canonical writer. Ordinary readers must never adopt missing provenance.
    const historical = await f.pool.connect()
    try {
    await historical.query('BEGIN')
    await historical.query('ALTER TABLE session_state DISABLE TRIGGER session_context_state_pair')
    await historical.query(`INSERT INTO session_state(session_id,user_id,assistant_id,key,status,summary,source)
      VALUES($1,$2,$3,'Fictional protected commitment','open','Fictional historical content','tool')`,
    [f.session.id, f.ownerId, f.assistantId])
    await historical.query('ALTER TABLE session_state ENABLE TRIGGER session_context_state_pair')
    await historical.query('COMMIT')
    } finally { await historical.query('ROLLBACK'); historical.release() }
    const authority = await f.modelContext()
    const store = createDbSessionStateStore()
    expect(await store.listOpenBySession(f.session.id, authority)).toEqual([])
    expect(await store.listRecentBySession(f.session.id, 50, authority)).toEqual([])
  })

  it('holds uncertified episodic labels before topic enumeration, filtering and retrieval', async () => {
    fixture = await persistentContextFixture()
    const f = fixture
    const historical = await f.pool.connect()
    try {
    await historical.query('BEGIN')
    await historical.query('ALTER TABLE episodic_memories DISABLE TRIGGER session_context_episode_pair')
    await historical.query(`INSERT INTO episodic_memories(user_id,assistant_id,session_id,topic_label,summary,message_span)
      VALUES($1,$2,$3,'Fictional protected topic','Fictional historical episode',
        '{"fromSequence":0,"toSequence":0,"turnCount":1}'::jsonb)`,
    [f.ownerId, f.assistantId, f.session.id])
    await historical.query('ALTER TABLE episodic_memories ENABLE TRIGGER session_context_episode_pair')
    await historical.query('COMMIT')
    } finally { await historical.query('ROLLBACK'); historical.release() }
    const authority = await f.modelContext()
    const store = createDbEpisodicStore()
    expect(await store.listTopicsBySession({ sessionId: f.session.id, authority })).toEqual([])
    expect(await store.fetchByTopic({ sessionId: f.session.id, topicLabel: 'Fictional protected topic', authority })).toEqual([])
    expect(await store.fetchBySession({ sessionId: f.session.id, authority })).toEqual([])
    expect(await store.listBySession(f.session.id, authority)).toEqual([])
  })

  it('persists commitment revisions, preserves tool content ancestry and resolves through the actual adapter', async () => {
    fixture = await persistentContextFixture()
    const f=fixture, store=createDbSessionStateStore(), authority=await f.modelContext(), history=await f.history()
    const derivation={producer:'fixture:commitment',sources:history.flatMap(boundScopeSources)}
    const original=await store.upsert({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
      key:'Fictional follow-up',summary:'Fictional authoritative content',detail:'Fictional detail',source:'tool',authority,derivation})
    expect(boundScopeSources(original)).toMatchObject([{resourceKind:'session_context_revision',userId:null,assistantId:null}])
    expect(await store.listOpenBySession(f.session.id,await f.modelContext(f.secondId))).toMatchObject([{summary:'Fictional authoritative content'}])
    const next=await store.upsert({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
      key:'Fictional follow-up',summary:'Fictional inferred alternative',source:'diff-pass',authority,derivation})
    expect(next.id).toBe(original.id)
    expect(next.summary).toBe(original.summary)
    expect(next.source).toBe('diff-pass')
    const ordinaryDiff=await store.upsert({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
      key:'Fictional follow-up',summary:'Fictional later inference',source:'diff-pass',authority,derivation})
    expect(ordinaryDiff.summary).toBe('Fictional later inference')
    const resolved=await store.resolve({sessionId:f.session.id,key:'Fictional follow-up',source:'tool',authority,derivation})
    expect(resolved?.status).toBe('resolved')
    expect(await store.listOpenBySession(f.session.id,authority)).toEqual([])
    expect(await store.listRecentBySession(f.session.id,50,authority)).toMatchObject([{status:'resolved'}])
    const raw=(await f.pool.query('SELECT key,summary,detail,status,source FROM session_state WHERE id=$1',[original.id])).rows[0]
    expect(raw).toEqual({key:original.id,summary:'',detail:null,status:'open',source:'tool'})
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_context_scope_revisions WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(4)
    const edges=(await f.pool.query(`SELECT s.source_id FROM scope_derivation_sources s JOIN scope_derivations d ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id
      WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision' AND d.resource_id=$2`,[f.workspaceId,boundScopeSources(next)[0].resourceId])).rows
    expect(edges.map(row=>row.source_id)).toContain(boundScopeSources(original)[0].resourceId)
  })

  it('admits episodic payloads before topic matching and holds them after native source contraction', async () => {
    fixture=await persistentContextFixture()
    const f=fixture,store=createDbEpisodicStore(),authority=await f.modelContext(),history=await f.history()
    const episode=await store.create({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
      topicLabel:'Fictional admitted topic',summary:'Fictional admitted episode',messageSpan:{fromSequence:1,toSequence:3,turnCount:3},authority,
      derivation:{producer:'fixture:episode',sources:history.flatMap(boundScopeSources)}})
    expect(boundScopeSources(episode)).toMatchObject([{resourceKind:'session_context_revision'}])
    expect(await store.listTopicsBySession({sessionId:f.session.id,authority})).toEqual(['Fictional admitted topic'])
    const fetched=await store.fetchByTopic({sessionId:f.session.id,topicLabel:episode.topicLabel,authority})
    expect(fetched).toMatchObject([{accessCount:1}])
    expect(boundScopeSources(fetched[0])).toEqual(boundScopeSources(episode))
    const raw=(await f.pool.query('SELECT topic_label,summary,message_span,entity_refs FROM episodic_memories WHERE id=$1',[episode.id])).rows[0]
    expect(raw).toEqual({topic_label:'',summary:'',message_span:{},entity_refs:null})
    const original=(await f.pool.query('SELECT id,payload_sha256 FROM session_context_scope_revisions WHERE workspace_id=$1',[f.workspaceId])).rows
    await f.pool.query("UPDATE sessions SET effective_clearance='confidential' WHERE id=$1",[f.session.id])
    expect(await store.listTopicsBySession({sessionId:f.session.id,authority:await f.modelContext(f.firstId)})).toEqual([])
    expect(await store.listTopicsBySession({sessionId:f.session.id,authority:await f.modelContext(f.secondId)})).toEqual(['Fictional admitted topic'])
    expect((await f.pool.query('SELECT id,payload_sha256 FROM session_context_scope_revisions WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual(original)
  })

  it('purges protected bytes while retaining immutable observations and holding descendants', async () => {
    fixture=await persistentContextFixture()
    const f=fixture,store=createDbSessionStateStore(),authority=await f.modelContext(),history=await f.history()
    const derivation={producer:'fixture:purge',sources:history.flatMap(boundScopeSources)}
    const first=await store.upsert({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,key:'Fictional purge key',summary:'Fictional purge content',source:'tool',authority,derivation})
    await store.resolve({sessionId:f.session.id,key:first.key,source:'tool',authority,derivation})
    const before=(await f.pool.query('SELECT id,payload_sha256 FROM session_context_scope_revisions WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows
    expect(await store.purgeResolvedOlderThan(f.session.id,new Date(Date.now()+1000),authority)).toBe(1)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_context_revision_contents WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(0)
    expect((await f.pool.query('SELECT id,payload_sha256 FROM session_context_scope_revisions WHERE workspace_id=$1 ORDER BY id',[f.workspaceId])).rows).toEqual(before)
    expect((await f.pool.query("SELECT read_scope_source($1,'session_context_revision',id) AS source FROM session_context_scope_revisions WHERE workspace_id=$1",[f.workspaceId])).rows.every(row=>row.source.held===true)).toBe(true)
  })

  it('keeps an independently authorized reader after another reader loses the external source grant', async () => {
    fixture=await persistentContextFixture('confidential')
    const f=fixture;independent=await persistentSourceFixture(f)
    const store=createDbSessionStateStore(),authority=await f.modelContext()
    bindSessionContextRetainedAuthority(authority.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
    const row=await store.upsert({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,key:'Fictional independent key',summary:'Fictional independent content',
      source:'tool',authority,derivation:{producer:'fixture:independent-state',sources:[independent.root]}})
    expect(await store.listOpenBySession(f.session.id,authority)).toMatchObject([{id:row.id}])
    const original=(await f.pool.query('SELECT id,payload_sha256 FROM session_context_scope_revisions WHERE workspace_id=$1',[f.workspaceId])).rows
    await independent.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
    expect(await store.listOpenBySession(f.session.id,authority)).toEqual([])
    const other=await f.modelContext(f.secondId)
    bindSessionContextRetainedAuthority(other.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
    expect(await store.listOpenBySession(f.session.id,other)).toMatchObject([{id:row.id,summary:'Fictional independent content'}])
    expect((await f.pool.query('SELECT id,payload_sha256 FROM session_context_scope_revisions WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual(original)
  })

  it('publishes exactly one compaction pointer and no orphan revision when cursor claims race', async () => {
    fixture=await persistentContextFixture()
    const f=fixture,history=await f.history(),sources=history.flatMap(boundScopeSources)
    const authorities=await Promise.all([f.modelContext(),f.modelContext()])
    const claims=await Promise.all(authorities.map((authority,index)=>writeSessionContextRevision({sessionId:f.session.id,kind:'compact_summary',
      content:{summary:`Fictional concurrent summary ${index}`,boundarySequence:2},expectedCursor:null,authority,
      derivation:{producer:'fixture:compaction-cas',sources}})))
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_context_scope_revisions WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(1)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_context_revision_contents WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(1)
    const parent=(await f.pool.query('SELECT compact_summary,compact_scope_revision_id,compact_boundary_sequence,compaction_count FROM sessions WHERE id=$1',[f.session.id])).rows[0]
    expect(parent).toEqual({compact_summary:null,compact_scope_revision_id:claims.find(Boolean)!.id,compact_boundary_sequence:2,compaction_count:1})
  })

  it('refuses a stale commitment generation without publishing an extra key or receipt', async () => {
    fixture=await persistentContextFixture()
    const f=fixture,history=await f.history(),sources=history.flatMap(boundScopeSources),generation=await sessionContextGeneration(f.session.id)
    const authorities=await Promise.all([f.modelContext(),f.modelContext()]),now=Date.now()
    const claims=await Promise.all(authorities.map(authority=>writeSessionContextRevision({sessionId:f.session.id,kind:'session_state',
      expectedGeneration:generation,content:{key:'Fictional same key',summary:'Fictional current content',detail:null,status:'open',source:'tool',createdAt:now,updatedAt:now,resolvedAt:null},
      authority,derivation:{producer:'fixture:state-cas',sources}})))
    expect(claims.filter(Boolean)).toHaveLength(1)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_state WHERE session_id=$1',[f.session.id])).rows[0].n).toBe(1)
    expect((await f.pool.query("SELECT count(*)::int AS n FROM scope_derivations WHERE workspace_id=$1 AND resource_kind='session_context_revision'",[f.workspaceId])).rows[0].n).toBe(1)
  })

  it('rechecks native session authority at the actual model boundary before protected content is used', async () => {
    fixture=await persistentContextFixture()
    const f=fixture,history=await f.history(),authority=await f.modelContext(),store=createDbSessionStateStore()
    const row=await store.upsert({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,key:'Fictional model key',summary:'Fictional model content',source:'tool',authority,
      derivation:{producer:'fixture:model-recheck',sources:history.flatMap(boundScopeSources)}})
    const reader=await f.modelContext(f.firstId)
    reader.accumulator.note({sources:boundScopeSources(row)})
    const context={...executionToolContext(reader.execution,{appId:'fixture'}),scopeAccumulator:reader.accumulator}
    await expect(assertSourceModelInputAuthority(context)).resolves.toBeUndefined()
    await f.pool.query("UPDATE sessions SET effective_clearance='confidential' WHERE id=$1",[f.session.id])
    await expect(assertSourceModelInputAuthority(context)).rejects.toBeDefined()
  })

  it('rejects payload and lineage rewriting and plaintext reinsertion after certification', async () => {
    fixture=await persistentContextFixture()
    const f=fixture,history=await f.history(),authority=await f.modelContext(),store=createDbSessionStateStore()
    const row=await store.upsert({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,key:'Fictional immutable key',summary:'Fictional immutable content',source:'tool',authority,
      derivation:{producer:'fixture:immutable-state',sources:history.flatMap(boundScopeSources)}})
    const id=boundScopeSources(row)[0].resourceId
    const episode=await createDbEpisodicStore().create({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,topicLabel:'Fictional foreign pointer',summary:'Fictional episode',messageSpan:{fromSequence:1,toSequence:3,turnCount:3},authority,derivation:{producer:'fixture:pointer-binding',sources:history.flatMap(boundScopeSources)}})
    await expect(f.pool.query('UPDATE session_state SET scope_revision_id=$2 WHERE id=$1',[row.id,boundScopeSources(episode)[0].resourceId])).rejects.toThrow('scope_source_changed')
    await expect(f.pool.query("UPDATE session_context_revision_contents SET content=content||'{\"summary\":\"Fictional tamper\"}' WHERE revision_id=$1",[id])).rejects.toThrow('scope_evidence_immutable')
    await expect(f.pool.query("UPDATE session_state SET summary='Fictional duplicate plaintext' WHERE id=$1",[row.id])).rejects.toThrow('scope_source_changed')
    await expect(f.pool.query("DELETE FROM scope_derivation_sources WHERE derivation_id IN(SELECT id FROM scope_derivations WHERE workspace_id=$1 AND resource_kind='session_context_revision')",[f.workspaceId])).rejects.toThrow('scope_evidence_immutable')
    expect(await store.listOpenBySession(f.session.id,authority)).toMatchObject([{summary:'Fictional immutable content'}])
  })

  it('preserves shared nullable axes across persisted message reads and formatting', async () => {
    fixture = await persistentContextFixture()
    const rows = await fixture.history()
    expect(rows).toHaveLength(3)
    for (const [index, message] of toStampedMessages(rows, 'UTC').entries()) {
      expect(boundScopeSources(message)).toEqual(boundScopeSources(rows[index]))
      expect(boundScopeSources(message)).toMatchObject([{
        workspaceId: fixture.workspaceId, userId: null, assistantId: null,
        resourceKind: 'session_message', resourceId: rows[index].id, sensitivity: 'internal',
      }])
    }
  })

  it('keeps every source edge through tool-result JSON flush and transitive replay holding', async () => {
    fixture = await persistentContextFixture('confidential')
    const f = fixture, first = await f.memory('Fictional first source'), second = await f.memory('Fictional second source', null, 'confidential')
    const sources = (await f.pool.query<{ source: ScopeSource }>(
      "SELECT read_scope_source($1,'memory',roots.id) AS source FROM unnest($2::uuid[]) AS roots(id)", [f.workspaceId, [first.id, second.id]],
    )).rows.map(row => row.source)
    const tool = await addSessionMessage({ sessionId: f.session.id, role: 'user',
      content: [{ type: 'tool_result', toolUseId: 'fixture-read', name: 'getMemory', content: 'Fictional mixed-source result' }],
      derivation: { producer: 'fixture:tool-flush', sources } })
    const answer = await addSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional derived answer',
      derivation: { producer: 'fixture:answer-flush', sources: boundScopeSources(tool) } })
    const edges = async () => (await f.pool.query(`SELECT d.resource_id,s.source_kind,s.source_id,s.source_version
      FROM scope_derivations d JOIN scope_derivation_sources s ON s.derivation_id=d.id AND s.workspace_id=d.workspace_id
      WHERE d.workspace_id=$1 AND d.resource_id=ANY($2::uuid[]) ORDER BY d.resource_id,s.source_id`,
    [f.workspaceId, [tool.id, answer.id]])).rows
    const before = await edges()
    expect(before.filter(row => row.resource_id === tool.id).map(row => row.source_id).sort()).toEqual([first.id, second.id].sort())
    expect(before.filter(row => row.resource_id === answer.id).map(row => row.source_id)).toEqual([tool.id])
    const replay = await getSessionMessages(f.session.id, { excludeHeld: true })
    expect(replay).toHaveLength(2)
    expect(replay.flatMap(boundScopeSources).every(source => source.sensitivity === 'confidential')).toBe(true)
    await f.pool.query("UPDATE memories SET summary='Fictional source changed' WHERE id=$1", [second.id])
    expect(await getSessionMessages(f.session.id, { excludeHeld: true })).toEqual([])
    expect(await edges()).toEqual(before)
  })

  it('retains the native historical-deletion allowance without lowering its labels', async () => {
    fixture = await persistentContextFixture('confidential')
    const f = fixture, memory = await f.memory('Fictional native content', null, 'confidential')
    const source = (await f.pool.query<{ source: ScopeSource }>("SELECT read_scope_source($1,'memory',$2) AS source", [f.workspaceId, memory.id])).rows[0].source
    await f.pool.query('DELETE FROM memories WHERE id=$1', [memory.id])
    const row = await addSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional native historical reply',
      derivation: { producer: 'fixture:native-gone', sources: [source] } })
    expect(boundScopeSources(row)).toMatchObject([{ sensitivity: 'confidential', compartments: [], projectIds: [] }])
    expect(await getSessionMessages(f.session.id, { excludeHeld: true })).toHaveLength(1)
  })

  it('cannot shed independent source obligations when the native carrier is deleted', async () => {
    fixture = await persistentContextFixture('confidential')
    const f = fixture
    independent = await persistentSourceFixture(f)
    const original = (await f.pool.query('SELECT id,version,observation FROM external_source_observations WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows
    await f.pool.query('DELETE FROM memories WHERE id=$1', [independent.root.resourceId])
    await independent.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1", [f.ownerId])
    const count = async () => (await f.pool.query('SELECT count(*)::int AS count FROM session_messages WHERE session_id=$1', [f.session.id])).rows[0].count
    expect(await count()).toBe(0)
    await expect(addSessionMessage({ sessionId: f.session.id, role: 'assistant', content: 'Fictional protected historical reply',
      derivation: { producer: 'fixture:external-gone', sources: [independent.root] } })).rejects.toThrow('scope_source_changed')
    expect(await count()).toBe(0)
    expect(await independent.independentlyAuthorized()).toBe(true)
    expect((await f.pool.query('SELECT id,version,observation FROM external_source_observations WHERE workspace_id=$1 ORDER BY id', [f.workspaceId])).rows).toEqual(original)
  })

  it('persists every transitive independent observation with a currently authorized native transcript', async () => {
    fixture = await persistentContextFixture('confidential')
    const f = fixture
    independent = await persistentSourceFixture(f)
    const row = await independent.writeTranscript()
    const edges = (await f.pool.query(`SELECT s.source_kind,s.source_id,s.source_version FROM scope_derivations d
      JOIN scope_derivation_sources s ON s.workspace_id=d.workspace_id AND s.derivation_id=d.id
      WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND d.resource_id=$2 ORDER BY s.source_kind`,
    [f.workspaceId, row.id])).rows
    expect(edges).toEqual([
      ...independent.observations.map(source => ({ source_kind: source.resourceKind, source_id: source.resourceId, source_version: source.version })),
      { source_kind: 'memory', source_id: independent.root.resourceId, source_version: independent.root.version },
    ])
    expect(await getSessionMessages(f.session.id, { excludeHeld: true })).toEqual([])
    expect(await independent.readTranscript(row)).toHaveLength(1)
    await f.pool.query("UPDATE connector_source_profiles SET status='revoked' WHERE workspace_id=$1", [f.workspaceId])
    expect(await getSessionMessages(f.session.id, { excludeHeld: true })).toEqual([])
    await expect(independent.readTranscript(row)).rejects.toMatchObject({ code: 'source_access_denied' })
  })

  it('refuses a transcript admission connection that inherits the table owner', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, role = `context_owner_${randomBytes(8).toString('hex')}`, password = randomBytes(32).toString('hex')
    await f.history()
    const owner = (await f.pool.query<{ owner: string }>("SELECT r.rolname AS owner FROM pg_class c JOIN pg_roles r ON r.oid=c.relowner WHERE c.oid='session_messages'::regclass")).rows[0].owner
    await f.pool.query(`CREATE ROLE ${role} LOGIN INHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS PASSWORD '${password}'`)
    const url = new URL(process.env.DATABASE_URL!); url.username = role; url.password = password
    const pool = new pg.Pool({ connectionString: url.href })
    try {
      await f.pool.query(`GRANT "${owner.replaceAll('"', '""')}" TO ${role}`)
      const tx = await pool.connect()
      try {
        await tx.query('BEGIN'); await tx.query("SELECT set_config('app.current_user_id',$1,true)", [f.ownerId])
        await expect(getSessionMessages(f.session.id, { excludeHeld: true }, tx)).rejects.toThrow('scope_source_changed')
        await tx.query('ROLLBACK')
      } finally { tx.release() }
    } finally { await pool.end(); await f.pool.query(`DROP ROLE ${role}`) }
  })
})
