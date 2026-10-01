import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {randomUUID} from 'node:crypto'
import {afterAll,expect,it} from 'vitest'
import {getPool,getAppPool} from '../../db/client.js'
import {inspectMigrationInventory,getMigrationInventory,MIGRATION_INVENTORY_FAMILIES} from '../migration-inventory.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
afterAll(async()=>{await getAppPool().end();await pool.end()})
it('bounds metadata pages, reconciles before-cursor insert/update/delete, never certifies; covers every fixed adapter',async()=>{
  const w=randomUUID(),u=randomUUID(),m=randomUUID(),p=randomUUID(),admin=randomUUID()
  for(const id of [u,m,admin])await pool.query("INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,'inventory')",[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'inventory',$2)",[w,u])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner'),($1,$3,'member')",[w,u,m])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'admin')",[w,admin])
  await pool.query("INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING",[w])
  await pool.query(`INSERT INTO workspace_access_migration_plans(id,workspace_id,actor_user_id,source_mode,target_mode,manifest_revision,schema_revision,policy_revision,inventory_revision,proposal_hash,idempotency_key,expires_at)
    SELECT $3,$1,$2,'departments','simple','test','631',revision,1,repeat('a',64),gen_random_uuid(),clock_timestamp()+interval '1 day' FROM workspace_access_policies WHERE workspace_id=$1`,[w,u,p])
  const a=randomUUID()
  await pool.query("INSERT INTO assistants(id,workspace_id,name,system_prompt) VALUES($1,$2,'inventory','SECRET BODY')",[a,w])
  // Principal insertion advances policy. Explicitly bind the fixture draft to current policy.
  await pool.query('UPDATE workspace_access_migration_plans SET policy_revision=(SELECT revision FROM workspace_access_policies WHERE workspace_id=$1) WHERE id=$2',[w,p])
  for(let i=0;i<51;i++)await pool.query("INSERT INTO sessions(workspace_id,assistant_id,user_id,channel_type,channel_id,compact_summary) VALUES($1,$2,$3,'web',gen_random_uuid()::text,'SECRET BODY')",[w,a,u])
  const page=()=>inspectMigrationInventory(w,u,p,{family:'sessions'})
  await pool.query("INSERT INTO assistant_chat_links(assistant_id,token,created_by) VALUES($1,'SECRET-LINK-TOKEN',$2)",[a,u])
  const permissionsBefore=(await pool.query('SELECT revision,access_mode FROM workspace_access_policies WHERE workspace_id=$1',[w])).rows
  expect((await page()).rows).toHaveLength(50)
  expect((await page()).rows).toHaveLength(1)
  expect((await page()).quiet).toBe(true)
  const saved=await getMigrationInventory(w,u,p,{family:'sessions'})
  expect(saved.rows).toHaveLength(50)
  expect((await getMigrationInventory(w,u,p,{family:'sessions',after:saved.nextAfter})).rows).toHaveLength(1)
  expect(saved.families.some(f=>f.coverageBlocker==='inventory_family_uninspected')).toBe(true)
  const early='00000000-0000-0000-0000-000000000001'
  await pool.query("INSERT INTO sessions(id,workspace_id,assistant_id,user_id,channel_type,channel_id) VALUES($1,$2,$3,$4,'web',gen_random_uuid()::text)",[early,w,a,u])
  expect((await page()).rows[0].id).toBe(early)
  await pool.query("UPDATE sessions SET compact_summary='CHANGED SECRET' WHERE id=$1",[early])
  const changed=await page();expect(changed.rows).toHaveLength(1);expect(JSON.stringify(changed)).not.toContain('SECRET')
  await pool.query('DELETE FROM sessions WHERE id=$1',[early])
  expect((await page()).rows[0]).toMatchObject({id:early,deleted:true,metadata:{}})
  for(const family of MIGRATION_INVENTORY_FAMILIES){
    const result=await inspectMigrationInventory(w,u,p,{family})
    expect(result.coverageBlocker,family).toBeNull()
    expect(result.inventoryComplete).toBe(false)
    expect(JSON.stringify(result)).not.toContain('SECRET BODY')
    expect(JSON.stringify(result)).not.toContain('SECRET-LINK-TOKEN')
  }
  expect((await pool.query('SELECT revision,access_mode FROM workspace_access_policies WHERE workspace_id=$1',[w])).rows).toEqual(permissionsBefore)
  // Composite locality FK rejects a forged workspace on a snapshot/checkpoint.
  await expect(pool.query(`INSERT INTO workspace_access_inventory_checkpoints(workspace_id,plan_id,family,manifest_version,policy_fingerprint)
    VALUES($1,$2,'foreign',repeat('a',64),repeat('b',64))`,[randomUUID(),p])).rejects.toMatchObject({code:'23503'})
  await expect(inspectMigrationInventory(w,admin,p,{family:'sessions'})).rejects.toMatchObject({code:'migration_actor_required'})
  // A missing family is a durable blocker; no empty-success fallback.
  await pool.query('ALTER TABLE teamspace_members RENAME TO inventory_test_hidden')
  try{
    const missing=await inspectMigrationInventory(w,u,p,{family:'teamspace_members'})
    expect(missing.coverageBlocker).toBe('inventory_family_unavailable');expect(missing.quiet).toBe(false)
    expect((await getMigrationInventory(w,u,p,{family:'teamspace_members'})).families.find(f=>f.family==='teamspace_members')?.coverageBlocker).toBe('inventory_family_unavailable')
  }finally{await pool.query('ALTER TABLE inventory_test_hidden RENAME TO teamspace_members')}
  expect((await inspectMigrationInventory(w,u,p,{family:'teamspace_members'})).quiet).toBe(true)
  // Clock-based display state changes without rewriting the durable observation.
  await pool.query(`UPDATE workspace_access_inventory_snapshots SET metadata=jsonb_set(metadata,'{expires_at}',to_jsonb((clock_timestamp()-interval '1 second')::text)) WHERE plan_id=$1 AND family='sessions'`,[p])
  expect((await getMigrationInventory(w,u,p,{family:'sessions'})).pageCounts.expired).toBe(50)
  await expect(inspectMigrationInventory(w,m,p,{family:'sessions'})).rejects.toMatchObject({code:'admin_required'})
  await expect(inspectMigrationInventory(w,u,randomUUID(),{family:'sessions'})).rejects.toMatchObject({code:'not_found'})
  const client=await getAppPool().connect()
  try{
    await client.query('BEGIN');await client.query("SELECT set_config('app.current_user_id',$1,true)",[m])
    expect((await client.query('SELECT * FROM workspace_access_inventory_snapshots WHERE plan_id=$1',[p])).rows).toEqual([])
    await client.query("SELECT set_config('app.current_user_id',$1,true)",[u])
    expect((await client.query('SELECT * FROM workspace_access_inventory_snapshots WHERE plan_id=$1',[p])).rows.length).toBeGreaterThan(0)
    expect((await client.query("UPDATE workspace_access_inventory_snapshots SET deleted=true WHERE plan_id=$1 RETURNING subject_id",[p])).rows).toEqual([])
  }finally{await client.query('ROLLBACK');client.release()}
  await pool.query("UPDATE workspace_access_migration_plans SET status='paused' WHERE id=$1",[p])
  await expect(page()).rejects.toMatchObject({code:'migration_not_active'})
  expect((await getMigrationInventory(w,u,p,{family:'sessions'})).planStatus).toBe('paused')
  await pool.query("UPDATE workspace_access_migration_plans SET status='cancelled' WHERE id=$1",[p])
  await expect(page()).rejects.toMatchObject({code:'migration_not_active'})
  await pool.query("UPDATE workspace_access_migration_plans SET status='draft',created_at=clock_timestamp()-interval '2 days',expires_at=clock_timestamp()-interval '1 day' WHERE id=$1",[p])
  await expect(page()).rejects.toMatchObject({code:'migration_expired'})
  await pool.query("UPDATE workspace_access_migration_plans SET expires_at=clock_timestamp()+interval '1 day' WHERE id=$1",[p])
  await pool.query('UPDATE workspace_access_policies SET revision=revision+1 WHERE workspace_id=$1',[w])
  await expect(page()).rejects.toMatchObject({code:'access_policy_conflict'})
  expect((await getMigrationInventory(w,u,p,{family:'sessions'})).stale).toBe(true)
  await pool.query('UPDATE workspace_access_migration_plans SET policy_revision=(SELECT revision FROM workspace_access_policies WHERE workspace_id=$1) WHERE id=$2',[w,p])
  await expect(page()).rejects.toMatchObject({code:'migration_inventory_stale'})
  await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[w,u])
  await expect(getMigrationInventory(w,u,p,{family:'sessions'})).rejects.toMatchObject({code:'admin_required'})
})

it('inventories new publication seams and only local connector exposure, without secrets or account proofs',async()=>{
  const w=randomUUID(),other=randomUUID(),u=randomUUID(),foreign=randomUUID(),a=randomUUID(),p=randomUUID()
  for(const id of [u,foreign])await pool.query("INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,'inventory seam')",[id])
  for(const [id,owner] of [[w,u],[other,foreign]]){
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'inventory seam',$2)",[id,owner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[id,owner])
    await pool.query('INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING',[id])
  }
  await pool.query("INSERT INTO assistants(id,workspace_id,name) VALUES($1,$2,'inventory seam')",[a,w])
  const personal=randomUUID(),ingest=randomUUID(),hidden=randomUUID(),remote=randomUUID()
  for(const id of [personal,ingest,hidden])await pool.query(`INSERT INTO connector_instance(id,scope,user_id,provider,label,connected_email,credentials,config,connected,ingest_workspace_id)
    VALUES($1,'user',$2,'gmail','SECRET ACCOUNT','SECRET EMAIL',$3,'{"secret":"SECRET CONFIG"}',true,$4)`,[id,foreign,Buffer.from('SECRET CREDENTIALS'),id===ingest?w:null])
  await pool.query(`INSERT INTO connector_instance(id,scope,workspace_id,provider,label,credentials,config,compartments)
    VALUES($1,'workspace',$2,'gmail','SECRET FOREIGN ACCOUNT',$3,'{"secret":"SECRET CONFIG"}',ARRAY['SECRET FOREIGN LABEL'])`,[remote,other,Buffer.from('SECRET CREDENTIALS')])
  for(const id of [personal,remote])await pool.query("INSERT INTO connector_grant(connector_instance_id,target_type,target_id,granted_by_user_id) VALUES($1,'workspace',$2,$3)",[id,w,foreign])
  const refreshHash='e'.repeat(64),proofHash='d'.repeat(64)
  for(const id of [personal,hidden])await pool.query(`INSERT INTO connector_rotation_attempts(instance_id,refresh_fingerprint,status,encrypted_result)
    VALUES($1,$2,'pending_verification',$3)`,[id,refreshHash,Buffer.from('SECRET ROTATED CREDENTIALS')])
  await pool.query(`INSERT INTO connector_setup_rotation_receipts(instance_id,transaction_id,expected_version,account_digest,credentials)
    VALUES($1,1,1,$2,$3)`,[personal,proofHash,Buffer.from('SECRET ROTATION PROOF')])
  await pool.query("INSERT INTO api_keys(assistant_id,name,key_hash,key_prefix) VALUES($1,'SECRET KEY NAME','SECRET KEY HASH','SECRET PREFIX')",[a])
  const source=randomUUID()
  await pool.query(`INSERT INTO workspace_knowledge_sources(id,workspace_id,source_type,repo,sync_error,sync_run_id,sync_lease_until,sync_dirty)
    VALUES($1,$2,'github','SECRET REPO','SECRET ERROR',gen_random_uuid(),clock_timestamp()+interval '1 hour',true)`,[source,w])
  const upload=randomUUID(),artifact=randomUUID(),job=randomUUID()
  await pool.query(`INSERT INTO workspace_file_uploads(id,workspace_id,acting_user_id,file_id,path,name,mime,size_bytes,chunk_size_bytes,part_count,storage_uri,expires_at,admission_binding)
    VALUES($1,$2,$3,gen_random_uuid(),'SECRET PATH','SECRET NAME','application/pdf',1,1,1,'SECRET STORAGE',clock_timestamp()+interval '1 hour',
      jsonb_build_object('workspaceId',($2::uuid)::text,'sensitivity','internal','compartments','[]'::jsonb,'secret','SECRET BINDING CONFIG'))`,[upload,w,u])
  await pool.query(`INSERT INTO office_artifacts(id,workspace_id,family,title,creator_user_id,owner_user_id,capability_version,sensitivity,pdf_intake_state,pdf_intake_sources,pdf_intake_request_hash)
    VALUES($1,$2,'document','SECRET DOCUMENT TITLE',$3,$3,1,'internal','pending',$4,$5)`,[artifact,w,u,JSON.stringify([{kind:'workspace_file',resourceId:randomUUID(),version:'SECRET SOURCE HASH',content:'SECRET BODY'}]),proofHash])
  await pool.query(`INSERT INTO office_generation_jobs(id,workspace_id,artifact_id,initiated_by_user_id,brief,authority_projection,idempotency_key,lease_token,lease_expires_at)
    VALUES($1,$2,$3,$4,'{"outcome":"SECRET INSTRUCTIONS"}',
      '{"sensitivity":"internal","creationBinding":{"protocol":"office_prompt_only_v1","authSessionId":"SECRET SESSION","secret":"SECRET CONFIG"},"secret":"SECRET JOB CONFIG"}',
      'SECRET IDEMPOTENCY',gen_random_uuid(),clock_timestamp()+interval '1 hour')`,[job,w,artifact,u])
  await pool.query(`INSERT INTO workspace_access_migration_plans(id,workspace_id,actor_user_id,source_mode,target_mode,manifest_revision,schema_revision,policy_revision,inventory_revision,proposal_hash,idempotency_key,expires_at)
    SELECT $3,$1,$2,'departments','simple','test','638',revision,1,repeat('a',64),gen_random_uuid(),clock_timestamp()+interval '1 day' FROM workspace_access_policies WHERE workspace_id=$1`,[w,u,p])
  const inspect=(family:string)=>inspectMigrationInventory(w,u,p,{family})
  for(const family of ['api_keys','workspace_knowledge_sources','knowledge_source','workspace_file_uploads','office_generation_jobs','office_pdf_intake_sources','connector_rotation_attempts','connector_setup_rotation_receipts']){
    const result=await inspect(family)
    expect(result.coverageBlocker,family).toBeNull();expect(result.rows.length,family).toBeGreaterThan(0)
    expect(result.allowedActions).toEqual([]);expect(result.unsupportedActions).toContain('migration_remediation_unavailable')
    const serialized=JSON.stringify(result)
    for(const secret of ['SECRET',refreshHash,proofHash])expect(serialized,family).not.toContain(secret)
  }
  const exposed=await inspect('connector_instance')
  expect(exposed.rows.map(r=>r.id).sort()).toEqual([personal,ingest,remote].sort())
  for(const row of exposed.rows){
    expect(row.metadata.exposure_only).toBe(true)
    for(const secret of ['SECRET',foreign,other])expect(JSON.stringify(row)).not.toContain(secret)
  }
  expect((await inspect('connector_rotation_attempts')).quiet).toBe(true)
  await pool.query("UPDATE connector_rotation_attempts SET status='published',encrypted_result=NULL WHERE instance_id=$1",[personal])
  const changed=await inspect('connector_rotation_attempts')
  expect(changed.rows.some(r=>r.metadata.status==='published')).toBe(true)
  expect(changed.rows.some(r=>r.deleted)).toBe(true)
  await pool.query('DELETE FROM connector_grant WHERE connector_instance_id=$1 AND target_id=$2',[personal,w])
  expect((await inspect('connector_instance')).rows).toContainEqual(expect.objectContaining({id:personal,deleted:true}))
  expect((await inspect('connector_rotation_attempts')).rows.every(r=>r.deleted)).toBe(true)
  const persisted=await pool.query('SELECT metadata,subject_id FROM workspace_access_inventory_snapshots WHERE plan_id=$1',[p])
  for(const secret of ['SECRET',refreshHash,proofHash])expect(JSON.stringify(persisted.rows)).not.toContain(secret)
})

it('projects 640-645 binding floors and references without configuration sessions, payloads or task snapshots',async()=>{
  async function fixture(){
    const w=randomUUID(),u=randomUUID(),a=randomUUID(),file=randomUUID(),recording=randomUUID(),task=randomUUID(),profile=randomUUID(),rule=randomUUID(),key=randomUUID(),batch=randomUUID(),p=randomUUID()
    await pool.query("INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,'SECRET PERSON')",[u])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'SECRET WORKSPACE',$2)",[w,u])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[w,u])
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'SECRET ASSISTANT','primary','internal')",[a,w])
    const team=await createDbWorkspaceGroupStore().createTeam(u,w,{name:'SECRET TEAM',key:'binding'})
    for(const visibility of ['owner','workspace'])await pool.query(`INSERT INTO sessions(workspace_id,assistant_id,user_id,visibility,channel_type,channel_id,app_origin,context_group_id,context_compartments,compact_summary)
      VALUES($1,$2,$3,$4,'web',gen_random_uuid()::text,'chat',$5,$6,'SECRET SUMMARY')`,[w,a,u,visibility,team.id,[team.compartmentKey]])
    await pool.query("INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id) VALUES($1,$2,'/SECRET','SECRET','SECRET STORAGE',$3)",[file,w,u])
    await pool.query("INSERT INTO episodes(id,workspace_id,source_kind,source_ref,occurred_at,created_by_user_id) VALUES($1,$2,'recording','{\"private\":\"SECRET SOURCE\"}',now(),$3)",[recording,w,u])
    await pool.query("INSERT INTO recordings(id,workspace_id,mime,gcs_key,media_file_id,created_by_user_id) VALUES($1,$2,'audio/wav','SECRET STORAGE',$3,$4)",[recording,w,file,u])
    await pool.query('INSERT INTO recording_intake_bindings(recording_id,workspace_id,file_id,file_version) VALUES($1,$2,$3,$4)',[recording,w,file,'1'])
    await pool.query("INSERT INTO file_segments(workspace_id,file_id,segment_index,char_start,char_end,content,created_by_user_id) VALUES($1,$2,0,0,1,'SECRET FILE CONTENT',$3)",[w,file,u])
    await pool.query("INSERT INTO transcript_segments(workspace_id,recording_id,segment_index,start_ms,end_ms,segment_text,created_by_user_id) VALUES($1,$2,0,0,1,'SECRET TRANSCRIPT',$3)",[w,recording,u])
    await pool.query("INSERT INTO tasks(id,workspace_id,title) VALUES($1,$2,'SECRET TASK')",[task,w])
    const proof={userId:u,workspaceId:w,assistantId:a,taskId:task,contextGroupId:team.id,contextProjectId:null,
      snapshot:'SECRET COMPLETE TASK SNAPSHOT',opaque:'SECRET PROVENANCE',authority:{version:1,assistantId:a,ceiling:{workspaceId:w,userId:u,clearance:'internal',compartments:[team.compartmentKey],mutationCompartments:[team.compartmentKey],projectIds:[],visibilityAssistantIds:[a]}}}
    await pool.query('INSERT INTO goal_task_source_authority(task_id,workspace_id,proof) VALUES($1,$2,$3)',[task,w,proof])
    const session=(await pool.query("INSERT INTO auth_sessions(user_id,auth_version,device_label) VALUES($1,0,'SECRET DEVICE') RETURNING id",[u])).rows[0].id
    await pool.query("UPDATE workspace_access_policies SET setup_state='ready',access_mode='simple',default_department_id=$2 WHERE workspace_id=$1",[w,team.id])
    const client=await pool.connect()
    try{
      await client.query('BEGIN')
      await client.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.capture_session',$2,true),set_config('app.external_key_session',$2,true),set_config('app.external_key_explicit','true',true)",[u,session])
      const revision=(await client.query('SELECT revision::text FROM workspace_access_policies WHERE workspace_id=$1',[w])).rows[0].revision
      const binding={actor:u,session,policyRevision:revision,sensitivity:'internal',compartments:[team.compartmentKey],projectIds:[],opaque:'SECRET PROFILE PROVENANCE'}
      await client.query("SELECT set_config('app.capture_admission',$1,true)",[JSON.stringify(binding)])
      await client.query("INSERT INTO programmatic_capture_profiles(id,workspace_id,name,created_by,intake_binding) VALUES($1,$2,'SECRET PROFILE',$3,$4)",[profile,w,u,binding])
      await client.query(`INSERT INTO ingest_rules(id,capture_profile_id,source,rule_order,filter_type,routing_mode,routing_schedule,episode_sensitivity,compartments,scope_binding_mode)
        VALUES($1,$2,'programmatic',0,'always','scheduled','* * * * *','internal',$3,'explicit')`,[rule,profile,[team.compartmentKey]])
      await client.query(`INSERT INTO brain_keys(id,workspace_id,name,key_hash,key_prefix,created_by,max_clearance,context_group_id,capture_assistant_id,capture_profile_id)
        VALUES($1,$2,'SECRET KEY','SECRET HASH','SECRET PREFIX',$3,'internal',$4,$5,$6)`,[key,w,u,team.id,a,profile])
      await client.query(`INSERT INTO pending_ingest_batches(id,workspace_id,rule_id,assistant_id,source,fires_at,events,episode_sensitivity,compartments)
        VALUES($1,$2,$3,$4,'programmatic',now(),$5,'internal',$6)`,[batch,w,rule,a,JSON.stringify([{eventId:'SECRET EVENT',principalKind:'api_key',principalId:key,content:'SECRET PAYLOAD',opaque:'SECRET OPAQUE'}]),[team.compartmentKey]])
      await client.query("INSERT INTO programmatic_capture_receipts(workspace_id,principal_kind,principal_id,event_id,rule_id,batch_id,status,error) VALUES($1,'api_key',$2,'SECRET EVENT',$3,$4,'queued','SECRET ERROR')",[w,key,rule,batch])
      await client.query('COMMIT')
    }catch(e){await client.query('ROLLBACK');throw e}finally{client.release()}
    await pool.query(`INSERT INTO workspace_access_migration_plans(id,workspace_id,actor_user_id,source_mode,target_mode,manifest_revision,schema_revision,policy_revision,inventory_revision,proposal_hash,idempotency_key,expires_at)
      SELECT $3,$1,$2,'simple','departments','test','645',revision,1,repeat('a',64),gen_random_uuid(),clock_timestamp()+interval '1 day' FROM workspace_access_policies WHERE workspace_id=$1`,[w,u,p])
    return {w,u,a,p,session,key,profile,rule,batch,team,file,recording,task}
  }
  const f=await fixture(),foreign=await fixture()
  const page=(family:string)=>inspectMigrationInventory(f.w,f.u,f.p,{family})
  const expected:Record<string,object>={
    programmatic_capture_profiles:{'intake_binding.actor':f.u,'intake_binding.compartments':[f.team.compartmentKey],configuration_bound:true},
    brain_keys:{capture_intake_revision:1,admitted_compartments:[f.team.compartmentKey],configuration_actor:f.u},
    programmatic_batch_producer_bindings:{principal_id:f.key,'producer_binding.profileId':f.profile,'producer_binding.ruleId':f.rule,binding_present:true},
    programmatic_capture_receipts:{batch_id:f.batch,principal_id:f.key,status:'queued'},
    recording_intake_bindings:{file_id:f.file,recording_id:f.recording,file_version:'1'},
    recording:{scope_version:1,scope_held:false,media_file_id:f.file},
    file_segment:{scope_version:1,scope_held:false,file_id:f.file},
    transcript_segment:{scope_version:1,scope_held:false,recording_id:f.recording},
    goal_task_source_authority:{task_id:f.task,'proof.authority.ceiling.compartments':[f.team.compartmentKey],snapshot_version_unavailable:true},
  }
  for(const [family,metadata] of Object.entries(expected)){
    const result=await page(family)
    expect(result.coverageBlocker,family).toBeNull();expect(result.rows,family).toHaveLength(1)
    expect(result.rows[0].metadata,family).toMatchObject(metadata)
    if(['programmatic_capture_profiles','programmatic_batch_producer_bindings','goal_task_source_authority','recording_intake_bindings'].includes(family)){
      expect(result.allowedActions).toEqual([]);expect(result.unsupportedActions).toContain('migration_remediation_unavailable')
    }
    for(const secret of ['SECRET',f.session,foreign.session,foreign.w,foreign.u])expect(JSON.stringify(result),family).not.toContain(secret)
  }
  const sessions=await page('sessions')
  expect(sessions.rows.map(r=>r.metadata.visibility).sort()).toEqual(['owner','workspace'])
  expect(sessions.rows.every(r=>r.metadata.app_origin==='chat'&&r.metadata.context_group_id===f.team.id)).toBe(true)
  await pool.query('UPDATE auth_sessions SET revoked_at=clock_timestamp() WHERE id=$1',[f.session])
  for(const family of ['brain_keys','programmatic_capture_profiles'])expect((await page(family)).rows[0].metadata.configuration_revoked_at).not.toBeNull()
  const durable=(await pool.query('SELECT metadata FROM workspace_access_inventory_snapshots WHERE plan_id=$1',[f.p])).rows
  for(const secret of ['SECRET',f.session,foreign.session,foreign.w])expect(JSON.stringify(durable)).not.toContain(secret)
})
