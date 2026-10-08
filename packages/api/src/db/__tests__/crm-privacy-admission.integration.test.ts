import {randomUUID} from 'node:crypto'
import {afterAll,describe,expect,it} from 'vitest'
import {getPool,getAppPool} from '../client.js'
import {createSoftDeleteStore} from '../soft-delete-store.js'
import {acquireCrmPrivacyAdmission} from '../../crm-operations/privacy-admission.js'
import {CRM_PRIVACY_COVERAGE} from '../../crm-operations/privacy-coverage.js'
import {pruneCrmOperationsRetention} from '../../crm-operations/privacy.js'

const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool(),appPool=getAppPool()
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Privacy admission fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",[workspaceId,userId])
  await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source) VALUES($1,$2,'person','Fixture person','person@example.com',$3,'manual')",[contactId,workspaceId,userId])
  const purge=async()=>{
    const store=createSoftDeleteStore(),snapshot=await store.readForSoftDelete('contact',workspaceId,contactId)
    await store.applyHardPurge({primitive:'contact',workspaceId,rowId:contactId,actorUserId:userId,reason:'Fixture erasure',ticketReference:null,snapshot:snapshot!,now:new Date()})
  }
  return {workspaceId,userId,contactId,purge}
}
const addNote=(f:{workspaceId:string;contactId:string})=>pool.query("INSERT INTO crm_activities(workspace_id,entity_id,activity_type,summary) VALUES($1,$2,'note','Fixture note')",[f.workspaceId,f.contactId])
describe('[COMP:crm/privacy-admission] Actual transaction admission for CRM privacy',()=>{
  afterAll(async()=>{await pool.end();await appPool.end()})
  it('guards every exported physical domain with an enabled row trigger in the actual schema',async()=>{
    const rows=(await pool.query("SELECT c.relname,t.tgenabled,t.tgtype FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND t.tgname='crm_privacy_write_admission'")).rows
    // Migration 522 adds protected immutable recovery evidence and a schema
    // registry, not ordinary writable CRM domains. Their dedicated trigger
    // and application-role denial are asserted by crm-erasure-journal.
    const protectedRecovery=new Set(['crm_erasure_journal','crm_erasure_journal_targets'])
    expect(rows.map(r=>r.relname).sort()).toEqual(CRM_PRIVACY_COVERAGE.map(e=>e.domain).filter(name=>!protectedRecovery.has(name)).sort())
    for(const row of rows){expect(row.tgenabled).toBe('O');expect(row.tgtype).toBe(31)}
  })
  it('rejects a privacy operation before it acts while another transaction is writing, then admits retry after rollback',async()=>{
    const f=await fixture(),writer=await pool.connect()
    try {
      await writer.query('BEGIN')
      await writer.query("UPDATE entities SET display_name='Pending private edit' WHERE id=$1",[f.contactId])
      await expect(f.purge()).rejects.toMatchObject({code:'conflict',details:{reason:'privacy_operation_busy'}})
      await expect(pruneCrmOperationsRetention({workspaceId:f.workspaceId,actor:{kind:'user',userId:f.userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}},new Date())).rejects.toMatchObject({code:'conflict',details:{reason:'privacy_operation_busy'}})
      expect((await pool.query('SELECT display_name FROM entities WHERE id=$1',[f.contactId])).rows[0].display_name).toBe('Fixture person')
      await writer.query('ROLLBACK')
      await f.purge()
      expect((await pool.query('SELECT id FROM entities WHERE id=$1',[f.contactId])).rows).toEqual([])
    }finally{await writer.query('ROLLBACK');writer.release()}
  })
  it('rejects concurrent same-workspace insert/update/delete with fixed errors while another workspace can write',async()=>{
    const f=await fixture(),other=await fixture(),privacy=await pool.connect()
    const draft=(await pool.query("INSERT INTO crm_email_drafts(workspace_id,body) VALUES($1,'Fixture draft') RETURNING id",[f.workspaceId])).rows[0].id
    try {
      await privacy.query('BEGIN');await acquireCrmPrivacyAdmission(privacy,f.workspaceId.toUpperCase())
      await expect(addNote(f)).rejects.toMatchObject({code:'55P03',message:'crm_privacy_operation_busy'})
      await expect(pool.query("UPDATE crm_email_drafts SET body='Changed private draft' WHERE id=$1",[draft])).rejects.toMatchObject({code:'55P03',message:'crm_privacy_operation_busy'})
      await expect(pool.query('DELETE FROM crm_email_drafts WHERE id=$1',[draft])).rejects.toMatchObject({code:'55P03',message:'crm_privacy_operation_busy'})
      await addNote(other)
      expect((await pool.query('SELECT body FROM crm_email_drafts WHERE id=$1',[draft])).rows[0].body).toBe('Fixture draft')
      // The privacy transaction can mutate its own guarded records without
      // treating its exclusive admission as a competing writer.
      await privacy.query("UPDATE crm_email_drafts SET body='Reviewed redaction' WHERE id=$1",[draft])
      await privacy.query('COMMIT')
      await addNote(f)
      expect((await pool.query('SELECT body FROM crm_email_drafts WHERE id=$1',[draft])).rows[0].body).toBe('Reviewed redaction')
    }finally{await privacy.query('ROLLBACK');privacy.release()}
  })
  it('guards both the old and new workspace when an owner-level migration moves a row',async()=>{
    const first=await fixture(),second=await fixture(),privacy=await pool.connect()
    const draft=(await pool.query("INSERT INTO crm_email_drafts(workspace_id,body) VALUES($1,'Movable fixture') RETURNING id",[first.workspaceId])).rows[0].id
    try {
      await privacy.query('BEGIN');await acquireCrmPrivacyAdmission(privacy,second.workspaceId)
      await expect(pool.query('UPDATE crm_email_drafts SET workspace_id=$1 WHERE id=$2',[second.workspaceId,draft])).rejects.toMatchObject({code:'55P03'})
      await privacy.query('ROLLBACK')
      await privacy.query('BEGIN');await acquireCrmPrivacyAdmission(privacy,first.workspaceId)
      await expect(pool.query('UPDATE crm_email_drafts SET workspace_id=$1 WHERE id=$2',[second.workspaceId,draft])).rejects.toMatchObject({code:'55P03'})
      await privacy.query('ROLLBACK')
      await pool.query('UPDATE crm_email_drafts SET workspace_id=$1 WHERE id=$2',[second.workspaceId,draft])
    }finally{await privacy.query('ROLLBACK');privacy.release()}
  })
  it('rolls back shared admission after a rejected statement so a later privacy transaction is not held indefinitely',async()=>{
    const f=await fixture(),client=await pool.connect(),privacy=await pool.connect()
    try {
      await client.query('BEGIN');await client.query('SAVEPOINT attempted_write')
      await expect(client.query("INSERT INTO crm_email_drafts(workspace_id,body) VALUES($1,'')",[f.workspaceId])).rejects.toMatchObject({code:'23514'})
      await client.query('ROLLBACK TO SAVEPOINT attempted_write')
      await privacy.query('BEGIN')
      await acquireCrmPrivacyAdmission(privacy,f.workspaceId)
      await privacy.query('COMMIT')
      await client.query('COMMIT')
    }finally{await client.query('ROLLBACK');await privacy.query('ROLLBACK');client.release();privacy.release()}
  })
  it('holds real purge admission before its target lock and closes the insert race without waiting in a trigger',async()=>{
    const f=await fixture(),holder=await pool.connect()
    let purge:Promise<void>|undefined
    try {
      await holder.query('BEGIN')
      await holder.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE',[f.contactId])
      purge=f.purge()
      let observed=false
      for(let n=0;n<100;n++) {
        const result=await pool.query<{allowed:boolean}>('SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) allowed',['crm-privacy-admission:'+f.workspaceId])
        if(!result.rows[0]!.allowed){observed=true;break}
        await new Promise(resolve=>setTimeout(resolve,10))
      }
      expect(observed).toBe(true)
      await expect(addNote(f)).rejects.toMatchObject({code:'55P03',message:'crm_privacy_operation_busy'})
      await holder.query('ROLLBACK');await purge
      await expect(addNote(f)).rejects.toMatchObject({code:'23503'})
    }finally{await holder.query('ROLLBACK');holder.release();await purge?.catch(()=>{})}
  })
  it('enforces the write guard for the application database role as well as the system adapter',async()=>{
    const f=await fixture(),privacy=await pool.connect(),app=await appPool.connect()
    try {
      await privacy.query('BEGIN');await acquireCrmPrivacyAdmission(privacy,f.workspaceId)
      await app.query('BEGIN');await app.query("SELECT set_config('app.current_user_id',$1,true)",[f.userId])
      await expect(app.query("INSERT INTO crm_email_drafts(workspace_id,body) VALUES($1,'App role fixture')",[f.workspaceId])).rejects.toMatchObject({code:'55P03'})
      await app.query('ROLLBACK');await privacy.query('ROLLBACK')
    }finally{await app.query('ROLLBACK');await privacy.query('ROLLBACK');app.release();privacy.release()}
  })
  it('guards null-workspace CRM history through its live parent and refuses to recreate it after purge',async()=>{
    const f=await fixture(),privacy=await pool.connect()
    const insert=()=>pool.query("INSERT INTO brain_row_versions(primitive,row_id,version_no,before_image,valid_from,valid_to,mutation_actor) VALUES('entity',$1,1,'{}',now()-interval '1 minute',now(),'human_edit')",[f.contactId])
    try {
      await privacy.query('BEGIN');await acquireCrmPrivacyAdmission(privacy,f.workspaceId)
      await expect(insert()).rejects.toMatchObject({code:'55P03',message:'crm_privacy_operation_busy'})
      await privacy.query('ROLLBACK')
      await f.purge()
      await expect(insert()).rejects.toMatchObject({code:'55P03',message:'crm_privacy_subject_unavailable'})
    }finally{await privacy.query('ROLLBACK');privacy.release()}
  })

})
