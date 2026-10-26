import express from 'express'
import request from 'supertest'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createTokens} from '../../auth/jwt.js'
import {requireAuth} from '../../auth/middleware.js'
import {memoryRoutes} from '../../routes/memories.js'
import {resolveNativeApplicationModuleExecution} from '../native-module-runtime.js'
import {recordFeedback} from '../../feedback/record.js'
import {recordRecallBatch,listMemoriesByRecentOutcome} from '../../db/memory-recall-events-store.js'
import {listUnverifiedByWorkspace} from '../../db/memories.js'
import {assertSourceModelOutputAuthority} from '../model-source-authority.js'
import { createAuthorityLease, runWithAuthorityLease } from '../../context-scope/authority-lease.js'
import { executePublicTurn } from '../../routes/public-turn.js'
import { updateSelfEntityAttributes } from '../../db/entities-store.js'
import { EventEmitter } from 'node:events'
import { houseKeepEpisodic } from '../../routes/proactive-compaction.js'
import { createCalleeExecutor } from '../../inter-assistant/executor.js'
import { createDbMemoryStore } from '../../db/memory-store.js'
import { createDbCapabilityStore } from '../../db/capability-store.js'
import { buildDeliveryConversationStateBlock, ContextScopeAccumulator } from '@use-brian/core'
import { runTurnSessionStateDiff } from '../../turn/session-state.js'
import type { ContentBlock, LLMProvider, Message } from '@use-brian/core'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { randomBytes, randomUUID } from 'node:crypto'
import pg from 'pg'
import { z } from 'zod'
import { classifyTopic, boundScopeSources, bindScopeSources, executionToolContext, createSessionStateTools, buildSessionStateBlock, runSessionStateDiff, type ScopeSource, type ScopeEvidence, type StreamFn } from '@use-brian/core'
import { getAppPool, getPool, applyRLSGucs, runWithAgentAccess } from '../../db/client.js'
import { applyApplicationRLSContext, releaseApplicationTransactionBinding } from '../execution-context.js'
import { validateCallerScopeEvidence } from '../../context-scope/caller-evidence.js'
import { createMemory } from '../../db/memories.js'
import { createWorkspaceChatSession, addSessionMessage, getSessionMessages, toStampedMessages } from '../../db/sessions.js'
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

  async function nativeOutcomeReview(f:Awaited<ReturnType<typeof persistentContextFixture>>,actor=f.firstId){
    const auth=await authSessionStore.create(actor,{deviceLabel:'Fictional outcome review',userAgent:'Fixture',ipAddress:'127.0.0.1'})
    if(!auth)throw new Error('Missing actual review authentication')
    const secret='fictional-outcome-review-secret',token=createTokens(actor,secret,auth).accessToken,app=express()
    app.use('/api/assistants/:assistantId/memories',requireAuth(secret),memoryRoutes())
    const read=(score=true)=>request(app).get(`/api/assistants/${f.assistantId}/memories?status=unverified${score?'&include=bad_outcome':''}`).set('Authorization',`Bearer ${token}`)
    const carrier=Object.assign(new EventEmitter(),{userId:actor,authSessionId:auth.id,authVersion:auth.authVersion,aborted:false})
    const execution=await resolveNativeApplicationModuleExecution(carrier as never,f.workspaceId,f.assistantId)
    const authority={execution,accumulator:new ContextScopeAccumulator()}
    const score=async(ids?:readonly string[])=>{
      const rows=await listUnverifiedByWorkspace(execution.security.access,100,undefined,authority)
      return listMemoriesByRecentOutcome({workspaceId:f.workspaceId,windowDays:30,authority,
        memoryIds:ids??rows.map(row=>row.id),memorySources:boundScopeSources(rows),sentimentFilter:'any'})
    }
    return{auth,read,authority,score,context:{...executionToolContext(execution,{appId:'native-memory-read'}),scopeAccumulator:authority.accumulator}}
  }
  async function nativeOutcomeTurns(f:Awaited<ReturnType<typeof persistentContextFixture>>,memoryId:string){
    const messages=[]
    for(let i=0;i<3;i++)messages.push(await addSessionMessage({sessionId:f.session.id,role:'assistant',content:[{type:'text',text:`Fictional reviewed answer ${i}`}],scope:{...f.envelope,assistantId:f.assistantId},senderAssistantId:f.assistantId}))
    for(const message of messages)await recordRecallBatch({memoryIds:[memoryId],sessionId:f.session.id,workspaceId:f.workspaceId,userId:f.firstId,recallKind:'index_inject',assistantMessageId:message.id})
    return messages
  }

  it('scores actual native own negative feedback before HTTP review and keeps another actor private positive irrelevant',async()=>{
    fixture=await persistentContextFixture();const f=fixture,memory=await f.memory('Fictional outcome review memory'),messages=await nativeOutcomeTurns(f,memory.id)
    await recordFeedback({userId:f.firstId,messageId:messages[0].id,sessionId:f.session.id,kind:'negative',details:':down:',source:'web'})
    await recordFeedback({userId:f.firstId,messageId:messages[1].id,sessionId:f.session.id,kind:'negative',details:'Fictional correction details',source:'web'})
    const review=await nativeOutcomeReview(f),response=await review.read()
    expect(review.authority.execution.identity).toMatchObject({kind:'attended',principal:{kind:'workspace_member',userId:f.firstId,authenticationKind:'native_session'}})
    const unsupportedIdentity={...review.authority.execution,identity:{kind:'attended',principal:{kind:'workspace_member',userId:f.firstId,authenticationKind:'verified_channel'}}}
    await expect(listMemoriesByRecentOutcome({workspaceId:f.workspaceId,windowDays:30,memoryIds:[memory.id],authority:{...review.authority,execution:unsupportedIdentity} as never})).rejects.toMatchObject({code:'scope_evidence_missing'})
    expect(response.status,JSON.stringify(response.body)).toBe(200)
    expect(response.headers['cache-control']).toBe('no-store')
    expect(response.body.memories.find((row:{id:string})=>row.id===memory.id)?.outcomeScore).toEqual({recallCount:3,negativeCount:2,correctionCount:1})
    const scored=await review.score([memory.id]),sources=boundScopeSources(scored)
    expect(sources.some(source=>source.resourceKind==='application_field')).toBe(true)
    const domain=(await f.pool.query(`SELECT q.domain FROM application_field_resources r JOIN application_query_domains q ON q.workspace_id=r.workspace_id AND q.id=r.resource_id
      WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND r.type_key='feedback_event' AND r.selection='query_domain'`,[f.workspaceId,sources.map(source=>source.resourceId)])).rows[0].domain
    expect(domain.associations).toHaveLength(3);expect(domain.feedback).toHaveLength(2);expect(domain.memoryCandidates).toEqual([{id:memory.id,version:expect.any(String)}])
    review.authority.accumulator.note({sources});await expect(assertSourceModelOutputAuthority(review.context)).resolves.toBeUndefined()
    await recordFeedback({userId:f.secondId,messageId:messages[0].id,sessionId:f.session.id,kind:'positive',source:'web'})
    const unchanged=await review.read();expect(unchanged.status,JSON.stringify(unchanged.body)).toBe(200)
    expect(unchanged.body.memories.find((row:{id:string})=>row.id===memory.id)?.outcomeScore).toEqual({recallCount:3,negativeCount:2,correctionCount:1})
  })

  it('holds actual outcome fields and native session contraction before scoring and revalidates a returned domain at egress',async()=>{
    fixture=await persistentContextFixture();const f=fixture,memory=await f.memory('Fictional field-scoped review'),messages=await nativeOutcomeTurns(f,memory.id)
    await recordFeedback({userId:f.firstId,messageId:messages[0].id,sessionId:f.session.id,kind:'negative',details:'Fictional correction detail',source:'web'})
    const review=await nativeOutcomeReview(f),scored=await review.score([memory.id]);expect(scored[0].negativeCount).toBe(1)
    review.authority.accumulator.note({sources:boundScopeSources(scored)})
    await f.pool.query("UPDATE sessions SET effective_clearance='confidential' WHERE id=$1",[f.session.id])
    await expect(assertSourceModelOutputAuthority(review.context)).rejects.toMatchObject({reason:'authority_changed'})
    const held=await review.read();expect(held.status,JSON.stringify(held.body)).toBe(200);expect(held.body.memories).toEqual([])
    await f.pool.query("UPDATE sessions SET effective_clearance='internal' WHERE id=$1",[f.session.id])
    let registered=false
    try{
      await f.pool.query(`CREATE TABLE outcome_field_fixture(workspace_id uuid PRIMARY KEY,fields jsonb NOT NULL);
        CREATE FUNCTION outcome_field_catalog(w uuid,o jsonb,t text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','feedback-fixture-v1','policyVersion','1','fieldKeys',to_jsonb(application_feedback_field_keys()),'fields',p.fields,
          'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) FROM outcome_field_fixture p WHERE p.workspace_id=w $$;
        CREATE FUNCTION outcome_field_record(w uuid,o jsonb,t text,i text) RETURNS jsonb LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        SELECT(outcome_field_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',a.scope_version::text,'source',read_scope_source(w,'feedback_event',a.id)) FROM analytics_events a WHERE a.workspace_id=w AND a.id=i::uuid $$;
        REVOKE ALL ON FUNCTION outcome_field_catalog(uuid,jsonb,text),outcome_field_record(uuid,jsonb,text,text) FROM PUBLIC`)
      await f.pool.query(`INSERT INTO outcome_field_fixture SELECT $1,jsonb_agg(jsonb_build_object('key',key,'read',CASE WHEN key='details' THEN '[["outcome_reader"]]'::jsonb ELSE '[]'::jsonb END,
        'write','[]'::jsonb,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb)) FROM unnest(application_feedback_field_keys()) key`,[f.workspaceId])
      await f.pool.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
        VALUES('native','1',ARRAY['outcome_reader'],'outcome_field_record(uuid,jsonb,text,text)'::regprocedure,'outcome_field_catalog(uuid,jsonb,text)'::regprocedure)`);registered=true
      await f.pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}','feedback_event','native')`,[f.workspaceId])
      await f.pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'outcome_reader',$3)`,[f.workspaceId,f.firstId,f.ownerId])
      expect((await review.read()).status).toBe(200)
      const fresh=await nativeOutcomeReview(f),value=await fresh.score([memory.id]);fresh.authority.accumulator.note({sources:boundScopeSources(value)})
      await f.pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND user_id=$2 AND module_key='native'",[f.workspaceId,f.firstId])
      expect((await review.read()).status).toBe(404);expect((await review.read(false)).status).toBe(200)
      await expect(assertSourceModelOutputAuthority(fresh.context)).rejects.toMatchObject({reason:'authority_changed'})
    }finally{
      await f.pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[f.workspaceId])
      await f.pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[f.workspaceId])
      if(registered)await f.pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
      await f.pool.query('DROP FUNCTION IF EXISTS outcome_field_record(uuid,jsonb,text,text);DROP FUNCTION IF EXISTS outcome_field_catalog(uuid,jsonb,text);DROP TABLE IF EXISTS outcome_field_fixture')
    }
  })

  it('retains empty outcome candidates and no-feedback associations while refusing own unsupported feedback without changing legacy counts',async()=>{
    fixture=await persistentContextFixture();const f=fixture,empty=await f.memory('Fictional empty outcome candidate'),memory=await f.memory('Fictional no-feedback outcome'),messages=await nativeOutcomeTurns(f,memory.id)
    const review=await nativeOutcomeReview(f),emptyScores=await review.score([empty.id]);expect(emptyScores).toEqual([])
    const roots=boundScopeSources(emptyScores);expect(roots.length).toBeGreaterThan(0)
    const domains=(await f.pool.query(`SELECT r.id,q.domain FROM application_field_resources r JOIN application_query_domains q ON q.workspace_id=r.workspace_id AND q.id=r.resource_id
      WHERE r.workspace_id=$1 AND r.id=ANY($2::uuid[]) AND r.type_key='feedback_event' AND r.selection='query_domain'`,[f.workspaceId,roots.map(source=>source.resourceId)])).rows
    expect(domains[0].domain.memoryCandidates).toEqual([{id:empty.id,version:expect.any(String)}]);expect(domains[0].domain.associations).toEqual([])
    const none=await nativeOutcomeReview(f),noFeedback=await none.score([memory.id]);expect(noFeedback[0]).toMatchObject({recallCount:3,negativeCount:0,correctionCount:0})
    none.authority.accumulator.note({sources:boundScopeSources(noFeedback)})
    await f.pool.query("UPDATE memory_recall_events SET recall_kind='tool_call' WHERE workspace_id=$1 AND memory_id=$2",[f.workspaceId,memory.id])
    await expect(assertSourceModelOutputAuthority(none.context)).rejects.toMatchObject({reason:'authority_changed'})
    await recordFeedback({userId:f.firstId,messageId:messages[0].id,sessionId:f.session.id,kind:'positive',source:'web'})
    const unsupported=await review.read();expect(unsupported.status,JSON.stringify(unsupported.body)).toBe(503);expect(unsupported.body.error).toContain('Outcome scoring unavailable')
    expect((await review.read(false)).status).toBe(200)
    const legacy=await listMemoriesByRecentOutcome({workspaceId:f.workspaceId,windowDays:30,sentimentFilter:'any'})
    expect(legacy.find(row=>row.memoryId===memory.id)).toMatchObject({recallCount:3,positiveCount:1,negativeCount:0,correctionCount:0})
    const isolated=await nativeOutcomeReview(f)
    isolated.authority.accumulator.note({sources:roots.filter(source=>source.resourceId===domains[0].id)})
    await f.pool.query("UPDATE memories SET sensitivity='confidential' WHERE id=$1",[empty.id])
    await expect(assertSourceModelOutputAuthority(isolated.context)).rejects.toMatchObject({reason:'authority_changed'})
  })

  it('ignores caller temporary tables when admitting canonical context metadata and payload',async()=>{
    fixture=await persistentContextFixture();const f=fixture,history=await f.history()
    const episode=await createDbEpisodicStore().create({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
      topicLabel:'fictional canonical context',summary:'Fictional canonical context',messageSpan:{fromSequence:1,toSequence:3,turnCount:3},authority:await f.modelContext(),
      derivation:{producer:'fixture:canonical-schema-path',sources:history.flatMap(boundScopeSources)}})
    const actualId=boundScopeSources(episode)[0].resourceId,forgedId=randomUUID(),execution=await f.execution(f.firstId),client=await getAppPool().connect()
    expect((await f.pool.query('SELECT id FROM public.session_context_scope_revisions WHERE id=$1',[forgedId])).rows).toEqual([])
    try{await runWithAgentAccess(execution.security.access,async()=>{
      await client.query('BEGIN');await applyRLSGucs(client,f.firstId);await applyApplicationRLSContext(client,execution)
      const configurations=(await client.query<{proname:string;proconfig:string[]}>(`SELECT proname,proconfig FROM pg_catalog.pg_proc
        WHERE pronamespace='public'::regnamespace AND (proname LIKE 'session_context_%' OR proname LIKE 'guard_session_context_%'
         OR proname=ANY($1::text[]))`,[['scope_source_table','hold_scope_descendants','read_scope_source','purge_session_context_parent',
          'session_personal_audience','session_workspace_audience','session_project_audience','read_admitted_native_scope_snapshot',
          'read_entity_derivation_source','read_session_context_revision','validate_session_context_revision_pair','guard_episodic_promotion',
          'guard_session_message_annotation_head','purge_session_message_annotations','read_admitted_session_context_dependencies',
          'application_memory_field_ancestry_allows','application_memory_unproven_ancestry_allows']])).rows
      expect(configurations).toHaveLength(25)
      for(const configuration of configurations)expect(configuration.proconfig,configuration.proname).toContain('search_path=pg_catalog, public, pg_temp')
      await client.query('CREATE TEMP TABLE session_context_scope_revisions AS SELECT * FROM public.session_context_scope_revisions WITH NO DATA')
      await client.query('CREATE TEMP TABLE session_context_revision_contents AS SELECT * FROM public.session_context_revision_contents WITH NO DATA')
      await client.query(`INSERT INTO pg_temp.session_context_scope_revisions
        (id,workspace_id,session_id,parent_kind,parent_id,user_id,assistant_id,sensitivity,compartments,project_ids,scope_version,scope_held,payload_sha256)
        VALUES($1,$2,$3,'compact_summary',$3,NULL,NULL,'internal','{}','{}',1,false,repeat('0',64))`,[forgedId,f.workspaceId,f.session.id])
      await client.query('INSERT INTO pg_temp.session_context_revision_contents(workspace_id,revision_id,content) VALUES($1,$2,$3)',
        [f.workspaceId,forgedId,{summary:'Fictional untrusted temporary payload',boundarySequence:1}])
      const forged=(await client.query("SELECT read_admitted_native_scope_snapshot($1,'session_context_revision',$2) AS source",[f.workspaceId,forgedId])).rows[0].source
      const forgedPayload=(await client.query('SELECT read_session_context_revision($1,$2) AS content',[f.workspaceId,forgedId])).rows[0].content
      const actual=(await client.query("SELECT read_admitted_native_scope_snapshot($1,'session_context_revision',$2) AS source",[f.workspaceId,actualId])).rows[0].source
      const actualPayload=(await client.query('SELECT read_session_context_revision($1,$2) AS content',[f.workspaceId,actualId])).rows[0].content
      expect(forged).toMatchObject({held:true})
      expect(forgedPayload).toBeNull()
      expect(actual).toMatchObject({held:false,resourceId:actualId})
      expect(actualPayload).toMatchObject({summary:'Fictional canonical context'})
    })}finally{releaseApplicationTransactionBinding(client);await client.query('ROLLBACK');client.release()}
  })

  it('withholds context-backed memory before actual payload, search, index, ranking and counts while a second reader remains usable',async()=>{
    fixture=await persistentContextFixture()
    const f=fixture,history=await f.history(),episodes=createDbEpisodicStore(),authority=await f.modelContext()
    const episode=await episodes.create({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,topicLabel:'fictional memory-reader topic',summary:'Fictional retained memory-reader detail',
      messageSpan:{fromSequence:1,toSequence:3,turnCount:3},authority,derivation:{producer:'fixture:actual-memory-reader',sources:history.flatMap(boundScopeSources)}})
    await f.pool.query('UPDATE episodic_memories SET access_count=1,survival_count=2 WHERE id=$1',[episode.id])
    const promoted=await episodes.promote!(episode.id,authority),memories=createDbMemoryStore()
    const original=(await f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,promoted.memoryId])).rows[0].source
    const target=await createWorkspaceChatSession({workspaceId:f.workspaceId,assistantId:f.assistantId,starterUserId:f.ownerId,effectiveClearance:'internal',authenticatedHuman:true})
    const wideTarget=await createWorkspaceChatSession({workspaceId:f.workspaceId,assistantId:f.assistantId,starterUserId:f.ownerId,effectiveClearance:'confidential',authenticatedHuman:true})
    async function reader(userId:typeof f.firstId,session:typeof f.session){
      const execution=await f.execution(userId,session)
      const context={...executionToolContext(execution,{appId:'fixture'}),workspaceId:f.workspaceId,assistantKind:execution.assistant.kind}
      return{body:await memories.getById(context,promoted.memoryId),index:await memories.getIndex(context),
        search:await memories.search(context,{query:'fictional'}),prefix:await memories.search(context,{query:'',idPrefix:promoted.memoryId.slice(0,12)}),
        ranked:await memories.getIndexRanked!(context,50),count:await memories.count(context)}
    }
    const before=await reader(f.firstId,target)
    expect(before.body).toMatchObject({id:promoted.memoryId})
    for(const rows of [before.index,before.search,before.prefix,before.ranked.rows])expect(rows).toContainEqual(expect.objectContaining({id:promoted.memoryId}))
    expect(before.count).toBe(1);expect(before.ranked.totalCount).toBe(1)
    await f.pool.query("UPDATE sessions SET effective_clearance='confidential' WHERE id=$1",[f.session.id])
    const denied=await reader(f.firstId,target)
    expect(denied.body).toBeNull()
    for(const rows of [denied.index,denied.search,denied.prefix,denied.ranked.rows])expect(rows).toEqual([])
    expect(denied.count).toBe(0);expect(denied.ranked.totalCount).toBe(0)
    const rawExecution=await f.execution(f.firstId,target),raw=await getAppPool().connect()
    try{await runWithAgentAccess(rawExecution.security.access,async()=>{
      await raw.query('BEGIN');await applyRLSGucs(raw,f.firstId);await applyApplicationRLSContext(raw,rawExecution)
      expect((await raw.query('SELECT count(*)::int AS count FROM memories WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{count:0}])
      expect((await raw.query("SELECT summary FROM memories WHERE id=$1 AND summary LIKE 'Recurring%'",[promoted.memoryId])).rows).toEqual([])
    })}finally{releaseApplicationTransactionBinding(raw);await raw.query('ROLLBACK');raw.release()}
    const second=await reader(f.secondId,wideTarget)
    expect(second.body).toMatchObject({id:promoted.memoryId})
    for(const rows of [second.index,second.search,second.prefix,second.ranked.rows])expect(rows).toContainEqual(expect.objectContaining({id:promoted.memoryId}))
    expect(second.count).toBe(1);expect(second.ranked.totalCount).toBe(1)
    expect((await f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,promoted.memoryId])).rows[0].source).toEqual(original)
  })

  it('holds protected memory in unproved system projections while ordinary native entries remain usable',async()=>{
    fixture=await persistentContextFixture();const f=fixture,history=await f.history(),episodes=createDbEpisodicStore(),authority=await f.modelContext()
    const episode=await episodes.create({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,topicLabel:'fictional system topic',summary:'Fictional protected system context',
      messageSpan:{fromSequence:1,toSequence:3,turnCount:3},authority,derivation:{producer:'fixture:system-parent',sources:history.flatMap(boundScopeSources)}})
    await f.pool.query('UPDATE episodic_memories SET access_count=1,survival_count=2 WHERE id=$1',[episode.id])
    const promoted=await episodes.promote!(episode.id,authority),memories=createDbMemoryStore(),first=await f.modelContext(f.firstId)
    const retained=(await readSessionContextRevisions(f.session.id,'episodic_memory',first,{includePromoted:true}))[0]
    expect(retained).toBeTruthy()
    const writer=await f.pool.connect();let privateId:string
    try{privateId=await runWithAgentAccess(first.execution.security.access,async()=>{
      await writer.query('BEGIN');await applyRLSGucs(writer,f.firstId);await applyApplicationRLSContext(writer,first.execution)
      await validateCallerScopeEvidence({sources:boundScopeSources(retained)},first.execution.security.ceiling,writer)
      const memory=await createMemory({workspaceId:f.workspaceId,userId:f.firstId,assistantId:f.assistantId,createdByUserId:f.firstId,summary:'Fictional private protected context',sensitivity:'internal',
        derivationTarget:{userId:f.firstId,assistantId:null},derivation:{producer:'fixture:private-system-parent',sources:boundScopeSources(retained)}},undefined,writer)
      await writer.query('COMMIT');return memory.id
    })}finally{releaseApplicationTransactionBinding(writer);await writer.query('ROLLBACK');writer.release()}
    const nativeShared=await f.memory('Fictional native shared content'),nativePrivate=await createMemory({workspaceId:f.workspaceId,userId:f.firstId,assistantId:f.assistantId,createdByUserId:f.firstId,summary:'Fictional native private content',sensitivity:'internal'})
    const ordinary={...executionToolContext(first.execution,{appId:'fixture'}),workspaceId:f.workspaceId,assistantKind:first.execution.assistant.kind},unproved={...ordinary,systemRead:true}
    expect(await memories.getById(ordinary,promoted.memoryId)).toMatchObject({id:promoted.memoryId})
    expect(await memories.getById(ordinary,privateId)).toMatchObject({id:privateId})
    for(const id of [promoted.memoryId,privateId]){
      expect(await memories.getById(unproved,id)).toBeNull()
      expect(await memories.getByIdSystem!(id)).toBeNull()
    }
    for(const id of [nativeShared.id,nativePrivate.id])expect(await memories.getByIdSystem!(id)).toMatchObject({id})
    const expected=[nativeShared.id,nativePrivate.id].sort()
    expect((await memories.getIndex(unproved)).map(row=>row.id).sort()).toEqual(expected)
    expect((await memories.search(unproved,{query:'fictional'})).map(row=>row.id).sort()).toEqual(expected)
    const ranked=await memories.getIndexRanked!(unproved,50)
    expect(ranked.rows.map(row=>row.id).sort()).toEqual(expected);expect(ranked.totalCount).toBe(2);expect(await memories.count(unproved)).toBe(2)
    expect((await memories.getIndexSystem!(f.assistantId,f.firstId)).map(row=>row.id)).toEqual([nativePrivate.id])
    expect((await memories.getWorkspaceIndexSystem!(f.assistantId,f.workspaceId)).map(row=>row.id).sort()).toEqual(expected)
    expect((await getAppPool().query(`SELECT has_function_privilege(current_user,'application_memory_field_ancestry_before_context(uuid,uuid,text)','EXECUTE') AS previous,
      has_function_privilege(current_user,'application_memory_unproven_ancestry_allows(uuid,uuid,text)','EXECUTE') AS private,
      has_function_privilege(current_user,'application_memory_field_ancestry_allows(uuid,uuid,text)','EXECUTE') AS current`)).rows[0]).toEqual({previous:false,private:false,current:true})
  })

  it('rechecks a cached native memory persistent parent from another current destination session',async()=>{
    fixture=await persistentContextFixture()
    const f=fixture,setup=await f.modelContext(),history=await f.history(),store=createDbEpisodicStore()
    const episode=await store.create({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
      topicLabel:'fictional retained topic',summary:'Fictional retained context',messageSpan:{fromSequence:1,toSequence:3,turnCount:3},authority:setup,
      derivation:{producer:'fixture:cached-native-parent',sources:history.flatMap(boundScopeSources)}})
    await f.pool.query('UPDATE episodic_memories SET access_count=1,survival_count=2 WHERE id=$1',[episode.id])
    const promoted=await store.promote!(episode.id,setup)
    const source=(await f.pool.query<{source:ScopeSource}>("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,promoted.memoryId])).rows[0].source
    const target=await createWorkspaceChatSession({workspaceId:f.workspaceId,assistantId:f.assistantId,starterUserId:f.ownerId,effectiveClearance:'internal',authenticatedHuman:true})
    const wideTarget=await createWorkspaceChatSession({workspaceId:f.workspaceId,assistantId:f.assistantId,starterUserId:f.ownerId,effectiveClearance:'confidential',authenticatedHuman:true})
    const currentMessage=await addSessionMessage({sessionId:target.id,role:'user',content:[{type:'text',text:'Fictional current request'}],scope:f.envelope})
    const stream=vi.fn<StreamFn>(async function*(){yield{type:'text_delta',text:'{"topic_label":"fictional retained topic","state":"resume","confidence":0.9}'}})
    const provider:LLMProvider={name:'fixture',models:['fixture'],stream,createSession(){throw new Error('Unused synthetic provider session')}}
    async function current(userId:typeof f.firstId,session:typeof f.session){return{execution:await f.execution(userId,session),accumulator:new ContextScopeAccumulator()}}
    async function classify(authority:Awaited<ReturnType<typeof current>>){
      const context={...executionToolContext(authority.execution,{appId:'fixture'}),scopeAccumulator:authority.accumulator}
      return classifyTopic(bindScopeSources({provider,model:'fixture',recentUserTurns:[{text:'Fictional retained context',topicLabel:'fictional retained topic'}],
        currentMessage:'Fictional current request',knownTopicsThisSession:['fictional retained topic'],replyToText:null,authority,
        assertInputAuthority:()=>assertSourceModelInputAuthority(context)},[source,...boundScopeSources(currentMessage)]))
    }
    expect(await classify(await current(f.firstId,target))).toMatchObject({topic_label:'fictional retained topic'})
    expect(stream).toHaveBeenCalledOnce()
    const metadataReader=await getAppPool().connect(),metadataExecution=await f.execution(f.firstId,target)
    try {await runWithAgentAccess(metadataExecution.security.access,async()=>{
      await metadataReader.query('BEGIN');await applyRLSGucs(metadataReader,f.firstId);await applyApplicationRLSContext(metadataReader,metadataExecution)
      expect((await metadataReader.query(`SELECT has_function_privilege(current_user,'application_scope_lineage(uuid,text[],uuid[],text[])','EXECUTE') AS raw,
        has_function_privilege(current_user,'read_scope_source(uuid,text,uuid)','EXECUTE') AS owner,
        has_function_privilege(current_user,'read_admitted_session_context_dependencies(uuid,text[],uuid[],text[])','EXECUTE') AS admitted`)).rows[0]).toEqual({raw:false,owner:false,admitted:true})
      const rows=(await metadataReader.query('SELECT * FROM read_admitted_session_context_dependencies($1,$2,$3,$4)',[f.workspaceId,['memory'],[promoted.memoryId],['1']])).rows
      expect(rows).toHaveLength(1);expect(rows[0].source).toMatchObject({resourceKind:'session_context_revision',held:false,version:'1'})
      expect(rows[0].source).not.toHaveProperty('content')
      await metadataReader.query('SAVEPOINT invalid_version')
      await expect(metadataReader.query('SELECT * FROM read_admitted_session_context_dependencies($1,$2,$3,$4)',[f.workspaceId,['session_context_revision'],[rows[0].source.resourceId],['2']])).rejects.toMatchObject({code:'42501'})
      await metadataReader.query('ROLLBACK TO SAVEPOINT invalid_version')
    })}finally{releaseApplicationTransactionBinding(metadataReader);await metadataReader.query('ROLLBACK');metadataReader.release()}
    await f.pool.query("UPDATE sessions SET effective_clearance='confidential' WHERE id=$1",[f.session.id])
    const denied=await current(f.firstId,target)
    expect(await readSessionContextRevisions(f.session.id,'episodic_memory',denied,{includePromoted:true})).toEqual([])
    expect((await f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,promoted.memoryId])).rows[0].source).toEqual(source)
    await expect(classify(denied)).rejects.toMatchObject({reason:'authority_changed',retrySafe:false})
    expect(stream).toHaveBeenCalledOnce()
    expect(await classify(await current(f.secondId,wideTarget))).toMatchObject({topic_label:'fictional retained topic'})
    expect(stream).toHaveBeenCalledTimes(2)
    expect((await f.pool.query("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,promoted.memoryId])).rows[0].source).toEqual(source)
  })

  it('rejects an uncommitted native descendant after its source session contracts in the same transaction',async()=>{
    fixture=await persistentContextFixture()
    const f=fixture,history=await f.history(),episode=await createDbEpisodicStore().create({sessionId:f.session.id,userId:f.ownerId,assistantId:f.assistantId,
      topicLabel:'fictional transaction topic',summary:'Fictional transaction context',messageSpan:{fromSequence:1,toSequence:3,turnCount:3},authority:await f.modelContext(),
      derivation:{producer:'fixture:transaction-parent',sources:history.flatMap(boundScopeSources)}})
    const target=await createWorkspaceChatSession({workspaceId:f.workspaceId,assistantId:f.assistantId,starterUserId:f.ownerId,effectiveClearance:'internal',authenticatedHuman:true})
    const execution=await f.execution(f.firstId,target),writer=await f.pool.connect()
    try { await runWithAgentAccess(execution.security.access,async()=>{
      await writer.query('BEGIN')
      await applyRLSGucs(writer,f.firstId);await applyApplicationRLSContext(writer,execution)
      const memory=await createMemory({workspaceId:f.workspaceId,userId:null,assistantId:f.assistantId,summary:'Fictional uncommitted derivative',sensitivity:'internal',createdByUserId:f.firstId,
        derivation:{producer:'fixture:uncommitted-native',sources:boundScopeSources(episode)}},undefined,writer)
      const source=(await writer.query<{source:ScopeSource}>("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,memory.id])).rows[0].source
      expect((await f.pool.query('SELECT id FROM memories WHERE id=$1',[memory.id])).rowCount).toBe(0)
      const admitted=await validateCallerScopeEvidence({sources:[source]},execution.security.ceiling,writer)
      expect(admitted.sources).toContainEqual(expect.objectContaining({resourceKind:'session_context_revision',resourceId:boundScopeSources(episode)[0].resourceId}))
      await writer.query("UPDATE sessions SET effective_clearance='confidential' WHERE id=$1",[f.session.id])
      await expect(validateCallerScopeEvidence({sources:[source]},execution.security.ceiling,writer)).rejects.toMatchObject({reason:'caller_evidence_unavailable',retrySafe:false})
    }) } finally {releaseApplicationTransactionBinding(writer);await writer.query('ROLLBACK');writer.release()}
  })

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

  it('carries actual private caller evidence through a delegated consult accumulator, returned evidence and canonical transcript',async()=>{
    fixture=await persistentContextFixture();const f=fixture,parent=await f.execution(f.firstId)
    const memory=await createMemory({workspaceId:f.workspaceId,userId:f.firstId,assistantId:f.assistantId,createdByUserId:f.firstId,summary:'Fictional private caller evidence',sensitivity:'internal'})
    const snapshot=(await f.pool.query<{source:ScopeSource & {held:boolean}}>("SELECT read_scope_source($1,'memory',$2) AS source",[f.workspaceId,memory.id])).rows[0].source
    expect(snapshot.held).toBe(false)
    const source:ScopeSource={workspaceId:f.workspaceId,userId:f.firstId,assistantId:null,sensitivity:'internal',compartments:[],projectIds:[],resourceKind:'memory',resourceId:memory.id,version:memory.scopeVersion}
    expect(snapshot).toMatchObject(source)
    const answer:StreamFn=async function*(){yield{type:'message_start',model:'gemini-3.6-flash-pro'};yield{type:'text_delta',text:'Fictional private consult result'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}}
    const provider:LLMProvider={name:'fixture',models:['gemini-3.6-flash-pro'],stream:answer,createSession(options){return{send:()=>answer({model:options.model,systemPrompt:options.systemPrompt,messages:[]})}}}
    const returned:ScopeEvidence[]=[],execute=createCalleeExecutor({provider,tools:new Map(),memoryStore:createDbMemoryStore(),capabilityStore:createDbCapabilityStore()})
    const invocation:Parameters<typeof execute>[0]={callerUserId:f.firstId,callerAssistantId:f.assistantId,callerAccessCeiling:parent.security.ceiling,
      callerScopeEvidence:{sources:[source]},onScopeEvidence:evidence=>{returned.push(evidence)},calleeAssistantId:f.assistantId,
      expectedWorkspaceId:f.workspaceId,callerSessionId:f.session.id,question:memory.summary}
    expect(await execute(invocation)).toBe('Fictional private consult result')
    expect(returned).toContainEqual(expect.objectContaining({sources:expect.arrayContaining([source])}))
    const rows=(await f.pool.query(`SELECT m.id,s.user_id,s.visibility FROM session_messages m JOIN sessions s ON s.id=m.session_id
      JOIN scope_derivations d ON d.resource_kind='session_message' AND d.resource_id=m.id AND d.workspace_id=$1
      JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id
      WHERE m.role='assistant' AND edge.source_kind='memory' AND edge.source_id=$2`,[f.workspaceId,memory.id])).rows
    expect(rows.length).toBeGreaterThan(0)
    for(const row of rows)expect(row).toMatchObject({user_id:f.firstId,visibility:'personal'})
    const before=(await f.pool.query('SELECT count(*)::int n FROM session_messages WHERE workspace_id=$1',[f.workspaceId])).rows[0].n
    const revoked=await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 RETURNING user_id',[f.workspaceId,f.firstId])
    expect(revoked.rows).toEqual([{user_id:f.firstId}])
    await expect(execute(invocation)).rejects.toThrow()
    expect((await f.pool.query('SELECT count(*)::int n FROM session_messages WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(before)
  })

  it.each(['public-member','delegated-consult'] as const)('retains actual %s identity field and empty-domain evidence and stops current actor contraction before the provider',async(surface)=>{
    fixture=await persistentContextFixture();const f=fixture,parent=await f.execution(f.firstId)
    const self=await updateSelfEntityAttributes({userId:f.firstId,workspaceId:f.workspaceId,displayName:'Fictional attributed identity',
      attributes:{name:'Fictional attributed identity',role:'Fictional bounded planner'}})
    const prompts:string[]=[],returned:ScopeEvidence[]=[],identities:ScopeSource[][]=[]
    const answer:StreamFn=async function*(){yield{type:'message_start',model:'gemini-3.6-flash-pro'};yield{type:'text_delta',text:'Fictional attributed response'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}}
    const provider:LLMProvider={name:'fixture',models:['gemini-3.6-flash-pro'],stream:answer,createSession(options){prompts.push(JSON.stringify(options));return{send:()=>answer({model:options.model,systemPrompt:options.systemPrompt,messages:[]})}}}
    const memories=createDbMemoryStore(),readIdentity=memories.getIdentity.bind(memories)
    let contractAfterRead=false,invocationNumber=0
    memories.getIdentity=async(ctx,authority)=>{
      expect(authority?.execution.security.access.userId).toBe(f.firstId)
      expect(authority?.execution.assistant.id).toBe(f.assistantId)
      const rows=await readIdentity(ctx,authority)
      identities.push(boundScopeSources(rows))
      if(contractAfterRead)await f.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.firstId])
      return rows
    }
    const consult=createCalleeExecutor({provider,tools:new Map(),memoryStore:memories,capabilityStore:createDbCapabilityStore()})
    const invoke=async()=>{
      invocationNumber++
      if(surface==='delegated-consult')return consult({callerUserId:f.firstId,callerAssistantId:f.assistantId,callerAccessCeiling:parent.security.ceiling,
        onScopeEvidence:evidence=>returned.push(evidence),calleeAssistantId:f.assistantId,expectedWorkspaceId:f.workspaceId,callerSessionId:f.session.id,question:'Fictional attributed input'})
      const req=new EventEmitter(),res={statusCode:200,body:undefined as unknown,status(code:number){this.statusCode=code;return this},json(body:unknown){this.body=body;return this}}
      await executePublicTurn({provider,tools:new Map(),systemPrompt:'Fictional public member fixture',memoryStore:memories,capabilityStore:createDbCapabilityStore()},
        {assistantId:f.assistantId,identityNamespace:'api:fictional-member-key',contextScope:'internal-member',internalActor:{email:null,defaultUserId:f.firstId},credentialCurrent:async()=>true,
          body:{externalUserId:'fictional-attribution',sessionId:`fictional-member-session-${invocationNumber}`,message:'Fictional attributed input'}},req as never,res as never)
      expect(res.statusCode,JSON.stringify(res.body)).toBe(200);return JSON.stringify(res.body)
    }
    expect(await invoke()).toContain('Fictional attributed response')
    expect(prompts).toHaveLength(1);expect(prompts[0]).toContain('Fictional attributed identity');expect(prompts[0]).toContain('Fictional bounded planner')
    expect(identities[0].some(root=>root.resourceKind==='application_field')).toBe(true)
    if(surface==='delegated-consult')expect(returned.some(evidence=>evidence.sources?.some(root=>root.resourceKind==='application_field'))).toBe(true)
    const retained=(await f.pool.query(`SELECT m.id,edge.source_kind,edge.source_id FROM session_messages m
      JOIN scope_derivations d ON d.resource_kind='session_message' AND d.resource_id=m.id AND d.workspace_id=m.workspace_id
      JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id
      WHERE m.workspace_id=$1 AND m.role='assistant'`,[f.workspaceId])).rows
    expect(retained.some(row=>row.source_kind==='entity'&&row.source_id===self.id)).toBe(true)
    for(const field of identities[0].filter(root=>root.resourceKind==='application_field'))expect(retained.some(row=>row.source_kind==='application_field'&&row.source_id===field.resourceId)).toBe(true)
    // Empty identity results still retain the admitted self=false field/query domain.
    await updateSelfEntityAttributes({userId:f.firstId,workspaceId:f.workspaceId,displayName:'Fictional attributed identity',attributes:{self:false}})
    expect(await invoke()).toContain('Fictional attributed response')
    expect(prompts).toHaveLength(2);expect(prompts[1]).not.toContain('Fictional bounded planner')
    expect(identities[1].some(root=>root.resourceKind==='application_field')).toBe(true)
    const emptyRetained=(await f.pool.query(`SELECT edge.source_id,edge.source_version FROM session_messages m
      JOIN scope_derivations d ON d.resource_kind='session_message' AND d.resource_id=m.id AND d.workspace_id=m.workspace_id
      JOIN scope_derivation_sources edge ON edge.workspace_id=d.workspace_id AND edge.derivation_id=d.id
      WHERE m.workspace_id=$1 AND m.role='assistant' AND edge.source_kind='application_field'`,[f.workspaceId])).rows
    for(const root of identities[1].filter(root=>root.resourceKind==='application_field'))expect(emptyRetained).toContainEqual({source_id:root.resourceId,source_version:root.version})
    const before=(await f.pool.query("SELECT count(*)::int n FROM session_messages WHERE workspace_id=$1 AND role='assistant'",[f.workspaceId])).rows[0].n
    contractAfterRead=true
    await expect(invoke()).rejects.toThrow()
    expect(prompts).toHaveLength(2)
    expect((await f.pool.query("SELECT count(*)::int n FROM session_messages WHERE workspace_id=$1 AND role='assistant'",[f.workspaceId])).rows[0].n).toBe(before)
  })

  it('keeps an actual consult identity inside its pinned parent ceiling without substituting the callee owner',async()=>{
    fixture=await persistentContextFixture();const f=fixture,parent=await f.execution(f.firstId)
    await updateSelfEntityAttributes({userId:f.firstId,workspaceId:f.workspaceId,displayName:'Fictional hidden identity',attributes:{name:'Fictional hidden identity'}})
    const prompts:string[]=[],answer:StreamFn=async function*(){yield{type:'message_start',model:'gemini-3.6-flash-pro'};yield{type:'text_delta',text:'Fictional public bounded response'};yield{type:'message_end',stopReason:'end_turn',usage:{inputTokens:1,outputTokens:1}}}
    const provider:LLMProvider={name:'fixture',models:['gemini-3.6-flash-pro'],stream:answer,createSession(options){prompts.push(JSON.stringify(options));return{send:()=>answer({model:options.model,systemPrompt:options.systemPrompt,messages:[]})}}}
    const memories=createDbMemoryStore(),authority=await f.delegatedExecution(f.firstId),accumulator=new ContextScopeAccumulator()
    await expect(memories.getIdentity({...authority.security.access,userId:f.secondId},{execution:authority,accumulator})).rejects.toMatchObject({code:'scope_evidence_missing'})
    const substituted={...authority,identity:{...authority.identity,parentCeiling:{...parent.security.ceiling,userId:f.secondId}}} as typeof authority
    await expect(memories.getIdentity(authority.security.access,{execution:substituted,accumulator})).rejects.toMatchObject({code:'scope_evidence_missing'})
    const pinned={...parent.security.ceiling,clearance:'public' as const},readIdentity=memories.getIdentity.bind(memories)
    let parentCurrent=true,contractParentAfterRead=false
    const originalParent=createAuthorityLease(pinned,async()=>parentCurrent?pinned:null)
    memories.getIdentity=async(ctx,current)=>{
      expect(current?.execution.identity).toMatchObject({kind:'delegated',actorUserId:f.firstId,parentCeiling:pinned})
      expect(current?.execution.assistant.id).toBe(f.assistantId)
      const rows=await readIdentity(ctx,current)
      if(contractParentAfterRead)parentCurrent=false
      return rows
    }
    const execute=createCalleeExecutor({provider,tools:new Map(),memoryStore:memories,capabilityStore:createDbCapabilityStore()})
    const invoke=()=>runWithAuthorityLease(originalParent,()=>execute({callerUserId:f.firstId,callerAssistantId:f.assistantId,callerAccessCeiling:pinned,
      calleeAssistantId:f.assistantId,expectedWorkspaceId:f.workspaceId,callerSessionId:f.session.id,question:'Fictional public bounded input'}))
    expect(await invoke()).toBe('Fictional public bounded response')
    expect(prompts).toHaveLength(1);expect(prompts[0]).not.toContain('Fictional hidden identity')
    const retained=(await f.pool.query(`SELECT m.id,s.user_id,s.visibility,m.sensitivity FROM session_messages m JOIN sessions s ON s.id=m.session_id
      WHERE m.workspace_id=$1 AND m.role='assistant'`,[f.workspaceId])).rows
    expect(retained).toHaveLength(1);expect(retained[0]).toMatchObject({user_id:f.firstId,visibility:'personal',sensitivity:'public'})
    contractParentAfterRead=true
    await expect(invoke()).rejects.toMatchObject({reason:'authority_changed'})
    expect(prompts).toHaveLength(1)
    expect((await f.pool.query("SELECT id FROM session_messages WHERE workspace_id=$1 AND role='assistant'",[f.workspaceId])).rows.map(row=>row.id)).toEqual(retained.map(row=>row.id))
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
