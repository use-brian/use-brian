import { randomUUID } from 'node:crypto'
import { setTimeout } from 'node:timers/promises'
import express from 'express'
import request from 'supertest'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { CrmConfigCommandSchema } from '@use-brian/core/application-platform/record-configuration.js'
import type { CrmIntegrationGrant } from '@use-brian/core/crm/integration-authority.js'
import { CrmOperationsCommandSchema, type CrmOperationsContext } from '@use-brian/core/crm/operations-types.js'
import { getPool, getAppPool } from '../client.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createCrmFieldDefinition, ensureCrmDefaultPipeline, getCrmConfig, applyCrmFieldPreset } from '../crm-r2.js'
import { crmIntegrationContext, crmIntegrationRoutes } from '../../routes/crm-integration.js'
import { crmOperationsRoutes } from '../../routes/crm-operations.js'
import { crmRoutes } from '../../routes/crm.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool(), appPool = getAppPool()
const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
const keys = createCrmIntegrationStore(pool, appPool)
const all: CrmIntegrationGrant[] = [{ operation: 'crm.catalog.configure', selectors: {
  definitionIds: 'all', purposeKeys: 'all', planIds: 'all', eventIds: 'all',
} }]
const field = (fieldKey = 'tier') => ({ kind: 'create_record_field', entityKind: 'person', fieldKey,
  label: 'Tier', fieldType: 'single_select', options: ['Standard', 'Plus'] })
async function fixture() {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Configuration fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId])
  const member: CrmOperationsContext = { workspaceId, actor: { kind: 'user', userId }, authority: {
    role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [],
  } }
  const credential = await keys.create(workspaceId, userId, { label: 'Configuration fixture', expiresAt: '2099-01-01T00:00:00Z', grants: all })
  const machine = crmIntegrationContext({ workspaceId, credentialId: credential.id, grants: all })
  const run = (command: unknown, context = member) => service.execute(context, CrmOperationsCommandSchema.parse(command))
  return { workspaceId, userId, member, machine, credential, run }
}
async function snapshot(workspaceId: string) {
  return Promise.all(['crm_field_definitions', 'crm_pipelines', 'crm_pipeline_stages', 'association_audit_log', 'workspace_audit_log'].map(async (table) =>
    (await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY id),'[]') AS rows FROM ${table} t WHERE workspace_id=$1`, [workspaceId])).rows[0].rows))
}
async function blockedBy(pid: number) {
  for (let attempt = 0; attempt < 200; attempt++) {
    const result = await pool.query(`SELECT pid FROM pg_stat_activity WHERE datname=current_database()
      AND $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'`, [pid])
    if (result.rows.length) return
    await setTimeout(10)
  }
  throw new Error('Configuration fixture never reached its intended lock wait')
}

describe('[COMP:crm/config-commands] Actual canonical configuration transactions', () => {
  afterAll(async () => { await Promise.all([...new Set([pool, appPool])].map((item) => item.end())) })

  it('creates and updates every resource with server-derived attribution, then makes zero writes for identical updates and archive repeats', async () => {
    const f = await fixture()
    const savedField = await f.run(field(), f.machine), fieldId = String(savedField.record.id)
    const savedPipeline = await f.run({ kind: 'create_pipeline', name: 'Memberships', isDefault: true }), pipelineId = String(savedPipeline.record.id)
    const savedStage = await f.run({ kind: 'create_pipeline_stage', pipelineId, name: 'Review', category: 'open', probability: 25 }), stageId = String(savedStage.record.id)
    expect(savedField.created && savedPipeline.created && savedStage.created).toBe(true)
    expect((await pool.query('SELECT created_by FROM crm_field_definitions WHERE id=$1', [fieldId])).rows[0].created_by).toBeNull()
    const commands = [
      { kind: 'update_record_field', fieldId, label: 'Level', options: ['Standard', 'Plus', 'Extra'], isRequired: true },
      { kind: 'update_pipeline', pipelineId, name: 'Members', isDefault: true },
      { kind: 'update_pipeline_stage', stageId, name: 'Approval', probability: 50, requiredFields: ['amount'] },
    ]
    for (const command of commands) expect((await f.run(command, f.machine)).duplicate).toBe(false)
    const before = await snapshot(f.workspaceId)
    for (const command of commands) expect((await f.run(command, f.machine)).duplicate).toBe(true)
    expect(await snapshot(f.workspaceId)).toEqual(before)
    const archive = { kind: 'set_record_field_archived', fieldId, archived: true }
    await f.run(archive)
    const archived = await snapshot(f.workspaceId)
    expect((await f.run(archive)).duplicate).toBe(true)
    expect(await snapshot(f.workspaceId)).toEqual(archived)
    await expect(f.run({ kind: 'update_record_field', fieldId, label: 'Changed' })).rejects.toMatchObject({ code: 'conflict' })
    await f.run({ ...archive, archived: false })
    await expect(f.run(field())).rejects.toMatchObject({ code: 'conflict', details: { reason: 'configuration_exists' } })
    const audit = (await pool.query('SELECT actor_kind,actor_credential_id FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])).rows
    expect(audit.filter((row) => row.actor_kind === 'integration_key')).toHaveLength(4)
    expect(audit.filter((row) => row.actor_kind === 'integration_key').every((row) => row.actor_credential_id === f.credential.id)).toBe(true)
    // Old member adapters did not bound individual option lengths. A label
    // edit must preserve legacy choices instead of forcing a schema rewrite.
    const legacyOptions = ['L'.repeat(240)]
    await pool.query('UPDATE crm_field_definitions SET options=$2 WHERE id=$1', [fieldId, JSON.stringify(legacyOptions)])
    expect((await f.run({ kind: 'update_record_field', fieldId, label: 'Legacy label' })).record.options).toEqual(legacyOptions)
  })

  it('rolls back domain and audit together and never owns a caller-supplied transaction', async () => {
    const f = await fixture(), client = await pool.connect()
    try {
      await client.query('BEGIN')
      const connect = vi.spyOn(pool, 'connect').mockImplementation(() => { throw new Error('Unexpected nested checkout') })
      const query = vi.spyOn(client, 'query')
      try {
        const composed = createCrmOperationsService(createDbCrmOperationsStore(pool, client))
        await composed.execute(f.member, CrmOperationsCommandSchema.parse(field()))
        expect(connect).not.toHaveBeenCalled()
        expect(query.mock.calls.some(([sql]) => /^(BEGIN|COMMIT|ROLLBACK)$/i.test(String(sql)))).toBe(false)
      } finally { connect.mockRestore(); query.mockRestore() }
      expect((await pool.query('SELECT count(*)::int AS n FROM crm_field_definitions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
      await client.query('ROLLBACK')
      expect((await pool.query('SELECT count(*)::int AS n FROM association_audit_log WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ')
      const staleSnapshot = createCrmOperationsService(createDbCrmOperationsStore(pool, client))
      await expect(staleSnapshot.execute(f.member, CrmOperationsCommandSchema.parse(field())))
        .rejects.toMatchObject({ code: 'invalid_input' })
      await client.query('ROLLBACK')
    } finally { await client.query('ROLLBACK'); client.release() }
    const name = `fixture_config_${randomUUID().replaceAll('-', '')}`
    await pool.query(`CREATE FUNCTION ${name}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture audit failure'; END $$`)
    try {
      await pool.query(`CREATE TRIGGER ${name} BEFORE INSERT ON association_audit_log FOR EACH ROW
        WHEN (NEW.workspace_id='${f.workspaceId}'::uuid) EXECUTE FUNCTION ${name}()`)
      const before = await snapshot(f.workspaceId)
      await expect(f.run(field())).rejects.toThrow('fixture audit failure')
      expect(await snapshot(f.workspaceId)).toEqual(before)
    } finally {
      await pool.query(`DROP TRIGGER IF EXISTS ${name} ON association_audit_log`)
      await pool.query(`DROP FUNCTION ${name}()`)
    }
  })

  it('serializes duplicate creation and the live-field cap across canonical and standalone entry points', async () => {
    const f = await fixture()
    const duplicates = await Promise.allSettled([f.run(field()), f.run(field())])
    expect(duplicates.filter((item) => item.status === 'fulfilled')).toHaveLength(1)
    expect(duplicates.filter((item) => item.status === 'rejected')).toHaveLength(1)
    await pool.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,position)
      SELECT $1,'person','fixture_'||n,'Fixture','text',n FROM generate_series(1,48) n`, [f.workspaceId])
    const pending = await Promise.allSettled([
      f.run(field('last_canonical')),
      createCrmFieldDefinition({ userId: f.userId, workspaceId: f.workspaceId, entityKind: 'person', fieldKey: 'last_helper', label: 'Last', fieldType: 'text' }),
    ])
    expect(pending.filter((item) => item.status === 'fulfilled' && item.value !== null)).toHaveLength(1)
    expect((await pool.query(`SELECT count(*)::int AS n FROM crm_field_definitions WHERE workspace_id=$1 AND archived_at IS NULL`, [f.workspaceId])).rows[0].n).toBe(50)
    const archivedId = (await pool.query(`SELECT id FROM crm_field_definitions WHERE workspace_id=$1 AND field_key='tier'`, [f.workspaceId])).rows[0].id
    await f.run({ kind: 'set_record_field_archived', fieldId: archivedId, archived: true })
    await f.run(field('replacement'))
    await expect(f.run({ kind: 'set_record_field_archived', fieldId: archivedId, archived: false })).rejects.toThrow('Custom field limit')
    const createPipelines = await Promise.all(Array.from({ length: 8 }, (_, n) => f.run({ kind: 'create_pipeline', name: `Pipeline ${n}` })))
    expect(createPipelines).toHaveLength(8)
    const positions = (await pool.query('SELECT position FROM crm_pipelines WHERE workspace_id=$1 ORDER BY position', [f.workspaceId])).rows.map((row) => row.position)
    expect(positions).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  it('keeps option use, default and live-deal archive barriers, including atomic stage restoration and changes', async () => {
    const f = await fixture(), fieldId = String((await f.run(field())).record.id)
    const pipelineId = String((await f.run({ kind: 'create_pipeline', name: 'Sales', isDefault: true })).record.id)
    const stageId = String((await f.run({ kind: 'create_pipeline_stage', pipelineId, name: 'Review', category: 'open', probability: 20 })).record.id)
    const entityId = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,source,created_by_user_id,attributes)
      VALUES($1,$2,'person','Fixture','manual',$3,$4)`, [entityId, f.workspaceId, f.userId, { custom_fields: { tier: 'Plus' } }])
    await expect(f.run({ kind: 'update_record_field', fieldId, label: 'Must roll back', options: ['Standard'] })).rejects.toThrow('used by 1 live record')
    expect((await pool.query('SELECT label FROM crm_field_definitions WHERE id=$1', [fieldId])).rows[0].label).toBe('Tier')
    await expect(f.run({ kind: 'update_pipeline', pipelineId, archived: true })).rejects.toThrow('default pipeline')
    await expect(f.run({ kind: 'update_pipeline', pipelineId, isDefault: false })).rejects.toThrow('another default')
    const dealId = randomUUID()
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,source,created_by_user_id,attributes)
      VALUES($1,$2,'deal','Fixture deal','manual',$3,$4)`, [dealId, f.workspaceId, f.userId, { pipeline_id: pipelineId, pipeline_stage_id: stageId }])
    const before = await snapshot(f.workspaceId)
    await expect(f.run({ kind: 'update_pipeline_stage', stageId, name: 'Must roll back', archived: true })).rejects.toThrow('Move 1 live deal')
    expect(await snapshot(f.workspaceId)).toEqual(before)
    await pool.query('DELETE FROM entities WHERE id=$1', [dealId])
    await f.run({ kind: 'update_pipeline_stage', stageId, archived: true })
    const restored = await f.run({ kind: 'update_pipeline_stage', stageId, archived: false, name: 'Restored', probability: 80 })
    expect(restored.record).toMatchObject({ archivedAt: null, name: 'Restored', probability: 80 })
  })

  it('requires every global selector and the current credential, refusing foreign ids without changes', async () => {
    const f = await fixture(), foreign = await fixture()
    const fieldId = String((await foreign.run(field())).record.id)
    const variants = [field(), { kind: 'update_record_field', fieldId, label: 'Denied' }, { kind: 'set_record_field_archived', fieldId, archived: true },
      { kind: 'create_pipeline', name: 'Denied' }, { kind: 'update_pipeline', pipelineId: fieldId, name: 'Denied' },
      { kind: 'create_pipeline_stage', pipelineId: fieldId, name: 'Denied', category: 'open', probability: 0 },
      { kind: 'update_pipeline_stage', stageId: fieldId, name: 'Denied' }]
    const narrow = await keys.create(f.workspaceId, f.userId, { label: 'Narrow fixture', expiresAt: '2099-01-01T00:00:00Z',
      grants: [{ operation: 'crm.catalog.configure', selectors: { eventIds: 'all' } }] })
    const exaggerated = crmIntegrationContext({ workspaceId: f.workspaceId, credentialId: narrow.id, grants: all })
    const before = await snapshot(f.workspaceId)
    for (const command of variants) await expect(f.run(command, exaggerated)).rejects.toMatchObject({ code: 'integration_scope_denied' })
    await expect(createDbCrmOperationsStore(pool).transaction(exaggerated, (tx) => tx.configureCatalog(CrmConfigCommandSchema.parse(field()))))
      .rejects.toMatchObject({ code: 'integration_scope_denied' })
    const unauthenticated = { ...f.machine, authority: { ...f.machine.authority, integration: undefined } }
    await expect(createDbCrmOperationsStore(pool).transaction(unauthenticated, (tx) => tx.configureCatalog(CrmConfigCommandSchema.parse(field()))))
      .rejects.toMatchObject({ code: 'not_authorized' })
    await expect(f.run({ kind: 'update_record_field', fieldId, label: 'Foreign' })).rejects.toMatchObject({ code: 'not_found' })
    await keys.revoke(f.workspaceId, f.userId, f.credential.id)
    const afterRevoke = await snapshot(f.workspaceId)
    for (const command of variants) await expect(f.run(command, f.machine)).rejects.toMatchObject({ code: 'credential_revoked' })
    expect(await snapshot(f.workspaceId)).toEqual(afterRevoke)
    expect(before.slice(0, 4)).toEqual(afterRevoke.slice(0, 4))
  })

  it('rechecks membership after waiting and preserves independent workspace progress', async () => {
    const f = await fixture(), other = await fixture(), locker = await pool.connect()
    let pending: Promise<unknown> | undefined
    try {
      await locker.query('BEGIN')
      await locker.query(`UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.userId])
      const pid = (await locker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid
      pending = f.run(field()).then((value) => value, (error) => error)
      await blockedBy(pid)
      expect((await other.run(field())).created).toBe(true)
      await locker.query('COMMIT')
      expect(await pending).toMatchObject({ code: 'not_authorized' })
      await expect(createCrmFieldDefinition({ userId: f.userId, workspaceId: f.workspaceId, entityKind: 'person', fieldKey: 'denied', label: 'Denied', fieldType: 'text' })).rejects.toMatchObject({ code: 'not_authorized' })
      expect((await pool.query('SELECT count(*)::int AS n FROM crm_field_definitions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(0)
    } finally { await locker.query('ROLLBACK'); locker.release(); await pending }
  })

  it('initializes a default without changing a custom Sales pipeline and serializes simultaneous initialization', async () => {
    const f = await fixture(), custom = await f.run({ kind: 'create_pipeline', name: 'Sales' })
    const defaults = await Promise.all([ensureCrmDefaultPipeline(f.workspaceId), ensureCrmDefaultPipeline(f.workspaceId)])
    expect(defaults[0]).toBe(defaults[1])
    expect(defaults[0]).not.toBe(custom.record.id)
    const config = await getCrmConfig(f.userId, f.workspaceId)
    expect(config.pipelines).toHaveLength(2)
    expect(config.pipelines.find((item) => item.id === custom.record.id)).toMatchObject({ name: 'Sales', position: 0, isDefault: false, stages: [] })
    expect(config.pipelines.find((item) => item.id === defaults[0])).toMatchObject({ name: 'Sales (default 1)', position: 1, isDefault: true })
    expect(config.pipelines.find((item) => item.id === defaults[0])?.stages).toHaveLength(6)
  })

  it('does not touch omitted pipelines when renaming the default or promote an archived stage through its parent', async () => {
    const f = await fixture(), first = await f.run({ kind: 'create_pipeline', name: 'Default', isDefault: true })
    const other = await f.run({ kind: 'create_pipeline', name: 'Other' })
    const otherId = String(other.record.id)
    const before = (await pool.query('SELECT to_jsonb(p) AS row FROM crm_pipelines p WHERE id=$1', [otherId])).rows[0].row
    await f.run({ kind: 'update_pipeline', pipelineId: first.record.id, name: 'Renamed', isDefault: true, archived: false })
    expect((await pool.query('SELECT to_jsonb(p) AS row FROM crm_pipelines p WHERE id=$1', [otherId])).rows[0].row).toEqual(before)
    const stages = await Promise.all(Array.from({ length: 5 }, (_, n) => f.run({ kind: 'create_pipeline_stage', pipelineId: otherId,
      name: `Stage ${n}`, category: 'open', probability: 0 })))
    expect((await pool.query('SELECT position FROM crm_pipeline_stages WHERE pipeline_id=$1 ORDER BY position', [otherId])).rows.map((row) => row.position)).toEqual([0, 1, 2, 3, 4])
    const stageId = stages[0].record.id
    await f.run({ kind: 'update_pipeline_stage', stageId, archived: true })
    await f.run({ kind: 'update_pipeline', pipelineId: otherId, archived: true })
    await expect(f.run({ kind: 'update_pipeline_stage', stageId, archived: false })).rejects.toThrow('parent pipeline')
    await f.run({ kind: 'create_pipeline', name: 'Collision' })
    const beforeConflict = await snapshot(f.workspaceId)
    await expect(f.run({ kind: 'update_pipeline', pipelineId: first.record.id, name: 'Collision' }))
      .rejects.toMatchObject({ code: 'conflict', details: { reason: 'configuration_conflict' } })
    expect(await snapshot(f.workspaceId)).toEqual(beforeConflict)
  })

  it('runs member settings, member commands, machine commands and preset creation through the same service', async () => {
    const f = await fixture(), app = express(), workspaceStore = createWorkspaceStore()
    app.use(express.json())
    app.use('/api/crm/integration', crmIntegrationRoutes({ credentials: keys, service,
      association: { execute: async () => { throw new Error('Unexpected commerce command') } } }))
    app.use((req, _res, next) => { req.userId = f.userId; next() })
    app.use('/api/crm', crmOperationsRoutes({ workspaceStore, service, readStore: createDbCrmIntakeReadStore() }))
    app.use('/api/crm', crmRoutes({ workspaceStore, crmOperationsService: service }))
    const created = await request(app).post(`/api/crm/${f.workspaceId}/pipelines`).send({ name: 'HTTP fixture' })
    expect(created.status).toBe(201)
    const pipelineId = created.body.id
    const stage = await request(app).post(`/api/crm/${f.workspaceId}/pipelines/${pipelineId}/stages`).send({ name: 'Review', category: 'open', probability: 10 })
    expect(stage.status).toBe(201)
    expect((await request(app).patch(`/api/crm/${f.workspaceId}/stages/${stage.body.id}`).send({ probability: 30 })).body.probability).toBe(30)
    const generic = await request(app).post(`/api/crm/${f.workspaceId}/operations/commands`).send(field())
    expect(generic.status).toBe(201)
    const machine = await request(app).post('/api/crm/integration/operations/commands').set('Authorization', `Bearer ${f.credential.oneTimeSecret}`)
      .send({ kind: 'update_record_field', fieldId: generic.body.record.id, label: 'HTTP update' })
    expect(machine.status).toBe(200)
    const preset = await applyCrmFieldPreset({ userId: f.userId, workspaceId: f.workspaceId, presetId: 'services_saas', execute: (command) => f.run(command) })
    expect(preset.created.length).toBeGreaterThan(0)
    expect(preset.conflicts).toEqual([])
    const before = await snapshot(f.workspaceId)
    const repeated = await applyCrmFieldPreset({ userId: f.userId, workspaceId: f.workspaceId, presetId: 'services_saas', execute: (command) => f.run(command) })
    expect(repeated.created).toEqual([])
    expect(await snapshot(f.workspaceId)).toEqual(before)
  })
})
