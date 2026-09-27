import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { afterAll, describe, expect, it } from 'vitest'
import type { AccessContext } from '@use-brian/core'
import { getPool, getAppPool, queryWithRLS } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { createDeal } from '../crm.js'
import { appendCrmActivity, listCrmTimeline, getCrmReport } from '../crm-r2.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()
const floorColumns = ['user_id','assistant_id','sensitivity','compartments','project_ids','source_scope_version','scope_origin','scope_held']
async function fixture() {
  const workspaceId=randomUUID(),userId=randomUUID(),memberId=randomUUID(),assistantId=randomUUID(),projectId=randomUUID()
  for(const id of [userId,memberId]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Activity scope fixture',$2)",[workspaceId,userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance,team_scope_mode) VALUES($1,$2,'owner','confidential','assigned'),($1,$3,'member','internal','assigned')",[workspaceId,userId,memberId])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')",[assistantId,workspaceId,userId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)",[projectId,workspaceId,userId])
  const team=await createDbWorkspaceGroupStore().createTeam(userId,workspaceId,{name:'Fixture department',key:'fixture-department'})
  const deal=await createDeal(userId,{workspaceId})
  const ctx:AccessContext={workspaceId,userId,assistantId,assistantKind:'primary',clearance:'confidential',compartments:null,mutationCompartments:null,projectIds:null,visibilityAssistantIds:null}
  const append=()=>appendCrmActivity({userId,workspaceId,entityId:deal.id,access:ctx,activityType:'note',summary:'Protected history'})
  return {workspaceId,userId,memberId,assistantId,projectId,team,deal,ctx,append}
}

describe('[COMP:crm/activity-scope] retained history audience',()=>{
  afterAll(async()=>{await getAppPool().end();await pool.end()})

  it.each(['department','sensitivity','private_user','private_assistant','project'] as const)('preserves %s protection after the parent audience broadens',async axis=>{
    const f=await fixture(),reader={...f.ctx}
    if(axis==='department') {await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[f.deal.id,[f.team.compartmentKey]]);reader.compartments=[]}
    if(axis==='sensitivity') {await pool.query("UPDATE entities SET sensitivity='confidential' WHERE id=$1",[f.deal.id]);reader.clearance='public'}
    if(axis==='private_user') {await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1',[f.deal.id,f.userId]);reader.userId=f.memberId}
    if(axis==='private_assistant') {await pool.query('UPDATE entities SET assistant_id=$2 WHERE id=$1',[f.deal.id,f.assistantId]);reader.visibilityAssistantIds=[]}
    if(axis==='project') {await pool.query('UPDATE entities SET project_ids=$2 WHERE id=$1',[f.deal.id,[f.projectId]]);reader.projectIds=[]}
    const row=await f.append()
    expect(row).not.toBeNull()
    const original=(await pool.query(`SELECT ${floorColumns.join(',')} FROM crm_activities WHERE id=$1`,[row!.id])).rows[0]
    // Owner SQL simulates a future explicit parent release; it must not release history.
    await pool.query("UPDATE entities SET user_id=NULL,assistant_id=NULL,sensitivity='public',compartments='{}',project_ids='{}' WHERE id=$1",[f.deal.id])
    expect(await listCrmTimeline({ctx:reader,entityId:f.deal.id})).toEqual([])
    const raw=await runWithAgentAccess({...reader,clearance:reader.clearance,compartments:reader.compartments},()=>queryWithRLS(reader.userId,'SELECT id FROM crm_activities WHERE workspace_id=$1',[f.workspaceId]))
    expect(raw.rows).toEqual([])
    expect((await pool.query(`SELECT ${floorColumns.join(',')} FROM crm_activities WHERE id=$1`,[row!.id])).rows[0]).toEqual(original)
    expect(await listCrmTimeline({ctx:f.ctx,entityId:f.deal.id})).toEqual([row])
    expect(JSON.stringify(row)).not.toContain('scope_origin')
  })

  it('excludes saved department history from reports after the parent becomes General',async()=>{
    const f=await fixture(),pipelineId=randomUUID(),stageId=randomUUID()
    await pool.query("INSERT INTO crm_pipelines(id,workspace_id,name) VALUES($1,$2,'Fixture pipeline')",[pipelineId,f.workspaceId])
    await pool.query("INSERT INTO crm_pipeline_stages(id,workspace_id,pipeline_id,name,category,position) VALUES($1,$2,$3,'Approved','won',0)",[stageId,f.workspaceId,pipelineId])
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[f.deal.id,[f.team.compartmentKey]])
    for(const occurredAt of [new Date('2026-01-01T00:00:00Z'),new Date('2026-01-03T00:00:00Z')])
      await appendCrmActivity({userId:f.userId,workspaceId:f.workspaceId,entityId:f.deal.id,access:f.ctx,activityType:'stage_change',occurredAt,metadata:{toStageId:stageId}})
    await pool.query("UPDATE entities SET compartments='{}' WHERE id=$1",[f.deal.id])
    expect((await getCrmReport(f.ctx)).stageVelocityDays.find(row=>row.stageId===stageId)).toMatchObject({samples:1,medianDays:2})
    expect((await getCrmReport({...f.ctx,compartments:[]})).stageVelocityDays.find(row=>row.stageId===stageId)).toMatchObject({samples:0,medianDays:null})
  })

  it('captures the real source floor on raw inserts and forbids rebinding or lowering it',async()=>{
    const f=await fixture()
    await pool.query("UPDATE entities SET sensitivity='confidential',compartments=$2 WHERE id=$1",[f.deal.id,[f.team.compartmentKey]])
    const row=(await pool.query(`INSERT INTO crm_activities(workspace_id,entity_id,activity_type,sensitivity,compartments,source_scope_version,scope_origin)
      VALUES($1,$2,'note','public','{}',999,'legacy') RETURNING *`,[f.workspaceId,f.deal.id])).rows[0]
    expect(row).toMatchObject({sensitivity:'confidential',compartments:[f.team.compartmentKey],scope_origin:'captured'})
    expect(row.source_scope_version).toBe((await pool.query('SELECT scope_version FROM entities WHERE id=$1',[f.deal.id])).rows[0].scope_version)
    for(const sql of ["sensitivity='public'","compartments='{}'","scope_origin='legacy'","source_scope_version=999","entity_id=gen_random_uuid()","id=gen_random_uuid()"])
      await expect(pool.query(`UPDATE crm_activities SET ${sql} WHERE id=$1`,[row.id])).rejects.toThrow('activity_scope_release_required')
    await pool.query('UPDATE crm_activities SET scope_held=true WHERE id=$1',[row.id])
    expect(await listCrmTimeline({ctx:f.ctx,entityId:f.deal.id})).toEqual([])
    await expect(pool.query('UPDATE crm_activities SET scope_held=false WHERE id=$1',[row.id])).rejects.toThrow('activity_scope_release_required')
  })

  it('keeps a read-only execution from directly inserting, changing or deleting history',async()=>{
    const f=await fixture()
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[f.deal.id,[f.team.compartmentKey]])
    const row=await f.append(),ctx={...f.ctx,compartments:[f.team.compartmentKey!],mutationCompartments:[]}
    await runWithAgentAccess({...ctx,clearance:'confidential'},async()=>{
      expect((await queryWithRLS(f.userId,'SELECT id FROM crm_activities WHERE id=$1',[row!.id])).rows).toHaveLength(1)
      await expect(queryWithRLS(f.userId,"INSERT INTO crm_activities(workspace_id,entity_id,activity_type) VALUES($1,$2,'note')",[f.workspaceId,f.deal.id])).rejects.toMatchObject({code:'42501'})
      expect((await queryWithRLS(f.userId,"UPDATE crm_activities SET summary='Refused' WHERE id=$1 RETURNING id",[row!.id])).rows).toEqual([])
      expect((await queryWithRLS(f.userId,'DELETE FROM crm_activities WHERE id=$1 RETURNING id',[row!.id])).rows).toEqual([])
    })
  })

  it('backfills existing rows as unproven legacy and withholds them in strict mode',async()=>{
    const f=await fixture(),client=await pool.connect()
    const migration=(await readFile(new URL('../../../migrations/581_crm_activity_scope.sql',import.meta.url),'utf8')).replace(/^BEGIN;\s*/,'').replace(/COMMIT;\s*$/,'')
    try {
      await client.query('BEGIN')
      for(const suffix of ['read','insert','update','delete']) await client.query(`DROP POLICY crm_activities_scope_${suffix} ON crm_activities`)
      await client.query('DROP TRIGGER crm_scope_activity_guard ON crm_activities; DROP FUNCTION guard_crm_activity_scope(); DROP FUNCTION crm_activity_scope_allows(crm_activities,boolean)')
      await client.query(`ALTER TABLE crm_activities ${floorColumns.map(column=>`DROP COLUMN ${column}`).join(',')}`)
      await client.query("INSERT INTO crm_activities(workspace_id,entity_id,activity_type,summary) VALUES($1,$2,'note','Legacy fixture')",[f.workspaceId,f.deal.id])
      await client.query(migration)
      const row=(await client.query('SELECT * FROM crm_activities WHERE workspace_id=$1',[f.workspaceId])).rows[0]
      expect(row).toMatchObject({scope_origin:'legacy',scope_held:false,sensitivity:'internal',compartments:[]})
      await client.query("SELECT set_config('app.current_user_id',$1,true),set_config('app.system_bypass','false',true)",[f.memberId])
      await client.query('SET LOCAL ROLE assurance_app')
      expect((await client.query('SELECT id FROM crm_activities WHERE workspace_id=$1',[f.workspaceId])).rows).toHaveLength(1)
      await client.query('RESET ROLE')
      await client.query("INSERT INTO workspace_access_policies(workspace_id,classification_mode) VALUES($1,'strict') ON CONFLICT(workspace_id) DO UPDATE SET classification_mode='strict'",[f.workspaceId])
      await client.query('SET LOCAL ROLE assurance_app')
      expect((await client.query('SELECT id FROM crm_activities WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
      await client.query('RESET ROLE')
    } finally {await client.query('ROLLBACK');client.release()}
  })
})
