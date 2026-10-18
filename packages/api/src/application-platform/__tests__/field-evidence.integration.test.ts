import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { PoolClient } from 'pg'
import { ContextScopeAccumulator, boundScopeSources, scopeEvidenceFromRows, executionToolContext, NOOP_TURN_LEDGER,
  type ExecutionContext, type LLMProvider, type ScopeSource } from '@use-brian/core'
import type { ApplicationRecordProjection } from '@use-brian/shared'
import { getAppPool, getPool, applyRLSGucs } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { createMemory } from '../../db/memories.js'
import { readCurrentScopeSources, validateDerivedMemoryInputs } from '../../db/derived-scope-store.js'
import { findAssistantById } from '../../db/users.js'
import { validateCallerScopeEvidence } from '../../context-scope/caller-evidence.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { runAssistantTurn } from '../../turn/kernel.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
import { readApplicationFieldAncestors } from '../field-evidence.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-field-evidence] canonical field observations through real non-bypass readers', () => {
  const owner = getPool(), workspaceId = randomUUID(), ownerId = randomUUID(), memberId = randomUUID(), assistantId = randomUUID()
  const store = createDbDocEntityStore({ actorUserId: ownerId }), dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
  beforeAll(async () => {
    for (const id of [ownerId,memberId]) await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Field evidence fixture',$2,false)", [workspaceId,ownerId])
    for (const [id,role] of [[ownerId,'owner'],[memberId,'member']]) await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,'internal')", [workspaceId,id,role])
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Field fixture assistant',$2,$3,'primary','confidential')", [assistantId,ownerId,workspaceId])
  })
  afterAll(async () => {
    await owner.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ownerId,memberId]])
    await getAppPool().end(); await owner.end()
  })
  async function execution(userId = memberId) {
    return (await resolveExecutionContextSystem({ userId,workspaceId,assistant: (await findAssistantById(assistantId))!,memberMode: 'member',
      identity: { kind: 'attended',principal: { kind: 'workspace_member',userId,authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace',workspaceId },lifecycle: { sessionId: randomUUID(),sessionPersisted: false,
        channelId: 'field-fixture',channelType: 'test',abortSignal: new AbortController().signal } })).executionContext
  }
  async function asMember<T>(userId: string, operation: (client: PoolClient) => Promise<T>) {
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client,userId)
      const role = (await client.query("SELECT r.rolsuper,r.rolbypassrls,c.relowner=r.oid AS owns FROM pg_roles r,pg_class c WHERE r.rolname=current_user AND c.oid='entity_instances'::regclass")).rows[0]
      expect(role).toEqual({ rolsuper: false,rolbypassrls: false,owns: false })
      const value = await operation(client)
      await client.query('COMMIT'); return value
    } finally { await client.query('ROLLBACK'); client.release() }
  }
  async function record() {
    const schema = await store.createEntityType({ workspaceId,name: `Fictional field records ${randomUUID()}`,createdBy: ownerId,properties: [
      { name: 'title',config: { kind: 'text' } },{ name: 'cost',config: { kind: 'number',format: 'decimal' } },
    ] })
    const row = await store.createEntity({ workspaceId,entityTypeId: schema.id,sourceApp: 'api',createdBy: ownerId,lastEditedBy: ownerId,
      data: { title: { kind: 'text',value: 'Fictional title' },cost: { kind: 'number',value: 37.25 } } })
    return { schema,row,origin: { kind: 'generic',entityTypeId: schema.id },typeKey: `record.${schema.id}` }
  }
  async function capture(fixture: Awaited<ReturnType<typeof record>>, fields: string[], userId = memberId) {
    return asMember(userId,async client => (await client.query('SELECT observe_application_field_projection($1,$2,$3,$4,$5,$6,$7,$8) AS value',
      [workspaceId,fixture.origin,fixture.typeKey,fixture.row.id,fixture.row.recordVersion,'read',null,fields])).rows[0].value as { values: unknown; sources: ScopeSource[]; policyVersion: string })
  }
  async function snapshot(source: ScopeSource,userId = memberId) {
    return asMember(userId,async client => (await client.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',
      [workspaceId,source.resourceId,source.version])).rows[0].value)
  }
  it('captures distinct exact field sets as immutable metadata and keeps bindings out of JSON', async () => {
    const fixture = await record(), narrow = await capture(fixture,['title']), wide = await capture(fixture,['title','cost'])
    expect(narrow.values).toEqual({ title: { kind: 'text',value: 'Fictional title' } })
    expect(narrow.sources[0].resourceId).not.toBe(wide.sources[0].resourceId)
    const projection = await dispatcher.query(await execution(),'records','get',{ type: fixture.typeKey,id: fixture.row.id }) as ApplicationRecordProjection
    expect(boundScopeSources(projection)).toEqual(wide.sources)
    expect(boundScopeSources(structuredClone(projection))).toEqual([])
    expect(JSON.stringify(projection)).not.toContain('application_field')
    const metadata = (await owner.query('SELECT to_jsonb(o) AS metadata FROM application_field_observations o WHERE resource_id=$1', [narrow.sources[0].resourceId])).rows[0].metadata
    expect(metadata).not.toHaveProperty('values'); expect(JSON.stringify(metadata)).not.toContain('Fictional title')
    await expect(owner.query("UPDATE application_field_observations SET policy_version=repeat('0',64) WHERE resource_id=$1", [narrow.sources[0].resourceId])).rejects.toMatchObject({ code: '22023' })
    await asMember(memberId,async client => {
      expect((await client.query('SELECT * FROM application_field_observations')).rows).toEqual([])
      expect((await client.query("SELECT has_table_privilege('app_user','application_field_observations','INSERT') AS allowed")).rows[0].allowed).toBe(false)
    })
  })
  it('allows live native content edits for audience checks while exact-version derivation rejects the old input', async () => {
    const fixture = await record(), captured = await capture(fixture,['title']), source = captured.sources[0]
    await store.updateEntity(workspaceId,fixture.row.id,{ data: { title: { kind: 'text',value: 'Edited title' } },lastEditedBy: ownerId })
    expect(await snapshot(source)).toMatchObject({ held: false })
    await asMember(memberId,async client => {
      expect(await readCurrentScopeSources(client,workspaceId,[source])).toMatchObject([{ state: 'changed' }])
      await expect(validateDerivedMemoryInputs(client,{ producer: 'fixture',sources: [source] })).rejects.toMatchObject({ code: 'scope_source_changed' })
    })
    expect((await capture({ ...fixture,row: (await store.getEntity(workspaceId,fixture.row.id))! },['title'])).sources[0].resourceId).toBe(source.resourceId)
  })
  it('never gives a missing, forged or deleted field observation native gone semantics', async () => {
    const fixture = await record(), captured = await capture(fixture,['title']), source = captured.sources[0]
    expect(await snapshot({ ...source,version: 'forged' })).toBeNull()
    expect(await snapshot({ ...source,resourceId: randomUUID() })).toBeNull()
    await store.deleteEntity(workspaceId,fixture.row.id)
    expect(await snapshot(source)).toMatchObject({ held: true })
    await asMember(memberId,async client => {
      expect(await readCurrentScopeSources(client,workspaceId,[{ ...source,resourceId: randomUUID() }])).toMatchObject([{ state: 'unverifiable' }])
    })
  })
  it('invalidates a recorded field policy after a canonical schema constraint change', async () => {
    const fixture = await record(), captured = await capture(fixture,['title'])
    await store.updateEntityType(workspaceId,fixture.schema.id,{ properties: fixture.schema.properties.map(property =>
      property.name === 'title' ? { ...property,required: true } : property) },{ actorUserId: ownerId,expectedSchemaVersion: fixture.schema.schemaVersion })
    expect(await snapshot(captured.sources[0])).toMatchObject({ held: true })
    const fresh = await capture(fixture,['title'])
    expect(fresh.sources[0].resourceId).toBe(captured.sources[0].resourceId)
    expect(fresh.sources[0].version).not.toBe(captured.sources[0].version)
  })
  it('keeps original relationship targets after a later parent edit and refuses only the reader losing that target', async () => {
    const target = await record()
    const schema = await store.createEntityType({ workspaceId,name: 'Fictional linked records',createdBy: ownerId,
      properties: [{ name: 'parent',config: { kind: 'relation',targetEntityTypeRef: { kind: 'user_defined',entityTypeId: target.schema.id } } }] })
    const row = await store.createEntity({ workspaceId,entityTypeId: schema.id,sourceApp: 'api',createdBy: ownerId,lastEditedBy: ownerId,
      data: { parent: { kind: 'relation',value: target.row.id } } })
    const projected = await dispatcher.query(await execution(),'records','get',{ type: `record.${schema.id}`,id: row.id }) as ApplicationRecordProjection
    const sources = scopeEvidenceFromRows([projected]).sources!
    expect(sources).toHaveLength(2)
    await store.updateEntity(workspaceId,row.id,{ data: { parent: { kind: 'relation',value: null } },lastEditedBy: ownerId })
    expect(await snapshot(sources[0])).toMatchObject({ held: false })
    await owner.query("UPDATE entity_instances SET sensitivity='confidential' WHERE id=$1", [target.row.id])
    expect(await snapshot(sources[0])).toMatchObject({ held: true })
    expect(await snapshot(sources[0],ownerId)).toMatchObject({ held: false })
  })
  it('recovers field observations through a native descendant and refuses lineage deletion', async () => {
    const fixture = await record(), captured = await capture(fixture,['title'])
    const memory = await asMember(memberId,client => createMemory({ workspaceId,userId: memberId,assistantId,sensitivity: 'internal',createdByUserId: memberId,summary: 'Fictional field derivative',
      derivation: { producer: 'field-fixture',sources: captured.sources } },undefined,client))
    const source: ScopeSource = { workspaceId,userId: memory.userId,assistantId: memory.assistantId,sensitivity: memory.sensitivity,
      compartments: memory.compartments,projectIds: memory.projectIds,resourceKind: 'memory',resourceId: memory.id,version: memory.scopeVersion }
    expect(await readApplicationFieldAncestors(workspaceId,[source])).toEqual(captured.sources)
    await expect(validateCallerScopeEvidence({ sources: [source] },(await execution()).security.ceiling)).rejects.toMatchObject({ diagnostic: 'source_unverifiable' })
    await asMember(memberId,async client => expect((await validateCallerScopeEvidence({ sources: [source] },(await execution()).security.ceiling,client)).sources).toContainEqual(captured.sources[0]))
    await expect(owner.query('DELETE FROM scope_derivation_sources WHERE source_kind=$1 AND source_id=$2', ['application_field',captured.sources[0].resourceId])).rejects.toMatchObject({ code: '42501' })
  })
  it('requires the original independent target edge in the same committed derivation', async () => {
    const target = await record()
    const schema = await store.createEntityType({ workspaceId,name: 'Fictional derivation links',createdBy: ownerId,
      properties: [{ name: 'parent',config: { kind: 'relation',targetEntityTypeRef: { kind: 'user_defined',entityTypeId: target.schema.id } } }] })
    const row = await store.createEntity({ workspaceId,entityTypeId: schema.id,sourceApp: 'api',createdBy: ownerId,lastEditedBy: ownerId,
      data: { parent: { kind: 'relation',value: target.row.id } } })
    const projected = await dispatcher.query(await execution(),'records','get',{ type: `record.${schema.id}`,id: row.id })
    const sources = scopeEvidenceFromRows([projected]).sources!
    expect(sources).toHaveLength(2)
    const derive = (inputs: ScopeSource[]) => asMember(memberId,client => createMemory({ workspaceId,userId: memberId,assistantId,sensitivity: 'internal',createdByUserId: memberId,
      summary: 'Fictional linked field derivative',derivation: { producer: 'field-fixture',sources: inputs } },undefined,client))
    await expect(derive(sources.slice(0,1))).rejects.toThrow('scope_evidence_missing')
    await expect(derive(sources)).resolves.toBeDefined()
  })
  it('compares field label sets independently of source array ordering', async () => {
    const fixture = await record()
    for (const key of ['zeta','alpha']) await owner.query('INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,$2,$2)', [workspaceId,key])
    await owner.query('UPDATE entity_instances SET compartments=$2 WHERE id=$1', [fixture.row.id,['zeta','alpha']])
    const fresh = { ...fixture,row: (await store.getEntity(workspaceId,fixture.row.id))! }
    const captured = await capture(fresh,['title'],ownerId), source = captured.sources[0]
    const shuffled = { ...source,compartments: [...source.compartments].reverse() }
    const memory = await asMember(ownerId,client => createMemory({ workspaceId,userId: null,assistantId,sensitivity: 'internal',
      compartments: shuffled.compartments,createdByUserId: ownerId,summary: 'Fictional set-equivalent field derivative',
      derivation: { producer: 'field-fixture',sources: [shuffled] } },undefined,client))
    expect(memory.compartments).toEqual(['alpha','zeta'])
  })
  it('refuses the narrow lineage operation for an old payload or an owner connection', async () => {
    const fixture = await record(), captured = await capture(fixture,['title'])
    const memory = await asMember(memberId,client => createMemory({ workspaceId,userId: null,assistantId,sensitivity: 'internal',createdByUserId: memberId,
      summary: 'Fictional immutable output',derivation: { producer: 'field-fixture',sources: captured.sources } },undefined,client))
    const args = [workspaceId,'memory',memory.id,memory.scopeVersion,'field-fixture',JSON.stringify(captured.sources)]
    await expect(asMember(memberId,client => client.query('SELECT record_admitted_application_field_derivation($1,$2,$3,$4,$5,$6)',args)))
      .rejects.toMatchObject({ code: '42501' })
    const client = await owner.connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client,memberId)
      await expect(client.query('SELECT record_admitted_application_field_derivation($1,$2,$3,$4,$5,$6)',args)).rejects.toMatchObject({ code: '42501' })
    } finally { await client.query('ROLLBACK'); client.release() }
  })
  it('checks actual member field evidence before the shared kernel constructs a model session', async () => {
    const fixture = await record(), actor = await execution(), captured = await capture(fixture,['title'])
    const accumulator = new ContextScopeAccumulator({ sources: captured.sources })
    let sessions = 0,requests = 0
    const provider: LLMProvider = { name: 'fixture',models: ['fixture-model'],createSession: () => {
      sessions++
      return { send: () => (async function* () {
        requests++
        yield { type: 'message_start' as const,model: 'fixture-model' }
        yield { type: 'text_delta' as const,text: 'Fictional checked output' }
        yield { type: 'message_end' as const,stopReason: 'end_turn' as const,usage: { inputTokens: 1,outputTokens: 1 } }
      })() }
    },stream: () => { throw new Error('Unexpected fixture provider fallback') } }
    const run = (execution: ExecutionContext) => runAssistantTurn({ sessionId: execution.lifecycle.sessionId,policy: { admission: 'personal' },sink: { kind: 'return' },lease: { mode: 'none' },
      abortController: new AbortController(),model: { provider,model: 'fixture-model',configuredProviders: undefined,customLlm: null },
      loop: { ledger: NOOP_TURN_LEDGER,context: { ...executionToolContext(execution,{ appId: 'field-fixture' }),scopeAccumulator: accumulator },
        systemPrompt: 'Fictional field fixture',runtimeSystemContext: JSON.stringify(captured.values),
        messages: [{ role: 'user',content: 'Report the fictional value.' }],tools: new Map(),maxTurns: 1 } })
    await expect(run(actor)).resolves.toMatchObject({ selection: { kind: 'text' } })
    expect({ sessions,requests }).toEqual({ sessions: 1,requests: 1 })
    await owner.query("UPDATE entity_instances SET sensitivity='confidential' WHERE id=$1", [fixture.row.id])
    await expect(run(await execution())).rejects.toMatchObject({ retrySafe: false })
    expect({ sessions,requests }).toEqual({ sessions: 1,requests: 1 })
  })
})
