import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { runReflectionConsolidation, type ScopeSource } from '@use-brian/core'
import { getPool,getAppPool } from '../client.js'
import { createMemory,updateMemory } from '../memories.js'
import { createDbMemoryStore } from '../memory-store.js'
import { createMemoryRetractionStore } from '../retraction-store.js'
import { createSoftDeleteStore } from '../soft-delete-store.js'
import { readReflectionReceipt } from '../reflection-evidence.js'
import { addSessionMessage, readSessionMessageScopeSource } from '../sessions.js'
import { recordFeedback } from '../../feedback/record.js'
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),assistantId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Reflection fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')",[workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind,clearance) VALUES($1,$2,$3,'Fixture','standard','confidential')",[assistantId,workspaceId,userId])
  await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'product','Product'),($1,'finance','Finance')",[workspaceId])
  const memory=await createMemory({workspaceId,userId,assistantId,createdByUserId:userId,summary:'Original source',sensitivity:'confidential',compartments:['product']})
  const receipt=async(target=memory.id,reason='Product wording',kind:'memory_verification'|'brain_verification'='memory_verification')=>{
    const id=randomUUID()
    if(kind==='memory_verification')await pool.query("INSERT INTO memory_verifications(id,workspace_id,memory_id,verified_by,action,model_value,user_value,reason) VALUES($1,$2,$3,$4,'edit_summary','\"Before\"','\"After\"',$5)",[id,workspaceId,target,userId,reason])
    else await pool.query("INSERT INTO brain_verifications(id,workspace_id,target_kind,target_id,verified_by,action,model_value,user_value,reason) VALUES($1,$2,'entity',$3,$4,'edit_summary','\"Before\"','\"After\"',$5)",[id,workspaceId,target,userId,reason])
    return id
  }
  const read=async(id:string,kind:'memory_verification'|'brain_verification'='memory_verification')=>readReflectionReceipt(workspaceId,kind,id)
  const derive=async(sources:ScopeSource[])=>createMemory({workspaceId,userId,assistantId,createdByUserId:userId,summary:'Learned pattern',sensitivity:'public',derivation:{producer:'fixture:reflection',sources}})
  return{workspaceId,userId,assistantId,memory,receipt,read,derive}
}
describe('[COMP:api/reflection-evidence] verification receipt provenance',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('runs real reflection per exact department bucket with actual canonical writes',async()=>{
    const f=await fixture()
    const finance=await createMemory({workspaceId:f.workspaceId,userId:f.userId,assistantId:f.assistantId,createdByUserId:f.userId,summary:'Finance source',sensitivity:'confidential',compartments:['finance']})
    for(let i=0;i<3;i++) {await f.receipt();await f.receipt(finance.id,'Finance wording')}
    const prompts:string[]=[]
    const result=await runReflectionConsolidation(createDbMemoryStore(),async prompt=>{prompts.push(prompt);return JSON.stringify([{summary:prompt.includes('Product wording')?'Product pattern':'Finance pattern'}])},f)
    expect(result.memoriesAffected).toHaveLength(2)
    expect(prompts).toHaveLength(2)
    for(const prompt of prompts)expect(prompt.includes('Product wording')&&prompt.includes('Finance wording')).toBe(false)
    const rows=(await pool.query("SELECT summary,sensitivity,compartments,user_id,assistant_id FROM memories WHERE id=ANY($1)",[result.memoriesAffected])).rows
    expect(rows).toEqual(expect.arrayContaining([
      expect.objectContaining({summary:'Product pattern',sensitivity:'confidential',compartments:['product'],user_id:f.userId,assistant_id:f.assistantId}),
      expect.objectContaining({summary:'Finance pattern',sensitivity:'confidential',compartments:['finance'],user_id:f.userId,assistant_id:f.assistantId}),
    ]))
    expect((await pool.query('SELECT count(*)::int count FROM scope_derivation_sources WHERE workspace_id=$1',[f.workspaceId])).rows[0].count).toBe(6)
  })
  it('retains complete whole-turn feedback lineage and holds it on message narrowing',async()=>{
    const f=await fixture(),sessionId=randomUUID()
    await pool.query("INSERT INTO sessions(id,assistant_id,user_id,workspace_id,channel_type,channel_id) VALUES($1,$2,$3,$4,'web',$1::uuid::text)",[sessionId,f.assistantId,f.userId,f.workspaceId])
    const input=await addSessionMessage({sessionId,role:'user',content:[{type:'text',text:'Use the product forecast'}],scope:{
      workspaceId:f.workspaceId,userId:f.userId,assistantId:f.assistantId,
      sensitivity:'confidential',compartments:['product'],projectIds:[],
    }})
    const inputSource=(await readSessionMessageScopeSource(f.workspaceId,input.id))!
    const answer=await addSessionMessage({sessionId,role:'assistant',content:[{type:'text',text:'Forecast answer'}],
      derivation:{producer:'fixture:turn',sources:[inputSource]}})
    await pool.query("INSERT INTO memory_recall_events(memory_id,session_id,assistant_message_id,workspace_id,user_id,recall_kind) VALUES($1,$2,$3,$4,$5,'index_inject')",
      [f.memory.id,sessionId,answer.id,f.workspaceId,f.userId])
    const feedback=await recordFeedback({userId:f.userId,messageId:answer.id,sessionId,kind:'negative',details:':down:',source:'web'})
    const event=(await readReflectionReceipt(f.workspaceId,'feedback_event',feedback.analyticsId!,f.memory.id))!
    expect(event.scopeSources).toEqual(expect.arrayContaining([
      expect.objectContaining({resourceKind:'feedback_event',compartments:['product']}),
      expect.objectContaining({resourceKind:'memory',compartments:['product']}),
    ]))
    const learned=await f.derive(event.scopeSources!)
    await pool.query("UPDATE session_messages SET content='[{\"type\":\"text\",\"text\":\"Changed input\"}]'::jsonb WHERE id=$1",[input.id])
    expect((await pool.query('SELECT scope_held FROM session_messages WHERE id=$1',[answer.id])).rows[0].scope_held).toBe(true)
    expect((await pool.query('SELECT scope_held FROM analytics_events WHERE id=$1',[feedback.analyticsId])).rows[0].scope_held).toBe(true)
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[learned.id])).rows[0].scope_held).toBe(true)
    expect(await readReflectionReceipt(f.workspaceId,'feedback_event',feedback.analyticsId!,f.memory.id)).toBeNull()
    await expect(f.derive(event.scopeSources!)).rejects.toThrow('scope_source_changed')
  })
  it('does not combine small departments to reach the model threshold',async()=>{
    const f=await fixture(),other=await createMemory({workspaceId:f.workspaceId,userId:f.userId,assistantId:f.assistantId,createdByUserId:f.userId,summary:'Other source',sensitivity:'confidential',compartments:['finance']})
    for(let i=0;i<2;i++){await f.receipt();await f.receipt(other.id,'Other department')}
    const model=vi.fn(async()=>JSON.stringify([{summary:'Unwanted combined lesson'}]))
    const result=await runReflectionConsolidation(createDbMemoryStore(),model,f)
    expect(model).not.toHaveBeenCalled()
    expect(result.memoriesAffected).toEqual([])
  })
  it('rejects pattern persistence when a receipt changes during model execution',async()=>{
    const f=await fixture(),id=await f.receipt()
    await f.receipt();await f.receipt()
    const result=await runReflectionConsolidation(createDbMemoryStore(),async()=>{
      await pool.query("UPDATE memory_verifications SET reason='Changed while generating' WHERE id=$1",[id])
      return JSON.stringify([{summary:'Stale learned pattern'}])
    },f)
    expect(result.memoriesAffected).toEqual([])
    expect((await pool.query("SELECT id FROM memories WHERE workspace_id=$1 AND summary='Stale learned pattern'",[f.workspaceId])).rows).toEqual([])
  })
  it.each(['receipt_edit','receipt_delete','target_edit','target_hold','target_delete'] as const)('holds learned patterns and refuses stale %s evidence',async change=>{
    const f=await fixture(),id=await f.receipt(),event=(await f.read(id))!,output=await f.derive(event.scopeSources!)
    if(change==='receipt_edit')await pool.query("UPDATE memory_verifications SET reason='Changed' WHERE id=$1",[id])
    if(change==='receipt_delete')await pool.query('DELETE FROM memory_verifications WHERE id=$1',[id])
    if(change==='target_edit')await pool.query("UPDATE memories SET summary='Changed' WHERE id=$1",[f.memory.id])
    if(change==='target_hold')await pool.query('UPDATE memories SET scope_held=true WHERE id=$1',[f.memory.id])
    if(change==='target_delete')await pool.query('DELETE FROM memories WHERE id=$1',[f.memory.id])
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[output.id])).rows[0].scope_held).toBe(true)
    await expect(f.derive(event.scopeSources!)).rejects.toThrow('scope_source_changed')
  })
  it('follows supersession without losing historical protection and holds earlier patterns',async()=>{
    const f=await fixture(),id=await f.receipt(),before=(await f.read(id))!,output=await f.derive(before.scopeSources!)
    const next=(await updateMemory(f.memory.id,{summary:'Revised source',sensitivity:'internal',compartments:['finance']}))!
    expect(next.id).not.toBe(f.memory.id)
    const after=(await f.read(id))!
    expect(after.rowSummary).toBeNull()
    expect(after.scopeSources![0]).toMatchObject({sensitivity:'confidential',compartments:['finance','product']})
    expect(after.scopeSources![0].version).not.toBe(before.scopeSources![0].version)
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[output.id])).rows[0].scope_held).toBe(true)
    const newPattern=await f.derive(after.scopeSources!)
    await updateMemory(next.id,{summary:'Next revision'})
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[newPattern.id])).rows[0].scope_held).toBe(true)
  })
  it('propagates across nested correction and derivation relationships',async()=>{
    const f=await fixture(),id=await f.receipt(),first=await f.derive((await f.read(id))!.scopeSources!),nextReceipt=await f.receipt(first.id),second=await f.derive((await f.read(nextReceipt))!.scopeSources!)
    await pool.query("UPDATE memories SET summary='Changed root' WHERE id=$1",[f.memory.id])
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=ANY($1)',[[first.id,second.id]])).rows).toEqual([{scope_held:true},{scope_held:true}])
  })
  it('supports non-memory verification payloads with canonical source protection',async()=>{
    const f=await fixture(),entityId=randomUUID()
    await pool.query("INSERT INTO entities(id,workspace_id,user_id,assistant_id,created_by_user_id,source,kind,display_name,sensitivity,compartments) VALUES($1,$2,$3,$4,$3,'model','person','Fixture entity','confidential',ARRAY['product'])",[entityId,f.workspaceId,f.userId,f.assistantId])
    const id=await f.receipt(entityId,'Correct entity wording','brain_verification'),event=(await f.read(id,'brain_verification'))!
    expect(event).toMatchObject({primitive:'entity',reason:'Correct entity wording',rowSummary:null})
    const output=await f.derive(event.scopeSources!)
    await pool.query("UPDATE entities SET display_name='Changed' WHERE id=$1",[entityId])
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[output.id])).rows[0].scope_held).toBe(true)
  })
  it('withholds held and external-principal receipts before model use',async()=>{
    const f=await fixture(),id=await f.receipt()
    await pool.query('UPDATE memory_verifications SET scope_held=true WHERE id=$1',[id])
    expect(await f.read(id)).toBeNull()
    const another=await f.receipt()
    await pool.query("UPDATE users SET auth_provider='channel',auth_provider_id='api:fixture:external' WHERE id=$1",[f.userId])
    expect(await f.read(another)).toBeNull()
    const callModel=vi.fn(async()=> '[]')
    await runReflectionConsolidation(createDbMemoryStore(),callModel,f)
    expect(callModel).not.toHaveBeenCalled()
  })
  it('retains historical projects and refuses incompatible personal visibility',async()=>{
    const f=await fixture(),projects=[randomUUID(),randomUUID()]
    for(const id of projects)await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1::uuid,$2,$1::text,$1::text,$3)",[id,f.workspaceId,f.userId])
    await pool.query('UPDATE memories SET project_ids=$2 WHERE id=$1',[f.memory.id,[projects[0]]])
    const id=await f.receipt()
    await pool.query('UPDATE memories SET project_ids=$2 WHERE id=$1',[f.memory.id,[projects[1]]])
    const event=(await f.read(id))!
    expect(event.scopeSources![0].projectIds).toEqual([...projects].sort())
    expect((await f.derive(event.scopeSources!)).projectIds).toEqual([...projects].sort())
    const other=randomUUID()
    await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[other])
    await pool.query('UPDATE memories SET user_id=$2 WHERE id=$1',[f.memory.id,other])
    expect(await f.read(id)).toBeNull()
  })
  it('upgrades existing saved scopes without inventing evidence for legacy receipts',async()=>{
    const f=await fixture(),id=await f.receipt(),legacy=randomUUID(),malformed=randomUUID(),client=await pool.connect()
    const migration=(await readFile(new URL('../../../migrations/587_verification_derivation.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
    try {
      await client.query('BEGIN')
      const before=(await client.query('SELECT source_scope FROM memory_verifications WHERE id=$1',[id])).rows[0].source_scope
      await client.query('DROP TRIGGER memory_verification_lifecycle ON memories; DROP FUNCTION hold_memory_verification_lifecycle()')
      for(const table of ['memory_verifications','brain_verifications']) {
        const policy=table==='memory_verifications'?'memory_verification_holding':'brain_verification_holding'
        await client.query(`DROP TRIGGER canonical_scope_version ON ${table}; DROP POLICY ${policy} ON ${table}; ALTER TABLE ${table} DROP COLUMN scope_version,DROP COLUMN scope_held`)
      }
      await client.query('DROP FUNCTION read_verification_scope(uuid,text,uuid); DROP FUNCTION join_correction_scope(jsonb,jsonb)')
      await client.query('ALTER TABLE memory_verifications DISABLE TRIGGER memory_verification_scope')
      await client.query("INSERT INTO memory_verifications(id,workspace_id,memory_id,verified_by,action,reason) VALUES($1,$2,$3,$4,'edit_summary','Unclassified legacy correction')",[legacy,f.workspaceId,f.memory.id,f.userId])
      await client.query("INSERT INTO memory_verifications(id,workspace_id,memory_id,verified_by,action,source_scope) VALUES($1,$2,$3,$4,'edit_summary',$5)",[malformed,f.workspaceId,f.memory.id,f.userId,JSON.stringify({...before,sensitivity:undefined})])
      await client.query('ALTER TABLE memory_verifications ENABLE TRIGGER memory_verification_scope')
      await client.query("DELETE FROM scope_derivation_sources WHERE source_kind IN('correction_audit','session_message','feedback_event')")
      await client.query(migration)
      expect((await client.query('SELECT source_scope FROM memory_verifications WHERE id=$1',[id])).rows[0].source_scope).toEqual(before)
      expect((await client.query("SELECT read_scope_source($1,'memory_verification',$2) AS source",[f.workspaceId,id])).rows[0].source).toMatchObject({compartments:['product'],sensitivity:'confidential'})
      expect((await client.query("SELECT read_scope_source($1,'memory_verification',$2) AS source",[f.workspaceId,legacy])).rows[0].source).toBeNull()
      expect((await client.query("SELECT read_scope_source($1,'memory_verification',$2) AS source",[f.workspaceId,malformed])).rows[0].source).toBeNull()
    } finally {await client.query('ROLLBACK');client.release()}
  })
  it('learns from actual soft-delete receipts without quoting archived row snapshots',async()=>{
    const f=await fixture(),repo=createSoftDeleteStore()
    for(let i=0;i<3;i++) {
      const id=randomUUID()
      await pool.query("INSERT INTO entities(id,workspace_id,user_id,assistant_id,created_by_user_id,source,kind,display_name,sensitivity,compartments) VALUES($1,$2,$3,$4,$3,'model','person','Private stale name','confidential',ARRAY['product'])",[id,f.workspaceId,f.userId,f.assistantId])
      await repo.applySoftDelete({primitive:'entity',workspaceId:f.workspaceId,rowId:id,actorUserId:f.userId,reason:'Remove duplicate product contacts',now:new Date()})
    }
    const prompts:string[]=[]
    const result=await runReflectionConsolidation(createDbMemoryStore(),async prompt=>{prompts.push(prompt);return JSON.stringify([{summary:'Avoid duplicate contacts'}])},f)
    expect(result.memoriesAffected).toHaveLength(1)
    expect(prompts[0]).toContain('Remove duplicate product contacts')
    expect(prompts[0]).not.toContain('Private stale name')
    expect((await pool.query('SELECT compartments,sensitivity,user_id,assistant_id FROM memories WHERE id=$1',[result.memoriesAffected[0]])).rows[0]).toMatchObject({compartments:['product'],sensitivity:'confidential',user_id:f.userId,assistant_id:f.assistantId})
    expect((await pool.query("SELECT count(*)::int count FROM scope_derivation_sources WHERE workspace_id=$1 AND source_kind='correction_audit'",[f.workspaceId])).rows[0].count).toBe(3)
  })
  it.each(['receipt_edit','receipt_delete','target_edit','target_delete','erasure','supersession'] as const)('invalidates correction-audit lessons on %s',async change=>{
    const f=await fixture(),id=randomUUID()
    await pool.query("INSERT INTO correction_audit(id,workspace_id,primitive,row_id,action,actor_user_id,reason,row_snapshot) VALUES($1,$2,'memory',$3,'retract',$4,'Avoid unsupported claims','{}')",[id,f.workspaceId,f.memory.id,f.userId])
    const event=(await readReflectionReceipt(f.workspaceId,'correction_audit',id))!
    expect(event).toMatchObject({reason:'Avoid unsupported claims',modelValue:null,userValue:null,rowSummary:null})
    const output=await f.derive(event.scopeSources!)
    if(change==='receipt_edit')await pool.query("UPDATE correction_audit SET reason='Changed' WHERE id=$1",[id])
    if(change==='receipt_delete')await pool.query('DELETE FROM correction_audit WHERE id=$1',[id])
    if(change==='target_edit')await pool.query("UPDATE memories SET summary='Changed' WHERE id=$1",[f.memory.id])
    if(change==='target_delete')await pool.query('DELETE FROM memories WHERE id=$1',[f.memory.id])
    if(change==='erasure')await pool.query(`UPDATE correction_audit SET reason='Personal data erased',row_snapshot='{"erased":true}',detail='{"erased":true}' WHERE id=$1`,[id])
    if(change==='supersession')await updateMemory(f.memory.id,{summary:'Replacement'})
    expect((await pool.query('SELECT scope_held FROM memories WHERE id=$1',[output.id])).rows[0].scope_held).toBe(true)
    await expect(f.derive(event.scopeSources!)).rejects.toThrow('scope_source_changed')
    if(['receipt_delete','target_delete','erasure'].includes(change))expect(await readReflectionReceipt(f.workspaceId,'correction_audit',id)).toBeNull()
  })
  it('refuses correction payload swaps and ignores unsupported or external receipts',async()=>{
    const f=await fixture(),id=randomUUID()
    await pool.query("INSERT INTO correction_audit(id,workspace_id,primitive,row_id,action,actor_user_id,reason) VALUES($1,$2,'memory',$3,'retract',$4,'Correction')",[id,f.workspaceId,f.memory.id,f.userId])
    await expect(pool.query("UPDATE correction_audit SET source_scope=jsonb_set(source_scope,'{compartments}','[]') WHERE id=$1",[id])).rejects.toThrow('correction_scope_immutable')
    await expect(pool.query('UPDATE correction_audit SET row_id=$2 WHERE id=$1',[id,randomUUID()])).rejects.toThrow('correction_scope_immutable')
    await pool.query("UPDATE correction_audit SET action='purge' WHERE id=$1",[id])
    expect(await readReflectionReceipt(f.workspaceId,'correction_audit',id)).toBeNull()
    await pool.query("UPDATE correction_audit SET action='retract' WHERE id=$1",[id])
    await pool.query("UPDATE users SET auth_provider='channel',auth_provider_id='chatlink:fixture:external' WHERE id=$1",[f.userId])
    expect(await readReflectionReceipt(f.workspaceId,'correction_audit',id)).toBeNull()
  })
  it('records real retractions atomically and respects an existing transaction',async()=>{
    const f=await fixture(),repo=createMemoryRetractionStore(),args={workspaceId:f.workspaceId,memoryId:f.memory.id,retractedBy:f.userId,reason:'Not a supported claim',now:new Date()}
    await repo.applySoftRetract(args)
    const receipt=(await pool.query("SELECT id FROM correction_audit WHERE workspace_id=$1 AND action='retract'",[f.workspaceId])).rows[0]
    expect(await readReflectionReceipt(f.workspaceId,'correction_audit',receipt.id)).toMatchObject({reason:args.reason,scopeSources:[expect.objectContaining({compartments:['product']})]})
    const other=await fixture(),client=await pool.connect()
    try {
      await client.query('BEGIN')
      await createMemoryRetractionStore(client).applySoftRetract({...args,workspaceId:other.workspaceId,memoryId:other.memory.id,retractedBy:other.userId})
      await client.query('ROLLBACK')
      expect((await pool.query('SELECT retracted_at FROM memories WHERE id=$1',[other.memory.id])).rows[0].retracted_at).toBeNull()
      expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1',[other.workspaceId])).rows).toEqual([])
    } finally {client.release()}
    // Reject the INSERT after the tombstone UPDATE has already succeeded.
    await pool.query(`CREATE FUNCTION fixture_reject_correction() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.reason='Fixture receipt failure' THEN RAISE EXCEPTION 'fixture_receipt_failed'; END IF; RETURN NEW; END $$;
      CREATE TRIGGER fixture_reject_correction BEFORE INSERT ON correction_audit FOR EACH ROW EXECUTE FUNCTION fixture_reject_correction()`)
    try {
      await expect(repo.applySoftRetract({...args,workspaceId:other.workspaceId,memoryId:other.memory.id,retractedBy:other.userId,reason:'Fixture receipt failure'})).rejects.toThrow('fixture_receipt_failed')
      expect((await pool.query('SELECT retracted_at FROM memories WHERE id=$1',[other.memory.id])).rows[0].retracted_at).toBeNull()
      expect((await pool.query('SELECT id FROM correction_audit WHERE workspace_id=$1',[other.workspaceId])).rows).toEqual([])
    } finally {await pool.query('DROP TRIGGER fixture_reject_correction ON correction_audit; DROP FUNCTION fixture_reject_correction()')}
    await expect(repo.applySoftRetract({...args,memoryId:randomUUID()})).rejects.toThrow('retraction_target_unavailable')
  })
  it('does not backfill legacy correction receipts from current target scope',async()=>{
    const f=await fixture(),id=randomUUID(),client=await pool.connect()
    const migration=(await readFile(new URL('../../../migrations/588_correction_reflection_scope.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
    try {
      await client.query('BEGIN')
      await client.query('DROP TRIGGER a_correction_scope ON correction_audit; DROP TRIGGER canonical_scope_version ON correction_audit; DROP POLICY correction_scope_read ON correction_audit; DROP FUNCTION capture_correction_scope(); ALTER TABLE correction_audit DROP COLUMN source_scope,DROP COLUMN scope_version,DROP COLUMN scope_held')
      await client.query("DELETE FROM scope_derivation_sources WHERE source_kind IN('session_message','feedback_event')")
      await client.query("INSERT INTO correction_audit(id,workspace_id,primitive,row_id,action,reason) VALUES($1,$2,'memory',$3,'retract','Legacy reason')",[id,f.workspaceId,f.memory.id])
      await client.query(migration)
      expect((await client.query("SELECT read_scope_source($1,'correction_audit',$2) AS source",[f.workspaceId,id])).rows[0].source).toBeNull()
      expect((await client.query('SELECT reason,source_scope FROM correction_audit WHERE id=$1',[id])).rows[0]).toEqual({reason:'Legacy reason',source_scope:null})
    } finally {await client.query('ROLLBACK');client.release()}
  })
  it('keeps metadata readers private and refuses cyclic or missing chains',async()=>{
    const f=await fixture(),id=await f.receipt()
    expect((await pool.query("SELECT has_function_privilege('assurance_app','read_verification_scope(uuid,text,uuid)','EXECUTE') AS allowed")).rows[0].allowed).toBe(false)
    await pool.query('UPDATE memories SET superseded_by=id WHERE id=$1',[f.memory.id])
    expect(await f.read(id)).toBeNull()
  })
})
