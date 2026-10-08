import { randomUUID, createHmac } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it } from 'vitest'
import { CrmOperationsCommandSchema, type CrmOperationsContext } from '@use-brian/core'
import { getPool,getAppPool } from '../client.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createSoftDeleteStore } from '../soft-delete-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { readCrmAddressSuppressions, listCrmAddressSuppression } from '../../crm-operations/suppression-tombstones.js'
import { flushWorkspaceData } from '../workspace-flush.js'
import { crmOperationsRoutes } from '../../routes/crm-operations.js'
import { createWorkspaceStore } from '../workspace-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool(), service = createCrmOperationsService(createDbCrmOperationsStore())
const key = Buffer.alloc(32,19).toString('base64'), key2 = Buffer.alloc(32,20).toString('base64')
const ring = (activeVersion='v1',keys: Record<string,string>={ v1:key }) => { process.env.CRM_SUPPRESSION_HMAC_KEYRING=JSON.stringify({activeVersion,keys}) }
async function fixture() {
  ring()
  const workspaceId=randomUUID(),userId=randomUUID(),contactId=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Suppression fixture',$2)`,[workspaceId,userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`,[workspaceId,userId])
  const context: CrmOperationsContext={workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}}
  const run=(input:unknown)=>service.execute(context,CrmOperationsCommandSchema.parse(input))
  const person=async(id:string)=>{ await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,canonical_id,created_by_user_id,source)
    VALUES($1,$2,'person','Fixture person','Person+tag@example.com',$3,'manual')`,[id,workspaceId,userId]) }
  await person(contactId)
  await run({kind:'save_consent_purpose',purposeKey:'updates',label:'Updates',wordingVersion:'1',wording:'Fixture wording',applicableChannels:['email']})
  const consent=(id:string,action='withdrawn')=>run({kind:'record_consent',contactId:id,purposeKey:'updates',action,source:'fixture'})
  const policy=(expectedVersion=0)=>run({kind:'save_privacy_policy',expectedVersion,confirmed:true,intakeReplay:null,addressSuppression:{retentionSeconds:3600}})
  const erase=async(id=contactId)=>{ const store=createSoftDeleteStore(); const snapshot=await store.readForSoftDelete('contact',workspaceId,id)
    await store.applyHardPurge({primitive:'contact',workspaceId,rowId:id,actorUserId:userId,reason:'Fixture erasure',ticketReference:null,snapshot:snapshot!,now:new Date()}) }
  return {workspaceId,userId,contactId,context,run,consent,policy,person,erase}
}
const matching=(f:{workspaceId:string},address='person+tag@EXAMPLE.COM')=>readCrmAddressSuppressions(pool,f.workspaceId,'email',address,'updates')

describe('[COMP:crm/suppression-tombstones] Actual suppression erasure and release',()=>{
  afterAll(async()=>{ delete process.env.CRM_SUPPRESSION_HMAC_KEYRING; await pool.end(); await appPool.end() })
  it('blocks evidence loss without policy/keys, captures atomically and protects a recreated contact and raw address',async()=>{
    const f=await fixture(); await f.consent(f.contactId)
    await expect(f.erase()).rejects.toMatchObject({details:{reason:'suppression_policy_unconfigured'}})
    expect((await pool.query('SELECT 1 FROM entities WHERE id=$1',[f.contactId])).rowCount).toBe(1)
    expect((await pool.query(`SELECT 1 FROM correction_audit WHERE workspace_id=$1 AND action='purge'`,[f.workspaceId])).rowCount).toBe(0)
    await f.policy(); delete process.env.CRM_SUPPRESSION_HMAC_KEYRING
    await expect(f.erase()).rejects.toMatchObject({details:{reason:'suppression_keyring_unavailable'}})
    ring(); await f.erase()
    const rows=(await pool.query('SELECT * FROM crm_address_suppression_tombstones WHERE workspace_id=$1',[f.workspaceId])).rows
    expect(rows).toHaveLength(1); expect(JSON.stringify(rows)).not.toContain('example.com'); expect(JSON.stringify(rows)).not.toContain(f.contactId)
    expect(rows[0].address_hmac).toMatch(/^[a-f0-9]{64}$/)
    expect(await matching(f)).toHaveLength(1); expect(await matching(f,'person@example.com')).toHaveLength(0)
    const replacement=randomUUID(); await f.person(replacement); await f.consent(replacement,'granted')
    expect(await createDbCrmIntakeReadStore().checkSendability(f.workspaceId,replacement,'email','updates',{kind:'user',userId:f.userId})).toMatchObject({verdict:'blocked',reasons:['address_suppression']})
    const review=await listCrmAddressSuppression(pool,f.workspaceId)
    expect(review.tombstones).toHaveLength(1); expect(JSON.stringify(review)).not.toContain(rows[0].address_hmac)
  })
  it('does not invent suppression for ordinary grants and preserves the explicit domain for old policy clients',async()=>{
    const f=await fixture(); await f.consent(f.contactId,'granted'); delete process.env.CRM_SUPPRESSION_HMAC_KEYRING; await f.erase()
    expect(await matching(f)).toEqual([])
    await f.policy()
    const old=await f.run({kind:'save_privacy_policy',expectedVersion:1,confirmed:true,intakeReplay:{retentionSeconds:600}})
    expect(old.record.policy).toMatchObject({addressSuppression:{retentionSeconds:3600}})
    const again=await f.run({kind:'save_privacy_policy',expectedVersion:2,confirmed:true,intakeReplay:{retentionSeconds:600}})
    expect(again.created).toBe(false)
  })
  it('requires current owner review and later human reconsent, and leaves other reasons blocked',async()=>{
    const f=await fixture(); await f.policy(); await f.consent(f.contactId)
    await f.run({kind:'record_suppression',contactId:f.contactId,channel:'email',action:'suppressed',reasonCode:'hard_bounce',source:'fixture'})
    await f.erase(); const rows=await matching(f), withdrawn=rows.find(row=>row.reasonCode==='consent_withdrawn')!, bounced=rows.find(row=>row.reasonCode==='hard_bounce')!
    const next=randomUUID(); await f.person(next); const grant=await f.consent(next,'granted')
    const release={kind:'release_address_suppression',tombstoneId:withdrawn.id,confirmed:true,evidenceKind:'consent_event',evidenceId:grant.record.id}
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1`,[f.workspaceId])
    await expect(f.run(release)).rejects.toMatchObject({code:'not_authorized'})
    await pool.query(`UPDATE workspace_members SET role='owner' WHERE workspace_id=$1`,[f.workspaceId])
    await expect(f.run({...release,tombstoneId:bounced.id})).rejects.toMatchObject({details:{reason:'suppression_release_file_required'}})
    const before=(await pool.query('SELECT count(*)::int n FROM association_audit_log WHERE workspace_id=$1',[f.workspaceId])).rows[0].n
    await f.run(release); expect((await f.run(release)).duplicate).toBe(true)
    expect((await pool.query('SELECT count(*)::int n FROM association_audit_log WHERE workspace_id=$1',[f.workspaceId])).rows[0].n).toBe(before+1)
    expect((await matching(f)).map(row=>row.id)).toEqual([bounced.id])
  })
  it('retains old keys across rotation, fails closed on lost versions and isolates workspace digests and RLS',async()=>{
    const f=await fixture(); await f.policy(); await f.consent(f.contactId); await f.erase()
    ring('v2',{v1:key,v2:key2}); expect(await matching(f)).toHaveLength(1)
    ring('v2',{v2:key2}); await expect(matching(f)).rejects.toMatchObject({details:{reason:'suppression_retained_key_missing'}})
    ring('v1',{v1:key2}); await expect(matching(f)).rejects.toMatchObject({details:{reason:'suppression_key_material_mismatch'}})
    const other=await fixture(); await other.policy(); await other.consent(other.contactId); await other.erase()
    const rows=(await pool.query('SELECT workspace_id,address_hmac FROM crm_address_suppression_tombstones WHERE workspace_id=ANY($1::uuid[])',[[f.workspaceId,other.workspaceId]])).rows
    expect(new Set(rows.map(row=>row.address_hmac)).size).toBe(2)
    const client=await appPool.connect()
    try { await client.query('BEGIN'); await client.query(`SELECT set_config('app.current_user_id',$1,true)`,[other.userId])
      expect((await client.query('SELECT id FROM crm_address_suppression_tombstones WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
      expect((await client.query('UPDATE crm_address_suppression_tombstones SET released_at=now() WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('captures before workspace reset and keeps retained suppression after all contacts are gone',async()=>{
    const f=await fixture(); await f.consent(f.contactId)
    await expect(flushWorkspaceData(f.userId,f.workspaceId)).rejects.toMatchObject({details:{reason:'suppression_policy_unconfigured'}})
    await f.policy(); await flushWorkspaceData(f.userId,f.workspaceId)
    expect((await pool.query('SELECT id FROM entities WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(0)
    expect(await matching(f)).toHaveLength(1)
    await flushWorkspaceData(f.userId,f.workspaceId); expect(await matching(f)).toHaveLength(1)
  })
  it('serves complete redacted owner review and requires a current workspace artifact for non-consent release',async()=>{
    const f=await fixture(); await f.policy()
    const app=express(); app.use(express.json()); app.use((req,_res,next)=>{req.userId=f.userId;next()})
    app.use('/api/crm',crmOperationsRoutes({service,readStore:createDbCrmIntakeReadStore(),workspaceStore:createWorkspaceStore()}))
    for(let i=0;i<103;i++) await pool.query(`INSERT INTO crm_address_suppression_tombstones(workspace_id,key_version,address_hmac,channel,reason_code,occurred_at,policy_version,created_at,expires_at,key_check)
      VALUES($1,'v1',$2,'email','hard_bounce',now(),1,now(),now()+interval '1 hour',repeat('0',64))`,[f.workspaceId,createHmac('sha256',Buffer.from(key,'base64')).update(`fictional-fixture:${i}`).digest('hex')])
    const path=`/api/crm/${f.workspaceId}/operations/address-suppression`
    let cursor:string|undefined; const ids:string[]=[]
    do { const response=await request(app).get(path).query({limit:100,...(cursor?{cursor}:{})}); expect(response.status).toBe(200)
      expect(JSON.stringify(response.body)).not.toContain('address_hmac'); expect(JSON.stringify(response.body)).not.toContain(key)
      ids.push(...response.body.tombstones.map((row:{id:string})=>row.id)); cursor=response.body.nextCursor??undefined
    } while(cursor)
    expect(ids).toHaveLength(103); expect(new Set(ids).size).toBe(103)
    const fileId=randomUUID(),body={confirmed:true,evidenceKind:'workspace_file',evidenceId:fileId}
    expect((await request(app).post(`${path}/${ids[0]}/release`).send(body)).status).toBe(409)
    await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,storage_uri,created_by_user_id)
      VALUES($1,$2,'/release-evidence.txt','release-evidence.txt','fixture://release-evidence',$3)`,[fileId,f.workspaceId,f.userId])
    expect((await request(app).post(`${path}/${ids[0]}/release`).send({...body,confirmed:false})).status).toBe(400)
    const released=await request(app).post(`${path}/${ids[0]}/release`).send(body); expect(released.status).toBe(200)
    expect(released.body.record.releasedAt).toBeTruthy(); expect(released.body.record.address_hmac).toBeUndefined()
    await pool.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1`,[f.workspaceId])
    expect((await request(app).get(path)).status).toBe(403)
    expect((await request(app).post(`${path}/${ids[1]}/release`).send(body)).status).toBe(403)
  })
  it('rejects untrusted, older, withdrawn and wrong-address reconsent without changing retained evidence',async()=>{
    const f=await fixture(); await f.policy(); const old=await f.consent(f.contactId,'granted'); await f.consent(f.contactId); await f.erase()
    const row=(await matching(f))[0]!, next=randomUUID(); await f.person(next)
    const release=(evidenceId:unknown)=>f.run({kind:'release_address_suppression',tombstoneId:row.id,confirmed:true,evidenceKind:'consent_event',evidenceId})
    await expect(release(old.record.id)).rejects.toMatchObject({details:{reason:'suppression_reconsent_required'}})
    const granted=await f.consent(next,'granted')
    await pool.query(`UPDATE association_consent_events SET occurred_at='2099-01-01T00:00:00Z' WHERE id=$1`,[granted.record.id])
    await expect(release(granted.record.id)).rejects.toMatchObject({details:{reason:'suppression_reconsent_required'}})
    await pool.query(`UPDATE association_consent_events SET occurred_at=created_at WHERE id=$1`,[granted.record.id])
    await pool.query(`UPDATE association_consent_events SET actor_kind='import' WHERE id=$1`,[granted.record.id])
    await expect(release(granted.record.id)).rejects.toMatchObject({details:{reason:'suppression_reconsent_required'}})
    await pool.query(`UPDATE association_consent_events SET actor_kind='user' WHERE id=$1`,[granted.record.id])
    await pool.query(`UPDATE entities SET canonical_id='different@example.com' WHERE id=$1`,[next])
    await expect(release(granted.record.id)).rejects.toMatchObject({details:{reason:'suppression_reconsent_address_mismatch'}})
    await pool.query(`UPDATE entities SET canonical_id='Person+tag@example.com' WHERE id=$1`,[next])
    await f.consent(next)
    await expect(release(granted.record.id)).rejects.toMatchObject({details:{reason:'suppression_reconsent_required'}})
    expect(await matching(f)).toHaveLength(1)
    await expect(pool.query(`UPDATE crm_address_suppression_tombstones SET address_hmac=repeat('0',64) WHERE id=$1`,[row.id])).rejects.toMatchObject({code:'23514'})
  })
  it('ignores expired suppression and refuses malformed keys or invalid addresses without leaking input',async()=>{
    const f=await fixture(); await f.policy(); await f.consent(f.contactId)
    await pool.query(`UPDATE entities SET canonical_id='invalid-address' WHERE id=$1`,[f.contactId])
    await expect(f.erase()).rejects.toMatchObject({details:{reason:'suppression_address_invalid'}})
    await pool.query(`UPDATE entities SET canonical_id='Person+tag@example.com' WHERE id=$1`,[f.contactId]); await f.erase()
    for(const invalid of ['secret-invalid-json',JSON.stringify({activeVersion:'missing',keys:{v1:key}}),JSON.stringify({activeVersion:'v1',keys:{v1:'short-secret'}})]) {
      process.env.CRM_SUPPRESSION_HMAC_KEYRING=invalid
      await expect(matching(f)).rejects.toMatchObject({details:{reason:'suppression_keyring_unavailable'}})
    }
    ring()
    // Expiry evidence is inserted with an old capture time; immutable rows
    // are never edited to make the clock test pass.
    const row=(await pool.query('SELECT * FROM crm_address_suppression_tombstones WHERE workspace_id=$1',[f.workspaceId])).rows[0]
    const other=await fixture(); await other.policy()
    await pool.query(`INSERT INTO crm_address_suppression_tombstones(workspace_id,key_version,address_hmac,channel,purpose_key,reason_code,occurred_at,policy_version,created_at,expires_at,key_check)
      VALUES($1,'retired',$2,'email','updates','consent_withdrawn','2020-01-01',1,'2020-01-01','2020-01-02',repeat('0',64))`,[other.workspaceId,row.address_hmac])
    delete process.env.CRM_SUPPRESSION_HMAC_KEYRING; expect(await matching(other)).toEqual([])
  })
  it('retains purpose withdrawal across channel catalog changes and normalizes phone formatting without rewriting opaque subjects',async()=>{
    const f=await fixture(); await f.policy(); await f.consent(f.contactId)
    await pool.query(`UPDATE entities SET attributes=attributes||'{"phone":"+1 (555) 123-4567"}'::jsonb WHERE id=$1`,[f.contactId])
    await pool.query(`INSERT INTO association_external_identities(workspace_id,contact_id,provider,provider_subject)
      VALUES($1,$2,'telegram','CaseSensitiveSubject')`,[f.workspaceId,f.contactId])
    await f.erase()
    // A purpose's current email-only catalog does not erase its withdrawal
    // for other known addresses when the purpose gains a channel later.
    for(const channel of ['phone','sms','whatsapp'] as const) expect(await readCrmAddressSuppressions(pool,f.workspaceId,channel,'+15551234567','updates')).toHaveLength(1)
    expect(await readCrmAddressSuppressions(pool,f.workspaceId,'telegram','CaseSensitiveSubject','updates')).toHaveLength(1)
    expect(await readCrmAddressSuppressions(pool,f.workspaceId,'telegram','casesensitivesubject','updates')).toHaveLength(0)
  })
  it('rolls capture and purge audit back when the final contact deletion is refused',async()=>{
    const f=await fixture(); await f.policy(); await f.consent(f.contactId)
    await pool.query('CREATE TABLE fixture_suppression_erase_guard(contact_id uuid REFERENCES entities(id))')
    try {
      await pool.query('INSERT INTO fixture_suppression_erase_guard VALUES($1)',[f.contactId])
      await expect(f.erase()).rejects.toMatchObject({code:'23503'})
      expect(await matching(f)).toEqual([])
      expect((await pool.query('SELECT 1 FROM association_consent_events WHERE workspace_id=$1',[f.workspaceId])).rowCount).toBe(1)
      expect((await pool.query(`SELECT 1 FROM correction_audit WHERE workspace_id=$1 AND action='purge'`,[f.workspaceId])).rowCount).toBe(0)
    } finally { await pool.query('DROP TABLE fixture_suppression_erase_guard') }
    await f.erase(); expect(await matching(f)).toHaveLength(1)
  })
  it('does not extend a captured horizon when the same evidence reappears after key rotation',async()=>{
    const f=await fixture(); await f.policy(); await f.consent(f.contactId); await f.erase()
    const before=(await pool.query('SELECT * FROM crm_address_suppression_tombstones WHERE workspace_id=$1',[f.workspaceId])).rows
    ring('v2',{v1:key,v2:key2})
    const next=randomUUID(); await f.person(next)
    await f.run({kind:'record_consent',contactId:next,purposeKey:'updates',action:'withdrawn',source:'fixture',occurredAt:before[0].occurred_at.toISOString()})
    await f.erase(next)
    expect((await pool.query('SELECT * FROM crm_address_suppression_tombstones WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual(before)
  })
})
