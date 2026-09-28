import {createDbWorkspaceGroupStore} from '../../db/workspace-group-store.js'
import {randomUUID} from 'node:crypto'
import express from 'express'
import request from 'supertest'
import {afterAll,describe,expect,it} from 'vitest'
import type {OrganizationCommand,OrganizationCommandReview} from '@use-brian/shared'
import {getPool,getAppPool} from '../../db/client.js'
import {getOrganizationChart,executeOrganizationCommand} from '../../db/org-chart-store.js'
import {getWorkspaceAccess} from '../service.js'
import {prepareOrganizationCommand,applyOrganizationCommand,applyOrganizationCommandIntent} from '../organization-command-review.js'
import {prepareDepartmentCommand,applyDepartmentCommand} from '../command-review.js'
import {workspaceAccessRoutes} from '../../routes/workspace-access.js'
const {assertLocalFixture}=await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()
const pool=getPool()
const create:OrganizationCommand={type:'org.unit.save',name:'Research',parentId:null,teamId:null,directoryVisibility:'members',position:0}
const proof=(review:OrganizationCommandReview)=>({type:'org.command.apply' as const,reviewId:review.id,payloadHash:review.payloadHash})
async function fixture(){
  const workspaceId=randomUUID(),owner=randomUUID(),member=randomUUID()
  for(const [id,name] of [[owner,'Casey'],[member,'Riley']])await pool.query('INSERT INTO users(id,auth_provider_id,name) VALUES($1::uuid,$1::text,$2)',[id,name])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Organization review fixture',$2)",[workspaceId,owner])
  for(const id of [owner,member])await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,$3,'assigned')",[workspaceId,id,id===owner?'owner':'member'])
  const intent=async(command:OrganizationCommand)=>({command,expectedRevision:(await getOrganizationChart(workspaceId,owner)).revision,expectedPolicyRevision:(await getWorkspaceAccess(workspaceId,owner)).policyRevision,idempotencyKey:randomUUID()})
  const app=express();app.use(express.json());app.use((req,_res,next)=>{req.userId=owner;next()});app.use('/api',workspaceAccessRoutes())
  return{workspaceId,owner,member,intent,app}
}
describe('[COMP:api/organization-chart] saved graph review transactions',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})
  it('rolls back preview graph, revisions and audit, then applies and retries one receipt',async()=>{
    const f=await fixture(),intent=await f.intent(create)
    const [review,again]=await Promise.all([prepareOrganizationCommand(f.workspaceId,f.owner,intent),prepareOrganizationCommand(f.workspaceId,f.owner,intent)])
    const http=await request(f.app).post(`/api/workspaces/${f.workspaceId}/org-chart/command-review`).send(intent);expect(http.status).toBe(200);expect(http.body.id).toBe(review.id)
    expect(again.id).toBe(review.id);expect(review.effects[0]).toMatchObject({kind:'unit',name:'Research'})
    expect((await getOrganizationChart(f.workspaceId,f.owner)).revision).toBe('0')
    for(const table of ['workspace_org_units','workspace_org_placements','workspace_access_events'])expect((await pool.query(`SELECT 1 FROM ${table} WHERE workspace_id=$1`,[f.workspaceId])).rows).toEqual([])
    const results=await Promise.all([applyOrganizationCommand(f.workspaceId,f.owner,proof(review)),applyOrganizationCommand(f.workspaceId,f.owner,proof(review))])
    expect(results.map(row=>row.commandReceipt?.replayed).sort()).toEqual([false,true])
    expect(results[0].units[0].id).toBe(results[1].units[0].id)
    expect((await pool.query('SELECT 1 FROM workspace_access_events WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1)
    expect((await applyOrganizationCommandIntent(f.workspaceId,f.owner,intent)).commandReceipt?.replayed).toBe(true)
    expect(await prepareOrganizationCommand(f.workspaceId,f.owner,intent)).toMatchObject({alreadyApplied:true,effects:[]})
  })
  it('shows all archive effects and preserves content authority',async()=>{
    const f=await fixture(),root=(await executeOrganizationCommand(f.workspaceId,f.owner,create)).units[0]
    await executeOrganizationCommand(f.workspaceId,f.owner,{...create,name:'Child',parentId:root.id})
    await executeOrganizationCommand(f.workspaceId,f.owner,{type:'org.placement.save',unitId:root.id,userId:f.member,assistantId:null,isPrimary:true,reportsToUserId:null,accountableUserId:null})
    const access=await getWorkspaceAccess(f.workspaceId,f.owner)
    const review=await prepareOrganizationCommand(f.workspaceId,f.owner,await f.intent({type:'org.unit.archive',id:root.id,expectedVersion:root.version,destinationId:null}))
    expect(review.effects.map(row=>row.name).sort()).toEqual(['Child','Research','Riley'])
    expect(review.effects.find(row=>row.name==='Child')?.changes).toContainEqual({field:'parentId',before:[{kind:'text',value:'Research'}],after:[{kind:'code',value:'none'}]})
    expect((await getOrganizationChart(f.workspaceId,f.owner)).placements).toHaveLength(1)
    const applied=await applyOrganizationCommand(f.workspaceId,f.owner,proof(review))
    expect(applied.placements).toEqual([]);expect(applied.units).toHaveLength(1);expect(applied.units[0].parentId).toBeNull()
    expect((await getWorkspaceAccess(f.workspaceId,f.owner)).policyRevision).toBe(access.policyRevision)
  })
  it('reviews atomic initialization without inventing a primary department or reporting line',async()=>{
    const f=await fixture(),groups=createDbWorkspaceGroupStore(),team=await groups.createTeam(f.owner,f.workspaceId,{name:'Research',key:'research'})
    await groups.addMember(f.owner,team.id,f.member)
    const chart=await getOrganizationChart(f.workspaceId,f.owner)
    const command:OrganizationCommand={type:'org.initialize.subject',kind:'member',subjectId:f.member,teamId:team.id,expectedRevision:chart.revision,expectedPolicyRevision:chart.initialization!.policyRevision}
    const review=await prepareOrganizationCommand(f.workspaceId,f.owner,await f.intent(command))
    expect(review.effects.map(row=>row.kind)).toEqual(['unit','placement'])
    expect((await getOrganizationChart(f.workspaceId,f.owner)).units).toEqual([])
    const applied=await applyOrganizationCommand(f.workspaceId,f.owner,proof(review))
    expect(applied.units[0]).toMatchObject({name:'Research',directoryVisibility:'members',teamId:team.id})
    expect(applied.placements[0]).toMatchObject({userId:f.member,isPrimary:true,reportsToUserId:null,accountableUserId:null})
  })
  it('reviews assistant accountability while leaving its access audience untouched',async()=>{
    const f=await fixture(),assistant=randomUUID(),unit=(await executeOrganizationCommand(f.workspaceId,f.owner,create)).units[0]
    await pool.query("INSERT INTO assistants(id,workspace_id,owner_user_id,name,kind) VALUES($1,$2,$3,'Research assistant','standard')",[assistant,f.workspaceId,f.owner])
    const audience=(await pool.query('SELECT team_scope_mode,project_scope_mode,default_workspace_group_id,default_project_id FROM assistants WHERE id=$1',[assistant])).rows[0]
    const review=await prepareOrganizationCommand(f.workspaceId,f.owner,await f.intent({type:'org.placement.save',unitId:unit.id,userId:null,assistantId:assistant,isPrimary:true,reportsToUserId:null,accountableUserId:f.member}))
    expect(review.effects[0]).toMatchObject({kind:'placement',name:'Research assistant'})
    expect(review.effects[0].changes).toContainEqual({field:'accountableUserId',before:[{kind:'code',value:'none'}],after:[{kind:'text',value:'Riley'}]})
    const applied=await applyOrganizationCommand(f.workspaceId,f.owner,proof(review))
    expect(applied.placements[0].accountableUserId).toBe(f.member)
    expect((await pool.query('SELECT team_scope_mode,project_scope_mode,default_workspace_group_id,default_project_id FROM assistants WHERE id=$1',[assistant])).rows[0]).toEqual(audience)
  })
  it('rejects raw HTTP writes, mismatched review families, substituted actors and changed intents',async()=>{
    const f=await fixture(),other=await fixture(),intent=await f.intent(create),review=await prepareOrganizationCommand(f.workspaceId,f.owner,intent)
    expect((await request(f.app).post(`/api/workspaces/${f.workspaceId}/access/commands`).send(create)).body.error).toBe('access_review_required')
    await expect(applyOrganizationCommandIntent(f.workspaceId,f.owner,{...intent,idempotencyKey:randomUUID()})).rejects.toMatchObject({code:'access_review_required'})
    await expect(prepareOrganizationCommand(f.workspaceId,f.owner,{...intent,command:{...create,name:'Other'}})).rejects.toMatchObject({code:'access_idempotency_conflict'})
    await expect(applyOrganizationCommand(f.workspaceId,f.member,proof(review))).rejects.toMatchObject({code:'not_found'})
    await expect(applyOrganizationCommand(other.workspaceId,other.owner,proof(review))).rejects.toMatchObject({code:'not_found'})
    await expect(applyOrganizationCommand(f.workspaceId,f.owner,{...proof(review),payloadHash:'0'.repeat(64)})).rejects.toMatchObject({code:'access_review_changed'})
    await expect(applyDepartmentCommand(f.workspaceId,f.owner,{...proof(review),type:'access.command.apply'})).rejects.toMatchObject({code:'not_found'})
    const department=await prepareDepartmentCommand(f.workspaceId,f.owner,{command:{type:'department.create',name:'Other',key:'other'},expectedPolicyRevision:intent.expectedPolicyRevision,idempotencyKey:randomUUID()})
    await expect(applyOrganizationCommand(f.workspaceId,f.owner,proof(department as unknown as OrganizationCommandReview))).rejects.toMatchObject({code:'not_found'})
    expect((await request(f.app).post(`/api/workspaces/${f.workspaceId}/access/commands`).send(proof(review))).status).toBe(200)
  })
  it('checks graph and policy revisions and refuses lost administrator authority',async()=>{
    const f=await fixture(),review=await prepareOrganizationCommand(f.workspaceId,f.owner,await f.intent(create))
    await executeOrganizationCommand(f.workspaceId,f.owner,{...create,name:'Elsewhere'})
    await expect(applyOrganizationCommand(f.workspaceId,f.owner,proof(review))).rejects.toMatchObject({code:'access_policy_conflict'})
    const next=await prepareOrganizationCommand(f.workspaceId,f.owner,await f.intent(create))
    await pool.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    await expect(applyOrganizationCommand(f.workspaceId,f.owner,proof(next))).rejects.toMatchObject({code:'access_policy_conflict'})
    const last=await prepareOrganizationCommand(f.workspaceId,f.owner,await f.intent(create))
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.owner])
    await expect(applyOrganizationCommand(f.workspaceId,f.owner,proof(last))).rejects.toMatchObject({code:'admin_required'})
  })
  it('returns only the current filtered chart and receipt notice after a committed retry',async()=>{
    const f=await fixture(),intent=await f.intent(create),review=await prepareOrganizationCommand(f.workspaceId,f.owner,intent)
    await applyOrganizationCommand(f.workspaceId,f.owner,proof(review))
    await pool.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.owner])
    const retried=await applyOrganizationCommand(f.workspaceId,f.owner,proof(review))
    expect(retried.canManage).toBe(false);expect(retried.units).toEqual([]);expect(retried.appliedCommand).toBeUndefined();expect(retried.initialization).toBeUndefined()
    expect(await prepareOrganizationCommand(f.workspaceId,f.owner,intent)).toMatchObject({alreadyApplied:true,effects:[]})
  })
  it('rejects changed label effects even when the graph revision is unchanged',async()=>{
    const f=await fixture(),unit=(await executeOrganizationCommand(f.workspaceId,f.owner,create)).units[0]
    const review=await prepareOrganizationCommand(f.workspaceId,f.owner,await f.intent({type:'org.placement.save',unitId:unit.id,userId:f.member,assistantId:null,isPrimary:true,reportsToUserId:null,accountableUserId:null}))
    await pool.query("UPDATE users SET name='Renamed person' WHERE id=$1",[f.member])
    await expect(applyOrganizationCommand(f.workspaceId,f.owner,proof(review))).rejects.toMatchObject({code:'access_review_changed'})
    expect((await getOrganizationChart(f.workspaceId,f.owner)).placements).toEqual([])
  })
  it('keeps revision metadata immutable, enforces expiry, and hides stale reviews through application-role RLS',async()=>{
    const f=await fixture(),review=await prepareOrganizationCommand(f.workspaceId,f.owner,await f.intent(create))
    await expect(pool.query('UPDATE workspace_access_command_reviews SET organization_revision=1 WHERE id=$1',[review.id])).rejects.toThrow('access_review_immutable')
    const expiredId=randomUUID()
    await pool.query(`INSERT INTO workspace_access_command_reviews(id,workspace_id,actor_user_id,idempotency_key,intent_hash,command,policy_revision,organization_revision,changes,payload_hash,created_at,expires_at)
      SELECT $2,workspace_id,actor_user_id,$3,intent_hash,command,policy_revision,organization_revision,changes,payload_hash,now()-interval '2 hours',now()-interval '1 hour' FROM workspace_access_command_reviews WHERE id=$1`,[review.id,expiredId,randomUUID()])
    await expect(applyOrganizationCommand(f.workspaceId,f.owner,{...proof(review),reviewId:expiredId})).rejects.toMatchObject({code:'access_review_expired'})
    const client=await getAppPool().connect()
    try{
      await client.query('BEGIN');await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.member])
      expect((await client.query('SELECT id FROM workspace_access_command_reviews WHERE id=$1',[review.id])).rows).toEqual([])
      await client.query("SELECT set_config('app.current_user_id',$1,true)",[f.owner])
      expect((await client.query('SELECT id FROM workspace_access_command_reviews WHERE id=$1',[review.id])).rows).toHaveLength(1)
      await executeOrganizationCommand(f.workspaceId,f.owner,{...create,name:'Other'})
      expect((await client.query('SELECT id FROM workspace_access_command_reviews WHERE id=$1',[review.id])).rows).toEqual([])
    }finally{await client.query('ROLLBACK');client.release()}
  })
  it('rolls back graph and audit if receipt persistence fails',async()=>{
    const f=await fixture(),review=await prepareOrganizationCommand(f.workspaceId,f.owner,await f.intent(create))
    await pool.query(`CREATE FUNCTION fixture_org_receipt_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.id='${review.id}'::uuid THEN RAISE EXCEPTION 'receipt_failure'; END IF; RETURN NEW; END $$`)
    await pool.query('CREATE TRIGGER fixture_org_receipt_failure BEFORE UPDATE ON workspace_access_command_reviews FOR EACH ROW EXECUTE FUNCTION fixture_org_receipt_failure()')
    try{await expect(applyOrganizationCommand(f.workspaceId,f.owner,proof(review))).rejects.toMatchObject({code:'access_conflict'});expect((await getOrganizationChart(f.workspaceId,f.owner)).units).toEqual([]);expect((await pool.query('SELECT 1 FROM workspace_access_events WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])}
    finally{await pool.query('DROP TRIGGER fixture_org_receipt_failure ON workspace_access_command_reviews');await pool.query('DROP FUNCTION fixture_org_receipt_failure()')}
    expect((await applyOrganizationCommand(f.workspaceId,f.owner,proof(review))).commandReceipt?.replayed).toBe(false)
  })
})
