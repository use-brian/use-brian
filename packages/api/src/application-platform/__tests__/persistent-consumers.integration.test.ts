import { houseKeepEpisodic } from '../../routes/proactive-compaction.js'
import { createCalleeExecutor } from '../../inter-assistant/executor.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { buildDeliveryConversationStateBlock, ContextScopeAccumulator } from '@use-brian/core'
import { runTurnSessionStateDiff } from '../../turn/session-state.js'
import type { ContentBlock, LLMProvider, Message } from '@use-brian/core'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import pg from 'pg'
import { z } from 'zod'
import { boundScopeSources, bindScopeSources, executionToolContext, createSessionStateTools, buildSessionStateBlock, runSessionStateDiff, type ScopeSource, type StreamFn } from '@use-brian/core'
import { getAppPool, getPool } from '../../db/client.js'
import { addSessionMessage, getSessionMessages, toStampedMessages } from '../../db/sessions.js'
import { createDbSessionStateStore } from '../../db/session-state-store.js'
import { createDbEpisodicStore } from '../../db/episodic-store.js'
import { writeSessionContextRevision, sessionContextGeneration, bindSessionContextRetainedAuthority, readSessionContextRevisions } from '../../db/session-context-revisions.js'
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
    const sources=(await f.history()).flatMap(boundScopeSources)
    await expect(store.upsert({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,key:'Fictional new key',summary:'Fictional new content',source:'tool',authority,derivation:{producer:'fixture:uncertified-key-domain',sources}})).rejects.toThrow('scope_source_changed')
    await expect(store.resolve({sessionId:f.session.id,key:'Fictional protected commitment',source:'tool',authority,derivation:{producer:'fixture:uncertified-key-resolution',sources}})).rejects.toThrow('scope_source_changed')
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
    const nativeHistory=await f.history(),fresh=await f.modelContext()
    bindSessionContextRetainedAuthority(fresh.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
    await expect(store.upsert({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,key:row.key,summary:'Fictional replacement without source access',source:'tool',authority:fresh,
      derivation:{producer:'fixture:hidden-key-collision',sources:nativeHistory.flatMap(boundScopeSources)}})).rejects.toThrow('scope_source_changed')
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_state WHERE session_id=$1',[f.session.id])).rows[0].n).toBe(1)
    const other=await f.modelContext(f.secondId)
    bindSessionContextRetainedAuthority(other.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
    expect(await store.listOpenBySession(f.session.id,other)).toMatchObject([{id:row.id,summary:'Fictional independent content'}])
    expect((await f.pool.query('SELECT id,payload_sha256 FROM session_context_scope_revisions WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual(original)
  })

  it('promotes governed external episodes without blocking source pins and preserves independent retained readers', async () => {
    fixture=await persistentContextFixture('confidential')
    const f=fixture;independent=await persistentSourceFixture(f)
    const store=createDbEpisodicStore(),authority=await f.modelContext()
    bindSessionContextRetainedAuthority(authority.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
    const row=await store.create({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
      topicLabel:'fictional-external-topic',summary:'Fictional governed episode',messageSpan:{fromSequence:1,toSequence:2,turnCount:2},authority,
      derivation:{producer:'fixture:external-promotion',sources:[independent.root]}})
    await store.fetchByTopic({sessionId:f.session.id,topicLabel:row.topicLabel,authority})
    await store.incrementSurvivalCount([row.id],authority)
    await store.incrementSurvivalCount([row.id],authority)
    const original=boundScopeSources(row)[0],published=await store.promote!(row.id,authority)
    expect(published.created).toBe(true)
    expect((await f.pool.query('SELECT promoted_memory_id FROM episodic_memories WHERE id=$1',[row.id])).rows[0].promoted_memory_id).toBe(published.memoryId)
    await independent.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
    await expect(store.promote!(row.id,authority)).rejects.toThrow('scope_source_changed')
    const second=await f.modelContext(f.secondId)
    bindSessionContextRetainedAuthority(second.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
    expect(await store.promote!(row.id,second)).toEqual({memoryId:published.memoryId,created:false})
    const retained=await readSessionContextRevisions(f.session.id,'episodic_memory',second,{includePromoted:true})
    expect(retained).toMatchObject([{content:{summary:'Fictional governed episode'}}])
    expect(boundScopeSources(retained[0])).toEqual([original])
    expect(await store.listBySession(f.session.id,second)).toEqual([])
  })

  it('propagates a typed retention refusal after an admitted episode read and keeps an independent promoter usable', async () => {
    fixture=await persistentContextFixture('confidential')
    const f=fixture;independent=await persistentSourceFixture(f)
    const store=createDbEpisodicStore(),setup=await f.modelContext()
    bindSessionContextRetainedAuthority(setup.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
    const row=await store.create({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
      topicLabel:'fictional-retain-race',summary:'Fictional retained topic',messageSpan:{fromSequence:1,toSequence:2,turnCount:2},authority:setup,
      derivation:{producer:'fixture:retain-race',sources:[independent.root]}})
    await store.fetchByTopic({sessionId:f.session.id,topicLabel:row.topicLabel,authority:setup})
    await store.incrementSurvivalCount([row.id],setup)
    await store.incrementSurvivalCount([row.id],setup)
    const native=await f.modelContext()
    const cold=await store.create({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
      topicLabel:'fictional-independent-cold',summary:'Fictional cold native episode',messageSpan:{fromSequence:1,toSequence:3,turnCount:3},authority:native,
      derivation:{producer:'fixture:native-cold-after-retain',sources:(await f.history()).flatMap(boundScopeSources)}})
    const original=boundScopeSources(row)[0],first=await f.modelContext()
    let revoked=false
    bindSessionContextRetainedAuthority(first.execution,async(execution,sources,action)=>{
      if(action==='retain'&&!revoked){
        revoked=true
        await independent!.pool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[f.ownerId])
      }
      return independent!.coordinator.prepare(execution,sources,action)
    })
    await expect(houseKeepEpisodic({episodicStore:store,memoryStore:createDbMemoryStore(),sessionId:f.session.id,
      assistantId:f.assistantId,userId:f.ownerId,contextAuthority:first})).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
    expect(revoked).toBe(true)
    expect((await f.pool.query('SELECT id FROM episodic_memories WHERE id=$1',[cold.id])).rows).toHaveLength(1)
    expect((await f.pool.query("SELECT id FROM memories WHERE workspace_id=$1 AND source='episodic-graduation'",[f.workspaceId])).rows).toHaveLength(0)
    expect((await f.pool.query('SELECT promoted_memory_id,survival_count FROM episodic_memories WHERE id=$1',[row.id])).rows[0]).toEqual({promoted_memory_id:null,survival_count:2})
    const second=await f.modelContext(f.secondId)
    bindSessionContextRetainedAuthority(second.execution,(execution,sources,action)=>independent!.coordinator.prepare(execution,sources,action))
    expect(await houseKeepEpisodic({episodicStore:store,memoryStore:createDbMemoryStore(),sessionId:f.session.id,
      assistantId:f.assistantId,userId:f.secondId,contextAuthority:second})).toEqual({promoted:1,evicted:1,kept:0})
    expect((await f.pool.query("SELECT created_by_user_id FROM memories WHERE workspace_id=$1 AND source='episodic-graduation'",[f.workspaceId])).rows).toEqual([{created_by_user_id:f.secondId}])
    expect((await f.pool.query("SELECT read_scope_source($1,'session_context_revision',$2) AS source",[f.workspaceId,original.resourceId])).rows[0].source).toMatchObject({version:original.version,held:false})
  })

  it('uses the actual Brian commitment tools and formatter with the same canonical execution', async () => {
    fixture=await persistentContextFixture()
    const f=fixture,authority=await f.modelContext(),history=await f.history(),store=createDbSessionStateStore()
    authority.accumulator.note({sources:history.flatMap(boundScopeSources)})
    const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
    const tools=createSessionStateTools(store)
    await tools.trackCommitment.execute({key:'Fictional tool key',summary:'Fictional tool commitment',detail:'Fictional tool detail'},context)
    expect(await buildSessionStateBlock({store,sessionId:f.session.id,authority})).toContain('Fictional tool detail')
    expect(authority.accumulator.evidence.sources?.some(source=>source.resourceKind==='session_context_revision')).toBe(true)
    await tools.resolveCommitment.execute({key:'Fictional tool key'},context)
    expect(await store.listOpenBySession(f.session.id,authority)).toEqual([])
    expect(await store.listRecentBySession(f.session.id,50,authority)).toMatchObject([{status:'resolved'}])
  })

  it('guards the actual diff model and writer with current inputs and keeps another member usable', async () => {
    fixture=await persistentContextFixture()
    const f=fixture,history=await f.history(),store=createDbSessionStateStore(),authority=await f.modelContext(f.firstId)
    const stream=vi.fn<StreamFn>(async function*(){
      yield {type:'text_delta',text:'{"upserts":[{"key":"Fictional diff key","summary":"Fictional diff commitment"}],"resolves":[]}'}
      yield {type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}
    })
    const provider={name:'fixture',models:['fixture'],stream,createSession(){throw new Error('Unused fixture session')}}
    const recentTurns=toStampedMessages(history,'UTC').map(message=>{
      const content=typeof message.content==='string'?message.content
        :z.array(z.object({type:z.literal('text'),text:z.string()})).parse(message.content).map(block=>block.text).join('\n')
      return bindScopeSources({role:message.role,content},boundScopeSources(message))
    })
    await expect(runSessionStateDiff({provider,model:'fixture',sessionId:f.session.id,userId:f.firstId,assistantId:f.assistantId,
      store,recentTurns,openCommitments:[],authority})).rejects.toThrow('scope_evidence_missing')
    expect(stream).not.toHaveBeenCalled()
    const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
    const result=await runSessionStateDiff({provider,model:'fixture',sessionId:f.session.id,userId:f.firstId,assistantId:f.assistantId,
      store,recentTurns,openCommitments:[],authority,assertInputAuthority:()=>assertSourceModelInputAuthority(context)})
    expect(result.upserts).toBe(1)
    const open=await store.listOpenBySession(f.session.id,authority)
    expect(open).toMatchObject([{key:'Fictional diff key'}])
    await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.firstId])
    await expect(runSessionStateDiff({provider,model:'fixture',sessionId:f.session.id,userId:f.firstId,assistantId:f.assistantId,
      store,recentTurns,openCommitments:open,authority,assertInputAuthority:()=>assertSourceModelInputAuthority(context)})).rejects.toMatchObject({reason:'authority_changed'})
    expect(stream).toHaveBeenCalledOnce()
    const other=await f.modelContext(f.secondId),otherContext={...executionToolContext(other.execution,{appId:'fixture'}),scopeAccumulator:other.accumulator}
    await runSessionStateDiff({provider,model:'fixture',sessionId:f.session.id,userId:f.secondId,assistantId:f.assistantId,
      store,recentTurns,openCommitments:await store.listOpenBySession(f.session.id,other),authority:other,
      assertInputAuthority:()=>assertSourceModelInputAuthority(otherContext)})
    expect(stream).toHaveBeenCalledTimes(2)
  })

  it('runs the actual API differ with complete turn ancestry and only the final substantive response', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, authority = await f.modelContext(), history = await f.history(), store = createDbSessionStateStore()
    const prior = await f.memory('Fictional consumed context')
    const source = (await f.pool.query<{ source: ScopeSource }>("SELECT read_scope_source($1,'memory',$2) AS source", [f.workspaceId, prior.id])).rows[0].source
    authority.accumulator.noteSource(source)
    const userMessage = bindScopeSources<Message>({ role: 'user', content: 'Fictional current request' }, boundScopeSources(history.at(-1)!))
    const requests: string[] = []
    const stream: StreamFn = async function* (request) {
      requests.push(JSON.stringify(request.messages))
      yield { type: 'text_delta', text: '{"upserts":[{"key":"Fictional API key","summary":"Fictional API commitment"}],"resolves":[]}' }
    }
    const provider: LLMProvider = { name: 'deterministic-context-fixture', models: ['fixture'], stream,
      createSession() { throw new Error('Stateless fixture expected') } }
    const result = await runTurnSessionStateDiff({ authority, provider, model: 'fixture', store, userMessage,
      assistantTurns: [
        { content: [{ type: 'text', text: 'Fictional private narration' }, { type: 'tool_use', id: 'fixture-read', name: 'getMemory', input: {} }] },
        { content: [{ type: 'text', text: 'Fictional final response' }] },
      ] })
    expect(result.upserts).toBe(1)
    expect(requests).toHaveLength(1)
    expect(requests[0]).toContain('Fictional final response')
    expect(requests[0]).not.toContain('Fictional private narration')
    const rows = await store.listOpenBySession(f.session.id, authority)
    expect(rows).toMatchObject([{ key: 'Fictional API key', summary: 'Fictional API commitment' }])
    const inputs = (await f.pool.query(`SELECT s.source_id FROM scope_derivation_sources s JOIN scope_derivations d
      ON d.id=s.derivation_id AND d.workspace_id=s.workspace_id WHERE d.workspace_id=$1 AND d.resource_kind='session_context_revision'
      AND d.resource_id=$2 ORDER BY s.source_id`, [f.workspaceId, boundScopeSources(rows[0])[0].resourceId])).rows.map(row => row.source_id)
    expect(inputs).toContain(prior.id)
    expect(inputs).toContain(history.at(-1)!.id)
  })

  it('refuses the actual API differ before reading response content after member contraction', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, authority = await f.modelContext(f.firstId), history = await f.history(), store = createDbSessionStateStore()
    const userMessage = bindScopeSources<Message>({ role: 'user', content: 'Fictional request' }, boundScopeSources(history.at(-1)!))
    const inspect = vi.fn((): ContentBlock[] => [{ type: 'text', text: 'Fictional held response' }])
    const stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text: '{"upserts":[],"resolves":[]}' } })
    const provider: LLMProvider = { name: 'deterministic-context-fixture', models: ['fixture'], stream,
      createSession() { throw new Error('Stateless fixture expected') } }
    await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
    await expect(runTurnSessionStateDiff({ authority, provider, model: 'fixture', store, userMessage,
      assistantTurns: [{ get content() { return inspect() } }] })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(inspect).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
    const other = await f.modelContext(f.secondId)
    expect((await runTurnSessionStateDiff({ authority: other, provider, model: 'fixture', store, userMessage,
      assistantTurns: [{ content: [{ type: 'text', text: 'Fictional current response' }] }] })).upserts).toBe(0)
    expect(stream).toHaveBeenCalledOnce()
  })

  it('discards the API diff after contraction during generation without publishing a revision', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, authority = await f.modelContext(f.firstId), history = await f.history(), store = createDbSessionStateStore()
    const userMessage = bindScopeSources<Message>({ role: 'user', content: 'Fictional request' }, boundScopeSources(history.at(-1)!))
    const stream = vi.fn<StreamFn>(async function* () {
      yield { type: 'text_delta', text: '{"upserts":[{"key":"Fictional withdrawn key","summary":"Fictional rejected content"}],"resolves":[]}' }
      await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
    })
    const provider: LLMProvider = { name: 'deterministic-context-fixture', models: ['fixture'], stream,
      createSession() { throw new Error('Stateless fixture expected') } }
    await expect(runTurnSessionStateDiff({ authority, provider, model: 'fixture', store, userMessage,
      assistantTurns: [{ content: [{ type: 'text', text: 'Fictional rejected response' }] }] })).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(stream).toHaveBeenCalledOnce()
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_context_scope_revisions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    expect((await f.pool.query('SELECT count(*)::int AS n FROM session_state WHERE session_id=$1', [f.session.id])).rows[0].n).toBe(0)
  })

  it('holds an unbound API diff input without formatting or provider dispatch', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, authority = await f.modelContext(), store = createDbSessionStateStore()
    const inspect = vi.fn((): ContentBlock[] => [{ type: 'text', text: 'Fictional unbound content' }])
    const stream = vi.fn<StreamFn>(async function* () { yield { type: 'text_delta', text: '{"upserts":[],"resolves":[]}' } })
    const provider: LLMProvider = { name: 'deterministic-context-fixture', models: ['fixture'], stream,
      createSession() { throw new Error('Stateless fixture expected') } }
    await expect(runTurnSessionStateDiff({ authority, provider, model: 'fixture', store,
      userMessage: { role: 'user', content: 'Fictional unbound input' },
      assistantTurns: [{ get content() { return inspect() } }] })).rejects.toThrow('scope_evidence_missing')
    expect(inspect).not.toHaveBeenCalled()
    expect(stream).not.toHaveBeenCalled()
  })

  it('admits only current native delegated commitment context without borrowing its session creator', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, store = createDbSessionStateStore(), history = await f.history(), authority = await f.modelContext()
    await store.upsert({ sessionId: f.session.id, userId: f.ownerId, assistantId: f.assistantId,
      key: 'Fictional delegated key', summary: 'Fictional delegated commitment', source: 'tool', authority,
      derivation: { producer: 'fixture:delegated-prior', sources: history.flatMap(boundScopeSources) } })
    const current = { execution: await f.delegatedExecution(f.firstId), accumulator: new ContextScopeAccumulator() }
    expect(current.execution.identity).toMatchObject({ kind: 'delegated', actorUserId: f.firstId })
    expect(current.execution.security.access.userId).not.toBe(f.session.userId)
    const block = await buildDeliveryConversationStateBlock({ store, authority: current, sessions: [{ sessionId: f.session.id }] })
    expect(block).toContain('Fictional delegated commitment')
    await expect(assertSourceModelInputAuthority({ ...executionToolContext(current.execution, { appId: 'fixture' }),
      scopeAccumulator: current.accumulator })).resolves.toBeUndefined()
    await f.pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.firstId])
    await expect(assertSourceModelInputAuthority({ ...executionToolContext(current.execution, { appId: 'fixture' }),
      scopeAccumulator: current.accumulator })).rejects.toMatchObject({ reason: 'authority_changed' })
    const second = { execution: await f.delegatedExecution(f.secondId), accumulator: new ContextScopeAccumulator() }
    expect(await buildDeliveryConversationStateBlock({ store, authority: second, sessions: [{ sessionId: f.session.id }] })).toContain('Fictional delegated commitment')
    await expect(assertSourceModelInputAuthority({ ...executionToolContext(second.execution, { appId: 'fixture' }),
      scopeAccumulator: second.accumulator })).resolves.toBeUndefined()
    independent = await persistentSourceFixture(f)
    const external = { execution: await f.delegatedExecution(), accumulator: new ContextScopeAccumulator() }
    external.accumulator.noteSource(independent.root)
    await expect(assertSourceModelInputAuthority({ ...executionToolContext(external.execution, { appId: 'fixture' }),
      scopeAccumulator: external.accumulator })).rejects.toMatchObject({ code: 'source_access_denied' })
    expect(await independent.independentlyAuthorized()).toBe(true)
  })

  it('injects healthy delivery commitments through the actual delegated executor and real source admission', async () => {
    fixture = await persistentContextFixture()
    const f = fixture, store = createDbSessionStateStore(), history = await f.history(), authority = await f.modelContext()
    const tracked = await store.upsert({ sessionId: f.session.id, userId: f.ownerId, assistantId: f.assistantId,
      key: 'Fictional delivery key', summary: 'Fictional delivery commitment', detail: 'Fictional delivery detail', source: 'tool', authority,
      derivation: { producer: 'fixture:delivery-prior', sources: history.flatMap(boundScopeSources) } })
    // The workspace primary can read this workspace conversation. A standard
    // assistant's narrower native visibility is not widened by this bridge.
    const calleeId = f.assistantId
    const prompts: string[] = []
    const answer: StreamFn = async function* () {
      yield { type: 'message_start', model: 'gemini-3.6-flash-pro' }
      yield { type: 'text_delta', text: 'Fictional delegated report' }
      yield { type: 'message_end', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    }
    const provider: LLMProvider = { name: 'deterministic-context-fixture', models: ['gemini-3.6-flash-pro'], stream: answer,
      createSession(options) {
        prompts.push(options.systemPrompt)
        return { send: () => answer({ model: options.model, systemPrompt: options.systemPrompt, messages: [] }) }
      } }
    const execute = createCalleeExecutor({ provider, tools: new Map(), memoryStore: createDbMemoryStore(),
      capabilityStore: createDbCapabilityStore(), sessionStateStore: store })
    const parent = await f.execution(f.firstId)
    const result = await execute({ callerUserId: f.firstId, callerAssistantId: f.assistantId,
      callerAccessCeiling: parent.security.ceiling, calleeAssistantId: calleeId, expectedWorkspaceId: f.workspaceId,
      callerSessionId: f.session.id, question: 'Fictional delivery state request',
      deliverTarget: { channelType: 'web', channelId: f.session.channelId } })
    expect(result).toBe('Fictional delegated report')
    expect(prompts).toHaveLength(1)
    expect(prompts[0]).toContain('# Open commitments (delivery conversation)')
    expect(prompts[0]).toContain('`Fictional delivery key`')
    expect(prompts[0]).toContain('Fictional delivery detail')
    const consumed = (await f.pool.query(`SELECT d.resource_id,s.source_id FROM scope_derivations d
      JOIN scope_derivation_sources s ON s.derivation_id=d.id AND s.workspace_id=d.workspace_id
      JOIN session_messages m ON m.id=d.resource_id JOIN sessions ss ON ss.id=m.session_id
      WHERE d.workspace_id=$1 AND d.resource_kind='session_message' AND ss.assistant_id=$2
        AND s.source_kind='session_context_revision' AND s.source_id=$3`,
    [f.workspaceId, calleeId, boundScopeSources(tracked)[0].resourceId])).rows
    expect(consumed.length).toBeGreaterThan(0)
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
