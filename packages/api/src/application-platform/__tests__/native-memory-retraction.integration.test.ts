/** Active-only native correction; legacy/retracted history compatibility is a separate gate. */
import {describe,it,expect,beforeEach,afterEach,afterAll} from 'vitest'
import type {PoolClient} from 'pg'
import {writeFile} from 'node:fs/promises'
import {ContextScopeAccumulator,boundScopeSources,createCorrectionTools,executionToolContext} from '@use-brian/core'
import {getAppPool,getPool} from '../../db/client.js'
import {createDbMemoryStore} from '../../db/memory-store.js'
import {createMemoryRetractionStore} from '../../db/retraction-store.js'
import {createSoftDeleteStore} from '../../db/soft-delete-store.js'
import {createSensitivityReclassificationStore} from '../../db/sensitivity-reclassification-store.js'
import {authSessionStore} from '../../db/auth-session-store.js'
import {createPersonalWebSession} from '../../db/sessions.js'
import {findAssistantById} from '../../db/users.js'
import {resolveExecutionContextSystem} from '../../context-scope/execution-context.js'
import {readRetainedContextFrame,writeRetainedContextFrame} from '../../db/session-context-revisions.js'
import {persistentContextFixture} from './fixtures/persistent-context.js'
import {sourceModeFixture} from './fixtures/source-modes.js'
import {originalMemoryAuthority,saveOriginalMemory} from './fixtures/retained-memory.js'
import {executeWorkspaceScopeReview} from '../../workspace-access/scope-review.js'
import {configureConnectorSourceRuntimeFactory} from '../source-runtime.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),memoryStore=createDbMemoryStore()
afterAll(async()=>{await getAppPool().end();await pool.end()})
describe.sequential('[COMP:corrections/retraction-store] active native Memory retraction',()=>{
 let fixture:Awaited<ReturnType<typeof persistentContextFixture>>,userId:string,assistantId:string,workspaceId:string
 let nativeSession:Awaited<ReturnType<typeof createPersonalWebSession>>,credential:Readonly<{userId:string;sessionId:string;authVersion:number}>
 beforeEach(async()=>{
  fixture=await persistentContextFixture();userId=fixture.ownerId;assistantId=fixture.assistantId;workspaceId=fixture.workspaceId
  const auth=await authSessionStore.create(userId,{deviceLabel:'Fictional correction device',userAgent:'Fixture',ipAddress:'127.0.0.1'})
  if(!auth)throw new Error('Missing actual correction auth session')
  credential=Object.freeze({userId,sessionId:auth.id,authVersion:auth.authVersion})
  nativeSession=await createPersonalWebSession({assistantId,userId,workspaceId,channelType:'web',channelId:crypto.randomUUID(),appOrigin:'chat'},
   {actorUserId:userId,authSessionId:auth.id,authVersion:auth.authVersion})
 })
 afterEach(async()=>{await fixture?.cleanup()})
 async function authority(){
  const assistant=await findAssistantById(assistantId);if(!assistant)throw new Error('Missing actual correction assistant')
  const resolved=await resolveExecutionContextSystem({userId,workspaceId,assistant,memberMode:'member',sharedAudience:false,session:nativeSession,sessionAuthority:nativeSession,
   identity:{kind:'attended',principal:{kind:'workspace_member',userId,authenticationKind:'native_session'}},ownership:{kind:'workspace',workspaceId},
   lifecycle:{sessionId:nativeSession.id,sessionPersisted:true,channelType:'web',channelId:nativeSession.channelId,abortSignal:new AbortController().signal},
   credentialCurrent:async()=>!!await authSessionStore.validateAccess(credential)})
  return{execution:resolved.executionContext,accumulator:new ContextScopeAccumulator()}
 }
 async function targetState(id:string,version:string){return(await pool.query(`SELECT workspace_id AS "workspaceId",resource_kind AS "resourceKind",resource_id AS "resourceId",resource_version AS "resourceVersion",review_state AS "reviewState",classification_revision::text AS "classificationRevision",holding_reason AS "holdingReason" FROM scope_resource_states WHERE workspace_id=$1 AND resource_kind='memory' AND resource_id=$2 AND resource_version=$3`,[workspaceId,id,version])).rows[0]??null}
 async function typedReceipt(id:string){return(await pool.query('SELECT native_memory_transition AS value FROM correction_audit WHERE workspace_id=$1 AND row_id=$2 AND native_memory_transition IS NOT NULL',[workspaceId,id])).rows[0].value}
 async function createMemory(params:Omit<Parameters<typeof memoryStore.create>[0],'authority'>){return memoryStore.create({...params,workspaceId,authority:await authority()})}
 async function updateMemory(id:string,updates:{summary:string}){
  const current=await authority(),access=current.execution.security.access,prior=await memoryStore.getById(access,id,current);expect(prior).not.toBeNull()
  const next=await memoryStore.update(id,updates,access,{authority:current,expectedVersion:prior!.scopeVersion!,writeFields:['summary']});expect(next).not.toBeNull();return next
 }
 async function withNativeTransaction<T>(action:(client:PoolClient)=>Promise<T>){return readRetainedContextFrame(await authority(),[],action)}
 async function retractUsingTool(memoryId:string,current?:Awaited<ReturnType<typeof authority>>){
  const host=current??await authority(),tools=createCorrectionTools({retraction:createMemoryRetractionStore(),softDelete:createSoftDeleteStore(),reclassify:createSensitivityReclassificationStore(),
   resolveWorkspaceRole:async(id,workspace)=>(await pool.query('SELECT role FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspace,id])).rows[0]?.role??null})
  return tools.find(tool=>tool.name==='retractMemory')!.execute({memory_id:memoryId,reason:'Fictional native correction'},
   {...executionToolContext(host.execution,{appId:'fictional-correction'}),scopeAccumulator:host.accumulator})
 }
  it('memories: canonical retraction commits an immutable receipt, rejects forgery and reports postcommit uncertainty honestly', async () => {
    const original = await createMemory({ assistantId, userId, summary: 'Fictional original fact', sensitivity: 'internal', createdByUserId: userId })
    const memory = (await updateMemory(original.id, { summary: 'Fictional withdrawn fact' }))!
    const unrelated = await createMemory({ assistantId, userId, summary: 'Fictional unrelated fact', sensitivity: 'internal', createdByUserId: userId })
    const childHost = await authority(), parent = await memoryStore.getById(childHost.execution.security.access, memory.id, childHost)
    expect(parent).not.toBeNull(); childHost.accumulator.note({ sources: boundScopeSources(parent!) })
    const child = await memoryStore.create({ assistantId, userId, workspaceId, summary: 'Fictional derived child', sensitivity: 'internal', createdByUserId: userId, authority: childHost })
    const current = await authority(), access = current.execution.security.access
    const extra = await memoryStore.getById(access, unrelated.id, current)
    expect(extra).not.toBeNull(); current.accumulator.note({ sources: boundScopeSources(extra!) })
    const boundarySnapshot=async()=>({
      policy:(await pool.query('SELECT to_jsonb(p) AS policy FROM workspace_access_policies p WHERE workspace_id=$1',[workspaceId])).rows,
      transitions:(await pool.query('SELECT to_jsonb(t) AS transition FROM native_memory_successor_transitions t WHERE workspace_id=$1 AND (predecessor_id=ANY($2::uuid[]) OR successor_id=ANY($2::uuid[])) ORDER BY predecessor_id',[workspaceId,[original.id,memory.id,child.id,unrelated.id]])).rows,
      rows:(await pool.query('SELECT id,scope_version,scope_held,valid_from,valid_to,superseded_by,retracted_at,updated_at FROM memories WHERE id=ANY($1::uuid[]) ORDER BY id',[[original.id,memory.id,child.id,unrelated.id]])).rows,
      states:(await pool.query(`SELECT to_jsonb(s) AS state FROM scope_resource_states s WHERE workspace_id=$1 AND resource_kind='memory' AND resource_id=ANY($2::uuid[]) ORDER BY resource_id`,[workspaceId,[original.id,memory.id,child.id,unrelated.id]])).rows,
      lineage:(await pool.query(`SELECT to_jsonb(d) AS derivation FROM scope_derivations d WHERE workspace_id=$1 AND resource_kind='memory' AND resource_id=ANY($2::uuid[]) ORDER BY resource_id,resource_version`,[workspaceId,[original.id,memory.id,child.id,unrelated.id]])).rows,
      edges:(await pool.query(`SELECT to_jsonb(s) AS source FROM scope_derivation_sources s JOIN scope_derivations d ON d.workspace_id=s.workspace_id AND d.id=s.derivation_id WHERE d.workspace_id=$1 AND d.resource_kind='memory' AND d.resource_id=ANY($2::uuid[]) ORDER BY d.resource_id,s.source_kind,s.source_id,s.source_version`,[workspaceId,[original.id,memory.id,child.id,unrelated.id]])).rows,
      receipts:(await pool.query('SELECT id,native_memory_transition FROM correction_audit WHERE workspace_id=$1 AND row_id=ANY($2::uuid[]) ORDER BY id',[workspaceId,[original.id,memory.id,child.id,unrelated.id]])).rows,
    })
    const boundaryBefore=await boundarySnapshot()
    const vectorBefore = (await pool.query('SELECT search_vector::text AS vector FROM memories WHERE id=$1', [memory.id])).rows[0].vector
    const observed = await memoryStore.getById(access, memory.id, current)
    expect(observed).not.toBeNull()
    const sources = boundScopeSources(observed!); current.accumulator.note({ sources })
    const owner=await pool.connect()
    try{
      await owner.query('BEGIN')
      await owner.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.v2_assistant_id',$2,true)",[userId,assistantId])
      await expect(owner.query('SELECT retract_admitted_native_memory($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
        [workspaceId,memory.id,memory.scopeVersion,assistantId,nativeSession.id,'a'.repeat(64),'Fictional refused owner correction',new Date(),JSON.stringify(current.accumulator.evidence)])).rejects.toMatchObject({code:'22023',message:'scope_evidence_missing'})
    }finally{await owner.query('ROLLBACK');owner.release()}
    expect(await boundarySnapshot()).toEqual(boundaryBefore)
    const result = await retractUsingTool(memory.id, current)
    expect(result.isError, JSON.stringify(result)).not.toBe(true)
    expect(result.data).toEqual({ memoryId: memory.id, retractedAt: expect.any(String) })
    const row = (await pool.query('SELECT summary,retracted_at,valid_to,scope_version::text AS version,search_vector::text AS vector FROM memories WHERE id=$1', [memory.id])).rows[0]
    expect(row).toMatchObject({ summary: 'Fictional withdrawn fact', retracted_at: expect.any(Date), valid_to: expect.any(Date), version: String(Number(memory.scopeVersion) + 1) })
    expect(row.vector).toBe(vectorBefore)
    expect((await pool.query("SELECT has_function_privilege('app_user','retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
    await expect(getAppPool().query('SELECT retract_admitted_native_memory($1,$2,$3,$4,$5,$6,$7,$8)',
      [workspaceId,memory.id,memory.scopeVersion,assistantId,nativeSession.id,'a'.repeat(64),'Fictional private legacy attempt',new Date()])).rejects.toMatchObject({code:'42501'})
    expect((await getAppPool().query("SELECT has_function_privilege(current_user,'retract_admitted_native_memory(uuid,uuid,text,uuid,uuid,text,text,timestamptz,jsonb)','EXECUTE') AS admitted")).rows).toEqual([{admitted:true}])
    await expect(getAppPool().query('SELECT retract_admitted_native_memory($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
      [workspaceId,memory.id,memory.scopeVersion,assistantId,nativeSession.id,'a'.repeat(64),'Fictional unbound attempt',new Date(),JSON.stringify(current.accumulator.evidence)])).rejects.toMatchObject({code:'22023',message:'scope_evidence_missing'})
    const receipt = (await pool.query("SELECT id,native_memory_transition AS transition FROM correction_audit WHERE workspace_id=$1 AND row_id=$2 AND native_memory_transition IS NOT NULL", [workspaceId, memory.id])).rows[0]
    expect(receipt.transition).toMatchObject({ kind: 'native_memory_retract_v1', priorVersion: memory.scopeVersion, resultVersion: row.version,
      actorId: userId, assistantId, sessionId: nativeSession.id, writeFields: ['retracted_at', 'retracted_reason', 'retracted_by', 'valid_to'], contextFingerprint: expect.stringMatching(/^[a-f0-9]{64}$/),
      reasonEvidence: expect.objectContaining({ sensitivity: 'internal', sources: expect.arrayContaining([expect.objectContaining({ resourceKind: 'memory', resourceId: unrelated.id, version: unrelated.scopeVersion })]) }),
      originalRoots: expect.arrayContaining([{ kind: 'memory', id: memory.id, version: memory.scopeVersion }, { kind: 'memory', id: unrelated.id, version: unrelated.scopeVersion }]) })
    expect(receipt.transition.resultHoldState).toEqual(await targetState(memory.id,row.version))
    expect(receipt.transition.resultHoldState).toMatchObject({workspaceId,resourceKind:'memory',resourceId:memory.id,resourceVersion:row.version,reviewState:'held',classificationRevision:expect.stringMatching(/^[1-9][0-9]*$/),holdingReason:'source_changed'})
    if(process.env.NATIVE_RETRACTION_BOUNDARY_ARTIFACT){
      await writeFile(process.env.NATIVE_RETRACTION_BOUNDARY_ARTIFACT,JSON.stringify({
        ids:{workspaceId,originalId:original.id,retractedSuccessorId:memory.id,childId:child.id,unrelatedId:unrelated.id},
        before:boundaryBefore,after:await boundarySnapshot(),
      },null,2)+'\n',{flag:'wx'})
    }
    await expect(withNativeTransaction(client => client.query(`INSERT INTO correction_audit(workspace_id,action,primitive,row_id,actor_user_id,native_memory_transition)
      VALUES($1,'retract','memory',$2,$3,'{"kind":"native_memory_retract_v1"}')`, [workspaceId, memory.id, userId]))).rejects.toThrow('scope_evidence_immutable')
    await expect(pool.query("UPDATE correction_audit SET reason='Forged replacement' WHERE id=$1", [receipt.id])).rejects.toThrow('scope_evidence_immutable')
    await expect(pool.query("UPDATE correction_audit SET native_memory_transition=jsonb_set(native_memory_transition,'{resultHoldState}','null') WHERE id=$1",[receipt.id])).rejects.toThrow('scope_evidence_immutable')
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1', [child.id])).rows[0].scope_held).toBe(true)
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1', [unrelated.id])).rows[0].scope_held).toBe(false)
    expect((await pool.query('SELECT summary FROM memories WHERE id=$1', [original.id])).rows[0].summary).toBe('Fictional original fact')
    expect((await pool.query("SELECT read_scope_source($1,'correction_audit',$2) AS source", [workspaceId, receipt.id])).rows[0].source).toBeNull()
    await expect(readRetainedContextFrame(await authority(), sources, async () => 'An old fact must not be reused')).rejects.toThrow()
    const heldHost = await authority()
    await expect(memoryStore.getById(heldHost.execution.security.access, memory.id, heldHost)).rejects.toMatchObject({ code: 'scope_source_changed' })
    await pool.query(`UPDATE correction_audit SET reason='Personal data erased',row_snapshot='{"erased":true}',detail='{"erased":true}' WHERE id=$1`, [receipt.id])
    expect((await pool.query("SELECT read_scope_source($1,'correction_audit',$2) AS source", [workspaceId, receipt.id])).rows[0].source).toBeNull()

    const uncertainMemory = await createMemory({ assistantId, userId, summary: 'Fictional uncertain correction', sensitivity: 'internal', createdByUserId: userId })
    const uncertainHost = await authority(), originals = new Map<PoolClient, PoolClient['query']>(), dispatched = new WeakSet<PoolClient>()
    let revoked = 0
    const trace = (client: PoolClient) => {
      if (originals.has(client)) return
      const original = client.query; originals.set(client, original)
      client.query = function (...args: unknown[]) {
        const sql = typeof args[0] === 'string' ? args[0] : ''
        if (sql.includes('SELECT retract_admitted_native_memory(')) dispatched.add(client)
        const pending = Reflect.apply(original, client, args)
        if (sql === 'COMMIT' && dispatched.has(client)) {
          dispatched.delete(client)
          return Promise.resolve(pending).then(async value => { revoked++; expect(await authSessionStore.revokeForUser(userId, credential.sessionId)).toBe(true); return value })
        }
        return pending
      } as typeof client.query
    }
    getAppPool().on('acquire', trace)
    let uncertain
    try { uncertain = await retractUsingTool(uncertainMemory.id, uncertainHost) }
    finally { getAppPool().off('acquire', trace); for (const [client, original] of originals) client.query = original }
    expect(revoked).toBe(1)
    expect(uncertain!.isError).toBe(true)
    expect(String(uncertain!.data)).toContain('may have committed')
    expect(String(uncertain!.data)).toContain('Do not repeat')
    expect(String(uncertain!.data)).not.toMatch(/nothing was saved|nothing changed|Fictional uncertain correction/i)
    expect((await pool.query('SELECT retracted_at FROM memories WHERE id=$1', [uncertainMemory.id])).rows[0].retracted_at).toBeInstanceOf(Date)
    expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1 AND row_id=$2 AND native_memory_transition IS NOT NULL', [workspaceId, uncertainMemory.id])).rows).toHaveLength(1)
  })

  it('memories: canonical retraction refuses stale versions, actor changes and lifecycle WRITE contraction without a partial receipt', async () => {
    const original = await createMemory({ assistantId, userId, summary: 'Fictional earlier fact', sensitivity: 'internal', createdByUserId: userId })
    const memory = (await updateMemory(original.id, { summary: 'Fictional unchanged fact' }))!
    const childHost = await authority(), parent = await memoryStore.getById(childHost.execution.security.access, memory.id, childHost)
    expect(parent).not.toBeNull(); childHost.accumulator.note({ sources: boundScopeSources(parent!) })
    const child = await memoryStore.create({ assistantId, userId, workspaceId, summary: 'Fictional rollback child', sensitivity: 'internal', createdByUserId: userId, authority: childHost })
    const current = await authority(), repo = createMemoryRetractionStore()
    const input = { workspaceId, memoryId: memory.id, retractedBy: userId, reason: 'Fictional denied correction', now: new Date(), operation: { authority: current, expectedVersion: memory.scopeVersion! } }
    const snapshot = async () => (await pool.query('SELECT id,summary,retracted_at,valid_to,scope_version,scope_held,search_vector::text AS vector FROM memories WHERE id=ANY($1::uuid[]) ORDER BY id', [[memory.id, child.id]])).rows
    const before = await snapshot()
    const holding=async()=>({states:(await pool.query('SELECT to_jsonb(s) AS state FROM scope_resource_states s WHERE workspace_id=$1 ORDER BY resource_kind,resource_id,resource_version',[workspaceId])).rows,policy:(await pool.query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[workspaceId])).rows})
    const holdingBefore=await holding()
    await expect(repo.applySoftRetract({ ...input, retractedBy: fixture.firstId })).rejects.toMatchObject({ code: 'scope_evidence_missing' })
    const actual = await memoryStore.getById(current.execution.security.access, memory.id, current)
    expect(actual).not.toBeNull(); current.accumulator.note({ sources: boundScopeSources(actual!) })
    const reasonInputs = JSON.stringify(current.accumulator.evidence)
    await expect(writeRetainedContextFrame(current, current.accumulator.evidence.sources ?? [], client => client.query('SELECT retract_admitted_native_memory($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)',
      [workspaceId, memory.id, '0', assistantId, nativeSession.id, 'a'.repeat(64), input.reason, input.now, reasonInputs]))).rejects.toThrow('scope_source_changed')
    await expect(writeRetainedContextFrame(current, current.accumulator.evidence.sources ?? [], async client => {
      const receipt = await client.query('SELECT retract_admitted_native_memory($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) AS receipt',
        [workspaceId, memory.id, memory.scopeVersion, assistantId, nativeSession.id, 'a'.repeat(64), input.reason, input.now, reasonInputs])
      expect(receipt.rows[0].receipt).toBeTruthy()
      throw new Error('Fictional transaction rollback after the canonical correction')
    })).rejects.toThrow('Fictional transaction rollback')
    expect(await holding()).toEqual(holdingBefore)
    expect(await snapshot()).toEqual(before)
    expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1 AND row_id=$2', [workspaceId, memory.id])).rows).toEqual([])
    const restricted = await createMemory({ assistantId, userId, summary: 'Fictional restricted reason input', sensitivity: 'confidential', createdByUserId: userId })
    const restrictedHost = await authority(), restrictedRead = await memoryStore.getById(restrictedHost.execution.security.access, restricted.id, restrictedHost)
    expect(restrictedRead).not.toBeNull(); restrictedHost.accumulator.note({ sources: boundScopeSources(restrictedRead!) })
    await expect(repo.applySoftRetract({ ...input, operation: { authority: restrictedHost, expectedVersion: memory.scopeVersion! } })).rejects.toMatchObject({ code: 'scope_visibility_incompatible' })
    const scalarHost = await authority(); scalarHost.accumulator.note({ sensitivity: 'confidential' })
    await expect(repo.applySoftRetract({ ...input, operation: { authority: scalarHost, expectedVersion: memory.scopeVersion! } })).rejects.toMatchObject({ code: 'scope_visibility_incompatible' })
    expect(await snapshot()).toEqual(before)
    expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1 AND row_id=$2', [workspaceId, memory.id])).rows).toEqual([])
    let registered = false
    try {
      await pool.query(`CREATE FUNCTION fixture_retraction_catalog(w uuid,o jsonb,t text) RETURNS jsonb
       LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       SELECT jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion','1','policyVersion','1',
        'fieldKeys',application_memory_field_keys(),'fields',(SELECT jsonb_agg(jsonb_build_object('key',key,'read','[]'::jsonb,
         'write',CASE WHEN key='retracted_reason' THEN '[["editor"]]'::jsonb ELSE '[]'::jsonb END,'releaseReadTo','[]'::jsonb,'releaseWriteTo','[]'::jsonb) ORDER BY key) FROM unnest(application_memory_field_keys()) key),
        'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','public','compartments','[]'::jsonb,'projectIds','[]'::jsonb)) $$;
       CREATE FUNCTION fixture_retraction_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
       LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
       SELECT (fixture_retraction_catalog(w,o,t)-'scope')||jsonb_build_object('recordVersion',m.scope_version::text,'source',read_scope_source(w,'memory',m.id)) FROM memories m WHERE m.workspace_id=w AND m.id=i::uuid $$;
       REVOKE ALL ON FUNCTION fixture_retraction_catalog(uuid,jsonb,text),fixture_retraction_reader(uuid,jsonb,text,text) FROM PUBLIC;
       INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
        VALUES('native','1',ARRAY['editor'],'fixture_retraction_reader(uuid,jsonb,text,text)'::regprocedure,'fixture_retraction_catalog(uuid,jsonb,text)'::regprocedure)`)
      registered = true
      await pool.query(`INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{"kind":"native","moduleKey":"native"}','memory','native')`, [workspaceId])
      await pool.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'editor',$2)`, [workspaceId, userId])
      // A catalog registration invalidates previous field evidence. Create this
      // exact-field revocation target under the installed contract and grant.
      const fieldTarget = await createMemory({ assistantId, userId, summary: 'Fictional field policy target', sensitivity: 'internal', createdByUserId: userId })
      const fieldBefore = (await pool.query('SELECT retracted_at,valid_to,scope_version,scope_held FROM memories WHERE id=$1', [fieldTarget.id])).rows[0]
      const granted = await repo.readMemoryForRetraction(workspaceId, fieldTarget.id, await authority())
      expect(granted?.scopeVersion).toBe(fieldTarget.scopeVersion)
      const fieldMask = await withNativeTransaction(client => client.query(`SELECT read_native_application_field_mask($1,'{"kind":"native","moduleKey":"native"}','memory',$2,$3) AS mask`, [workspaceId, fieldTarget.id, granted!.scopeVersion]))
      expect(fieldMask.rows[0].mask.writeFields).toEqual(expect.arrayContaining(['retracted_at', 'retracted_reason', 'retracted_by', 'valid_to']))
      await pool.query("UPDATE application_native_role_assignments SET status='revoked' WHERE workspace_id=$1 AND module_key='native'", [workspaceId])
      await expect(repo.applySoftRetract({ ...input, memoryId: fieldTarget.id, operation: { authority: await authority(), expectedVersion: granted!.scopeVersion! } })).rejects.toThrow('scope_operation_denied')
      expect((await pool.query('SELECT retracted_at,valid_to,scope_version,scope_held FROM memories WHERE id=$1', [fieldTarget.id])).rows[0]).toEqual(fieldBefore)
      expect(await snapshot()).toEqual(before)
      expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1 AND row_id=ANY($2::uuid[])', [workspaceId, [memory.id,fieldTarget.id]])).rows).toEqual([])
    } finally {
      await pool.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'", [workspaceId])
      await pool.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'", [workspaceId])
      if (registered) await pool.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
      await pool.query('DROP FUNCTION IF EXISTS fixture_retraction_reader(uuid,jsonb,text,text);DROP FUNCTION IF EXISTS fixture_retraction_catalog(uuid,jsonb,text)')
    }
  })


 it('refuses a revoked initiating credential before dispatch without lifecycle, descendant or receipt effects',async()=>{
  const memory=await createMemory({assistantId,userId,summary:'Fictional revoked correction',sensitivity:'internal',createdByUserId:userId}),current=await authority()
  const admitted=await memoryStore.getById(current.execution.security.access,memory.id,current);expect(admitted).not.toBeNull();current.accumulator.note({sources:boundScopeSources(admitted!)})
  const snapshot=async()=>(await pool.query('SELECT to_jsonb(m) AS row FROM memories m WHERE workspace_id=$1 ORDER BY id',[workspaceId])).rows
  const before=await snapshot();expect(await authSessionStore.revokeForUser(userId,credential.sessionId)).toBe(true)
  const result=await retractUsingTool(memory.id,current);expect(result.isError).toBe(true);expect(String(result.data)).not.toContain(memory.summary)
  expect(await snapshot()).toEqual(before)
  expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1',[workspaceId])).rows).toEqual([])
 })
 it('retains complete independent reason ancestry and refuses current source withdrawal without a second correction',async()=>{
  const x=await sourceModeFixture('internal')
  try{
   configureConnectorSourceRuntimeFactory(x.factory,{instances:x.instances})
   const first=await saveOriginalMemory(x,'governed',false),second=await saveOriginalMemory(x,'governed',false)
   const host=await originalMemoryAuthority(x),record=await memoryStore.getById(host.execution.security.access,first.id,host)
   expect(record).not.toBeNull();host.accumulator.note({sources:boundScopeSources(record!)})
   const result=await retractUsingTool(first.id,host);expect(result.isError,JSON.stringify(result)).not.toBe(true)
   const receipt=(await pool.query('SELECT native_memory_transition AS value FROM correction_audit WHERE workspace_id=$1 AND row_id=$2',[x.f.workspaceId,first.id])).rows[0].value
   expect(receipt.reasonEvidence.sources).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'external_source'}),expect.objectContaining({resourceKind:'application_field'})]))
   const denied=await originalMemoryAuthority(x),prior=await memoryStore.getById(denied.execution.security.access,second.id,denied);expect(prior).not.toBeNull();denied.accumulator.note({sources:boundScopeSources(prior!)})
   const snapshot=async()=>(await pool.query('SELECT to_jsonb(m) AS row FROM memories m WHERE workspace_id=$1 ORDER BY id',[x.f.workspaceId])).rows
   const before=await snapshot();await x.sourcePool.query("DELETE FROM grants WHERE kind='human' AND account_id=$1",[x.f.ownerId])
   expect((await retractUsingTool(second.id,denied)).isError).toBe(true);expect(await snapshot()).toEqual(before)
   expect((await pool.query('SELECT row_id FROM correction_audit WHERE workspace_id=$1',[x.f.workspaceId])).rows).toEqual([{row_id:first.id}])
  }finally{configureConnectorSourceRuntimeFactory(undefined);await x.cleanup()}
 })
 it('binds explicit absence for an admitted root retraction without a result hold row',async()=>{
  const root=await createMemory({assistantId,userId,summary:'Fictional unheld correction root',sensitivity:'internal',createdByUserId:userId})
  const result=await retractUsingTool(root.id);expect(result.isError,JSON.stringify(result)).not.toBe(true)
  const receipt=await typedReceipt(root.id);expect(Object.hasOwn(receipt,'resultHoldState')).toBe(true);expect(receipt.resultHoldState).toBeNull()
  expect(await targetState(root.id,receipt.resultVersion)).toBeNull()
  expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[root.id])).rows[0].scope_held).toBe(false)
 })
 it('keeps the own hold binding immutable across independent source invalidation and administrator review',async()=>{
  const root=await createMemory({assistantId,userId,summary:'Fictional predecessor for binding',sensitivity:'internal',createdByUserId:userId})
  const independent=await createMemory({assistantId,userId,summary:'Fictional independent binding input',sensitivity:'internal',createdByUserId:userId})
  const updating=await authority(),prior=await memoryStore.getById(updating.execution.security.access,root.id,updating),input=await memoryStore.getById(updating.execution.security.access,independent.id,updating)
  expect(prior).not.toBeNull();expect(input).not.toBeNull();updating.accumulator.note({sources:[...boundScopeSources(prior!),...boundScopeSources(input!)]})
  const target=(await memoryStore.update(root.id,{summary:'Fictional bound successor'},updating.execution.security.access,{authority:updating,expectedVersion:prior!.scopeVersion!,writeFields:['summary']}))!
  expect(target).not.toBeNull();expect((await retractUsingTool(target.id)).isError).not.toBe(true)
  const receipt=await typedReceipt(target.id),bound=receipt.resultHoldState
  expect(bound).toEqual(await targetState(target.id,receipt.resultVersion));expect(bound).toMatchObject({reviewState:'held',holdingReason:'source_changed'})
  expect((await retractUsingTool(independent.id)).isError).not.toBe(true)
  const later=await targetState(target.id,receipt.resultVersion)
  expect(later).toMatchObject({resourceVersion:bound.resourceVersion,holdingReason:'source_changed',reviewState:'held'})
  expect(BigInt(later!.classificationRevision)).toBeGreaterThan(BigInt(bound.classificationRevision))
  expect(later).not.toEqual(bound);expect(await typedReceipt(target.id)).toEqual(receipt)
  const review=await executeWorkspaceScopeReview(workspaceId,userId,{type:'scope.review.preview',resourceKind:'memory',resourceIds:[target.id],action:'hold',targetTeamId:null,reason:'Fictional independent review of bound correction'})
  const applied=await executeWorkspaceScopeReview(workspaceId,userId,{type:'scope.review.apply',reviewId:review.id,expectedVersion:review.version,payloadHash:review.payloadHash})
  expect(applied.status).toBe('complete')
  expect(await targetState(target.id,receipt.resultVersion)).toMatchObject({resourceVersion:bound.resourceVersion,holdingReason:'administrator_review'})
  expect(await targetState(target.id,receipt.resultVersion)).not.toEqual(bound);expect(await typedReceipt(target.id)).toEqual(receipt)
 })

})
