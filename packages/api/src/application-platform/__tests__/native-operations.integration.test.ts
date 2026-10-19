/** Native canonical transaction composition, not a substitute CRM/task store. */
import { randomUUID } from 'node:crypto'
import express from 'express'
import request from 'supertest'
import { viewsRoutes, type ViewsRouteOptions } from '../../routes/views.js'
import { crmRoutes } from '../../routes/crm.js'
import { createWorkspaceStore } from '../../db/workspace-store.js'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { createCrmTools, executionToolContext, boundScopeSources, type ApplicationModuleDefinition, type TaskRecord, type TaskUpdateFields,type CompanyUpdateFields,type ContactUpdateFields,type DealUpdateFields,type EntityCreateParams,type EntityUpdateFields,type EntitySupersedePatch } from '@use-brian/core'
import { ApplicationPlatformError } from '@use-brian/shared'
import { applyRLSGucs, getAppPool, getPool } from '../../db/client.js'
import { bindTaskClosedHook, createTask, getTaskById, resolveTaskById, updateTask } from '../../db/tasks.js'
import { createCompany,createContact,createDeal,getDealById,listDeals,updateCompany,updateContact,updateDeal,setDealStage } from '../../db/crm.js'
import { createCrmFieldDefinition,archiveCrmFieldDefinition,updateCrmCustomFields,setCrmArchived,setCrmDealPipelineStage,getCrmConfig,addCrmDealParticipant,removeCrmDealParticipant } from '../../db/crm-r2.js'
import { createEntity, supersedeEntity, updateEntity } from '../../db/entities-store.js'
import { createDbCrmStore } from '../../db/crm-store.js'
import { createDbCrmOperationsStore } from '../../db/crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { findAssistantById } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { ApplicationPlatformService } from '../service.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-records] canonical native operation composition', () => {
  const owner = getPool(), workspaceId = randomUUID(), userId = randomUUID(), readerId = randomUUID(), assistantId = randomUUID()
  const access = { workspaceId, userId, assistantId, assistantKind: 'primary' as const }
  beforeAll(async () => {
    for (const id of [userId,readerId]) await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional native operations',$2,false)", [workspaceId,userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId,userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')", [workspaceId,readerId])
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional native operator',$2,$3,'primary','confidential')", [assistantId,userId,workspaceId])
  })
  afterAll(async () => {
    bindTaskClosedHook(null)
    await owner.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId,readerId]])
    await getAppPool().end(); await owner.end()
  })
  const version = (task: TaskRecord) => boundScopeSources(task)[0].version!
  const task = (title = `Fictional operation ${randomUUID()}`, parentId?: string) => createTask(userId, { workspaceId, title, parentId, access })
  async function client() {
    const connection = await getAppPool().connect()
    await connection.query('BEGIN'); await applyRLSGucs(connection,userId)
    expect((await connection.query(`SELECT r.rolsuper OR r.rolbypassrls OR pg_has_role(r.oid,c.relowner,'USAGE') AS bypass
      FROM pg_roles r JOIN pg_class c ON c.oid='public.tasks'::regclass WHERE r.rolname=current_user`)).rows[0].bypass).toBe(false)
    return connection
  }
  async function execution() {
    return (await resolveExecutionContextSystem({ userId, workspaceId, assistant: (await findAssistantById(assistantId))!, memberMode: 'member',
      identity: { kind: 'attended', principal: { kind: 'workspace_member', userId, authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace', workspaceId }, lifecycle: { sessionId: randomUUID(), sessionPersisted: false,
        channelId: 'native-operation-fixture', channelType: 'test', abortSignal: new AbortController().signal } })).executionContext
  }
  it('Q05 rolls back task supersession, child and Goal links without early lifecycle effects', async () => {
    const parent = await task(), child = await task('Fictional linked child',parent.id)
    const goal = (await owner.query(`INSERT INTO goals(workspace_id,host_type,host_id,outcome,done_when,means,status,created_by_user_id,confirmed_at)
      VALUES($1,'task',$2,'Fictional linked outcome','{"kind":"subtasks"}','{}','active',$3,now()) RETURNING id`, [workspaceId,parent.id,userId])).rows[0].id
    const connection = await client(), effects: Array<() => void> = [], closed: string[] = []
    bindTaskClosedHook(value => closed.push(value.id))
    try {
      const updated = await updateTask(userId,parent.id,{ title: 'Fictional uncommitted successor',status: 'done' },undefined,{ access,expectedVersion: version(parent) },
        { client: connection,afterCommit: (effect: () => void) => effects.push(effect) })
      expect(updated).not.toBeNull(); expect(updated!.id).not.toBe(parent.id)
      expect(version(updated!)).toBe(String(BigInt(version(parent))+1n))
      expect((await connection.query('SELECT parent_id FROM tasks WHERE id=$1',[child.id])).rows[0].parent_id).toBe(updated!.id)
      expect((await connection.query('SELECT host_id FROM goals WHERE id=$1',[goal])).rows[0].host_id).toBe(updated!.id)
      expect(closed).toEqual([]); expect(effects).toHaveLength(1)
      await connection.query('ROLLBACK')
      expect((await owner.query('SELECT valid_to,superseded_by FROM tasks WHERE id=$1',[parent.id])).rows[0]).toEqual({ valid_to: null,superseded_by: null })
      expect((await owner.query('SELECT parent_id FROM tasks WHERE id=$1',[child.id])).rows[0].parent_id).toBe(parent.id)
      expect((await owner.query('SELECT host_id FROM goals WHERE id=$1',[goal])).rows[0].host_id).toBe(parent.id)
      expect((await owner.query('SELECT id FROM tasks WHERE id=$1',[updated!.id])).rows).toEqual([])
      expect(closed).toEqual([])
    } finally { await connection.query('ROLLBACK'); connection.release(); bindTaskClosedHook(null) }
  })
  it('Q05 composes the canonical entity-backed company and task writers in one commit', async () => {
    const company = await createCompany(userId,{ workspaceId,name: `Fictional company ${randomUUID()}`,access,mergeByName: false }), before = await task()
    const connection = await client(), effects: Array<() => void> = []
    try {
      const changedCompany = await updateCompany(userId,company.id,{ name: 'Fictional revised company' },access,connection)
      const changedTask = await updateTask(userId,before.id,{ title: 'Fictional revised work' },undefined,{ access,expectedVersion: version(before) },
        { client: connection,afterCommit: (effect: () => void) => effects.push(effect) })
      expect(changedCompany?.id).toBe(company.id)
      expect((await owner.query('SELECT display_name FROM entities WHERE id=$1',[company.id])).rows[0].display_name).toBe(company.name)
      expect((await owner.query('SELECT valid_to FROM tasks WHERE id=$1',[before.id])).rows[0].valid_to).toBeNull()
      await connection.query('COMMIT'); for (const effect of effects) effect()
      expect((await owner.query('SELECT display_name FROM entities WHERE id=$1',[company.id])).rows[0].display_name).toBe('Fictional revised company')
      expect((await getTaskById(access,changedTask!.id))?.title).toBe('Fictional revised work')
      expect(version(changedTask!)).toBe(String(BigInt(version(before))+1n))
    } finally { await connection.query('ROLLBACK'); connection.release() }
  })
  it('Q05 lets exactly one canonical CAS writer win and refuses a stale predecessor precondition', async () => {
    const before = await task()
    const results = await Promise.allSettled(['Fictional first edit','Fictional second edit'].map(title =>
      updateTask(userId,before.id,{ title },undefined,{ access,expectedVersion: version(before) })))
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const refused = results.find(result => result.status === 'rejected')
    expect(refused?.status === 'rejected' && refused.reason.code).toBe('record_version_conflict')
    expect((await owner.query('SELECT id FROM tasks WHERE workspace_id=$1 AND valid_to IS NULL AND title=ANY($2::text[])',[workspaceId,['Fictional first edit','Fictional second edit']])).rows).toHaveLength(1)
  })
  it.each([{ unknown: 'not a field' },{ title: '' },{ status: 'invented' },{ due: 'not a Date' }])('Q04 refuses invalid native patch %j at the canonical writer', async fields => {
    const before = await task()
    await expect(updateTask(userId,before.id,fields as TaskUpdateFields,undefined,{ access })).rejects.toMatchObject({ code: 'invalid_value' })
    expect((await owner.query('SELECT valid_to,superseded_by FROM tasks WHERE id=$1',[before.id])).rows[0]).toEqual({ valid_to: null,superseded_by: null })
  })
  it('Q05 serializes canonical CRM attribute merges and keeps business changes outside metadata epochs',async () => {
    const company=await createCompany(userId,{workspaceId,name:`Fictional merge ${randomUUID()}`,access,mergeByName:false})
    const invocation=await execution()
    const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0].version
    const results=await Promise.all([
      updateCompany(userId,company.id,{domain:'fictional.example'},access),
      updateCompany(userId,company.id,{tags:['fictional-category']},access),
    ])
    expect(results.every(value => value?.id===company.id)).toBe(true)
    const current=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0]
    expect(current.attributes).toMatchObject({domain:'fictional.example',tags:['fictional-category']})
    expect(current.version).toBe(String(BigInt(before)+2n))
    await expect(invocation.security.authority.assertCurrent()).resolves.toBeUndefined()
  })
  it('Q05 admits one canonical CRM CAS edit and preserves its ID and references on stale refusal',async () => {
    const company=await createCompany(userId,{workspaceId,name:`Fictional CAS ${randomUUID()}`,access,mergeByName:false})
    const contact=await createContact(userId,{workspaceId,name:'Fictional linked contact',companyId:company.id,access})
    const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0].version
    const outcomes=await Promise.allSettled(['Fictional CAS first','Fictional CAS second'].map(name =>
      updateCompany(userId,company.id,{name},access,undefined,undefined,{expectedVersion:before})))
    expect(outcomes.filter(outcome => outcome.status==='fulfilled')).toHaveLength(1)
    const denied=outcomes.find(outcome => outcome.status==='rejected')
    expect(denied?.status==='rejected' && denied.reason.code).toBe('record_version_conflict')
    const current=(await owner.query('SELECT id,scope_version::text AS version FROM entities WHERE id=$1',[company.id])).rows[0]
    expect(current).toEqual({id:company.id,version:String(BigInt(before)+1n)})
    expect((await owner.query("SELECT attributes->>'company_id' AS company FROM entities WHERE id=$1",[contact.id])).rows[0].company).toBe(company.id)
    await expect(updateCompany(userId,company.id,{domain:'stale.example'},access,undefined,undefined,{expectedVersion:before})).rejects.toMatchObject({code:'record_version_conflict'})
    expect((await owner.query("SELECT attributes ? 'domain' AS present FROM entities WHERE id=$1",[company.id])).rows[0].present).toBe(false)
  })
  it('Q04 refuses immutable and invalid create keys through every typed canonical CRM writer',async () => {
    const invalid=await Promise.allSettled([
      createCompany(userId,{workspaceId,name:'Fictional creation',access,immutableId:randomUUID()} as Parameters<typeof createCompany>[1]),
      createContact(userId,{workspaceId,name:'Fictional creation',access,phone:17} as unknown as Parameters<typeof createContact>[1]),
      createDeal(userId,{workspaceId,access,stage:'invented'} as unknown as Parameters<typeof createDeal>[1]),
    ])
    expect(invalid.every(outcome => outcome.status==='rejected' && outcome.reason.code==='invalid_value')).toBe(true)
    expect((await owner.query("SELECT id FROM entities WHERE workspace_id=$1 AND display_name='Fictional creation'",[workspaceId])).rows).toEqual([])
  })
  it('Q05 serializes the legacy stage writer with canonical field patches',async () => {
    const deal=await createDeal(userId,{workspaceId,access})
    const version=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0].version
    await Promise.all([setDealStage(userId,deal.id,'won',access),updateDeal(userId,deal.id,{amount:42},undefined,access)])
    expect((await owner.query("SELECT attributes->>'stage' AS stage,attributes->>'amount' AS amount FROM entities WHERE id=$1",[deal.id])).rows[0]).toEqual({stage:'won',amount:'42'})
    await expect(setDealStage(userId,deal.id,'lost',access,undefined,undefined,{expectedVersion:version})).rejects.toMatchObject({code:'record_version_conflict'})
  })
  it.each([
    { kind: 'company',fields: { invented: 'unregistered field' } },
    { kind: 'company',fields: { name: '' } },
    { kind: 'company',fields: { domain: 17 } },
    { kind: 'company',fields: { tags: ['valid',17] } },
    { kind: 'person',fields: { phone: { invalid: 'object' } } },
    { kind: 'person',fields: { companyId: 'not-a-uuid' } },
    { kind: 'deal',fields: { amount: Number.POSITIVE_INFINITY } },
    { kind: 'deal',fields: { closeDate: new Date('not-a-date') } },
    { kind: 'deal',fields: { stage: 'won' } },
  ])('Q04 refuses invalid canonical CRM $kind patch before changing storage: $fields',async ({kind,fields}) => {
    const company=await createCompany(userId,{workspaceId,name:`Fictional validation ${randomUUID()}`,access,mergeByName:false})
    const record=kind==='company' ? company : kind==='person' ? await createContact(userId,{workspaceId,name:'Fictional contact',access})
      : await createDeal(userId,{workspaceId,companyId:company.id,access})
    const before=(await owner.query('SELECT display_name,attributes,scope_version::text FROM entities WHERE id=$1',[record.id])).rows[0]
    const write=kind==='company' ? () => updateCompany(userId,record.id,fields as CompanyUpdateFields,access)
      : kind==='person' ? () => updateContact(userId,record.id,fields as ContactUpdateFields,undefined,access)
      : () => updateDeal(userId,record.id,fields as DealUpdateFields,undefined,access)
    await expect(write()).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT display_name,attributes,scope_version::text FROM entities WHERE id=$1',[record.id])).rows[0]).toEqual(before)
  })
  it('Q06 commits a registered multi-task command and its receipt/audit/outbox exactly once, with complete rollback on refusal', async () => {
    const first = await task(), second = await task(), input = z.object({ ids: z.array(z.string().uuid()).length(2),versions: z.array(z.string()).length(2),title: z.string().min(1) }).strict()
    const module: ApplicationModuleDefinition<PoolClient> = { key: 'native_operation_fixture',defaultState: 'enabled',application: {
      version: '1',dependencies: [],resources: [],queries: [],commands: ['rename_pair'],events: ['native_operation_fixture.changed'],policyCapabilities: [],backgroundHandlers: [],uiContributions: [] },queries: {},commands: {
      rename_pair: { input,eventKey: 'native_operation_fixture.changed',authorize: async (context,raw) => {
        for (const id of input.parse(raw).ids) if (!await resolveTaskById(context.execution.security.access,id,context.transaction)) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
      },execute: async (context,raw) => {
        const value = input.parse(raw),refs = []
        for (const [index,id] of value.ids.entries()) {
          const updated = await updateTask(userId,id,{ title: value.title },undefined,{ access: context.execution.security.access,expectedVersion: value.versions[index] },
            { client: context.transaction,afterCommit: context.afterCommit })
          if (!updated) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
          refs.push({ workspaceId,origin: { kind: 'native' as const,moduleKey: 'native' },typeKey: 'task',id: updated.id,version: version(updated) })
        }
        return refs
      },authorizeResult: async (context,refs) => {
        for (const ref of refs) if (!await getTaskById(context.execution.security.access,ref.id,context.transaction)) throw new ApplicationPlatformError('access_unavailable','The task is unavailable.')
      } },
    } }
    const service = new ApplicationPlatformService([module]), identity = await execution(), key = randomUUID()
    const failed = { idempotencyKey: key,input: { ids: [first.id,second.id],versions: [version(first),'999'],title: 'Fictional rolled back pair' } }
    await expect(service.command(identity,module.key,'rename_pair',failed)).rejects.toMatchObject({ code: 'record_version_conflict' })
    expect((await owner.query('SELECT id FROM tasks WHERE id=ANY($1::uuid[]) AND valid_to IS NULL',[[first.id,second.id]])).rows).toHaveLength(2)
    expect((await owner.query('SELECT id FROM application_operation_receipts WHERE idempotency_key=$1',[key])).rows).toEqual([])
    const command = { idempotencyKey: randomUUID(),input: { ids: [first.id,second.id],versions: [version(first),version(second)],title: 'Fictional committed pair' } }
    const committed = await service.command(identity,module.key,'rename_pair',command), replay = await service.command(identity,module.key,'rename_pair',command)
    expect(replay.id).toBe(committed.id); expect(committed.resources).toHaveLength(2)
    expect((await owner.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
    expect((await owner.query('SELECT count(*)::int AS count FROM application_committed_events WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
    expect((await owner.query('SELECT resources::text FROM application_operation_receipts WHERE id=$1',[committed.id])).rows[0].resources).not.toContain('Fictional committed pair')
    // Replay is governed by current native visibility; another actual member
    // retains access to the same source after this caller loses its audience.
    await owner.query('UPDATE tasks SET user_id=$2 WHERE id=$1',[committed.resources[0].id,readerId])
    await expect(service.command(identity,module.key,'rename_pair',command)).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(await getTaskById({ ...access,userId: readerId },committed.resources[0].id)).not.toBeNull()
    expect((await owner.query('SELECT count(*)::int AS count FROM application_command_audit WHERE receipt_id=$1',[committed.id])).rows[0].count).toBe(1)
  })
  it.each([
    {unexpected:true},{createdByUserId:'forged-creation-metadata'},{displayName:42},{attributes:[]},
    {attributes:{invalid:NaN}},{attributes:{invalid:Infinity}},{verifiedAt:new Date('invalid')},{sensitivity:'undeclared'},
  ])('Q04 refuses an invalid raw canonical entity patch frame without changing storage: %j',async fields => {
    const value=await createCompany(userId,{workspaceId,name:`Fictional frame ${randomUUID()}`,access,mergeByName:false})
    const before=(await owner.query('SELECT display_name,attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    await expect(updateEntity(userId,value.id,fields as EntityUpdateFields,access)).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT display_name,attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  it.each([{unexpected:true},{id:'caller-forged-id'},{aliases:[17]},{source:'undeclared'},{attributes:{invalid:NaN}},{displayName:'   '}])
  ('Q04 refuses an invalid raw canonical entity create frame without a row: %j',async fields => {
    const before=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    await expect(createEntity({kind:'company',displayName:'Fictional invalid frame',workspaceId,createdByUserId:userId,source:'user',...fields} as EntityCreateParams))
      .rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(before)
  })
  it.each([{unexpected:true},{attributes:{invalid:Infinity}},{displayName:42}])
  ('Q04 refuses an invalid raw canonical supersession frame without retiring its source: %j',async fields => {
    const value=await createCompany(userId,{workspaceId,name:`Fictional successor ${randomUUID()}`,access,mergeByName:false})
    const before=(await owner.query('SELECT display_name,attributes,valid_to,superseded_by,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    await expect(supersedeEntity(userId,value.id,{attributes:{},...fields} as EntitySupersedePatch)).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT display_name,attributes,valid_to,superseded_by,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  it.each([
    {label:'company domain scalar',kind:'company',attributes:{domain:17}},
    {label:'company tags array',kind:'company',attributes:{tags:'invented'}},
    {label:'contact email scalar',kind:'person',attributes:{email:{invented:true}}},
    {label:'contact phone scalar',kind:'person',attributes:{phone:17}},
    {label:'contact company UUID',kind:'person',attributes:{company_id:'not-a-uuid'}},
    {label:'deal stage enum',kind:'deal',attributes:{stage:'invented'}},
    {label:'negative deal decimal',kind:'deal',attributes:{amount:'-1'}},
    {label:'exponent deal decimal',kind:'deal',attributes:{amount:'1e8'}},
    {label:'deal decimal shape',kind:'deal',attributes:{amount:false}},
    {label:'deal invalid close date',kind:'deal',attributes:{close_date:'2026-02-30'}},
    {label:'deal company UUID',kind:'deal',attributes:{company_id:'not-a-uuid'}},
    {label:'deal contact UUID',kind:'deal',attributes:{contact_id:'not-a-uuid'}},
  ].flatMap(value => ['entity writer','raw nonowner SQL'].map(writer => ({...value,writer}))))
  ('Q04 refuses invalid $label through the $writer without changing its canonical version',async ({kind,attributes,writer}) => {
    const value=kind==='company'?await createCompany(userId,{workspaceId,name:`Fictional value ${randomUUID()}`,access,mergeByName:false})
      :kind==='person'?await createContact(userId,{workspaceId,name:'Fictional value contact',access}):await createDeal(userId,{workspaceId,amount:12,access})
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    const patch={...before.attributes,...attributes}
    if(writer==='entity writer') await expect(updateEntity(userId,value.id,{attributes:patch},access)).rejects.toThrow('invalid_value')
    else {
      const transaction=await client()
      try {await expect(transaction.query('UPDATE entities SET attributes=$2::jsonb WHERE id=$1',[value.id,patch])).rejects.toMatchObject({code:'22023'})}
      finally {await transaction.query('ROLLBACK');transaction.release()}
    }
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  it.each([{kind:'company',attributes:{domain:17}},{kind:'person',attributes:{email:[]}},
    {kind:'deal',attributes:{stage:'invented'}},{kind:'deal',attributes:{amount:'-1'}}])
  ('Q04 refuses malformed native $kind attributes during raw canonical creation',async ({kind,attributes}) => {
    const before=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    await expect(createEntity({kind,displayName:'Fictional invalid business value',workspaceId,createdByUserId:userId,source:'user',attributes} as EntityCreateParams))
      .rejects.toThrow('invalid_value')
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(before)
  })
  it.each([
    {fieldType:'text' as const,value:17,options:[]},
    {fieldType:'number' as const,value:'1',options:[]},
    {fieldType:'date' as const,value:'2026-02-30',options:[]},
    {fieldType:'boolean' as const,value:0,options:[]},
    {fieldType:'single_select' as const,value:'undeclared',options:['accepted']},
    {fieldType:'multi_select' as const,value:['accepted','undeclared'],options:['accepted']},
    {fieldType:'entity_reference' as const,value:'not-a-uuid',options:['company']},
  ])('Q04 enforces current custom $fieldType values below raw nonowner SQL',async ({fieldType,value,options}) => {
    const record=await createDeal(userId,{workspaceId,access}),fieldKey=`validation_${fieldType}`
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:'deal',fieldKey,label:'Fictional value vocabulary',fieldType,options})
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]
    const transaction=await client()
    try {
      await expect(transaction.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields}',$2::jsonb) WHERE id=$1",[record.id,{[fieldKey]:value}]))
        .rejects.toMatchObject({code:'22023'})
      await transaction.query('ROLLBACK')
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]).toEqual(before)
    } finally {
      await transaction.query('ROLLBACK');transaction.release()
      await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])
    }
  })
  it('Q04 rejects an undeclared custom key below the raw entity writer',async () => {
    const record=await createDeal(userId,{workspaceId,access})
    await expect(updateEntity(userId,record.id,{attributes:{stage:'lead',custom_fields:{undeclared:'value'}}},access)).rejects.toThrow('invalid_value')
    expect((await owner.query("SELECT attributes ? 'custom_fields' AS present FROM entities WHERE id=$1",[record.id])).rows[0].present).toBe(false)
  })
  it('Q04 enforces required custom values on raw create and replacement without partial effects',async () => {
    const record=await createDeal(userId,{workspaceId,access}),fieldKey='validation_required'
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:'deal',fieldKey,label:'Fictional required value',fieldType:'text',isRequired:true})
    try {
      await expect(createEntity({kind:'deal',displayName:'Fictional missing required value',workspaceId,createdByUserId:userId,source:'user',attributes:{stage:'lead'}}))
        .rejects.toThrow('invalid_value')
      expect((await owner.query("SELECT id FROM entities WHERE workspace_id=$1 AND display_name='Fictional missing required value'",[workspaceId])).rows).toEqual([])
      await updateEntity(userId,record.id,{attributes:{stage:'lead',custom_fields:{[fieldKey]:'accepted'}}},access)
      const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]
      await expect(updateEntity(userId,record.id,{attributes:{stage:'lead',custom_fields:{}}},access)).rejects.toThrow('invalid_value')
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]).toEqual(before)
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it('Q04 retains archived custom values while refusing edits and deletion through raw replacements',async () => {
    const record=await createDeal(userId,{workspaceId,access}),fieldKey='validation_archived'
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:'deal',fieldKey,label:'Fictional archived value',fieldType:'text'})
    try {
      await updateCrmCustomFields({ctx:access,entityId:record.id,values:{[fieldKey]:'original'}})
      await archiveCrmFieldDefinition(userId,workspaceId,definition!.id)
      const attributes=(await owner.query('SELECT attributes FROM entities WHERE id=$1',[record.id])).rows[0].attributes
      expect(await updateEntity(userId,record.id,{displayName:'Fictional retained historical value',attributes},access)).toMatchObject({id:record.id})
      const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]
      for(const custom_fields of [{[fieldKey]:'edited'},{}]) {
        await expect(updateEntity(userId,record.id,{attributes:{...attributes,custom_fields}},access)).rejects.toThrow('invalid_value')
        expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[record.id])).rows[0]).toEqual(before)
      }
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it.each(['organisation_name','position','mailing_address'])
  ('Q04 preserves the compiled native profile text contract for %s below raw writers',async fieldKey => {
    const value=await createContact(userId,{workspaceId,name:'Fictional native profile',access})
    expect(await updateEntity(userId,value.id,{attributes:{custom_fields:{[fieldKey]:'Fictional profile text'}}},access)).toMatchObject({id:value.id})
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    for(const invalid of [17,'x'.repeat(fieldKey==='mailing_address'?601:201)]) {
      await expect(updateEntity(userId,value.id,{attributes:{custom_fields:{[fieldKey]:invalid}}},access)).rejects.toThrow('invalid_value')
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
    }
  })
  it('Q04 refuses an already unsafe native amount number at raw canonical creation',async () => {
    const before=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    await expect(createEntity({kind:'deal',displayName:'Fictional unsafe amount',workspaceId,createdByUserId:userId,source:'user',attributes:{stage:'lead',amount:9007199254740992}}))
      .rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(before)
  })
  it('Q04 refuses an already unsafe native amount number before a raw canonical patch commits',async () => {
    const value=await createDeal(userId,{workspaceId,amount:12,access})
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    await expect(updateEntity(userId,value.id,{attributes:{stage:'lead',amount:9007199254740992}},access)).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  it('Q04 refuses an already unsafe native amount before raw canonical supersession',async () => {
    const value=await createDeal(userId,{workspaceId,amount:12,access})
    const before=(await owner.query('SELECT attributes,valid_to,superseded_by,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    const count=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    await expect(supersedeEntity(userId,value.id,{attributes:{stage:'lead',amount:9007199254740992}})).rejects.toMatchObject({code:'invalid_value'})
    expect((await owner.query('SELECT attributes,valid_to,superseded_by,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(count)
  })
  it('Q03/Q04 does not reveal a private native kind while refusing an unsafe amount input',async () => {
    const value=await createDeal(userId,{workspaceId,amount:12,access})
    await owner.query('UPDATE entities SET user_id=$2 WHERE id=$1',[value.id,userId])
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    expect(await updateEntity(readerId,value.id,{attributes:{stage:'lead',amount:9007199254740992}},{...access,userId:readerId})).toBeNull()
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
  })
  function crmHttp() {
    const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as typeof req & {userId:string}).userId=userId;next()})
    app.use('/api/crm',crmRoutes({workspaceStore:createWorkspaceStore()}));return app
  }
  it('Q04/Q05 rolls back a real CRM HTTP create when a later owner field is invalid',async () => {
    const name=`Fictional atomic HTTP create ${randomUUID()}`
    const count=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    const response=await request(crmHttp()).post(`/api/crm/${workspaceId}/records`).send({kind:'deal',name,ownerId:'invalid-identifier',amount:'12.25'})
    expect(response.status).toBe(400)
    expect((await owner.query('SELECT id FROM entities WHERE workspace_id=$1 AND display_name=$2',[workspaceId,name])).rows).toEqual([])
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(count)
  })
  it('Q04/Q05 rolls back an earlier typed amount patch when a later CRM HTTP currency field refuses',async () => {
    const deal=await createDeal(userId,{workspaceId,access,amount:'12.25'})
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0]
    const response=await request(crmHttp()).patch(`/api/crm/${workspaceId}/records/${deal.id}`).send({amount:'23.75',currencyCode:'$$$'})
    expect(response.status).toBe(400)
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0]).toEqual(before)
  })
  it('Q04/Q05 rolls back a real CRM HTTP creation when its activity insert fails',async () => {
    const name=`Fictional atomic HTTP activity ${randomUUID()}`
    await owner.query(`CREATE FUNCTION native_operation_http_activity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${workspaceId}'::uuid THEN RAISE EXCEPTION 'Fictional activity storage refusal';END IF;RETURN NEW;END $$;
      CREATE TRIGGER native_operation_http_activity_fixture BEFORE INSERT ON crm_activities FOR EACH ROW EXECUTE FUNCTION native_operation_http_activity_fixture()`)
    try {
      const response=await request(crmHttp()).post(`/api/crm/${workspaceId}/records`).send({kind:'company',name})
      expect(response.status).toBe(400)
      expect((await owner.query('SELECT id FROM entities WHERE workspace_id=$1 AND display_name=$2',[workspaceId,name])).rows).toEqual([])
      expect((await owner.query('SELECT id FROM crm_activities WHERE workspace_id=$1 AND summary=$2',[workspaceId,'CRM record created'])).rows).toEqual([])
    } finally {await owner.query('DROP TRIGGER native_operation_http_activity_fixture ON crm_activities;DROP FUNCTION native_operation_http_activity_fixture()')}
  })
  it.each(['archive','custom','pipeline'] as const)('Q04/Q05 rolls back the actual CRM %s route and its source version when activity storage fails',async operation => {
    const field=operation==='custom'?await createCrmFieldDefinition({userId,workspaceId,entityKind:'company',fieldKey:'http_rollback_custom',label:'Fictional HTTP rollback custom',fieldType:'text'}):null
    const value=operation==='pipeline'?await createDeal(userId,{workspaceId,access,amount:'12.25'}):await createCompany(userId,{workspaceId,name:`Fictional secondary HTTP ${randomUUID()}`,access,mergeByName:false,
      ...(operation==='custom'?{customFields:{http_rollback_custom:'before'}}:{})})
    const config=operation==='pipeline'?await getCrmConfig(userId,workspaceId):null
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
    await owner.query(`CREATE FUNCTION native_operation_http_activity_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.workspace_id='${workspaceId}'::uuid THEN RAISE EXCEPTION 'Fictional activity storage refusal';END IF;RETURN NEW;END $$;
      CREATE TRIGGER native_operation_http_activity_fixture BEFORE INSERT ON crm_activities FOR EACH ROW EXECUTE FUNCTION native_operation_http_activity_fixture()`)
    try {
      const app=request(crmHttp()),base=`/api/crm/${workspaceId}/records/${value.id}`
      const response=operation==='archive'?await app.post(`${base}/archive`).send({}):operation==='custom'?await app.patch(`${base}/custom-fields`).send({values:{http_rollback_custom:'after'}})
        :await app.patch(`${base}/pipeline-stage`).send({stageId:config!.pipelines[0].stages.find(stage=>stage.legacyKey==='won')!.id})
      expect(response.status).toBeGreaterThanOrEqual(400)
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
      expect((await owner.query('SELECT id FROM crm_activities WHERE entity_id=$1',[value.id])).rows).toEqual([])
    } finally {
      await owner.query('DROP TRIGGER native_operation_http_activity_fixture ON crm_activities;DROP FUNCTION native_operation_http_activity_fixture()')
      if(field) await owner.query('DELETE FROM crm_field_definitions WHERE id=$1',[field.id])
    }
  })
  it.each(['unknown','invalid-type','overlong'] as const)('Q04 refuses an original CRM HTTP creation frame: %s',async invalid => {
    const body=invalid==='unknown'?{unexpected_key:true}:invalid==='invalid-type'?{domain:{secret:'unaccepted'}}:{name:'x'.repeat(257)}
    const count=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    const response=await request(crmHttp()).post(`/api/crm/${workspaceId}/records`).send({kind:'company',name:'Fictional original frame',...body})
    expect(response.status).toBe(400)
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(count)
  })
  it('Q04 preserves every admitted CRM HTTP tag and refuses an overlong patch without truncation',async () => {
    const tags=Array.from({length:64},(_,index)=>`fictional-tag-${index}`)
    const created=await request(crmHttp()).post(`/api/crm/${workspaceId}/records`).send({kind:'company',name:`Fictional full tags ${randomUUID()}`,tags})
    expect(created.status).toBe(201)
    expect((await owner.query("SELECT attributes->'tags' AS tags FROM entities WHERE id=$1",[created.body.id])).rows[0].tags).toEqual(tags)
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[created.body.id])).rows[0]
    const patched=await request(crmHttp()).patch(`/api/crm/${workspaceId}/records/${created.body.id}`).send({domain:'x'.repeat(321)})
    expect(patched.status).toBe(400)
    expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[created.body.id])).rows[0]).toEqual(before)
  })
  it('Q04 rolls back every real CRM mapped-row batch member when a later original frame refuses',async () => {
    const count=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
    const response=await request(crmHttp()).post(`/api/crm/${workspaceId}/import`).send({records:[{kind:'company',name:`Fictional first batch ${randomUUID()}`},{kind:'company',name:'Fictional refused batch',unknown_field:true}]})
    expect(response.status).toBe(400);expect(response.body.created).toBe(0)
    expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(count)
  })
  it('Q04/Q05 commits a real CRM mapped-row batch once with only committed record IDs',async () => {
    const names=[`Fictional first committed batch ${randomUUID()}`,`Fictional second committed batch ${randomUUID()}`]
    const response=await request(crmHttp()).post(`/api/crm/${workspaceId}/import`).send({records:names.map(name=>({kind:'company',name}))})
    expect(response.status).toBe(207);expect(response.body).toMatchObject({created:2,failed:0})
    const rows=(await owner.query('SELECT id FROM entities WHERE workspace_id=$1 AND display_name=ANY($2::text[]) ORDER BY id',[workspaceId,names])).rows
    expect(rows).toHaveLength(2);expect(response.body.results.map((row:{id:string})=>row.id).sort()).toEqual(rows.map(row=>row.id))
  })
  it('Q04/Q05 commits a real CRM HTTP combined custom patch on the existing company ID and one revision',async () => {
    const value=await createCompany(userId,{workspaceId,name:`Fictional HTTP combined ${randomUUID()}`,access,mergeByName:false})
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:'company',fieldKey:'http_required',label:'Fictional HTTP requirement',fieldType:'text',isRequired:true})
    try {
      const version=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
      const response=await request(crmHttp()).patch(`/api/crm/${workspaceId}/records/${value.id}`).send({domain:'http.example',customFields:{http_required:'accepted'}})
      expect(response.status).toBe(200)
      expect((await owner.query("SELECT id,attributes->>'domain' AS domain,attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0])
        .toEqual({id:value.id,domain:'http.example',custom:{http_required:'accepted'},version:String(BigInt(version)+1n)})
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1',[definition!.id])}
  })
  it('Q05 synchronizes the real CRM HTTP primary participant with one canonical deal edit',async () => {
    const first=await createContact(userId,{workspaceId,name:'Fictional first HTTP participant',access}),second=await createContact(userId,{workspaceId,name:'Fictional second HTTP participant',access})
    const deal=await createDeal(userId,{workspaceId,contactId:first.id,access})
    const version=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0].version
    const response=await request(crmHttp()).patch(`/api/crm/${workspaceId}/records/${deal.id}`).send({contactId:second.id})
    expect(response.status).toBe(200)
    expect((await owner.query("SELECT id,attributes->>'contact_id' AS contact,scope_version::text AS version FROM entities WHERE id=$1",[deal.id])).rows[0])
      .toEqual({id:deal.id,contact:second.id,version:String(BigInt(version)+1n)})
    expect((await owner.query('SELECT contact_id AS contact FROM crm_deal_contacts WHERE deal_id=$1 AND is_primary',[deal.id])).rows).toEqual([{contact:second.id}])
  })
  it.each(['company','person','deal'] as const)('Q04 sends actual legacy view %s initial custom values to the canonical writer',async kind => {
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:kind,fieldKey:'view_required',label:'Fictional view requirement',fieldType:'text',isRequired:true})
    try {
      const app=express();app.use(express.json());app.use((req,_res,next)=>{(req as typeof req & {userId:string}).userId=userId;next()})
      app.use('/api',viewsRoutes({workspaceStore:createWorkspaceStore(),crmStore:createDbCrmStore(),savedViewStore:{},taskStore:{},workflowRunStore:{},workspaceDirectory:{},softDeleteStore:{}} as ViewsRouteOptions))
      const route=kind==='company'?'companies':kind==='person'?'contacts':'deals'
      const body={workspaceId,...(kind==='deal'?{}:{name:`Fictional required view ${randomUUID()}`}),customFields:{view_required:'accepted'}}
      const response=await request(app).post(`/api/${route}`).send(body)
      expect(response.status).toBe(201)
      expect((await owner.query("SELECT attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE id=$1",[response.body.id])).rows[0]).toEqual({custom:{view_required:'accepted'},version:'1'})
      expect((await request(app).post(`/api/${route}`).send({...body,unknown_original_key:true})).status).toBe(400)
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1',[definition!.id])}
  })
  it.each(['company','person','deal'] as const)
  ('Q04/Q05 creates canonical %s required custom values in the initial row',async kind => {
    const key='initial_required',definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:kind,fieldKey:key,label:'Fictional required initial value',fieldType:'text',isRequired:true})
    try {
      const customFields={[key]:'accepted'}
      const value=kind==='company'?await createCompany(userId,{workspaceId,name:`Fictional initial ${randomUUID()}`,access,mergeByName:false,customFields} as Parameters<typeof createCompany>[1])
        :kind==='person'?await createContact(userId,{workspaceId,name:'Fictional initial contact',access,customFields} as Parameters<typeof createContact>[1])
        :await createDeal(userId,{workspaceId,amount:'12.000000000000000001',access,customFields} as Parameters<typeof createDeal>[1])
      expect((await owner.query("SELECT attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0])
        .toEqual({custom:customFields,version:'1'})
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it.each(['company','person','deal'] as const)
  ('Q04/Q05 applies canonical %s business and required custom edits in one version',async kind => {
    const value=kind==='company'?await createCompany(userId,{workspaceId,name:`Fictional combined ${randomUUID()}`,access,mergeByName:false})
      :kind==='person'?await createContact(userId,{workspaceId,name:'Fictional combined contact',access}):await createDeal(userId,{workspaceId,amount:12,access})
    const key='combined_required',definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:kind,fieldKey:key,label:'Fictional required combined value',fieldType:'text',isRequired:true})
    try {
      const version=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
      const customFields={[key]:'accepted'}
      const updated=kind==='company'?await updateCompany(userId,value.id,{domain:'combined.example',customFields} as CompanyUpdateFields,access)
        :kind==='person'?await updateContact(userId,value.id,{phone:'+1 202 555 0101',customFields} as ContactUpdateFields,undefined,access)
        :await updateDeal(userId,value.id,{amount:'12.000000000000000001',customFields} as DealUpdateFields,undefined,access)
      expect(updated).toMatchObject({id:value.id})
      expect((await owner.query("SELECT attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0])
        .toEqual({custom:customFields,version:String(BigInt(version)+1n)})
      const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
      const invalid={customFields:{[key]:17}}
      const write=kind==='company'?()=>updateCompany(userId,value.id,invalid as CompanyUpdateFields,access)
        :kind==='person'?()=>updateContact(userId,value.id,invalid as ContactUpdateFields,undefined,access)
        :()=>updateDeal(userId,value.id,invalid as DealUpdateFields,undefined,access)
      await expect(write()).rejects.toMatchObject({code:'invalid_value'})
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it.each(['company','person','deal'] as const)('Q04/Q05 joins initial %s custom-reference privacy and refuses a hidden target without partial creation',async kind => {
    const target=await createEntity({workspaceId,kind:'company',displayName:`Fictional private reference ${randomUUID()}`,userId,createdByUserId:userId,source:'user',attributes:{}})
    const hidden=await createEntity({workspaceId,kind:'company',displayName:`Fictional hidden reference ${randomUUID()}`,userId:readerId,createdByUserId:readerId,source:'user',attributes:{}})
    const key='initial_reference',definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:kind,fieldKey:key,label:'Fictional initial reference',fieldType:'entity_reference',options:['company'],isRequired:true})
    const create=(id:string)=>kind==='company'?createCompany(userId,{workspaceId,name:`Fictional scoped custom ${randomUUID()}`,access,mergeByName:false,customFields:{[key]:id}})
      :kind==='person'?createContact(userId,{workspaceId,name:'Fictional scoped custom person',access,customFields:{[key]:id}})
      :createDeal(userId,{workspaceId,access,customFields:{[key]:id}})
    try {
      const value=await create(target.id)
      expect((await owner.query("SELECT user_id,attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0])
        .toEqual({user_id:userId,custom:{[key]:target.id},version:'1'})
      const count=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
      await expect(create(hidden.id)).rejects.toMatchObject({code:'scope_operation_denied'})
      expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(count)
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it('Q04/Q05 keeps one company identity and one revision when upserting newly required custom values',async () => {
    const name=`Fictional required upsert ${randomUUID()}`,value=await createCompany(userId,{workspaceId,name,access})
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:'company',fieldKey:'upsert_required',label:'Fictional upsert requirement',fieldType:'text',isRequired:true})
    try {
      const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
      expect(await createCompany(userId,{workspaceId,name,domain:'upsert.example',access,customFields:{upsert_required:'accepted'}})).toMatchObject({id:value.id,domain:'upsert.example'})
      expect((await owner.query("SELECT id,attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE workspace_id=$1 AND display_name=$2",[workspaceId,name])).rows)
        .toEqual([{id:value.id,custom:{upsert_required:'accepted'},version:String(BigInt(before)+1n)}])
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it.each(['company','person','deal'] as const)('Q04 executes the actual %s tool with required initial custom values and refuses a malformed retry',async kind => {
    const company=kind==='deal'?await createCompany(userId,{workspaceId,name:`Fictional tool relation ${randomUUID()}`,access,mergeByName:false}):null
    const definition=await createCrmFieldDefinition({userId,workspaceId,entityKind:kind,fieldKey:'tool_required',label:'Fictional tool requirement',fieldType:'text',isRequired:true})
    try {
      const tools=createCrmTools(createDbCrmStore()),context=executionToolContext(await execution(),{appId:'Fictional CRM fixture'})
      const tool=kind==='company'?tools.saveCompany:kind==='person'?tools.saveContact:tools.saveDeal
      const input={...(kind==='deal'?{company_id:company!.id}:{name:`Fictional required tool ${randomUUID()}`}),custom_fields:{tool_required:'accepted'}}
      expect((await tool.execute(input,context)).isError).toBeFalsy()
      const rows=(await owner.query("SELECT id,attributes->'custom_fields' AS custom,scope_version::text AS version FROM entities WHERE workspace_id=$1 AND kind=$2 AND attributes->'custom_fields' ? 'tool_required'",[workspaceId,kind])).rows
      expect(rows).toHaveLength(1);expect(rows[0]).toMatchObject({custom:{tool_required:'accepted'},version:'1'})
      const before=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
      expect((await tool.execute({...input,unknown_business_key:true},context)).isError).toBe(true)
      expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(before)
    } finally {await owner.query('DELETE FROM crm_field_definitions WHERE id=$1 AND workspace_id=$2',[definition!.id,workspaceId])}
  })
  it.each(['catalog stage','registered stage','primary participant removal'] as const)
  ('Q04/Q05 keeps untouched numeric JSON exact through the legacy %s writer',async operation => {
    const contact=await createContact(userId,{workspaceId,name:'Fictional precision contact',access})
    const deal=await createDeal(userId,{workspaceId,contactId:contact.id,amount:'123.456789012345678',access})
    const exact='9007199254740993.123456789012345678',connection=await client()
    try {await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{precision_guard}',to_jsonb($2::numeric)) WHERE id=$1",[deal.id,exact]);await connection.query('COMMIT')}
    finally {await connection.query('ROLLBACK');connection.release()}
    if(operation==='primary participant removal') {
      await addCrmDealParticipant({ctx:access,dealId:deal.id,contactId:contact.id,isPrimary:true})
      expect(await removeCrmDealParticipant({ctx:access,dealId:deal.id,contactId:contact.id})).toBe(true)
    } else {
      const config=await getCrmConfig(userId,workspaceId),pipeline=config.pipelines[0],stage=pipeline.stages.find(value => value.legacyKey==='won')!
      if(operation==='catalog stage') expect(await setCrmDealPipelineStage({ctx:access,entityId:deal.id,stageId:stage.id})).toMatchObject({entity:{id:deal.id}})
      else {
        const transaction=await client()
        try {
          const service=createCrmOperationsService(createDbCrmOperationsStore(getAppPool(),transaction))
          const context={workspaceId,actor:{kind:'user' as const,userId},authority:{role:'owner' as const,canWrite:true,canConfigure:true,trustedIdentitySources:[]}}
          const command={kind:'set_deal_pipeline_stage' as const,dealId:deal.id,pipelineId:pipeline.id,stageId:stage.id}
          const committed=await service.execute(context,command)
          expect(committed.emittedEventIds).toHaveLength(1)
          expect((await service.execute(context,command)).duplicate).toBe(true)
          expect((await transaction.query('SELECT id FROM crm_domain_event_outbox WHERE workspace_id=$1 AND subject_id=$2',[workspaceId,deal.id])).rows)
            .toEqual([{id:committed.emittedEventIds[0]}])
          await transaction.query('COMMIT')
        } finally {await transaction.query('ROLLBACK');transaction.release()}
      }
    }
    expect((await owner.query("SELECT attributes->>'precision_guard' AS exact,attributes->>'amount' AS amount FROM entities WHERE id=$1",[deal.id])).rows[0])
      .toEqual({exact,amount:'123.456789012345678'})
  })
  it('Q05/Q06 rolls back a real nonowner registered stage when its outbox insert fails',async () => {
    const deal=await createDeal(userId,{workspaceId,amount:'123.000000000000000001',access}),config=await getCrmConfig(userId,workspaceId)
    const pipeline=config.pipelines[0],stage=pipeline.stages.find(value => value.legacyKey==='won')!
    const before=(await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0]
    await owner.query(`CREATE FUNCTION native_operation_outbox_fixture() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.subject_id='${deal.id}'::uuid THEN RAISE EXCEPTION 'Fictional outbox storage refusal';END IF;RETURN NEW;END $$;
      CREATE TRIGGER native_operation_outbox_fixture BEFORE INSERT ON crm_domain_event_outbox FOR EACH ROW EXECUTE FUNCTION native_operation_outbox_fixture()`)
    const transaction=await client()
    try {
      const service=createCrmOperationsService(createDbCrmOperationsStore(getAppPool(),transaction))
      await expect(service.execute({workspaceId,actor:{kind:'user',userId},authority:{role:'owner',canWrite:true,canConfigure:true,trustedIdentitySources:[]}},
        {kind:'set_deal_pipeline_stage',dealId:deal.id,pipelineId:pipeline.id,stageId:stage.id})).rejects.toThrow('Fictional outbox storage refusal')
      await transaction.query('ROLLBACK')
      expect((await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[deal.id])).rows[0]).toEqual(before)
      for(const table of ['crm_activities','crm_domain_event_outbox','association_audit_log','workspace_audit_log']) {
        const key=table==='crm_activities'?'entity_id':'subject_id'
        expect((await owner.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND ${key}=$2`,[workspaceId,deal.id])).rows).toEqual([])
      }
    } finally {
      await transaction.query('ROLLBACK');transaction.release()
      await owner.query('DROP TRIGGER native_operation_outbox_fixture ON crm_domain_event_outbox;DROP FUNCTION native_operation_outbox_fixture()')
    }
  })
  it('Q04/Q05 preserves an exact native decimal amount through canonical creation, get and list',async () => {
    const amount='9007199254740993.123456789012345678'
    const value=await createDeal(userId,{workspaceId,amount:amount as unknown as number,access})
    expect(value.amount).toBe(amount)
    const dispatcher=new ApplicationPlatformService([(await import('../native-adapters.js')).createCanonicalNativeApplicationModule()])
    expect((await dispatcher.query(await execution(),'native','get',{type:'deal',id:value.id}) as {values:Record<string,unknown>}).values.amount).toBe(amount)
    expect((await getDealById(access,value.id))?.amount).toBe(amount)
    expect((await listDeals(access,{})).find(row => row.id===value.id)?.amount).toBe(amount)
    expect((await owner.query("SELECT attributes->>'amount' AS amount FROM entities WHERE id=$1",[value.id])).rows[0].amount).toBe(amount)
  })
  it('Q04/Q05 preserves original numeric precision on native deal reads and unrelated partial edits',async () => {
    const value=await createDeal(userId,{workspaceId,amount:12,access}),amount='9007199254740993.123456789012345678'
    const connection=await client()
    try {await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{amount}',to_jsonb($2::numeric)) WHERE id=$1",[value.id,amount]);await connection.query('COMMIT')}
    finally {await connection.query('ROLLBACK');connection.release()}
    expect((await getDealById(access,value.id))?.amount).toBe(amount)
    expect((await listDeals(access,{})).find(row => row.id===value.id)?.amount).toBe(amount)
    expect(await updateDeal(userId,value.id,{externalRef:{fictional:'preserved'}},undefined,access)).toMatchObject({id:value.id,amount})
    expect((await owner.query("SELECT attributes->>'amount' AS amount FROM entities WHERE id=$1",[value.id])).rows[0].amount).toBe(amount)
  })
  it('Q04/Q05 preserves an exact decimal patch, source identity and version',async () => {
    const before=await createDeal(userId,{workspaceId,amount:12,access}),amount='9007199254740993.000000000000000001'
    const prior=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[before.id])).rows[0].version
    expect(await updateDeal(userId,before.id,{amount:amount as unknown as number},undefined,access)).toMatchObject({id:before.id,amount})
    expect((await getDealById(access,before.id))?.amount).toBe(amount)
    expect((await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[before.id])).rows[0].version).toBe(String(BigInt(prior)+1n))
  })
  it.each(['1e8','-1','NaN','01.2','1.1234567890123456789',9007199254740992])('Q04 refuses an invalid or already unsafe native amount: %s',async amount => {
    const before=await createDeal(userId,{workspaceId,amount:12,access})
    await expect(updateDeal(userId,before.id,{amount:amount as unknown as number},undefined,access)).rejects.toMatchObject({code:'invalid_value'})
    expect((await getDealById(access,before.id))?.amount).toBe(12)
  })
  describe('[COMP:security/native-field-policy] canonical native CRM write admission',() => {
    const nativeOrigin={kind:'native',moduleKey:'native'}
    beforeAll(async () => {
      await owner.query(`CREATE SEQUENCE native_operation_field_fixture_seq;
        CREATE TABLE native_operation_field_fixture_epochs(workspace_id uuid PRIMARY KEY,revision bigint NOT NULL);
        CREATE FUNCTION native_operation_field_fixture_revision(w uuid) RETURNS text
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT coalesce((SELECT revision::text FROM public.native_operation_field_fixture_epochs WHERE workspace_id=w),'0') $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_revision(uuid) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_changed() RETURNS trigger
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        DECLARE w uuid;BEGIN w:=CASE WHEN TG_OP='DELETE' THEN OLD.workspace_id ELSE NEW.workspace_id END;
          INSERT INTO public.native_operation_field_fixture_epochs(workspace_id,revision) VALUES(w,nextval('public.native_operation_field_fixture_seq'))
            ON CONFLICT(workspace_id) DO UPDATE SET revision=nextval('public.native_operation_field_fixture_seq');RETURN NULL;END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_changed() FROM PUBLIC;
        CREATE TRIGGER native_operation_field_fixture_configuration AFTER INSERT OR UPDATE OR DELETE ON public.crm_field_definitions
          FOR EACH ROW EXECUTE FUNCTION native_operation_field_fixture_changed();
        CREATE FUNCTION native_operation_field_fixture_rules() RETURNS jsonb
        LANGUAGE sql IMMUTABLE SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT '[{"key":"name","read":[],"write":[],"releaseReadTo":["external_user","service"],"releaseWriteTo":["service"]},
            {"key":"domain","read":[],"write":[],"releaseReadTo":["external_user","service"],"releaseWriteTo":["service"]},
            {"key":"archivedAt","read":[],"write":[],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"tags","read":[],"write":[],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"externalRef","read":[],"write":[],"releaseReadTo":[],"releaseWriteTo":[]},
            {"key":"custom.cost","read":[["finance"]],"write":[["finance"]],"releaseReadTo":[],"releaseWriteTo":[]}]'::jsonb $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_rules() FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_keys(w uuid) RETURNS jsonb
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
          SELECT to_jsonb(ARRAY['name','domain','tags','externalRef','archivedAt']||ARRAY(SELECT 'custom.'||field_key FROM public.crm_field_definitions
            WHERE workspace_id=w AND entity_kind='company' AND archived_at IS NULL ORDER BY field_key)) $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_keys(uuid) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        DECLARE source jsonb;BEGIN
          IF o<>'{"kind":"native","moduleKey":"native"}'::jsonb OR t<>'company' THEN RETURN NULL;END IF;
          source:=public.read_scope_source(w,'entity',i::uuid);
          RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion',public.native_operation_field_fixture_revision(w),
            'policyVersion','1','recordVersion',source->>'version','fieldKeys',public.native_operation_field_fixture_keys(w),
            'fields',CASE WHEN source->>'userId' IS NOT NULL THEN jsonb_set(public.native_operation_field_fixture_rules(),'{0,write}','[["finance"]]'::jsonb) ELSE public.native_operation_field_fixture_rules() END,'source',source);END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_reader(uuid,jsonb,text,text) FROM PUBLIC;
        CREATE FUNCTION native_operation_field_fixture_catalog(w uuid,o jsonb,t text) RETURNS jsonb
        LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        BEGIN
          IF o<>'{"kind":"native","moduleKey":"native"}'::jsonb OR t<>'company' THEN RETURN NULL;END IF;
          RETURN jsonb_build_object('moduleKey','native','origin',o,'typeKey',t,'schemaVersion',public.native_operation_field_fixture_revision(w),
            'policyVersion','1','fieldKeys',public.native_operation_field_fixture_keys(w),'fields',public.native_operation_field_fixture_rules(),
            'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));END $$;
        REVOKE ALL ON FUNCTION native_operation_field_fixture_catalog(uuid,jsonb,text) FROM PUBLIC`)
      await createCrmFieldDefinition({userId,workspaceId,entityKind:'company',fieldKey:'cost',label:'Fictional cost',fieldType:'number'})
      await owner.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required,configuration_reader)
        VALUES('native','1',ARRAY['finance'],'native_operation_field_fixture_reader(uuid,jsonb,text,text)'::regprocedure,
          'native_operation_field_fixture_catalog(uuid,jsonb,text)'::regprocedure,true,'native_operation_field_fixture_revision(uuid)'::regprocedure)`)
      await owner.query("INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,$2,'company','native')",[workspaceId,nativeOrigin])
      // The provisioning actor has an explicit current field role; tested
      // ordinary readers never inherit owner status or that assignment.
      await owner.query("INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id) VALUES($1,'native',$2,'finance',$2)",[workspaceId,userId])
    })
    afterAll(async () => {
      await owner.query("DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND module_key='native'",[workspaceId])
      await owner.query("DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='native'",[workspaceId])
      await owner.query("DELETE FROM application_native_field_contracts WHERE module_key='native'")
      await owner.query('DROP TRIGGER native_operation_field_fixture_configuration ON crm_field_definitions')
      await owner.query('DROP FUNCTION native_operation_field_fixture_reader(uuid,jsonb,text,text)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_catalog(uuid,jsonb,text)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_keys(uuid)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_rules()')
      await owner.query('DROP FUNCTION native_operation_field_fixture_revision(uuid)')
      await owner.query('DROP FUNCTION native_operation_field_fixture_changed()')
      await owner.query('DROP TABLE native_operation_field_fixture_epochs')
      await owner.query('DROP SEQUENCE native_operation_field_fixture_seq')
    })
    async function company() {
      const value=await createCompany(userId,{workspaceId,name:`Fictional protected company ${randomUUID()}`,access,mergeByName:false})
      await updateCrmCustomFields({ctx:access,entityId:value.id,values:{cost:42}})
      return value
    }
    async function member<T>(actor:string,operation:(client:PoolClient)=>Promise<T>) {
      const connection=await getAppPool().connect()
      try {await connection.query('BEGIN');await applyRLSGucs(connection,actor);const value=await operation(connection);await connection.query('COMMIT');return value}
      finally {await connection.query('ROLLBACK');connection.release()}
    }
    const reader={...access,userId:readerId}
    async function snapshot(id:string) {return (await owner.query('SELECT attributes,scope_version::text AS version FROM entities WHERE id=$1',[id])).rows[0]}
    it('Q04/Q05 refuses creation when the actual private native point is stricter than its catalog',async () => {
      const before=(await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count
      await expect(createEntity({kind:'company',displayName:'Fictional private point',workspaceId,createdByUserId:readerId,userId:readerId,source:'user',attributes:{}}))
        .rejects.toThrow('access_unavailable')
      expect((await owner.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1',[workspaceId])).rows[0].count).toBe(before)
    })
    it('Q04/Q05 retains a positively admitted actual private native creation point',async () => {
      const value=await createEntity({kind:'company',displayName:'Fictional admitted private point',workspaceId,createdByUserId:userId,userId,source:'user',attributes:{}})
      expect((await owner.query('SELECT id,user_id,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0])
        .toEqual({id:value.id,user_id:userId,version:'1'})
    })
    it('Q04 refuses an unowned-to-native kind promotion when its destination point denies a field',async () => {
      const value=await createEntity({kind:'project',displayName:'Fictional private promotion',workspaceId,createdByUserId:readerId,userId:readerId,source:'user',attributes:{}})
      const before=(await owner.query('SELECT kind,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]
      await expect(member(readerId,connection=>connection.query("UPDATE entities SET kind='company' WHERE id=$1",[value.id]))).rejects.toThrow('access_unavailable')
      expect((await owner.query('SELECT kind,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0]).toEqual(before)
    })
    it('Q04/Q05 preserves the canonical ID for a positively admitted native kind promotion',async () => {
      const value=await createEntity({kind:'project',displayName:'Fictional shared promotion',workspaceId,createdByUserId:readerId,source:'user',attributes:{}})
      const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
      await member(readerId,connection=>connection.query("UPDATE entities SET kind='company' WHERE id=$1",[value.id]))
      expect((await owner.query('SELECT id,kind,scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0])
        .toEqual({id:value.id,kind:'company',version:String(BigInt(before)+1n)})
    })
    it('Q04/Q05 archives and restores a protected native company without touching a hidden exact value',async () => {
      const value=await company(),cost='9007199254740993.123456789012345678',reader={...access,userId:readerId}
      await member(userId,connection => connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields,cost}',to_jsonb($2::numeric)) WHERE id=$1",[value.id,cost]))
      const before=(await owner.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
      const invocation=await execution()
      expect(await setCrmArchived({ctx:reader,entityId:value.id,archived:true})).toMatchObject({id:value.id})
      expect((await owner.query("SELECT attributes ? 'crm_archived_at' AS archived,attributes->'custom_fields'->>'cost' AS cost FROM entities WHERE id=$1",[value.id])).rows[0]).toEqual({archived:true,cost})
      expect(await setCrmArchived({ctx:reader,entityId:value.id,archived:false})).toMatchObject({id:value.id})
      expect((await owner.query("SELECT attributes ? 'crm_archived_at' AS archived,attributes->'custom_fields'->>'cost' AS cost,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0]).toEqual({archived:false,cost,version:String(BigInt(before)+2n)})
      await expect(invocation.security.authority.assertCurrent()).resolves.toBeUndefined()
    })
    it.each([43,42])('Q04 refuses a protected native custom write of %s, including an equal hidden value',async cost => {
      const value=await company(),before=await snapshot(value.id)
      const mask=await member(readerId,async connection => (await connection.query('SELECT read_native_application_field_mask($1,$2,$3,$4,$5) AS value',
        [workspaceId,nativeOrigin,'company',value.id,before.version])).rows[0].value)
      expect(mask.writeFields).not.toContain('custom.cost')
      await expect(updateCrmCustomFields({ctx:reader,entityId:value.id,values:{cost}})).rejects.toMatchObject({code:'access_unavailable'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 refuses protected native fields through the canonical raw entity writer',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(updateEntity(readerId,value.id,{attributes:{...before.attributes,custom_fields:{cost:43}}},reader)).rejects.toMatchObject({code:'access_unavailable'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 keeps actual nonowner raw SQL behind the same protected native field boundary',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => (await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields,cost}','43') WHERE id=$1",[value.id])).rowCount))
        .rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 refuses a raw equal attribute replacement without typed partial intent',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => (await connection.query('UPDATE entities SET attributes=attributes WHERE id=$1',[value.id])).rowCount))
        .rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it.each(['aliases=aliases',"aliases=ARRAY['Fictional alias']"])('Q04 refuses undeclared canonical alias fields through raw SQL: %s',async assignment => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => (await connection.query(`UPDATE entities SET ${assignment} WHERE id=$1`,[value.id])).rowCount))
        .rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 does not let a spoofed allowed partial intent hide an actual hidden-field change',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => {
        await connection.query("SELECT set_config('app.native_entity_write_intent',$1,true)",[JSON.stringify({workspaceId,typeKey:'company',id:value.id,fields:['domain']})])
        return (await connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields,cost}','43') WHERE id=$1",[value.id])).rowCount
      })).rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04 scopes partial intent to its exact native record, including equal assignments',async () => {
      const value=await company(),before=await snapshot(value.id)
      await expect(member(readerId,async connection => {
        await connection.query("SELECT set_config('app.native_entity_write_intent',$1,true)",[JSON.stringify({workspaceId,typeKey:'company',id:randomUUID(),fields:['domain']})])
        return (await connection.query('UPDATE entities SET attributes=attributes WHERE id=$1',[value.id])).rowCount
      })).rejects.toMatchObject({code:'42501'})
      expect(await snapshot(value.id)).toEqual(before)
    })
    it('Q04/Q05 preserves an untouched hidden JSON numeric field exactly during an allowed native partial edit',async () => {
      const value=await company(),cost='9007199254740993.123456789012345678'
      await member(userId,connection => connection.query("UPDATE entities SET attributes=jsonb_set(attributes,'{custom_fields,cost}',to_jsonb($2::numeric)) WHERE id=$1",[value.id,cost]))
      const before=(await owner.query("SELECT attributes->'custom_fields'->>'cost' AS cost,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0]
      expect(await updateCompany(readerId,value.id,{domain:'precise-partial.example'},reader)).toMatchObject({id:value.id,domain:'precise-partial.example'})
      const after=(await owner.query("SELECT attributes->'custom_fields'->>'cost' AS cost,scope_version::text AS version FROM entities WHERE id=$1",[value.id])).rows[0]
      expect(before.cost).toBe(cost);expect(after.cost).toBe(cost);expect(after.version).toBe(String(BigInt(before.version)+1n))
    })
    it('Q04/Q05 lets a typed allowed native domain edit preserve an unreadable custom field and source identity',async () => {
      const value=await company(),before=await snapshot(value.id)
      expect(await updateCompany(readerId,value.id,{domain:'native-fields.example'},reader)).toMatchObject({id:value.id,domain:'native-fields.example'})
      const after=await snapshot(value.id)
      expect(after.attributes.custom_fields).toEqual({cost:42})
      expect(after.version).toBe(String(BigInt(before.version)+1n))
    })
  })

})
