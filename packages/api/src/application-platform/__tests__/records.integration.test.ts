import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createExecutionContext, type ApplicationModuleDefinition, type CellValue, type PropertyDef } from '@use-brian/core'
import { z } from 'zod'
import type { PoolClient } from 'pg'
import { ApplicationPlatformError } from '@use-brian/shared'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalNativeApplicationModule } from '../native-adapters.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { applyRLSGucs, getAppPool, getPool, queryWithRLS } from '../../db/client.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-records] real canonical generic record transactions', () => {
  const owner = getPool(), userId = randomUUID(), readerId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID()
  const store = createDbDocEntityStore({ actorUserId: userId })
  const title: PropertyDef = { name: 'title', config: { kind: 'text' }, required: true }
  async function type(properties: PropertyDef[] = [title]) {
    return store.createEntityType({ workspaceId, name: `Fixture ${randomUUID()}`, properties, createdBy: userId })
  }
  function create(entityTypeId: string, data: Record<string, CellValue>) {
    return store.createEntity({ workspaceId, entityTypeId, data, sourceApp: 'api', createdBy: userId, lastEditedBy: userId })
  }
  beforeAll(async () => {
    await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
    await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [readerId])
    await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Record fixture',$2,false)", [workspaceId, userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId, userId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')", [workspaceId, readerId])
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind) VALUES($1,'Fixture assistant',$2,$3,'primary')", [assistantId,userId,workspaceId])
  })
  afterAll(async () => {
    await owner.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[userId,readerId]])
    await getAppPool().end(); await owner.end()
  })
  it('checks required, kind, enum, number, date and undeclared values at the canonical SQL writer', async () => {
    const schema = await type([title, { name: 'state', config: { kind: 'select', options: [{ id: 'open', name: 'Open' }] } },
      { name: 'count', config: { kind: 'number', format: 'int', minimum: 1, maximum: 5 } },
      { name: 'date', config: { kind: 'date', supportRange: true } }])
    const titleValue = { title: { kind: 'text' as const, value: 'Request' } }
    const invalid = [{}, { title: { kind: 'number', value: 3 } }, { ...titleValue, unknown: { kind: 'text', value: 'x' } },
      { ...titleValue, state: { kind: 'select', value: 'not-an-option' } }, { ...titleValue, count: { kind: 'number', value: 1.5 } },
      { ...titleValue, count: { kind: 'number', value: 6 } }, { ...titleValue, date: { kind: 'date', value: { start: '2026-02-30' } } },
      { ...titleValue, date: { kind: 'date', value: { start: '2026-02-02', end: '2026-02-01' } } }]
    for (const data of invalid) {
      await expect(queryWithRLS(userId, `INSERT INTO entity_instances(entity_type_id,workspace_id,data,created_by,last_edited_by)
        VALUES($1,$2,$3,$4,$4)`, [schema.id, workspaceId, JSON.stringify(data), userId])).rejects.toMatchObject({ code: '22023' })
    }
    expect((await owner.query('SELECT id FROM entity_instances WHERE entity_type_id=$1', [schema.id])).rows).toHaveLength(0)
    const record = await create(schema.id, { ...titleValue, count: { kind: 'number', value: 2 } })
    expect(record.recordVersion).toBe('1')
  })
  it('advances history on legacy direct SQL and rolls back the record if history cannot be committed', async () => {
    const schema = await type(), record = await create(schema.id, { title: { kind: 'text', value: 'First' } })
    await queryWithRLS(userId, "UPDATE entity_instances SET data=jsonb_set(data,'{title,value}','\"Second\"') WHERE id=$1", [record.id])
    expect((await store.getEntity(workspaceId, record.id))?.recordVersion).toBe('2')
    expect((await owner.query('SELECT record_version FROM application_record_revisions WHERE entity_instance_id=$1 ORDER BY record_version', [record.id])).rows.map(row => String(row.record_version))).toEqual(['1', '2'])
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client, userId)
      const composed = createDbDocEntityStore({ actorUserId: userId, transaction: client })
      await composed.updateEntity(workspaceId, record.id, { data: { title: { kind: 'text', value: 'Rolled back' } }, lastEditedBy: userId })
      await expect(client.query("SELECT 'forced audit failure'::integer")).rejects.toThrow()
      await client.query('ROLLBACK')
    } finally { client.release() }
    expect((await store.getEntity(workspaceId, record.id))?.data.title.value).toBe('Second')
    expect((await owner.query('SELECT count(*)::int AS count FROM application_record_revisions WHERE entity_instance_id=$1', [record.id])).rows[0].count).toBe(2)
  })
  it('permits one normalized unique winner across concurrent connections and releases claims on delete', async () => {
    const schema = await type([{ ...title, unique: true }])
    const outcomes = await Promise.allSettled([create(schema.id, { title: { kind: 'text', value: '  Example  ' } }),
      create(schema.id, { title: { kind: 'text', value: 'example' } })])
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1)
    const winner = outcomes.find(result => result.status === 'fulfilled')!
    if (winner.status !== 'fulfilled') throw new Error('Missing unique winner')
    await store.deleteEntity(workspaceId, winner.value.id)
    expect((await create(schema.id, { title: { kind: 'text', value: 'example' } })).recordVersion).toBe('1')
  })
  it('allows exactly one compare-and-swap update and keeps all effects of the loser absent', async () => {
    const schema = await type(), record = await create(schema.id, { title: { kind: 'text', value: 'Start' } })
    const outcomes = await Promise.allSettled(['First', 'Second'].map(value => store.updateEntity(workspaceId, record.id,
      { data: { title: { kind: 'text', value } }, lastEditedBy: userId }, { actorUserId: userId, expectedRecordVersion: '1' })))
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    const rejected = outcomes.find(result => result.status === 'rejected')
    expect(rejected?.status === 'rejected' && rejected.reason.code).toBe('record_version_conflict')
    expect((await store.getEntity(workspaceId, record.id))?.recordVersion).toBe('2')
  })
  it('refuses incompatible schema edits and new uniqueness over duplicate legacy values atomically', async () => {
    const schema = await type()
    await create(schema.id, { title: { kind: 'text', value: 'Same' } })
    await create(schema.id, { title: { kind: 'text', value: 'same' } })
    await expect(store.updateEntityType(workspaceId, schema.id, { properties: [] })).rejects.toMatchObject({ code: '22023' })
    await expect(store.updateEntityType(workspaceId, schema.id, { properties: [{ ...title, unique: true }] })).rejects.toMatchObject({ code: '23505' })
    const unchanged = await store.getEntityType(workspaceId, schema.id)
    expect(unchanged?.schemaVersion).toBe(1)
    expect(unchanged?.properties).toEqual([title])
    expect((await owner.query('SELECT id FROM entity_instances WHERE entity_type_id=$1', [schema.id])).rows).toHaveLength(2)
  })
  it('renames schema and values in one transaction without changing canonical IDs', async () => {
    const schema = await type(), record = await create(schema.id, { title: { kind: 'text', value: 'Stable' } })
    const renamed = await store.renameProperty(workspaceId, schema.id, 'title', 'name', { actorUserId: userId, expectedSchemaVersion: 1 })
    expect(renamed.id).toBe(schema.id); expect(renamed.schemaVersion).toBe(2)
    expect((await store.getEntity(workspaceId, record.id))?.data).toEqual({ name: { kind: 'text', value: 'Stable' } })
    await expect(store.renameProperty(workspaceId, schema.id, 'name', 'other', { actorUserId: userId, expectedSchemaVersion: 1 })).rejects.toMatchObject({ code: 'schema_version_conflict' })
  })
  it('rejects unavailable relations and preserves a valid same-workspace reference', async () => {
    const targetType = await type(), target = await create(targetType.id, { title: { kind: 'text', value: 'Target' } })
    const schema = await type([title, { name: 'parent', config: { kind: 'relation', targetEntityTypeRef: { kind: 'user_defined', entityTypeId: targetType.id } } }])
    await expect(create(schema.id, { title: { kind: 'text', value: 'Request' }, parent: { kind: 'relation', value: randomUUID() } })).rejects.toMatchObject({ code: '22023' })
    const record = await create(schema.id, { title: { kind: 'text', value: 'Request' }, parent: { kind: 'relation', value: target.id } })
    expect(record.data.parent.value).toBe(target.id)
    await owner.query("UPDATE entity_instances SET sensitivity='confidential' WHERE id=$1", [target.id])
    const readerStore = createDbDocEntityStore({ actorUserId: readerId })
    await expect(readerStore.createEntity({ workspaceId, entityTypeId: schema.id,
      data: { title: { kind: 'text', value: 'Refused' }, parent: { kind: 'relation', value: target.id } },
      sourceApp: 'api', createdBy: readerId, lastEditedBy: readerId })).rejects.toMatchObject({ code: '22023' })
  })
  it('refuses a canonical composition on the owner pool', async () => {
    const client = await owner.connect()
    try {
      await client.query('BEGIN')
      const unsafe = createDbDocEntityStore({ actorUserId: userId, transaction: client })
      await expect(unsafe.listEntityTypes(workspaceId)).rejects.toMatchObject({ code: 'access_unavailable' })
      await client.query('ROLLBACK')
    } finally { client.release() }
  })
  it('queries actual cell values and paginates mixed numeric ordering, ties and nulls without duplicates',async()=>{
    const schema=await type([title,{name:'quantity',config:{kind:'number'}},{name:'tags',config:{kind:'multi_select',options:[{id:'red',name:'Red'},{id:'blue',name:'Blue'}]}}])
    const expected=new Map<string,number|null>()
    for(const [index,quantity]of [2,10,2,null,1].entries()) {
      const record=await create(schema.id,{title:{kind:'text',value:`Request ${index}`},quantity:{kind:'number',value:quantity},tags:{kind:'multi_select',value:index%2?['blue']:['red']}})
      expected.set(record.id,quantity)
    }
    const sorted:{id:string;value:number|null}[]=[],sort=[{field:'quantity',direction:'asc' as const}]
    let cursor:string|undefined
    do {
      const page=await store.queryEntities(workspaceId,schema.id,[],sort,2,cursor)
      sorted.push(...page.rows.map(row=>({id:row.id,value:row.data.quantity.value as number|null})));cursor=page.nextCursor
    }while(cursor)
    expect(sorted.map(row=>row.value)).toEqual([1,2,2,10,null])
    expect(new Set(sorted.map(row=>row.id)).size).toBe(expected.size)
    expect((await store.queryEntities(workspaceId,schema.id,[{field:'quantity',op:'gt',value:2}])).rows.map(row=>row.data.quantity.value)).toEqual([10])
    expect((await store.queryEntities(workspaceId,schema.id,[{field:'tags',op:'contains',value:'red'}])).rows).toHaveLength(3)
    expect((await store.queryEntities(workspaceId,schema.id,[{field:'title',op:'contains',value:'request 1'}])).rows).toHaveLength(1)
    for(const filter of [{field:'missing',op:'eq' as const,value:1},{field:'quantity',op:'eq' as const,value:'2'},{field:'tags',op:'contains' as const,value:'missing'}]) {
      await expect(store.queryEntities(workspaceId,schema.id,[filter])).rejects.toMatchObject({code:'invalid_value'})
    }
    const first=await store.queryEntities(workspaceId,schema.id,[],sort,2)
    await expect(store.queryEntities(workspaceId,schema.id,[],[{field:'quantity',direction:'desc'}],2,first.nextCursor)).rejects.toMatchObject({code:'invalid_value'})
  })

  it('preserves PostgreSQL microseconds in default keyset cursors', async () => {
    const schema = await type(), ids = [randomUUID(), randomUUID(), randomUUID()]
    for (const [index, timestamp] of ['2026-01-01T00:00:00.123456Z', '2026-01-01T00:00:00.123455Z', '2026-01-01T00:00:00.123400Z'].entries()) {
      await queryWithRLS(userId, `INSERT INTO entity_instances(id,workspace_id,entity_type_id,data,created_by,last_edited_by,created_at)
        VALUES($1,$2,$3,$4,$5,$5,$6)`, [ids[index], workspaceId, schema.id, { title: { kind: 'text', value: `Precise record ${index}` } }, userId, timestamp])
    }
    const seen: string[] = []
    let cursor: string | undefined
    for (let index = 0; index < 5; index++) {
      const page = await store.queryEntities(workspaceId, schema.id, [], [], 1, cursor)
      seen.push(...page.rows.map(row => row.id)); cursor = page.nextCursor
      if (index === 0) expect(Buffer.from(cursor!, 'base64url').toString('utf8')).toContain('123456')
      if (!cursor) break
    }
    expect(seen).toEqual(ids)
  })

  function execution(actorUserId = userId) {
    const assertCurrent = async () => {
      const current = await queryWithRLS(actorUserId, 'SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId,actorUserId])
      if (!current.rows[0]) throw new ApplicationPlatformError('access_unavailable', 'Fixture member is no longer admitted.')
    }
    return createExecutionContext({ identity: { kind: 'attended', principal: { kind: 'workspace_member', userId: actorUserId } },
      ownership: { kind: 'workspace', workspaceId },
      access: { workspaceId, userId: actorUserId, assistantId, assistantKind: 'primary', clearance: 'confidential',
        compartments: null, mutationCompartments: null, projectIds: null, visibilityAssistantIds: null },
      writeDefaults: { compartments: [], projectIds: [] },
      authority: { assertCurrent, execute: async operation => { await assertCurrent(); return operation() } },
      lifecycle: { sessionId: randomUUID(), sessionPersisted: false, channelType: 'test', channelId: 'fixture', abortSignal: new AbortController().signal } })
  }
  function pairModule(key: string): ApplicationModuleDefinition<PoolClient> {
    const input = z.object({ entityTypeId: z.string().uuid(), title: z.string().min(1) }).strict()
    return { key, defaultState: 'enabled', application: { version: '1', dependencies: [], resources: [], queries: [], commands: ['create_pair'],
      events: [`${key}.created`], policyCapabilities: [], backgroundHandlers: [], uiContributions: [] }, queries: {},
    commands: { create_pair: { input, eventKey: `${key}.created`,
      authorize: async (context, raw) => {
        const data = input.parse(raw)
        const canonical = createDbDocEntityStore({ actorUserId: context.execution.security.access.userId, transaction: context.transaction })
        if (!await canonical.getEntityType(workspaceId,data.entityTypeId)) throw new ApplicationPlatformError('access_unavailable','Schema unavailable.')
      },
      execute: async (context, raw) => {
        const data = input.parse(raw), actorUserId = context.execution.security.access.userId
        const canonical = createDbDocEntityStore({ actorUserId, transaction: context.transaction })
        const resources = []
        for (const suffix of ['one','two']) {
          const record = await canonical.createEntity({ workspaceId,entityTypeId:data.entityTypeId,sourceApp:'api',createdBy:actorUserId,lastEditedBy:actorUserId,
            data:{title:{kind:'text',value:`${data.title} ${suffix}`}} })
          resources.push({ workspaceId,origin:{kind:'generic' as const,entityTypeId:data.entityTypeId},typeKey:'request',id:record.id,version:record.recordVersion! })
        }
        return resources
      },
      authorizeResult: async (context, resources) => {
        const canonical = createDbDocEntityStore({ actorUserId:context.execution.security.access.userId,transaction:context.transaction })
        for (const resource of resources) if (!await canonical.getEntity(workspaceId,resource.id)) {
          throw new ApplicationPlatformError('access_unavailable','Result unavailable.')
        }
      },
    } } }
  }
  it('previews and applies an actor-bound schema revision once without rewriting record IDs or values',async()=>{
    const schema=await type(),record=await create(schema.id,{title:{kind:'text',value:'Preserved'}}),service=new ApplicationPlatformService([]),context=execution()
    const preview=await service.previewSchema(context,schema.id,1,[title,{name:'quantity',config:{kind:'number'}}])
    expect(preview).toMatchObject({affectedRecords:1,invalidRecords:0,canApply:true})
    const applied=await service.applySchema(context,preview.id)
    expect(applied).toMatchObject({entityTypeId:schema.id,schemaVersion:2,applied:true})
    expect(await service.applySchema(context,preview.id)).toEqual(applied)
    expect((await store.getEntity(workspaceId,record.id))?.data).toEqual({title:{kind:'text',value:'Preserved'}})
    expect((await store.getEntityType(workspaceId,schema.id))?.schemaVersion).toBe(2)
  })
  it('refuses invalid, stale, substituted and directly rewritten schema reviews',async()=>{
    const schema=await type(),record=await create(schema.id,{title:{kind:'text',value:'Preserved'}}),service=new ApplicationPlatformService([]),context=execution()
    const invalid=await service.previewSchema(context,schema.id,1,[])
    expect(invalid).toMatchObject({invalidRecords:1,canApply:false})
    await expect(service.applySchema(context,invalid.id)).rejects.toMatchObject({code:'invalid_value'})
    const valid=await service.previewSchema(context,schema.id,1,[title,{name:'quantity',config:{kind:'number'}}])
    await expect(service.applySchema(execution(readerId),valid.id)).rejects.toMatchObject({code:'access_unavailable'})
    await expect(queryWithRLS(userId,"UPDATE application_schema_change_reviews SET proposed_properties='[]' WHERE id=$1",[valid.id])).rejects.toMatchObject({code:'22023'})
    await store.updateEntity(workspaceId,record.id,{data:{title:{kind:'text',value:'Changed'}},lastEditedBy:userId})
    await expect(service.applySchema(context,valid.id)).rejects.toMatchObject({code:'schema_version_conflict'})
    expect((await store.getEntityType(workspaceId,schema.id))?.schemaVersion).toBe(1)
  })
  it('commits two canonical writes, revisions, audit and event once under concurrent idempotent replay', async () => {
    const schema = await type(), moduleKey = 'fixture-pair', service = new ApplicationPlatformService([pairModule(moduleKey)])
    const context = execution(), command = { idempotencyKey:'same-command',input:{entityTypeId:schema.id,title:'Pair'} }
    const receipts = await Promise.all([service.command(context,moduleKey,'create_pair',command),service.command(context,moduleKey,'create_pair',command)])
    expect(receipts[0]).toEqual(receipts[1]); expect(receipts[0].resources).toHaveLength(2)
    expect((await owner.query('SELECT id FROM entity_instances WHERE entity_type_id=$1',[schema.id])).rows).toHaveLength(2)
    for (const table of ['application_operation_receipts','application_command_audit','application_committed_events']) {
      expect((await owner.query(`SELECT id FROM ${table} WHERE workspace_id=$1 AND module_key=$2`,[workspaceId,moduleKey])).rows).toHaveLength(1)
    }
    await expect(service.command(context,moduleKey,'create_pair',{...command,input:{entityTypeId:schema.id,title:'Different'}})).rejects.toMatchObject({code:'record_version_conflict'})
  })
  it('adapts native CRM and task writers without changing their canonical identities',async()=>{
    const service=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),context=execution()
    const company=await service.command(context,'native','create_company',{idempotencyKey:'canonical-company',input:{name:'Example Workshop',domain:'workshop.example'}})
    const id=company.resources[0].id
    expect((await owner.query("SELECT id,kind FROM entities WHERE id=$1 AND workspace_id=$2",[id,workspaceId])).rows).toEqual([{id,kind:'company'}])
    const projection=await service.query(context,'native','get',{type:'company',id}) as {ref:{id:string};values:{name:string}}
    expect(projection.ref.id).toBe(id);expect(projection.values.name).toBe('Example Workshop')
    const schema=await type([title,{name:'company',config:{kind:'relation',targetEntityTypeRef:{kind:'builtin',name:'company'}}}])
    expect((await create(schema.id,{title:{kind:'text',value:'Linked request'},company:{kind:'relation',value:id}})).data.company.value).toBe(id)
    const task=await service.command(context,'native','create_task',{idempotencyKey:'canonical-task',input:{title:'Review request'}})
    expect((await owner.query('SELECT title FROM tasks WHERE id=$1 AND workspace_id=$2',[task.resources[0].id,workspaceId])).rows[0].title).toBe('Review request')
  })
  it('uses the same generic module commands for native sessions with exact versions and canonical history', async () => {
    const schema = await type(), id = randomUUID(), service = new ApplicationPlatformService([createCanonicalGenericApplicationModule()]), context = execution()
    const typeKey = `record.${schema.id}`
    const created = await service.command(context, 'records', 'record_create', { idempotencyKey: randomUUID(), input: {
      operation: 'create', type: typeKey, id, data: { title: { kind: 'text', value: 'Native generic request' } },
    } })
    expect(created.resources[0]).toMatchObject({ id, version: '1' })
    const updated = await service.command(context, 'records', 'record_patch', { idempotencyKey: randomUUID(), input: {
      operation: 'patch', type: typeKey, id, expectedVersion: '1', data: { title: { kind: 'text', value: 'Native patched request' } },
    } })
    expect(updated.resources[0].version).toBe('2')
    const history = await service.query(context, 'records', 'history', { type: typeKey, id }) as Array<{ ref: { version: string } }>
    expect(history.map(item => item.ref.version)).toEqual(['2', '1'])
    const input = { operation: 'delete', type: typeKey, id, expectedVersion: '2' }, idempotencyKey = randomUUID()
    const deleted = await service.command(context, 'records', 'record_delete', { idempotencyKey, input })
    expect(deleted.resources[0].version).toBe('3')
    expect(await service.command(context, 'records', 'record_delete', { idempotencyKey, input })).toEqual(deleted)
  })
  it('uses envelope CAS for single edits and rejects conflicting or misplaced preconditions without effects', async () => {
    const schema = await type(), service = new ApplicationPlatformService([createCanonicalGenericApplicationModule()]), context = execution()
    const typeKey = `record.${schema.id}`, record = await create(schema.id, { title: { kind: 'text', value: 'Before' } })
    const input = { operation: 'patch', type: typeKey, id: record.id, data: { title: { kind: 'text', value: 'After' } } }
    await expect(service.command(context, 'records', 'record_patch', { idempotencyKey: randomUUID(), input })).rejects.toMatchObject({ code: 'invalid_value' })
    await expect(service.command(context, 'records', 'record_patch', { idempotencyKey: randomUUID(), expectedVersion: '1', input: { ...input, expectedVersion: '2' } })).rejects.toMatchObject({ code: 'record_version_conflict' })
    const receipt = await service.command(context, 'records', 'record_patch', { idempotencyKey: randomUUID(), expectedVersion: '1', input })
    expect(receipt.resources[0]).toMatchObject({ id: record.id, version: '2' })
    await expect(service.command(context, 'records', 'record_create', { idempotencyKey: randomUUID(), expectedVersion: '2', input: {
      operation: 'create', type: typeKey, data: { title: { kind: 'text', value: 'Refused' } },
    } })).rejects.toMatchObject({ code: 'invalid_value' })
    await expect(service.command(context, 'records', 'record_batch', { idempotencyKey: randomUUID(), expectedVersion: '2', input: {
      operations: [{ ...input, expectedVersion: '2' }],
    } })).rejects.toMatchObject({ code: 'invalid_value' })
    expect((await store.getEntity(workspaceId, record.id))?.recordVersion).toBe('2')
    const removed = await service.command(context, 'records', 'record_delete', { idempotencyKey: randomUUID(), expectedVersion: '2', input: {
      operation: 'delete', type: typeKey, id: record.id,
    } })
    expect(removed.resources[0].version).toBe('3')
    expect(await store.getEntity(workspaceId, record.id)).toBeNull()
  })
  it.each(['application_command_audit','application_committed_events'])('rolls back every command effect when %s fails',async table=>{
    const schema=await type(),moduleKey=table==='application_command_audit'?'fixture-audit-failure':'fixture-event-failure'
    const service=new ApplicationPlatformService([pairModule(moduleKey)])
    await owner.query(`ALTER TABLE ${table} ADD CONSTRAINT fixture_command_failure CHECK(module_key<>'${moduleKey}') NOT VALID`)
    try {
      await expect(service.command(execution(),moduleKey,'create_pair',{idempotencyKey:'failure',input:{entityTypeId:schema.id,title:'Refused'}})).rejects.toMatchObject({code:'invalid_value',effect:'none'})
      expect((await owner.query('SELECT id FROM entity_instances WHERE entity_type_id=$1',[schema.id])).rows).toHaveLength(0)
      expect((await owner.query('SELECT id FROM application_operation_receipts WHERE workspace_id=$1 AND module_key=$2',[workspaceId,moduleKey])).rows).toHaveLength(0)
    } finally { await owner.query(`ALTER TABLE ${table} DROP CONSTRAINT fixture_command_failure`) }
  })
  it('reauthorizes saved resource references on replay after current source access changes',async()=>{
    const schema=await type(),moduleKey='fixture-replay',service=new ApplicationPlatformService([pairModule(moduleKey)])
    const context=execution(readerId),command={idempotencyKey:'replay',input:{entityTypeId:schema.id,title:'Reader pair'}}
    const receipt=await service.command(context,moduleKey,'create_pair',command)
    await owner.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,readerId])
    try { await expect(service.command(context,moduleKey,'create_pair',command)).rejects.toMatchObject({code:'access_unavailable'}) }
    finally { await owner.query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,readerId]) }
    expect((await owner.query('SELECT id FROM entity_instances WHERE id=ANY($1::uuid[])',[receipt.resources.map(resource=>resource.id)])).rows).toHaveLength(2)
  })
})
