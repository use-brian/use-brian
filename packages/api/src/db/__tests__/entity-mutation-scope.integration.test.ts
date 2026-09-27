import { randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import type { AccessContext, EntityCreateParams, CrmOperationsContext } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { runWithAgentAccess } from '../agent-access-context.js'
import { createEntity, updateEntity, supersedeEntity, addEntityAlias, removeEntityAlias } from '../entities-store.js'
import { createDbWorkspaceGroupStore } from '../workspace-group-store.js'
import { createCompany, createContact, createDeal, updateCompany, updateContact, updateDeal, setDealStage } from '../crm.js'
import { appendCrmActivity, listCrmTimeline, getCrmReport, addCrmDealParticipant, listCrmDealParticipants, removeCrmDealParticipant, setCrmArchived, setCrmDealPipelineStage, setCrmDealPrimaryContact, updateCrmCustomFields, validateCrmCustomFieldValues } from '../crm-r2.js'
import { createDbCrmStore } from '../crm-store.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { applyBrainCorrection } from '../brain-inbox-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID(), assistantId = randomUUID(), projectId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Entity mutation fixture',$2)", [workspaceId, userId])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')", [workspaceId, userId])
  await pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2", [workspaceId,userId])
  await pool.query("INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind) VALUES($1,'Fixture assistant',$2,$3,'standard')", [assistantId, workspaceId, userId])
  await pool.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1,$2,'Fixture','fixture',$3)", [projectId, workspaceId, userId])
  const groups=createDbWorkspaceGroupStore()
  const team = await groups.createTeam(userId, workspaceId, { name: 'Product fixture', key: 'product-fixture' })
  const member=randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[member])
  await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,team_scope_mode) VALUES($1,$2,'member','assigned')",[workspaceId,member])
  const key = team.compartmentKey!
  const params: EntityCreateParams = { kind: 'person', displayName: 'Fictional person', workspaceId,
    userId: null, assistantId: null, createdByUserId: userId, source: 'user',
    aliases: ['fixture-alias'], attributes: { role: 'Coordinator' }, sensitivity: 'internal',
    compartments: [key], projectIds: [projectId] }
  const entity = await createEntity(params)
  const access: AccessContext = { workspaceId, userId, assistantId, assistantKind: 'primary',
    clearance: 'confidential', compartments: [key], mutationCompartments: [], projectIds: [projectId],
    visibilityAssistantIds: [assistantId] }
  const execution = (mutationCompartments: string[] | null = []) => ({ workspaceId, userId,
    clearance: 'confidential', compartments: [key], mutationCompartments, projectIds: [projectId],
    visibilityAssistantIds: [assistantId] })
  const stored = async () => (await pool.query('SELECT display_name,attributes,aliases,valid_to,superseded_by FROM entities WHERE id=$1', [entity.id])).rows[0]
  return { workspaceId, userId, member, groups, team, assistantId, projectId, key, params, entity, access, execution, stored }
}

async function customFixture() {
  const f=await fixture(),ctx={...f.access,mutationCompartments:null}
  const deal=await createDeal(f.userId,{workspaceId:f.workspaceId})
  await pool.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,options)
    VALUES($1,'deal','related_record','Related record','entity_reference','["person","company","deal"]'),
          ($1,'deal','note','Note','text','[]')`,[f.workspaceId])
  const stored=async()=>(await pool.query('SELECT attributes,sensitivity,compartments,project_ids FROM entities WHERE id=$1',[deal.id])).rows
  return {...f,ctx,deal,stored}
}

async function stageFixture() {
  const f=await customFixture(),pipelineId=randomUUID(),stageId=randomUUID()
  await pool.query("INSERT INTO crm_pipelines(id,workspace_id,name) VALUES($1,$2,'Fixture pipeline')",[pipelineId,f.workspaceId])
  await pool.query("INSERT INTO crm_pipeline_stages(id,workspace_id,pipeline_id,name,category,position) VALUES($1,$2,$3,'Approved','won',0)",[stageId,f.workspaceId,pipelineId])
  return {...f,pipelineId,stageId}
}

describe('[COMP:api/entity-mutation-scope] canonical entity writers', () => {
  afterAll(async () => { await getAppPool().end(); await pool.end() })

  it.each(['held','retracted','foreign','private','department','clearance'] as const)('refuses activity mutation and timeline disclosure for %s sources',async restriction=>{
    const f=await stageFixture(),access={...f.ctx,userId:f.member},target=restriction==='foreign'?(await stageFixture()).deal.id:f.deal.id
    await appendCrmActivity({userId:f.userId,workspaceId:f.workspaceId,entityId:f.deal.id,activityType:'note',summary:'Protected history',sourceKind:'fixture',sourceId:'once'})
    if(restriction==='held') await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.deal.id])
    if(restriction==='retracted') await pool.query('UPDATE entities SET retracted_at=now() WHERE id=$1',[f.deal.id])
    if(restriction==='private') await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1',[f.deal.id,f.userId])
    if(restriction==='department') await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[f.deal.id,[f.key]])
    if(restriction==='clearance') await pool.query("UPDATE entities SET sensitivity='confidential' WHERE id=$1",[f.deal.id])
    expect(await appendCrmActivity({userId:f.member,workspaceId:f.workspaceId,access,entityId:target,activityType:'note',summary:'Refused',sourceKind:'fixture',sourceId:'once'})).toBeNull()
    expect(await listCrmTimeline({ctx:access,entityId:target})).toBeNull()
    expect((await pool.query('SELECT summary FROM crm_activities WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{summary:'Protected history'}])
  })

  it('allows activity reads through read reach but requires mutation reach for appending',async()=>{
    const f=await fixture(),input={userId:f.userId,workspaceId:f.workspaceId,entityId:f.entity.id,activityType:'note' as const,summary:'Authorized history'}
    await expect(appendCrmActivity({...input,access:f.access})).rejects.toMatchObject({code:'scope_operation_denied'})
    const row=await appendCrmActivity({...input,access:{...f.access,mutationCompartments:[f.key]}})
    expect(await listCrmTimeline({ctx:f.access,entityId:f.entity.id})).toEqual([row])
    await expect(runWithAgentAccess(f.execution([]),()=>appendCrmActivity(input))).rejects.toMatchObject({code:'scope_operation_denied'})
    await expect(appendCrmActivity({...input,access:{...f.access,userId:f.member}})).rejects.toMatchObject({code:'scope_operation_denied'})
  })

  it('composes activity with its source mutation and rolls both back',async()=>{
    const f=await stageFixture(),client=await pool.connect()
    try {
      await client.query('BEGIN')
      await updateEntity(f.userId,f.deal.id,{displayName:'Uncommitted'},f.ctx,client)
      expect(await appendCrmActivity({userId:f.userId,workspaceId:f.workspaceId,access:f.ctx,entityId:f.deal.id,activityType:'note',summary:'Uncommitted history'},client)).not.toBeNull()
      expect((await pool.query('SELECT id FROM crm_activities WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
      await client.query('ROLLBACK')
      expect((await pool.query('SELECT display_name FROM entities WHERE id=$1',[f.deal.id])).rows[0].display_name).not.toBe('Uncommitted')
      expect(await listCrmTimeline({ctx:f.ctx,entityId:f.deal.id})).toEqual([])
    } finally {await client.query('ROLLBACK');client.release()}
  })

  it('does not append activity for a departed member even with an owner client',async()=>{
    const f=await stageFixture(),client=await pool.connect()
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.member])
    try {
      expect(await appendCrmActivity({userId:f.member,workspaceId:f.workspaceId,entityId:f.deal.id,activityType:'note',summary:'Refused'},client)).toBeNull()
      expect(await listCrmTimeline({ctx:{...f.ctx,userId:f.member},entityId:f.deal.id})).toBeNull()
      expect((await pool.query('SELECT id FROM crm_activities WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
    } finally {client.release()}
  })

  it('excludes held source history from stage-velocity aggregates',async()=>{
    const f=await stageFixture()
    for(const occurredAt of [new Date('2026-01-01T00:00:00Z'),new Date('2026-01-03T00:00:00Z')]) await appendCrmActivity({userId:f.userId,workspaceId:f.workspaceId,entityId:f.deal.id,activityType:'stage_change',occurredAt,metadata:{toStageId:f.stageId}})
    const before=await getCrmReport(f.ctx)
    expect(before.stageVelocityDays.find(row=>row.stageId===f.stageId)).toMatchObject({samples:1,medianDays:2})
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.deal.id])
    const after=await getCrmReport(f.ctx)
    expect(after.stageVelocityDays.find(row=>row.stageId===f.stageId)).toMatchObject({samples:0,medianDays:null})
    expect(after.byStage.every(row=>row.count===0)).toBe(true)
  })

  it('uses only admitted contact addresses for a company timeline mailbox projection',async()=>{
    const f=await fixture(),company=await createCompany(f.userId,{workspaceId:f.workspaceId,name:'Fixture company'}),instanceId=randomUUID()
    await pool.query(`UPDATE entities SET attributes=attributes || jsonb_build_object('company_id',$2::text,'email','fixture@example.test') WHERE id=$1`,[f.entity.id,company.id])
    await pool.query("INSERT INTO connector_instance(id,scope,workspace_id,provider,label,connected,credentials) VALUES($1,'workspace',$2,'imap','Fixture mailbox',true,$3)",[instanceId,f.workspaceId,Buffer.alloc(1)])
    await pool.query(`INSERT INTO email_archive_messages(workspace_id,instance_id,owner_user_id,folder,provider_message_id,from_addr,subject,body_text)
      VALUES($1,$2,$3,'inbox','fixture-message','fixture@example.test','Mailbox fixture','Mailbox body')`,[f.workspaceId,instanceId,f.userId])
    expect(await listCrmTimeline({ctx:f.access,entityId:company.id})).toEqual([expect.objectContaining({subject:'Mailbox fixture',summary:'Mailbox body'})])
    expect(await listCrmTimeline({ctx:{...f.access,compartments:[]},entityId:company.id})).toEqual([])
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.entity.id])
    expect(await listCrmTimeline({ctx:f.access,entityId:company.id})).toEqual([])
  })

  it('commits custom field values and locked before/after history together',async()=>{
    const f=await customFixture(),store=createDbCrmStore()
    await store.setCustomFields!(f.ctx,f.deal.id,{note:'First'})
    await store.setCustomFields!(f.ctx,f.deal.id,{note:'Second'})
    const activities=(await pool.query('SELECT metadata FROM crm_activities WHERE workspace_id=$1 ORDER BY created_at',[f.workspaceId])).rows
    expect(activities.map(row=>row.metadata)).toEqual([
      {fields:['note'],before:{},after:{note:'First'}},
      {fields:['note'],before:{note:'First'},after:{note:'Second'}},
    ])
    expect((await f.stored())[0].attributes.custom_fields).toEqual({note:'Second'})
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.deal.id])
    expect(await store.setCustomFields!(f.ctx,f.deal.id,{note:'Refused'})).toBeNull()
    expect((await f.stored())[0].attributes.custom_fields).toEqual({note:'Second'})
  })

  it('rolls custom field values back if their history cannot commit',async()=>{
    const f=await customFixture(),store=createDbCrmStore(),before=await f.stored(),trigger=`fixture_history_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.entity_id='${f.deal.id}'::uuid THEN RAISE EXCEPTION 'fixture history commit refusal'; END IF; RETURN NULL; END $$`)
    await pool.query(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON crm_activities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    try {
      await expect(store.setCustomFields!(f.ctx,f.deal.id,{note:'Uncommitted'})).rejects.toThrow('fixture history commit refusal')
      expect(await f.stored()).toEqual(before)
      expect((await pool.query('SELECT id FROM crm_activities WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
    } finally {await pool.query(`DROP TRIGGER ${trigger} ON crm_activities`);await pool.query(`DROP FUNCTION ${trigger}()`)}
  })

  function operations(f: Awaited<ReturnType<typeof stageFixture>>) {
    const context: CrmOperationsContext = { workspaceId: f.workspaceId, actor: { kind: 'user', userId: f.userId },
      authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] } }
    const command = { kind: 'set_deal_pipeline_stage' as const, dealId: f.deal.id, pipelineId: f.pipelineId, stageId: f.stageId }
    const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
    const counts = async () => (await pool.query(`SELECT
      (SELECT count(*)::int FROM crm_activities WHERE workspace_id=$1) AS activities,
      (SELECT count(*)::int FROM association_audit_log WHERE workspace_id=$1) AS domain_audit,
      (SELECT count(*)::int FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='crm.deal.stage_changed') AS workspace_audit,
      (SELECT count(*)::int FROM crm_domain_event_outbox WHERE workspace_id=$1) AS events`, [f.workspaceId])).rows[0]
    return { context, command, service, counts }
  }

  it.each(['department','held','private','clearance','retracted','foreign'] as const)('guards active stage source before catalog guidance: %s', async restriction => {
    const f=await stageFixture(),o=operations(f),ctx={...o.context,actor:{kind:'user' as const,userId:f.member}}
    if(restriction==='department') await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[f.deal.id,[f.key]])
    if(restriction==='held') await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.deal.id])
    if(restriction==='private') await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1',[f.deal.id,f.userId])
    if(restriction==='clearance') await pool.query("UPDATE entities SET sensitivity='confidential' WHERE id=$1",[f.deal.id])
    if(restriction==='retracted') await pool.query('UPDATE entities SET retracted_at=now() WHERE id=$1',[f.deal.id])
    if(restriction==='foreign') ctx.workspaceId=(await fixture()).workspaceId
    const before=await f.stored(),counts=await o.counts()
    await expect(o.service.execute(ctx,{...o.command,stageId:randomUUID()})).rejects.toMatchObject({
      code:restriction==='foreign'?'scope_operation_denied':'catalog_key_invalid',
    })
    expect(await f.stored()).toEqual(before)
    expect(await o.counts()).toEqual(counts)
  })

  it('commits active stage, activity, audit and event once, and reauthorizes exact replay', async()=>{
    const f=await stageFixture(),o=operations(f),before=await o.counts()
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[f.deal.id,[f.key]])
    const result=await runWithAgentAccess(f.execution([f.key]),()=>o.service.execute(o.context,o.command))
    expect(JSON.stringify(result)).not.toContain('compartments')
    expect((await f.stored())[0]).toMatchObject({compartments:[f.key],attributes:{pipeline_stage_id:f.stageId}})
    const after=await o.counts()
    for(const key of Object.keys(before)) expect(after[key]).toBe(before[key]+1)
    await o.service.execute(o.context,o.command)
    expect(await o.counts()).toEqual(after)
    await expect(runWithAgentAccess(f.execution([]),()=>o.service.execute(o.context,o.command))).rejects.toMatchObject({code:'scope_operation_denied'})
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId])
    await expect(o.service.execute(o.context,o.command)).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await o.counts()).toEqual(after)
  })

  it.each(['brain_key','integration_key','oauth_token','home_app'] as const)('refuses stage machine %s without borrowing credential authorship',async kind=>{
    const f=await stageFixture(),o=operations(f),before=await f.stored(),counts=await o.counts()
    const context={...o.context,actor:{kind,credentialId:randomUUID(),userId:f.userId}}
    const store=createDbCrmOperationsStore(pool)
    await expect(store.transaction(context,tx=>tx.setDealPipelineStage({...o.command,actorUserId:f.userId,actorAssistantId:null}))).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await f.stored()).toEqual(before)
    expect(await o.counts()).toEqual(counts)
  })

  it.each(['assistant','workflow'] as const)('requires a complete bound %s execution context for stage changes',async kind=>{
    const f=await stageFixture(),o=operations(f)
    const actor=kind==='assistant'?{kind,assistantId:f.assistantId,userId:f.userId,sessionId:randomUUID()}:{kind,workflowId:randomUUID(),runId:randomUUID(),userId:f.userId}
    const ctx={...o.context,actor}
    await expect(o.service.execute(ctx,o.command)).rejects.toMatchObject({code:'scope_operation_denied'})
    await expect(runWithAgentAccess({...f.execution(null),userId:f.member},()=>o.service.execute(ctx,o.command))).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await runWithAgentAccess(f.execution(null),()=>o.service.execute(ctx,o.command))).toBeTruthy()
  })

  it('rechecks assistant clearance even when the retained execution envelope is broader',async()=>{
    const f=await stageFixture(),o=operations(f),before=await f.stored()
    await pool.query("UPDATE assistants SET clearance='public' WHERE id=$1",[f.assistantId])
    const ctx={...o.context,actor:{kind:'assistant' as const,assistantId:f.assistantId,userId:f.userId,sessionId:randomUUID()}}
    await expect(runWithAgentAccess(f.execution(null),()=>o.service.execute(ctx,o.command))).rejects.toMatchObject({code:'catalog_key_invalid'})
    expect(await f.stored()).toEqual(before)
  })

  it('holds member and selected catalog locks through composed stage completion',async()=>{
    const f=await stageFixture(),o=operations(f),before=await f.stored(),counts=await o.counts()
    const client=await pool.connect(),contender=await pool.connect()
    try {
      await client.query('BEGIN')
      const store=createDbCrmOperationsStore(pool,client)
      expect(await store.transaction(o.context,tx=>tx.setDealPipelineStage({...o.command,actorUserId:f.userId,actorAssistantId:null}))).not.toBeNull()
      await contender.query("SET lock_timeout='50ms'")
      for(const [sql,values] of [
        ['DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.userId]],
        ['UPDATE crm_pipeline_stages SET archived_at=now() WHERE id=$1',[f.stageId]],
        ['UPDATE crm_pipelines SET archived_at=now() WHERE id=$1',[f.pipelineId]],
      ] as const) await expect(contender.query(sql,[...values])).rejects.toMatchObject({code:'55P03'})
      await client.query('ROLLBACK')
      expect(await f.stored()).toEqual(before)
      expect(await o.counts()).toEqual(counts)
    } finally {await client.query('ROLLBACK');await contender.query('RESET lock_timeout');client.release();contender.release()}
  })

  it('rolls back active stage, activity and audits if the outbox append fails',async()=>{
    const f=await stageFixture(),o=operations(f),before=await f.stored(),counts=await o.counts(),trigger=`fixture_ops_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${f.workspaceId}'::uuid THEN RAISE EXCEPTION 'fixture outbox refusal'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON crm_domain_event_outbox FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    try {
      await expect(o.service.execute(o.context,o.command)).rejects.toThrow('fixture outbox refusal')
      expect(await f.stored()).toEqual(before)
      expect(await o.counts()).toEqual(counts)
    } finally {await pool.query(`DROP TRIGGER ${trigger} ON crm_domain_event_outbox`);await pool.query(`DROP FUNCTION ${trigger}()`)}
  })

  it('bounds custom validation to current membership on owner clients without seeding pipelines',async()=>{
    const f=await customFixture(),client=await pool.connect()
    const ctx={...f.ctx,userId:f.member}
    try {
      expect(await validateCrmCustomFieldValues({ctx,entityKind:'deal',values:{note:'Allowed'}},client)).toHaveLength(2)
      expect((await pool.query('SELECT id FROM crm_pipelines WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
      await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[f.workspaceId,f.member])
      await expect(validateCrmCustomFieldValues({ctx,entityKind:'deal',values:{unknown:'No catalog'}},client)).rejects.toThrow('Valid fields: (none configured)')
      await expect(runWithAgentAccess(f.execution(),()=>validateCrmCustomFieldValues({ctx,entityKind:'deal',values:{note:'Wrong actor'}},client))).rejects.toMatchObject({code:'scope_operation_denied'})
      expect((await pool.query('SELECT id FROM crm_pipelines WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([])
    } finally {client.release()}
  })

  it.each(['archive','stage'] as const)('gates %s edits on current source and mutation reach',async action=>{
    const f=await stageFixture()
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[f.deal.id,[f.key]])
    const change=(ctx:AccessContext)=>action==='archive'?setCrmArchived({ctx,entityId:f.deal.id,archived:true}):setCrmDealPipelineStage({ctx,entityId:f.deal.id,stageId:f.stageId})
    const before=await f.stored()
    expect(await change({...f.ctx,userId:f.member})).toBeNull()
    await expect(change(f.access)).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await f.stored()).toEqual(before)
    expect(await change(f.ctx)).not.toBeNull()
    expect((await f.stored())[0].compartments).toEqual([f.key])
    if(action==='archive') {
      expect((await f.stored())[0].attributes.crm_archived_at).toEqual(expect.any(String))
      expect(await setCrmArchived({ctx:f.ctx,entityId:f.deal.id,archived:false})).not.toBeNull()
      expect((await f.stored())[0].attributes.crm_archived_at).toBeUndefined()
    } else expect((await f.stored())[0].attributes).toMatchObject({pipeline_id:f.pipelineId,pipeline_stage_id:f.stageId,stage:'won'})
  })

  it('refuses retired/foreign stage configuration and checks required fields without changing the deal',async()=>{
    const f=await stageFixture(),other=await stageFixture(),before=await f.stored()
    expect(await setCrmDealPipelineStage({ctx:f.ctx,entityId:f.deal.id,stageId:other.stageId})).toBeNull()
    await pool.query('UPDATE crm_pipeline_stages SET archived_at=now() WHERE id=$1',[f.stageId])
    expect(await setCrmDealPipelineStage({ctx:f.ctx,entityId:f.deal.id,stageId:f.stageId})).toBeNull()
    await pool.query('UPDATE crm_pipeline_stages SET archived_at=NULL WHERE id=$1',[f.stageId])
    await pool.query('UPDATE crm_pipelines SET archived_at=now() WHERE id=$1',[f.pipelineId])
    expect(await setCrmDealPipelineStage({ctx:f.ctx,entityId:f.deal.id,stageId:f.stageId})).toBeNull()
    await pool.query('UPDATE crm_pipelines SET archived_at=NULL WHERE id=$1',[f.pipelineId])
    await pool.query("UPDATE crm_pipeline_stages SET required_fields=ARRAY['approval_note'] WHERE id=$1",[f.stageId])
    await expect(setCrmDealPipelineStage({ctx:f.ctx,entityId:f.deal.id,stageId:f.stageId})).rejects.toThrow('Required fields are missing: approval_note')
    expect(await f.stored()).toEqual(before)
    await pool.query(`UPDATE entities SET attributes=attributes || '{"custom_fields":{"approval_note":"Approved"}}'::jsonb WHERE id=$1`,[f.deal.id])
    expect(await setCrmDealPipelineStage({ctx:f.ctx,entityId:f.deal.id,stageId:f.stageId})).toMatchObject({fromStageId:null,toStage:{id:f.stageId}})
  })

  it.each(['archive','stage'] as const)('rolls back a %s mutation when commit fails',async action=>{
    const f=await stageFixture(),before=await f.stored(),trigger=`fixture_stage_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${f.deal.id}'::uuid THEN RAISE EXCEPTION 'fixture stage commit refusal'; END IF; RETURN NULL; END $$`)
    await pool.query(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER UPDATE ON entities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    try {
      const write=action==='archive'?setCrmArchived({ctx:f.ctx,entityId:f.deal.id,archived:true}):setCrmDealPipelineStage({ctx:f.ctx,entityId:f.deal.id,stageId:f.stageId})
      await expect(write).rejects.toThrow('fixture stage commit refusal')
      expect(await f.stored()).toEqual(before)
    } finally {await pool.query(`DROP TRIGGER ${trigger} ON entities`);await pool.query(`DROP FUNCTION ${trigger}()`)}
  })

  it('holds selected stage and pipeline configuration through the source commit',async()=>{
    const f=await stageFixture(),writer=await pool.connect(),other=await pool.connect()
    try {
      await writer.query('BEGIN')
      expect(await setCrmDealPipelineStage({ctx:f.ctx,entityId:f.deal.id,stageId:f.stageId},writer)).not.toBeNull()
      for(const [table,id] of [['crm_pipeline_stages',f.stageId],['crm_pipelines',f.pipelineId]]) {
        await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='100ms'")
        await expect(other.query(`UPDATE ${table} SET archived_at=now() WHERE id=$1`,[id])).rejects.toMatchObject({code:'55P03'})
        await other.query('ROLLBACK')
      }
      await writer.query('ROLLBACK')
      expect((await f.stored())[0].attributes.pipeline_stage_id).toBeUndefined()
    } finally {await writer.query('ROLLBACK');await other.query('ROLLBACK');writer.release();other.release()}
  })

  it.each(['department','held','private','foreign','clearance','read-only'] as const)('refuses a %s custom reference without partial attributes or protection',async boundary=>{
    const f=await customFixture(),scope=boundary==='foreign'?await fixture():f
    const target=await createEntity({...scope.params,projectIds:[],compartments:boundary==='department'||boundary==='read-only'?[scope.key]:[],
      userId:boundary==='private'?f.userId:null,sensitivity:boundary==='clearance'?'confidential':'internal'})
    if(boundary==='held') await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[target.id])
    const ctx=boundary==='read-only'?f.access:{...f.ctx,userId:f.member,compartments:[],mutationCompartments:[],projectIds:[]}
    const before=await f.stored()
    await expect(updateCrmCustomFields({ctx,entityId:f.deal.id,values:{related_record:target.id,note:'Must roll back'}})).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await f.stored()).toEqual(before)
  })

  it.each(['person','company','deal'] as const)('inherits a %s custom reference and preserves its protection after clearing',async kind=>{
    const f=await customFixture(),target=await createEntity({...f.params,kind,sensitivity:'confidential'})
    expect(await updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{related_record:target.id,note:'Allowed'}}))
      .toMatchObject({sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId],attributes:{custom_fields:{related_record:target.id,note:'Allowed'}}})
    await expect(updateCrmCustomFields({ctx:f.access,entityId:f.deal.id,values:{}})).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{related_record:null}}))
      .toMatchObject({sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId],attributes:{custom_fields:{note:'Allowed'}}})
    expect((await f.stored())[0].attributes.custom_fields.related_record).toBeUndefined()
  })

  it('admits custom source before validation and refuses broader private reference copies',async()=>{
    const f=await customFixture(),target=await createEntity({...f.params,userId:f.userId,assistantId:f.assistantId})
    await expect(updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{related_record:target.id}})).rejects.toMatchObject({code:'scope_operation_denied'})
    await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.deal.id])
    expect(await updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{unknown:'Should not validate hidden source'}})).toBeNull()
    await pool.query('UPDATE entities SET scope_held=false,user_id=$2,assistant_id=$3 WHERE id=$1',[f.deal.id,f.userId,f.assistantId])
    expect(await updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{related_record:target.id}})).toMatchObject({userId:f.userId,assistantId:f.assistantId})
  })

  it('retains bounded catalog validation and required-field checks inside the custom transaction',async()=>{
    const f=await customFixture(),before=await f.stored()
    await expect(updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{unknown:'Unknown'}})).rejects.toThrow('Valid fields:')
    await expect(updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{related_record:'not-an-id'}})).rejects.toThrow('Invalid entity_reference')
    await pool.query("UPDATE crm_field_definitions SET is_required=true WHERE workspace_id=$1 AND field_key='note'",[f.workspaceId])
    await expect(updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{note:null}})).rejects.toThrow('Invalid text')
    expect(await f.stored()).toEqual(before)
  })

  it('rolls back custom fields and inherited scope when commit fails',async()=>{
    const f=await customFixture(),target=await createEntity({...f.params,sensitivity:'confidential'}),before=await f.stored()
    const trigger=`fixture_custom_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.id='${f.deal.id}'::uuid THEN RAISE EXCEPTION 'fixture custom commit refusal'; END IF; RETURN NULL; END $$`)
    await pool.query(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER UPDATE ON entities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    try {
      await expect(updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{related_record:target.id,note:'Pending'}})).rejects.toThrow('fixture custom commit refusal')
      expect(await f.stored()).toEqual(before)
    } finally {await pool.query(`DROP TRIGGER ${trigger} ON entities`);await pool.query(`DROP FUNCTION ${trigger}()`)}
  })

  it('keeps custom references stable through a composed owner transaction',async()=>{
    const f=await customFixture(),writer=await pool.connect(),other=await pool.connect()
    try {
      await writer.query('BEGIN')
      const target=await createEntity({...f.params,kind:'company'},writer)
      expect(await updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{related_record:target.id}},writer)).toMatchObject({compartments:[f.key]})
      await writer.query('COMMIT')
      await writer.query('BEGIN')
      await updateCrmCustomFields({ctx:f.ctx,entityId:f.deal.id,values:{related_record:target.id}},writer)
      await other.query('BEGIN');await other.query("SET LOCAL lock_timeout='100ms'")
      await expect(other.query('UPDATE entities SET scope_held=true WHERE id=$1',[target.id])).rejects.toMatchObject({code:'55P03'})
      await other.query('ROLLBACK');await writer.query('ROLLBACK')
      await other.query('UPDATE entities SET scope_held=true WHERE id=$1',[target.id])
    } finally {await writer.query('ROLLBACK');await other.query('ROLLBACK');writer.release();other.release()}
  })

  it('projects only live authorized participants from legacy broader deal relationships',async()=>{
    const f=await fixture(),ctx={...f.access,userId:f.member,compartments:[],mutationCompartments:[],projectIds:[]}
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId})
    const visible=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Visible participant',email:'visible@example.test'})
    const candidates=[visible.id]
    for(const boundary of ['department','held','private','clearance','retired','retracted','self']) {
      const contact=await createEntity({...f.params,displayName:'Hidden participant',canonicalId:'hidden@example.test',attributes:boundary==='self'?{self:true}:{},projectIds:[],
        compartments:boundary==='department'?[f.key]:[],userId:boundary==='self'?f.member:boundary==='private'?f.userId:null,sensitivity:boundary==='clearance'?'confidential':'internal'})
      if(boundary==='held') await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[contact.id])
      if(boundary==='retired') await pool.query('UPDATE entities SET valid_to=now() WHERE id=$1',[contact.id])
      if(boundary==='retracted') await pool.query('UPDATE entities SET retracted_at=now() WHERE id=$1',[contact.id])
      candidates.push(contact.id)
    }
    for(const contactId of candidates) await pool.query('INSERT INTO crm_deal_contacts(workspace_id,deal_id,contact_id,role,created_by) VALUES($1,$2,$3,$4,$5)',[f.workspaceId,deal.id,contactId,'Member',f.userId])
    expect(await listCrmDealParticipants(ctx,deal.id)).toEqual([{contactId:visible.id,role:'Member',isPrimary:false,name:'Visible participant',email:'visible@example.test'}])
    await pool.query('UPDATE entities SET compartments=$2 WHERE id=$1',[deal.id,[f.key]])
    expect(await listCrmDealParticipants(ctx,deal.id)).toBeNull()
    await pool.query('UPDATE entities SET compartments=$2,scope_held=true WHERE id=$1',[deal.id,[]])
    expect(await listCrmDealParticipants(ctx,deal.id)).toBeNull()
  })

  it('rechecks participant member reach instead of trusting a stale broad read context',async()=>{
    const f=await fixture(),ctx={...f.access,userId:f.member,mutationCompartments:null}
    await f.groups.addMember(f.userId,f.team.id,f.member)
    const contact=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Scoped participant',compartments:[f.key]})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId})
    // A legacy general deal may reference a restricted person without inherited labels.
    await pool.query('INSERT INTO crm_deal_contacts(workspace_id,deal_id,contact_id,created_by) VALUES($1,$2,$3,$4)',[f.workspaceId,deal.id,contact.id,f.userId])
    expect(await listCrmDealParticipants(ctx,deal.id)).toHaveLength(1)
    await f.groups.removeMember(f.userId,f.team.id,f.member)
    expect(await listCrmDealParticipants(ctx,deal.id)).toEqual([])
  })

  it.each(['department','held','private','foreign','clearance','read-only'] as const)('refuses %s secondary participant mutations without altering the deal',async boundary=>{
    const f=await fixture(),scope=boundary==='foreign'?await fixture():f
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId})
    const contact=await createEntity({...scope.params,displayName:'Participant candidate',projectIds:[],
      compartments:boundary==='department'||boundary==='read-only'?[scope.key]:[],
      userId:boundary==='private'?f.userId:null,sensitivity:boundary==='clearance'?'confidential':'internal'})
    if(boundary==='held') await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[contact.id])
    const ctx=boundary==='read-only'?f.access:{...f.access,userId:f.member,compartments:[],mutationCompartments:[],projectIds:[]}
    for(const write of [addCrmDealParticipant,removeCrmDealParticipant]) {
      await expect(write({ctx,dealId:deal.id,contactId:contact.id})).rejects.toMatchObject({code:'scope_operation_denied'})
    }
    expect((await pool.query('SELECT contact_id FROM crm_deal_contacts WHERE deal_id=$1',[deal.id])).rows).toEqual([])
    expect((await pool.query('SELECT compartments FROM entities WHERE id=$1',[deal.id])).rows).toEqual([{compartments:[]}])
  })

  it('keeps participant scope, primary flags and the canonical contact consistent across edits and removal',async()=>{
    const f=await fixture(),ctx={...f.access,mutationCompartments:null}
    const primary=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Primary contact'})
    const secondary=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Restricted participant',sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId})
    expect(await setCrmDealPrimaryContact({ctx,dealId:deal.id,contactId:primary.id})).toBe(true)
    expect(await addCrmDealParticipant({ctx,dealId:deal.id,contactId:primary.id,role:'Coordinator'})).toBe(true)
    expect((await pool.query('SELECT is_primary,role FROM crm_deal_contacts WHERE deal_id=$1 AND contact_id=$2',[deal.id,primary.id])).rows)
      .toEqual([{is_primary:true,role:'Coordinator'}])
    expect(await addCrmDealParticipant({ctx,dealId:deal.id,contactId:secondary.id})).toBe(true)
    const stored=async()=>(await pool.query("SELECT attributes->>'contact_id' AS contact_id,sensitivity,compartments,project_ids FROM entities WHERE id=$1",[deal.id])).rows[0]
    expect(await stored()).toEqual({contact_id:primary.id,sensitivity:'confidential',compartments:[f.key],project_ids:[f.projectId]})
    expect(await removeCrmDealParticipant({ctx:{...ctx,userId:f.member},dealId:deal.id,contactId:secondary.id})).toBe(false)
    await expect(removeCrmDealParticipant({ctx:f.access,dealId:deal.id,contactId:secondary.id})).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await removeCrmDealParticipant({ctx,dealId:deal.id,contactId:secondary.id})).toBe(true)
    expect((await stored()).contact_id).toBe(primary.id)
    expect(await removeCrmDealParticipant({ctx,dealId:deal.id,contactId:primary.id})).toBe(true)
    expect(await stored()).toEqual({contact_id:null,sensitivity:'confidential',compartments:[f.key],project_ids:[f.projectId]})
    expect((await pool.query('SELECT contact_id FROM crm_deal_contacts WHERE deal_id=$1',[deal.id])).rows).toEqual([])
  })

  it('does not change deal protection when removing an absent participant',async()=>{
    const f=await fixture(),ctx={...f.access,mutationCompartments:null}
    const contact=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Absent participant',compartments:[f.key]})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId})
    const before=(await pool.query('SELECT compartments,updated_at FROM entities WHERE id=$1',[deal.id])).rows
    expect(await removeCrmDealParticipant({ctx,dealId:deal.id,contactId:contact.id})).toBe(false)
    expect((await pool.query('SELECT compartments,updated_at FROM entities WHERE id=$1',[deal.id])).rows).toEqual(before)
  })

  it('refuses publishing a readable private participant into a broader deal',async()=>{
    const f=await fixture(),ctx={...f.access,mutationCompartments:null}
    const contact=await createEntity({...f.params,userId:f.userId,assistantId:f.assistantId})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId})
    await expect(addCrmDealParticipant({ctx,dealId:deal.id,contactId:contact.id})).rejects.toMatchObject({code:'scope_operation_denied'})
    expect((await pool.query('SELECT contact_id FROM crm_deal_contacts WHERE deal_id=$1',[deal.id])).rows).toEqual([])
    const compatible=await createDeal(f.userId,{workspaceId:f.workspaceId,contactId:contact.id})
    expect(await addCrmDealParticipant({ctx,dealId:compatible.id,contactId:contact.id})).toBe(true)
  })

  it('keeps ambient read-only authority narrower than an explicit participant context',async()=>{
    const f=await fixture(),ctx={...f.access,mutationCompartments:null}
    const contact=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Ambient participant'})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId,compartments:[f.key]})
    await addCrmDealParticipant({ctx,dealId:deal.id,contactId:contact.id})
    for(const write of [addCrmDealParticipant,removeCrmDealParticipant,setCrmDealPrimaryContact]) {
      await expect(runWithAgentAccess(f.execution(),()=>write({ctx,dealId:deal.id,contactId:contact.id}))).rejects.toMatchObject({code:'scope_operation_denied'})
    }
    expect((await pool.query('SELECT contact_id,is_primary FROM crm_deal_contacts WHERE deal_id=$1',[deal.id])).rows)
      .toEqual([{contact_id:contact.id,is_primary:false}])
  })

  it.each(['add','remove'] as const)('rolls back participant %s and deal protection on commit failure',async action=>{
    const f=await fixture(),ctx={...f.access,mutationCompartments:null}
    const contact=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Participant rollback',compartments:action==='add'?[f.key]:[]})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId})
    if(action==='remove') await setCrmDealPrimaryContact({ctx,dealId:deal.id,contactId:contact.id})
    const source=async()=>(await pool.query('SELECT attributes,compartments FROM entities WHERE id=$1',[deal.id])).rows
    const participants=async()=>(await pool.query('SELECT contact_id,is_primary FROM crm_deal_contacts WHERE deal_id=$1',[deal.id])).rows
    const before=await source(),links=await participants(),trigger=`fixture_participant_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF ${action==='add'?'NEW':'OLD'}.workspace_id='${f.workspaceId}'::uuid THEN RAISE EXCEPTION 'fixture participant commit refusal'; END IF; RETURN NULL; END $$`)
    await pool.query(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER ${action==='add'?'INSERT':'DELETE'} ON crm_deal_contacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    try {
      await expect((action==='add'?addCrmDealParticipant:removeCrmDealParticipant)({ctx,dealId:deal.id,contactId:contact.id})).rejects.toThrow('fixture participant commit refusal')
      expect(await source()).toEqual(before);expect(await participants()).toEqual(links)
    } finally {await pool.query(`DROP TRIGGER ${trigger} ON crm_deal_contacts`);await pool.query(`DROP FUNCTION ${trigger}()`)}
  })

  it.each(['attribute','hold'] as const)('rechecks a concurrent %s change after obtaining the participant source lock',async change=>{
    const f=await fixture(),ctx={...f.access,mutationCompartments:null},locker=await pool.connect()
    const contact=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Concurrent participant'})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId})
    let pending:Promise<boolean|Error>|undefined
    try {
      await locker.query('BEGIN')
      await locker.query('SELECT id FROM entities WHERE id=$1 FOR UPDATE',[deal.id])
      const pid=(await locker.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0]!.pid
      pending=addCrmDealParticipant({ctx,dealId:deal.id,contactId:contact.id}).catch(error=>error as Error)
      let blocked=false
      for(let attempt=0;attempt<100;attempt++) {
        blocked=(await pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',[pid])).rows.length>0
        if(blocked) break
        await new Promise(resolve=>setTimeout(resolve,20))
      }
      expect(blocked).toBe(true)
      await locker.query(change==='hold'?'UPDATE entities SET scope_held=true WHERE id=$1':`UPDATE entities SET attributes=attributes || '{"concurrent_field":"retained"}'::jsonb WHERE id=$1`,[deal.id])
      await locker.query('COMMIT')
      expect(await pending).toBe(change==='attribute')
      const stored=(await pool.query('SELECT attributes FROM entities WHERE id=$1',[deal.id])).rows[0]
      if(change==='attribute') expect(stored.attributes.concurrent_field).toBe('retained')
      expect((await pool.query('SELECT contact_id FROM crm_deal_contacts WHERE deal_id=$1',[deal.id])).rows).toHaveLength(change==='attribute'?1:0)
    } finally {await locker.query('ROLLBACK');locker.release();await pending}
  })

  it.each(['department','held','private','foreign','clearance','read-only'] as const)('refuses a %s primary contact without changing either representation',async boundary=>{
    const f=await fixture()
    const original=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Original primary'})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId,contactId:original.id})
    const owner={...f.access,mutationCompartments:null}
    expect(await setCrmDealPrimaryContact({ctx:owner,dealId:deal.id,contactId:original.id})).toBe(true)
    const scope=boundary==='foreign'?await fixture():f
    const target=await createEntity({...scope.params,displayName:'Candidate primary',projectIds:[],
      compartments:boundary==='department'||boundary==='read-only'?[scope.key]:[],
      userId:boundary==='private'?f.userId:null,sensitivity:boundary==='clearance'?'confidential':'internal'})
    if(boundary==='held') await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[target.id])
    const ctx=boundary==='read-only'?f.access:{...f.access,userId:f.member,compartments:[],mutationCompartments:[],projectIds:[]}
    await expect(setCrmDealPrimaryContact({ctx,dealId:deal.id,contactId:target.id})).rejects.toMatchObject({code:'scope_operation_denied'})
    expect((await pool.query("SELECT attributes->>'contact_id' AS contact_id,compartments FROM entities WHERE id=$1",[deal.id])).rows)
      .toEqual([{contact_id:original.id,compartments:[]}])
    expect((await pool.query('SELECT contact_id,is_primary FROM crm_deal_contacts WHERE deal_id=$1',[deal.id])).rows)
      .toEqual([{contact_id:original.id,is_primary:true}])
  })

  it('inherits primary reference protection and keeps it after clearing the primary',async()=>{
    const f=await fixture(),ctx={...f.access,mutationCompartments:null}
    const person=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Protected primary',sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId})
    expect(await setCrmDealPrimaryContact({ctx,dealId:deal.id,contactId:person.id})).toBe(true)
    expect((await pool.query("SELECT attributes->>'contact_id' AS contact_id,sensitivity,compartments,project_ids FROM entities WHERE id=$1",[deal.id])).rows)
      .toEqual([{contact_id:person.id,sensitivity:'confidential',compartments:[f.key],project_ids:[f.projectId]}])
    expect(await setCrmDealPrimaryContact({ctx:{...ctx,userId:f.member},dealId:deal.id,contactId:null})).toBe(false)
    await expect(setCrmDealPrimaryContact({ctx:f.access,dealId:deal.id,contactId:null})).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await setCrmDealPrimaryContact({ctx,dealId:deal.id,contactId:null})).toBe(true)
    expect((await pool.query("SELECT attributes->>'contact_id' AS contact_id,sensitivity,compartments FROM entities WHERE id=$1",[deal.id])).rows)
      .toEqual([{contact_id:null,sensitivity:'confidential',compartments:[f.key]}])
    expect((await pool.query('SELECT is_primary FROM crm_deal_contacts WHERE deal_id=$1',[deal.id])).rows).toEqual([{is_primary:false}])
  })

  it('rolls back a primary participant commit failure together with the canonical contact and scope',async()=>{
    const f=await fixture(),ctx={...f.access,mutationCompartments:null}
    const original=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Original contact'})
    const target=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Protected candidate',compartments:[f.key]})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId,contactId:original.id})
    expect(await setCrmDealPrimaryContact({ctx,dealId:deal.id,contactId:original.id})).toBe(true)
    const trigger=`fixture_primary_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${f.workspaceId}'::uuid THEN RAISE EXCEPTION 'fixture primary commit refusal'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON crm_deal_contacts DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    try {
      await expect(setCrmDealPrimaryContact({ctx,dealId:deal.id,contactId:target.id})).rejects.toThrow('fixture primary commit refusal')
      expect((await pool.query("SELECT attributes->>'contact_id' AS contact_id,compartments FROM entities WHERE id=$1",[deal.id])).rows)
        .toEqual([{contact_id:original.id,compartments:[]}])
      expect((await pool.query('SELECT contact_id,is_primary FROM crm_deal_contacts WHERE deal_id=$1',[deal.id])).rows)
        .toEqual([{contact_id:original.id,is_primary:true}])
    } finally {await pool.query(`DROP TRIGGER ${trigger} ON crm_deal_contacts`);await pool.query(`DROP FUNCTION ${trigger}()`)}
  })

  it.each(['contact','deal'] as const)('holds the %s reference snapshot until the owning transaction ends',async kind=>{
    const f=await fixture(),writer=await pool.connect(),contender=await pool.connect()
    const company=await createCompany(f.userId,{workspaceId:f.workspaceId,name:'Locked reference'})
    const effects:Array<()=>void>=[]
    const transaction={client:writer,afterCommit:(effect:()=>void)=>effects.push(effect)}
    try {
      await writer.query('BEGIN')
      const row=kind==='contact'
        ?await createContact(f.userId,{workspaceId:f.workspaceId,name:'Locked contact',companyId:company.id},undefined,transaction)
        :await createDeal(f.userId,{workspaceId:f.workspaceId,companyId:company.id},undefined,transaction)
      await contender.query('BEGIN')
      await contender.query("SET LOCAL lock_timeout='100ms'")
      await expect(contender.query('UPDATE entities SET scope_held=true WHERE id=$1',[company.id])).rejects.toMatchObject({code:'55P03'})
      await contender.query('ROLLBACK')
      expect((await pool.query('SELECT id FROM entities WHERE id=$1',[row.id])).rows).toEqual([])
      await writer.query('COMMIT')
      await contender.query('UPDATE entities SET scope_held=true WHERE id=$1',[company.id])
      const denied=kind==='contact'
        ?createContact(f.userId,{workspaceId:f.workspaceId,name:'Later contact',companyId:company.id})
        :createDeal(f.userId,{workspaceId:f.workspaceId,companyId:company.id})
      await expect(denied).rejects.toMatchObject({code:'scope_operation_denied'})
    } finally {
      await writer.query('ROLLBACK');await contender.query('ROLLBACK')
      writer.release();contender.release()
    }
  })

  it.each(['contact','deal'] as const)('rolls back standalone %s creation when commit fails, without graph effects',async kind=>{
    const f=await fixture(),company=await createCompany(f.userId,{workspaceId:f.workspaceId,name:'Commit reference'})
    const trigger=`fixture_commit_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${f.workspaceId}'::uuid AND NEW.kind='${kind==='contact'?'person':'deal'}'
        THEN RAISE EXCEPTION 'fixture commit refusal'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE CONSTRAINT TRIGGER ${trigger} AFTER INSERT ON entities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    const effects:unknown[]=[],links={create:async(value:unknown)=>{effects.push(value)}} as never
    try {
      const write=kind==='contact'
        ?createContact(f.userId,{workspaceId:f.workspaceId,name:'Refused contact',companyId:company.id},links)
        :createDeal(f.userId,{workspaceId:f.workspaceId,companyId:company.id},links)
      await expect(write).rejects.toThrow('fixture commit refusal')
      expect(effects).toEqual([])
      expect((await pool.query("SELECT id FROM entities WHERE workspace_id=$1 AND attributes->>'company_id'=$2",[f.workspaceId,company.id])).rows).toEqual([])
      // Rollback releases the reference lock too.
      await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[company.id])
    } finally {await pool.query(`DROP TRIGGER ${trigger} ON entities`);await pool.query(`DROP FUNCTION ${trigger}()`)}
  })

  it.each(['missing','department','held','private','foreign'] as const)('refuses a %s relationship without editing the source',async boundary=>{
    const f=await fixture(),client=await pool.connect()
    const contact=await createEntity({...f.params,compartments:[],projectIds:[]})
    let targetId: string=randomUUID()
    if(boundary!=='missing') {
      const owner=boundary==='foreign'?await fixture():f
      const company=await createEntity({...owner.params,kind:'company',displayName:'Reference fixture',compartments:boundary==='department'?[owner.key]:[],userId:boundary==='private'?f.member:null})
      targetId=company.id
      if(boundary==='held') await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[company.id])
    }
    try {
      await client.query('BEGIN')
      await expect(updateContact(f.member,contact.id,{phone:'555-0199',companyId:targetId},undefined,undefined,client)).rejects.toMatchObject({code:'scope_operation_denied'})
      await client.query('COMMIT')
    } finally {await client.query('ROLLBACK');client.release()}
    expect((await pool.query('SELECT attributes,compartments FROM entities WHERE id=$1',[contact.id])).rows).toEqual([{attributes:{role:'Coordinator'},compartments:[]}])
  })

  it('inherits relationship sensitivity and department requirements and retains them when cleared',async()=>{
    const f=await fixture()
    await f.groups.addMember(f.userId,f.team.id,f.member)
    await pool.query("UPDATE workspace_members SET clearance='confidential' WHERE workspace_id=$1 AND user_id=$2",[f.workspaceId,f.member])
    const company=await createCompany(f.userId,{workspaceId:f.workspaceId,name:'Reference fixture',sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
    const contact=await createContact(f.member,{workspaceId:f.workspaceId,name:'Related person',companyId:company.id})
    expect(contact).toMatchObject({companyId:company.id,sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
    expect(await updateContact(f.member,contact.id,{companyId:null})).toMatchObject({companyId:null,sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
    const deal=await createDeal(f.member,{workspaceId:f.workspaceId,companyId:company.id,contactId:contact.id})
    expect(deal).toMatchObject({name:'Deal - Reference fixture',sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
    expect(await updateDeal(f.member,deal.id,{companyId:null,contactId:null})).toMatchObject({companyId:null,contactId:null,sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId]})
  })

  it('refuses a reference outside the destination mutation envelope even when readable',async()=>{
    const f=await fixture(),company=await createCompany(f.userId,{workspaceId:f.workspaceId,name:'Reference fixture',compartments:[f.key]})
    const contact=await createContact(f.userId,{workspaceId:f.workspaceId,name:'General person'})
    await expect(updateContact(f.userId,contact.id,{companyId:company.id,phone:'555-0199'},undefined,f.access)).rejects.toMatchObject({code:'scope_operation_denied'})
    await expect(createContact(f.userId,{workspaceId:f.workspaceId,name:'Refused person',companyId:company.id,access:f.access})).rejects.toMatchObject({code:'scope_operation_denied'})
    await expect(createDeal(f.userId,{workspaceId:f.workspaceId,companyId:company.id,access:f.access})).rejects.toMatchObject({code:'scope_operation_denied'})
    expect((await pool.query('SELECT attributes,compartments FROM entities WHERE id=$1',[contact.id])).rows).toEqual([{attributes:{tags:[]},compartments:[]}])
  })

  it('preserves a readable private target on newly derived CRM records',async()=>{
    const f=await fixture()
    const company=await createEntity({...f.params,kind:'company',displayName:'Private reference',userId:f.userId,assistantId:f.assistantId})
    const contact=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Private related person',companyId:company.id})
    const deal=await createDeal(f.userId,{workspaceId:f.workspaceId,companyId:company.id,contactId:contact.id})
    expect((await pool.query('SELECT user_id,assistant_id,compartments FROM entities WHERE id=ANY($1::uuid[])',[ [contact.id,deal.id] ])).rows)
      .toEqual([{user_id:f.userId,assistant_id:f.assistantId,compartments:[f.key]},{user_id:f.userId,assistant_id:f.assistantId,compartments:[f.key]}])
  })

  it('admits uncommitted references on the supplied transaction and rejects wrong visible kinds',async()=>{
    const f=await fixture(),client=await pool.connect()
    try {
      await client.query('BEGIN')
      const company=await createCompany(f.userId,{workspaceId:f.workspaceId,name:'Uncommitted company'}, {client,afterCommit:()=>{}})
      const deal=await createDeal(f.userId,{workspaceId:f.workspaceId,companyId:company.id},undefined,{client,afterCommit:()=>{}})
      expect(deal.name).toBe('Deal - Uncommitted company')
      await expect(createDeal(f.userId,{workspaceId:f.workspaceId,contactId:company.id},undefined,{client,afterCommit:()=>{}})).rejects.toThrow('non-self CRM person')
      await expect(updateContact(f.userId,f.entity.id,{companyId:f.entity.id},undefined,undefined,client)).rejects.toThrow('CRM company')
      await client.query('ROLLBACK')
    } finally {client.release()}
    expect((await pool.query("SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND kind='deal'",[f.workspaceId])).rows).toEqual([{count:0}])
  })

  it.each(['department','held','private','clearance'] as const)('does not reuse a %s company through owner-pool deduplication',async boundary=>{
    const f=await fixture(),client=await pool.connect()
    if(boundary!=='department') await f.groups.addMember(f.userId,f.team.id,f.member)
    const hidden=await createEntity({...f.params,kind:'company',displayName:'Company fixture',userId:boundary==='private'?f.userId:null,sensitivity:boundary==='clearance'?'confidential':'internal'})
    if(boundary==='held') await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[hidden.id])
    try {
      await client.query('BEGIN')
      const result=await createCompany(f.member,{workspaceId:f.workspaceId,name:'Company fixture'}, {client,afterCommit:()=>{}})
      expect(result.id).not.toBe(hidden.id)
      expect(result).toMatchObject({sensitivity:'internal',compartments:[]})
      await client.query('COMMIT')
    } finally {await client.query('ROLLBACK');client.release()}
    expect((await pool.query('SELECT attributes,valid_to FROM entities WHERE id=$1',[hidden.id])).rows).toEqual([{attributes:{role:'Coordinator'},valid_to:null}])
  })

  it.each(['company','person'] as const)('retains incoming sensitivity on %s no-op merges',async kind=>{
    const f=await fixture(),identity={provider:'fixture',providerInstanceKey:'fixture-instance',subjectId:randomUUID()}
    const save=(sensitivity:'internal'|'confidential')=>kind==='company'
      ? createCompany(f.userId,{workspaceId:f.workspaceId,name:'Merge fixture',compartments:[f.key],sensitivity})
      : createContact(f.userId,{workspaceId:f.workspaceId,name:'Merge fixture',compartments:[f.key],sensitivity,stableIdentity:identity})
    const first=await save('internal'),second=await save('confidential')
    expect(second).toMatchObject({id:first.id,sensitivity:'confidential',compartments:[f.key]})
    expect((await save('internal')).sensitivity).toBe('confidential')
    expect((await pool.query("SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND display_name='Merge fixture'",[f.workspaceId])).rows).toEqual([{count:1}])
  })

  it.each(['none','explicit','ambient'] as const)('protects stable identity no-op results with %s access',async mode=>{
    const f=await fixture(),identity={provider:'fixture',providerInstanceKey:'fixture-instance',subjectId:randomUUID()}
    const first=await createContact(f.userId,{workspaceId:f.workspaceId,name:'Identity fixture',compartments:[f.key],stableIdentity:identity})
    const ctx={...f.access,userId:f.member,mutationCompartments:[f.key]}
    const save=()=>createContact(f.member,{workspaceId:f.workspaceId,name:'Identity fixture',stableIdentity:identity,access:mode==='explicit'?ctx:undefined})
    const run=()=>mode==='ambient'?runWithAgentAccess({...f.execution([f.key]),userId:f.member},save):save()
    const denied=await run().catch(error=>error)
    expect(denied).toMatchObject({code:'scope_operation_denied'})
    expect(denied.entityIds).toBeUndefined()
    await f.groups.addMember(f.userId,f.team.id,f.member)
    expect(await run()).toMatchObject({id:first.id})
    await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.team.id,f.member])
    await expect(run()).rejects.toMatchObject({code:'scope_operation_denied'})
    expect((await pool.query("SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND display_name='Identity fixture'",[f.workspaceId])).rows).toEqual([{count:1}])
  })

  it.each(['held','private','clearance'] as const)('does not reveal or duplicate a %s stable identity target',async boundary=>{
    const f=await fixture(),identity={provider:'fixture',providerInstanceKey:'fixture-instance',subjectId:randomUUID()}
    const params={workspaceId:f.workspaceId,name:'Hidden identity fixture',stableIdentity:identity}
    const first=await createContact(f.userId,params)
    const change=boundary==='held'?'scope_held=true':boundary==='private'?'user_id=created_by_user_id':"sensitivity='confidential'"
    await pool.query(`UPDATE entities SET ${change} WHERE id=$1`,[first.id])
    const denied=await createContact(f.member,params).catch(error=>error)
    expect(denied).toMatchObject({code:'scope_operation_denied'})
    expect(denied.entityIds).toBeUndefined()
    expect((await pool.query("SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND display_name='Hidden identity fixture'",[f.workspaceId])).rows).toEqual([{count:1}])
    expect((await pool.query('SELECT count(*)::int AS count FROM crm_identity_bindings WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{count:1}])
  })

  it('serializes stable identity creation and rolls back a binding failure before projecting edges',async()=>{
    const f=await fixture(),identity={provider:'fixture',providerInstanceKey:'fixture-instance',subjectId:randomUUID()}
    const params={workspaceId:f.workspaceId,name:'Concurrent fixture',stableIdentity:identity}
    const rows=await Promise.all([createContact(f.userId,params),createContact(f.userId,params)])
    expect(rows[0].id).toBe(rows[1].id)
    const trigger=`fixture_identity_${randomUUID().replaceAll('-','')}`
    await pool.query(`CREATE FUNCTION ${trigger}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${f.workspaceId}'::uuid THEN RAISE EXCEPTION 'fixture binding refusal'; END IF; RETURN NEW; END $$`)
    await pool.query(`CREATE TRIGGER ${trigger} BEFORE INSERT ON crm_identity_bindings FOR EACH ROW EXECUTE FUNCTION ${trigger}()`)
    const company=await createCompany(f.userId,{workspaceId:f.workspaceId,name:'Company for rollback'})
    const effects:unknown[]=[]
    try {
      await expect(createContact(f.userId,{...params,companyId:company.id,stableIdentity:{...identity,subjectId:randomUUID()}}, {create:async(value:unknown)=>{effects.push(value)}} as never)).rejects.toThrow('fixture binding refusal')
      expect(effects).toEqual([])
      expect((await pool.query("SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND display_name='Concurrent fixture'",[f.workspaceId])).rows).toEqual([{count:1}])
    } finally {await pool.query(`DROP TRIGGER ${trigger} ON crm_identity_bindings`);await pool.query(`DROP FUNCTION ${trigger}()`)}
  })

  it('refuses actor substitution and explicit read-only reach on create and identity no-ops',async()=>{
    const f=await fixture(),identity={provider:'fixture',providerInstanceKey:'fixture-instance',subjectId:randomUUID()}
    const params={workspaceId:f.workspaceId,name:'Protected fixture',compartments:[f.key]}
    await expect(createCompany(f.member,{...params,access:f.access})).rejects.toMatchObject({code:'scope_operation_denied'})
    await expect(createContact(f.member,{...params,access:f.access})).rejects.toMatchObject({code:'scope_operation_denied'})
    await expect(createCompany(f.userId,{...params,access:f.access})).rejects.toMatchObject({code:'scope_operation_denied'})
    await createContact(f.userId,{...params,stableIdentity:identity})
    await expect(createContact(f.userId,{workspaceId:f.workspaceId,name:'Protected fixture',stableIdentity:identity,access:f.access})).rejects.toMatchObject({code:'scope_operation_denied'})
  })

  it.each(['company', 'contact', 'deal', 'stage'] as const)('checks current member authority before typed %s edits', async kind => {
    const f = await fixture()
    const record = await createEntity({ ...f.params, kind: kind === 'company' ? 'company' : kind === 'contact' ? 'person' : 'deal',
      displayName: 'Typed fixture', attributes: { stage: 'lead', phone: '555-0100', amount: 10 } })
    const client = await pool.connect()
    const explicit = { ...f.access, userId: f.member, mutationCompartments: [f.key] }
    const edit = (access?: AccessContext) => kind === 'company'
      ? updateCompany(f.member, record.id, { name: 'Revised' }, access, client)
      : kind === 'contact' ? updateContact(f.member, record.id, { phone: '555-0101' }, undefined, access, client)
      : kind === 'deal' ? updateDeal(f.member, record.id, { amount: 20 }, undefined, access, client)
      : setDealStage(f.member, record.id, 'won', access, client)
    try {
      await client.query('BEGIN')
      expect(await edit()).toBeNull()
      expect(await edit(explicit)).toBeNull()
      expect(await runWithAgentAccess({ ...f.execution([f.key]), userId: f.member }, () => edit())).toBeNull()
      await client.query('COMMIT')
      await f.groups.addMember(f.userId, f.team.id, f.member)
      await client.query('BEGIN')
      const changed = await edit(explicit)
      expect(changed).not.toBeNull()
      expect(changed).toMatchObject(kind === 'company' ? { name: 'Revised' } : kind === 'contact' ? { phone: '555-0101' } : kind === 'deal' ? { amount: 20 } : { stage: 'won' })
      await client.query('COMMIT')
      await pool.query("UPDATE entities SET sensitivity='confidential' WHERE id=$1", [record.id])
      expect(await edit(explicit)).toBeNull()
      await pool.query("UPDATE entities SET sensitivity='internal',scope_held=true WHERE id=$1", [record.id])
      expect(await edit(explicit)).toBeNull()
      await pool.query('UPDATE entities SET scope_held=false,user_id=$2 WHERE id=$1', [record.id, f.userId])
      expect(await edit(explicit)).toBeNull()
      await pool.query('UPDATE entities SET user_id=NULL WHERE id=$1', [record.id])
      await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2', [f.team.id, f.member])
      expect(await edit(explicit)).toBeNull()
      await expect(edit(f.access)).rejects.toMatchObject({ code: 'scope_operation_denied' })
    } finally { await client.query('ROLLBACK'); client.release() }
  })

  it('checks member destination Teams even inside an owner-pool create transaction',async()=>{
    const f=await fixture(),client=await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(createEntity({...f.params,createdByUserId:f.member,displayName:'Refused'},client)).rejects.toMatchObject({code:'scope_operation_denied'})
      await client.query('COMMIT')
    } finally {await client.query('ROLLBACK');client.release()}
    await f.groups.addMember(f.userId,f.team.id,f.member)
    expect(await createEntity({...f.params,createdByUserId:f.member,displayName:'Authorized'})).toMatchObject({displayName:'Authorized'})
    expect((await pool.query('SELECT display_name FROM entities WHERE workspace_id=$1 ORDER BY display_name',[f.workspaceId])).rows).toEqual([{display_name:'Authorized'},{display_name:'Fictional person'}])
  })

  it.each(['none','explicit','ambient'])('refuses a current-member Team denial under %s source authority',async mode=>{
    const f=await fixture(),client=await pool.connect(),ctx={...f.access,userId:f.member,mutationCompartments:[f.key]}
    const run=async()=>{
      expect(await updateEntity(f.member,f.entity.id,{displayName:'Refused'},mode==='explicit'?ctx:undefined,client)).toBeNull()
      expect(await updateEntity(f.member,f.entity.id,{},mode==='explicit'?ctx:undefined,client)).toBeNull()
      expect(await addEntityAlias(f.member,f.entity.id,'new-alias',mode==='explicit'?ctx:undefined)).toEqual({kind:'not_found'})
      expect(await removeEntityAlias(f.member,f.entity.id,'fixture-alias',mode==='explicit'?ctx:undefined)).toBeNull()
      expect(await supersedeEntity(f.member,f.entity.id,{attributes:{role:'Refused'}})).toBeNull()
    }
    try {await client.query('BEGIN');await(mode==='ambient'?runWithAgentAccess({...f.execution([f.key]),userId:f.member},run):run());await client.query('COMMIT')}
    finally {await client.query('ROLLBACK');client.release()}
    expect(await f.stored()).toMatchObject({display_name:'Fictional person',aliases:['fixture-alias'],valid_to:null})
  })

  it('refuses inherited destination Teams without retiring or modifying the entity',async()=>{
    const f=await fixture();await f.groups.addMember(f.userId,f.team.id,f.member)
    const other=await f.groups.createTeam(f.userId,f.workspaceId,{name:'Research',key:'research'})
    expect(await updateEntity(f.member,f.entity.id,{displayName:'Refused',inheritCompartments:[other.compartmentKey!]})).toBeNull()
    await expect(supersedeEntity(f.member,f.entity.id,{attributes:{},compartments:[other.compartmentKey!]})).rejects.toMatchObject({code:'scope_operation_denied'})
    expect(await f.stored()).toMatchObject({display_name:'Fictional person',valid_to:null,superseded_by:null})
  })

  it('enforces membership removal and current clearance against previously usable contexts',async()=>{
    const f=await fixture();await f.groups.addMember(f.userId,f.team.id,f.member)
    const ctx={...f.access,userId:f.member,mutationCompartments:[f.key]}
    expect(await updateEntity(f.member,f.entity.id,{displayName:'Authorized'},ctx)).toMatchObject({displayName:'Authorized'})
    await pool.query('DELETE FROM workspace_group_members WHERE group_id=$1 AND user_id=$2',[f.team.id,f.member])
    expect(await updateEntity(f.member,f.entity.id,{displayName:'Refused'},ctx)).toBeNull()
    await f.groups.addMember(f.userId,f.team.id,f.member)
    await pool.query("UPDATE entities SET sensitivity='confidential' WHERE id=$1",[f.entity.id])
    expect(await runWithAgentAccess({...f.execution([f.key]),userId:f.member},()=>updateEntity(f.member,f.entity.id,{displayName:'Refused'},ctx))).toBeNull()
    expect((await f.stored()).display_name).toBe('Authorized')
  })

  it('preserves confidentiality in ordinary updates and supersession',async()=>{
    const f=await fixture()
    expect(await updateEntity(f.userId,f.entity.id,{sensitivity:'confidential'})).toMatchObject({sensitivity:'confidential'})
    await expect(updateEntity(f.userId,f.entity.id,{displayName:'Refused',sensitivity:'internal'})).rejects.toMatchObject({code:'scope_declassification_required'})
    await expect(applyBrainCorrection({
      mutate:client=>updateEntity(f.userId,f.entity.id,{displayName:'Refused',sensitivity:'internal'},undefined,client),
      verifications:()=>[{targetKind:'entity',targetId:f.entity.id,workspaceId:f.workspaceId,verifiedByUserId:f.userId,action:'adjust_sensitivity',modelValue:'confidential',userValue:'internal'}],
    })).rejects.toMatchObject({code:'scope_declassification_required'})
    expect((await pool.query('SELECT count(*)::int AS count FROM brain_verifications WHERE workspace_id=$1',[f.workspaceId])).rows).toEqual([{count:0}])
    await expect(supersedeEntity(f.userId,f.entity.id,{attributes:{role:'Refused'},sensitivity:'public'})).rejects.toMatchObject({code:'scope_declassification_required'})
    expect(await supersedeEntity(f.userId,f.entity.id,{attributes:{role:'Revised'}})).toMatchObject({sensitivity:'confidential',compartments:[f.key],projectIds:[f.projectId],displayName:'Fictional person'})
  })

  it.each(['department','held','private','clearance'])('does not expose a %s alias conflict',async kind=>{
    const f=await fixture();await f.groups.addMember(f.userId,f.team.id,f.member)
    const other=await f.groups.createTeam(f.userId,f.workspaceId,{name:'Research',key:'research'})
    const conflict=await createEntity({...f.params,displayName:'Hidden alias',aliases:[],
      compartments:kind==='department'?[other.compartmentKey!]:[f.key],userId:kind==='private'?f.userId:null,
      sensitivity:kind==='clearance'?'confidential':'internal'})
    if(kind==='held')await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[conflict.id])
    const result=await addEntityAlias(f.member,f.entity.id,'hidden alias')
    expect(result.kind).toBe('ok')
    expect(JSON.stringify(result)).not.toContain(conflict.id)
  })

  it('refuses alias edits and self-alias reads on held targets',async()=>{
    const f=await fixture();await pool.query('UPDATE entities SET scope_held=true WHERE id=$1',[f.entity.id])
    expect(await addEntityAlias(f.userId,f.entity.id,'new-alias')).toEqual({kind:'not_found'})
    expect(await addEntityAlias(f.userId,f.entity.id,'fictional person')).toEqual({kind:'not_found'})
    expect(await removeEntityAlias(f.userId,f.entity.id,'fixture-alias')).toBeNull()
    expect((await f.stored()).aliases).toEqual(['fixture-alias'])
  })

  it('checks the destination even on an owner-pool create transaction', async () => {
    const f = await fixture(), client = await pool.connect()
    try {
      await client.query('BEGIN')
      await runWithAgentAccess(f.execution(), async () => {
        await expect(createEntity({ ...f.params, displayName: 'Refused' }, client)).rejects.toMatchObject({ code: 'scope_operation_denied' })
        const general = await createEntity({ ...f.params, compartments: [], displayName: 'General' }, client)
        expect(general.compartments).toEqual([])
      })
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
    expect((await pool.query('SELECT display_name FROM entities WHERE workspace_id=$1 ORDER BY display_name', [f.workspaceId])).rows)
      .toEqual([{ display_name: 'Fictional person' }, { display_name: 'General' }])
  })

  it.each(['explicit', 'ambient'] as const)('refuses a read-only source update through %s authority on an owner transaction', async mode => {
    const f = await fixture(), client = await pool.connect()
    try {
      await client.query('BEGIN')
      const update = () => updateEntity(f.userId, f.entity.id, { attributes: { role: 'Changed' } }, mode === 'explicit' ? f.access : undefined, client)
      expect(await (mode === 'explicit' ? update() : runWithAgentAccess(f.execution(), update))).toBeNull()
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
    expect((await f.stored()).attributes).toEqual({ role: 'Coordinator' })
  })

  it('checks added Team and Project requirements before applying a same-source update', async () => {
    const f = await fixture(), writable = { ...f.access, mutationCompartments: [f.key] }
    await expect(updateEntity(f.userId, f.entity.id, { displayName: 'Changed', inheritCompartments: ['foreign'] }, writable)).rejects.toMatchObject({ code: 'scope_operation_denied' })
    await expect(updateEntity(f.userId, f.entity.id, { displayName: 'Changed', inheritProjectIds: [randomUUID()] }, writable)).rejects.toMatchObject({ code: 'scope_operation_denied' })
    expect((await f.stored()).display_name).toBe('Fictional person')
    expect(await updateEntity(f.userId, f.entity.id, { displayName: 'Updated' }, writable)).toMatchObject({ displayName: 'Updated' })
  })

  it.each(['held', 'retracted', 'superseded'] as const)('does not update a %s source through an owner-pool transaction', async state => {
    const f = await fixture(), client = await pool.connect()
    const changes = { held: 'scope_held=true', retracted: 'retracted_at=now()', superseded: 'valid_to=now()' }
    await pool.query(`UPDATE entities SET ${changes[state]} WHERE id=$1`, [f.entity.id])
    try {
      await client.query('BEGIN')
      expect(await updateEntity(f.userId, f.entity.id, { displayName: 'Changed' }, { ...f.access, mutationCompartments: null }, client)).toBeNull()
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
    expect((await f.stored()).display_name).toBe('Fictional person')
  })

  it('does not turn a broad reconstructed owner context into mutation authority', async () => {
    const f = await fixture()
    await runWithAgentAccess(f.execution(), async () => {
      expect(await updateEntity(f.userId, f.entity.id, { displayName: 'Changed' }, { ...f.access, compartments: null, mutationCompartments: null, projectIds: null })).toBeNull()
      expect(await addEntityAlias(f.userId, f.entity.id, 'new-alias')).toEqual({ kind: 'not_found' })
      expect(await removeEntityAlias(f.userId, f.entity.id, 'fixture-alias')).toBeNull()
      expect(await supersedeEntity(f.userId, f.entity.id, { attributes: { role: 'Changed' } })).toBeNull()
    })
    expect(await f.stored()).toMatchObject({ display_name: 'Fictional person', aliases: ['fixture-alias'], valid_to: null, superseded_by: null })
  })

  it('supersedes and edits aliases inside the independent mutation ceiling', async () => {
    const f = await fixture()
    await runWithAgentAccess(f.execution([f.key]), async () => {
      expect(await addEntityAlias(f.userId, f.entity.id, 'new-alias')).toMatchObject({ kind: 'ok' })
      expect(await removeEntityAlias(f.userId, f.entity.id, 'fixture-alias')).toMatchObject({ aliases: ['new-alias'] })
      await expect(supersedeEntity(f.userId, f.entity.id, { attributes: {}, compartments: ['foreign'] })).rejects.toMatchObject({ code: 'scope_operation_denied' })
      expect((await f.stored()).valid_to).toBeNull()
      const next = await supersedeEntity(f.userId, f.entity.id, { attributes: { role: 'Revised' } })
      expect(next).toMatchObject({ attributes: { role: 'Revised' }, compartments: [f.key], projectIds: [f.projectId] })
      expect((await f.stored()).superseded_by).toBe(next!.id)
    })
  })

  it('refuses replacing the executing author', async () => {
    const f = await fixture()
    await runWithAgentAccess(f.execution([f.key]), async () => {
      await expect(createEntity({ ...f.params, createdByUserId: randomUUID() })).rejects.toMatchObject({ code: 'scope_operation_denied' })
      await expect(updateEntity(randomUUID(), f.entity.id, { displayName: 'Changed' })).rejects.toMatchObject({ code: 'scope_operation_denied' })
    })
    expect((await f.stored()).display_name).toBe('Fictional person')
  })
  it('refuses actor substitution through explicit access without an ambient execution', async () => {
    const f = await fixture(), client = await pool.connect()
    try {
      await client.query('BEGIN')
      await expect(updateEntity(f.userId, f.entity.id, { displayName: 'Changed' },
        { ...f.access, userId: randomUUID(), mutationCompartments: [f.key] }, client))
        .rejects.toMatchObject({ code: 'scope_operation_denied' })
      await client.query('COMMIT')
    } finally { await client.query('ROLLBACK'); client.release() }
    await expect(runWithAgentAccess(f.execution([f.key]), () => updateEntity(f.userId,
      f.entity.id, { displayName: 'Changed' }, { ...f.access, workspaceId: randomUUID(), mutationCompartments: [f.key] })))
      .rejects.toMatchObject({ code: 'scope_operation_denied' })
    expect((await f.stored()).display_name).toBe('Fictional person')
  })
})
