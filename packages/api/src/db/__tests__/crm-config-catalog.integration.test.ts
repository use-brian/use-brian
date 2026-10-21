import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CrmOperationsCommandSchema, type AssociationServicePort, type CrmIntegrationGrant, type CrmOperationsServicePort } from '@use-brian/core'
import { getAppPool, getPool } from '../client.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createCrmIntegrationRecordReadStore } from '../crm-integration-records.js'
import { crmIntegrationRoutes } from '../../routes/crm-integration.js'
import { crmOperationsRoutes } from '../../routes/crm-operations.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool()
const keys = createCrmIntegrationStore(pool, appPool)
const catalogGrants: CrmIntegrationGrant[] = [
  { operation: 'crm.records.read', selectors: {} },
  { operation: 'crm.catalog.read', selectors: { definitionIds: 'all', purposeKeys: 'all', planIds: 'all', eventIds: 'all' } },
  { operation: 'crm.consent.read', selectors: { purposeKeys: 'all' } },
  { operation: 'crm.entitlements.read', selectors: { planIds: 'all' } },
  { operation: 'crm.participation.read', selectors: { eventIds: 'all' } },
]

async function fixture(grants: CrmIntegrationGrant[] = [{ operation: 'crm.records.read', selectors: {} }]) {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Catalog fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId])
  const credential = await keys.create(workspaceId, userId, { label: 'Catalog fixture', expiresAt: '2099-01-01T00:00:00Z', grants })
  const execute = vi.fn(async () => { throw new Error('Catalog discovery must not execute a command') })
  const service: CrmOperationsServicePort = { execute }
  const association: AssociationServicePort = { execute }
  const app = express()
  app.use(express.json())
  app.use('/api/crm/integration', crmIntegrationRoutes({ credentials: keys, service, association }))
  // Simulate only the upstream member JWT identity. Membership is read from
  // the actual app-role database by the production workspace store.
  app.use((req, _res, next) => { req.userId = userId; next() })
  app.use('/api/crm', crmOperationsRoutes({ workspaceStore: createWorkspaceStore(), service, readStore: createDbCrmIntakeReadStore() }))
  const get = (path: string, machine = true) => request(app).get(machine
    ? `/api/crm/integration${path}` : `/api/crm/${workspaceId}${path}`)
    .set('Authorization', `Bearer ${credential.oneTimeSecret}`)
  return { app, workspaceId, userId, credential, execute, get }
}

async function snapshot(workspaceId: string) {
  const tables = ['crm_pipelines', 'crm_pipeline_stages', 'crm_field_definitions', 'crm_segments',
    'crm_consent_purposes', 'crm_consent_purpose_versions', 'association_membership_plans', 'association_events',
    'crm_intake_definitions', 'crm_intake_definition_versions', 'association_audit_log', 'workspace_audit_log']
  return Promise.all(tables.map(async (table) => (await pool.query(
    `SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') AS rows FROM ${table} t WHERE workspace_id=$1`, [workspaceId],
  )).rows[0].rows))
}

async function collect(f: Awaited<ReturnType<typeof fixture>>, path: string, key: string, machine: boolean,
  filters: { includeArchived?: 'true' | 'false'; entityKind?: 'person' | 'company' | 'deal' } = {}) {
  const rows: Array<Record<string, unknown>> = [], cursors = new Set<string>()
  let cursor: string | null = null
  do {
    const response = await f.get(`/operations/${path}`, machine).query({ ...filters, limit: 17, ...(cursor ? { cursor } : {}) })
    expect(response.status).toBe(200)
    expect(Array.isArray(response.body[key])).toBe(true)
    rows.push(...response.body[key])
    cursor = response.body.nextCursor
    expect(cursor === null || typeof cursor === 'string').toBe(true)
    if (cursor) { expect(cursors.has(cursor)).toBe(false); cursors.add(cursor) }
    expect(cursors.size).toBeLessThan(20)
  } while (cursor)
  expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length)
  return rows
}

describe('[COMP:api/crm-config-catalog] Pure member and integration configuration discovery', () => {
  afterAll(async () => { await Promise.all([...new Set([pool, appPool])].map((item) => item.end())) })

  it('leaves an empty workspace without a default pipeline, fields or new audit while exposing the actual credential destination', async () => {
    const f = await fixture(), before = await snapshot(f.workspaceId)
    const discovery = await f.get('/catalog')
    expect(discovery.status).toBe(200)
    expect(discovery.headers['cache-control']).toBe('no-store')
    expect(discovery.body).toMatchObject({ workspaceId: f.workspaceId, credentialId: f.credential.id })
    expect(JSON.stringify(discovery.body)).not.toMatch(/oneTimeSecret|secretHash|sk_crm_/)
    for (const machine of [false, true]) {
      for (const [path, key] of [['record-fields', 'fields'], ['pipelines', 'pipelines']]) {
        const response = await f.get(`/operations/${path}`, machine)
        expect(response.status).toBe(200)
        expect(response.body).toEqual({ [key]: [], nextCursor: null })
      }
    }
    expect(await snapshot(f.workspaceId)).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('returns all pages with the same workspace, archive and entity-kind selection for both authentication modes', async () => {
    const f = await fixture(), foreign = await fixture()
    for (const workspaceId of [f.workspaceId, foreign.workspaceId]) {
      await pool.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,position,archived_at)
        SELECT $1,CASE n%3 WHEN 0 THEN 'person' WHEN 1 THEN 'company' ELSE 'deal' END,
          'fixture_'||n,'Fixture '||n,'text',n,CASE WHEN n<=6 THEN now() END FROM generate_series(1,126) n`, [workspaceId])
      await pool.query(`INSERT INTO crm_pipelines(workspace_id,name,position,archived_at)
        SELECT $1,'Fixture '||n,n,CASE WHEN n=106 THEN now() END FROM generate_series(1,106) n`, [workspaceId])
    }
    // The production cursor sorts createdAt/id descending. Choose its last
    // live parent so the archive assertion must traverse beyond two pages.
    const pipelineId = (await pool.query(`SELECT id FROM crm_pipelines WHERE workspace_id=$1 AND archived_at IS NULL ORDER BY created_at ASC,id ASC LIMIT 1`, [f.workspaceId])).rows[0].id
    await pool.query(`INSERT INTO crm_pipeline_stages(workspace_id,pipeline_id,name,category,position,archived_at)
      VALUES($1,$2,'Live','open',0,NULL),($1,$2,'Archived','won',1,now())`, [f.workspaceId, pipelineId])
    const before = await snapshot(f.workspaceId)
    const memberFields = await collect(f, 'record-fields', 'fields', false)
    const machineFields = await collect(f, 'record-fields', 'fields', true)
    expect(machineFields).toHaveLength(120)
    expect(machineFields).toEqual(memberFields)
    const memberPipelines = await collect(f, 'pipelines', 'pipelines', false)
    const machinePipelines = await collect(f, 'pipelines', 'pipelines', true)
    expect(machinePipelines).toHaveLength(105)
    expect(machinePipelines).toEqual(memberPipelines)
    expect(machinePipelines.find((row) => row.id === pipelineId)?.stages).toEqual([expect.objectContaining({ name: 'Live' })])
    for (const machine of [false, true]) {
      const fields = await f.get('/operations/record-fields', machine).query({ entityKind: 'person', includeArchived: 'true' })
      expect(fields.status).toBe(200)
      expect(fields.body.fields).toHaveLength(42)
      expect(fields.body.fields.every((field: { entityKind: string }) => field.entityKind === 'person')).toBe(true)
      expect(fields.body.fields.filter((field: { archivedAt: string | null }) => field.archivedAt !== null)).toHaveLength(2)
      const all = await collect(f, 'pipelines', 'pipelines', machine, { includeArchived: 'true' })
      expect(all).toHaveLength(106)
      // Explicit archive selection includes both stages even on a late page.
      expect(all.findIndex((row) => row.id === pipelineId)).toBeGreaterThanOrEqual(100)
      expect(all.find((row) => row.id === pipelineId)?.stages).toHaveLength(2)
    }
    const principal = await keys.authenticate(f.credential.oneTimeSecret)
    expect(principal).not.toBeNull()
    const direct = await createCrmIntegrationRecordReadStore(principal!, pool).fields({ entityKind: 'person', includeArchived: 'true' })
    expect(direct.fields).toHaveLength(42)
    expect(await snapshot(f.workspaceId)).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('binds cursors to the workspace, resource and archive/entity filters', async () => {
    const f = await fixture(), other = await fixture()
    await pool.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,position)
      SELECT $1,'person','fixture_'||n,'Fixture','text',n FROM generate_series(1,3) n`, [f.workspaceId])
    const first = await f.get('/operations/record-fields').query({ limit: 1 })
    expect(first.status).toBe(200)
    const cursor = first.body.nextCursor
    expect(cursor).toBeTypeOf('string')
    for (const machine of [false, true]) {
      // The compatibility integration adapter maps domain invalid_input to
      // 422; member operations retain 400. Both must reject the bound cursor.
      const status = machine ? 422 : 400
      for (const query of [{ cursor, includeArchived: 'true' }, { cursor, entityKind: 'company' }]) {
        const rejected = await f.get('/operations/record-fields', machine).query(query)
        expect(rejected.status).toBe(status)
        expect(rejected.body.error).toBe('invalid_input')
      }
      expect((await f.get('/operations/pipelines', machine).query({ cursor })).status).toBe(status)
      expect((await other.get('/operations/record-fields', machine).query({ cursor })).status).toBe(status)
    }
  })

  it('rejects absent read grants, revoked keys and foreign membership without executing a command', async () => {
    const f = await fixture([{ operation: 'crm.catalog.configure', selectors: { eventIds: 'all' } }])
    for (const path of ['record-fields', 'pipelines']) {
      const denied = await f.get(`/operations/${path}`)
      expect(denied.status).toBe(403)
      expect(denied.body.error).toBe('integration_scope_denied')
    }
    const other = await fixture()
    expect((await request(f.app).get(`/api/crm/${other.workspaceId}/operations/record-fields`)).status).toBe(404)
    await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [f.workspaceId, f.userId])
    expect((await f.get('/operations/record-fields', false)).status).toBe(404)
    await keys.revoke(other.workspaceId, other.userId, other.credential.id)
    expect((await other.get('/operations/pipelines')).status).toBe(401)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('refuses unsupported filters and malformed page queries in both adapters', async () => {
    const f = await fixture(), before = await snapshot(f.workspaceId)
    for (const machine of [false, true]) {
      for (const path of ['record-fields', 'pipelines', 'segments']) {
        for (const query of [{ entityKind: 'unsupported' }, { includeArchived: 'yes' }, { limit: 0 }, { workspaceId: randomUUID() }]) {
          expect((await f.get(`/operations/${path}`, machine).query(query)).status).toBe(400)
        }
      }
    }
    expect(await snapshot(f.workspaceId)).toEqual(before)
    expect(f.execute).not.toHaveBeenCalled()
  })

  it('discovers every segment page with member parity and requires every global derived-catalog grant', async () => {
    const grants = catalogGrants
    const f = await fixture(grants), foreign = await fixture(grants)
    const predicate = JSON.stringify({ type: 'group', combinator: 'and', items: [
      { type: 'rule', family: 'base', field: 'name', operator: 'is_not_empty' },
    ] })
    for (const workspaceId of [f.workspaceId, foreign.workspaceId]) {
      await pool.query(`INSERT INTO crm_segments(workspace_id,segment_key,name,entity_kind,predicate,archived_at)
        SELECT $1,'fixture_'||n,'Fixture '||n,CASE WHEN n=122 THEN 'company' ELSE 'person' END,$2::jsonb,
          CASE WHEN n=121 THEN now() END FROM generate_series(1,122) n`, [workspaceId, predicate])
    }
    const before = await snapshot(f.workspaceId)
    const machine = await collect(f, 'segments', 'segments', true)
    expect(machine).toHaveLength(120)
    expect(machine).toEqual(await collect(f, 'segments', 'segments', false))
    for (const machineMode of [true, false]) {
      const archived = await f.get('/operations/segments', machineMode).query({ includeArchived: 'true', limit: 100 })
      expect(archived.status).toBe(200)
      expect(archived.body.catalog).toContainEqual(expect.objectContaining({ family: 'base', field: 'name' }))
      const second = await f.get('/operations/segments', machineMode).query({ includeArchived: 'true', limit: 100, cursor: archived.body.nextCursor })
      expect([...archived.body.segments, ...second.body.segments]).toHaveLength(121)
      expect(second.body.nextCursor).toBeNull()
      const company = await f.get('/operations/segments', machineMode).query({ entityKind: 'company' })
      expect(company.status).toBe(200)
      expect(company.body.segments).toHaveLength(1)
      const invalidCursor = await f.get('/operations/segments', machineMode).query({ entityKind: 'company', cursor: archived.body.nextCursor })
      expect(invalidCursor.status).toBe(machineMode ? 422 : 400)
    }
    expect(await snapshot(f.workspaceId)).toEqual(before)
    for (const grant of grants) {
      const denied = await keys.create(f.workspaceId, f.userId, { label: 'Limited fixture', expiresAt: '2099-01-01T00:00:00Z',
        grants: grants.filter((item) => item.operation !== grant.operation) })
      const deniedBefore = await snapshot(f.workspaceId)
      const response = await request(f.app).get('/api/crm/integration/operations/segments')
        .set('Authorization', `Bearer ${denied.oneTimeSecret}`)
      expect(response.status).toBe(403)
      expect(response.body.error).toBe('integration_scope_denied')
      expect(response.body).not.toHaveProperty('catalog')
      expect(await snapshot(f.workspaceId)).toEqual(deniedBefore)
    }
    const narrowed = await keys.create(f.workspaceId, f.userId, { label: 'Narrow fixture', expiresAt: '2099-01-01T00:00:00Z',
      grants: grants.map((item) => item.operation === 'crm.catalog.read' ? { ...item, selectors: { purposeKeys: 'all', planIds: 'all', eventIds: 'all' } } : item) })
    const narrowedBefore = await snapshot(f.workspaceId)
    expect((await request(f.app).get('/api/crm/integration/operations/segments')
      .set('Authorization', `Bearer ${narrowed.oneTimeSecret}`)).status).toBe(403)
    expect(await snapshot(f.workspaceId)).toEqual(narrowedBefore)
    expect(f.execute).not.toHaveBeenCalled()
    await keys.revoke(f.workspaceId, f.userId, f.credential.id)
    expect((await f.get('/operations/segments')).status).toBe(401)
  })

  it('runs the manifest discovery client against real member and integration HTTP without seeding configuration', async () => {
    const { createManifestClient, discoverManifestCatalogs } = await import(new URL('../../../../../scripts/crm/manifest-client.mjs', import.meta.url).href)
    const manifest = JSON.parse(readFileSync(new URL('../../../../../scripts/crm/fixtures/community-manifest.v1.json', import.meta.url), 'utf8'))
    const f = await fixture(catalogGrants)
    const server = f.app.listen(0, '127.0.0.1')
    await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
    const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const before = await snapshot(f.workspaceId)
    try {
      for (const mode of ['member', 'integration']) {
        const client = createManifestClient({ apiUrl, workspaceId: f.workspaceId, mode,
          token: mode === 'member' ? 'synthetic_member_fixture' : f.credential.oneTimeSecret, pageSize: 7 })
        const empty = await discoverManifestCatalogs(client, manifest)
        for (const resource of empty.loaded) expect(empty[resource]).toEqual([])
        expect(empty.loaded).toHaveLength(7)
        expect(await snapshot(f.workspaceId)).toEqual(before)
      }
      await pool.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,position)
        SELECT $1,'person','fixture_'||n,'Fixture','text',n FROM generate_series(1,23) n`, [f.workspaceId])
      const populated = await snapshot(f.workspaceId)
      const client = createManifestClient({ apiUrl, workspaceId: f.workspaceId, mode: 'integration', token: f.credential.oneTimeSecret, pageSize: 7 })
      expect((await discoverManifestCatalogs(client, manifest)).recordFields).toHaveLength(23)
      expect(await snapshot(f.workspaceId)).toEqual(populated)
      // Seed through real canonical commands, then verify that discovery can
      // consume every populated resource shape, including nested stages and
      // flattened intake definition versions. This is fixture setup, not a
      // manifest apply implementation or a preview mutation.
      const commands = createCrmOperationsService(createDbCrmOperationsStore(pool))
      const run = (command: unknown) => commands.execute({ workspaceId: f.workspaceId,
        actor: { kind: 'user', userId: f.userId }, authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] },
      }, CrmOperationsCommandSchema.parse(command))
      for (const item of manifest.recordFields) await run({ kind: 'create_record_field', ...item.value })
      const pipelineIds = new Map<string, string>()
      for (const item of manifest.pipelines) pipelineIds.set(item.ref, String((await run({ kind: 'create_pipeline', ...item.value })).record.id))
      for (const item of manifest.pipelineStages) await run({ kind: 'create_pipeline_stage', pipelineId: pipelineIds.get(item.pipelineRef), ...item.value })
      for (const [resource, kind] of [['consentPurposes', 'save_consent_purpose'], ['entitlementPlans', 'save_entitlement_plan'],
        ['events', 'save_event'], ['intakeDefinitions', 'save_intake_definition'], ['segments', 'save_segment']]) {
        for (const item of manifest[resource]) await run({ kind, ...item.value })
      }
      const completeBefore = await snapshot(f.workspaceId)
      const complete = await discoverManifestCatalogs(client, manifest)
      expect(complete.recordFields).toHaveLength(24)
      for (const resource of ['pipelines', 'consentPurposes', 'entitlementPlans', 'events', 'intakeDefinitions', 'segments']) expect(complete[resource]).toHaveLength(1)
      expect(complete.pipelines[0].stages).toHaveLength(2)
      expect(await snapshot(f.workspaceId)).toEqual(completeBefore)
      await expect(discoverManifestCatalogs(createManifestClient({ apiUrl, workspaceId: randomUUID(), mode: 'integration', token: f.credential.oneTimeSecret }), manifest))
        .rejects.toMatchObject({ code: 'workspace_mismatch' })
      expect(f.execute).not.toHaveBeenCalled()
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    }
  })
})
