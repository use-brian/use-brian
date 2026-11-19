import { randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'
import type { Server } from 'node:http'
import express from 'express'
import { afterAll, describe, expect, it } from 'vitest'
import type { CrmIntegrationGrant } from '@use-brian/core/crm/integration-authority.js'
import { CrmOperationsCommandSchema } from '@use-brian/core/crm/operations-types.js'
import { getPool, getAppPool } from '../client.js'
import { createCrmIntegrationStore } from '../crm-integration-store.js'
import { createDbCrmIntakeReadStore } from '../crm-intake-store.js'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'
import { createCrmOperationsService } from '../../crm-operations/service.js'
import { createWorkspaceStore } from '../workspace-store.js'
import { crmIntegrationRoutes } from '../../routes/crm-integration.js'
import { crmOperationsRoutes } from '../../routes/crm-operations.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const { createManifestClient, discoverManifestCatalogs } = await import(new URL('../../../../../scripts/crm/manifest-client.mjs', import.meta.url).href)
const { runManifest } = await import(new URL('../../../../../scripts/crm/manifest-runner.mjs', import.meta.url).href)
const fixturePath = fileURLToPath(new URL('../../../../../scripts/crm/fixtures/community-manifest.v1.json', import.meta.url))
const cliPath = fileURLToPath(new URL('../../../../../scripts/crm/apply-manifest.mjs', import.meta.url))
const input = () => JSON.parse(readFileSync(fixturePath, 'utf8'))
const pool = getPool(), appPool = getAppPool(), servers: Server[] = []
const keys = createCrmIntegrationStore(pool, appPool)
const service = createCrmOperationsService(createDbCrmOperationsStore(pool))
const grants: CrmIntegrationGrant[] = [
  { operation: 'crm.records.read', selectors: {} },
  { operation: 'crm.records.write', selectors: {} },
  { operation: 'crm.catalog.read', selectors: { definitionIds: 'all', purposeKeys: 'all', planIds: 'all', eventIds: 'all' } },
  { operation: 'crm.catalog.configure', selectors: { definitionIds: 'all', purposeKeys: 'all', planIds: 'all', eventIds: 'all' } },
  { operation: 'crm.consent.read', selectors: { purposeKeys: 'all' } },
  { operation: 'crm.entitlements.read', selectors: { planIds: 'all' } },
  { operation: 'crm.participation.read', selectors: { eventIds: 'all' } },
]
async function fixture(selected = grants, gate?: (req: express.Request, res: express.Response) => Promise<boolean>) {
  const workspaceId = randomUUID(), userId = randomUUID()
  await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [userId])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Manifest fixture',$2)`, [workspaceId, userId])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')`, [workspaceId, userId])
  const key = await keys.create(workspaceId, userId, { label: 'Manifest fixture', expiresAt: '2099-01-01T00:00:00Z', grants: selected })
  const app = express(); app.use(express.json())
  if (gate) app.use(async (req, res, next) => { if (!await gate(req, res)) next() })
  app.use('/api/crm/integration', crmIntegrationRoutes({ credentials: keys, service,}))
  app.use((req, _res, next) => { req.userId = userId; next() })
  app.use('/api/crm', crmOperationsRoutes({ workspaceStore: createWorkspaceStore(), service, readStore: createDbCrmIntakeReadStore() }))
  const server = app.listen(0, '127.0.0.1'); servers.push(server)
  await new Promise<void>((resolve, reject) => { server.once('listening', resolve); server.once('error', reject) })
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`
  const client = (mode = 'integration', fetchImpl = fetch) => createManifestClient({ apiUrl, workspaceId, mode,
    token: mode === 'integration' ? key.oneTimeSecret : 'synthetic_member_fixture', fetchImpl })
  const run = (command: unknown) => service.execute({ workspaceId, actor: { kind: 'user', userId },
    authority: { role: 'owner', canWrite: true, canConfigure: true, trustedIdentitySources: [] },
  }, CrmOperationsCommandSchema.parse(command))
  return { workspaceId, userId, key, client, run, apiUrl }
}
async function snapshot(workspaceId: string) {
  return Promise.all(['crm_field_definitions', 'crm_pipelines', 'crm_pipeline_stages', 'crm_consent_purposes',
    'crm_consent_purpose_versions', 'association_membership_plans', 'association_events', 'crm_intake_definitions',
    'crm_intake_definition_versions', 'crm_segments', 'association_audit_log', 'workspace_audit_log', 'workspace_modules']
    .map(async (table) => (await pool.query(`SELECT coalesce(jsonb_agg(to_jsonb(t) ORDER BY to_jsonb(t)::text),'[]') AS rows FROM ${table} t WHERE workspace_id=$1`, [workspaceId])).rows[0].rows))
}
function cli(f: Awaited<ReturnType<typeof fixture>>, apply = false) {
  const child = spawn(process.execPath, [cliPath, '--manifest', fixturePath, '--api-url', f.apiUrl, '--workspace', f.workspaceId,
    '--mode', 'integration', '--token-env', 'CRM_MANIFEST_FIXTURE', ...(apply ? ['--apply'] : [])], {
    env: { PATH: process.env.PATH, CRM_MANIFEST_FIXTURE: f.key.oneTimeSecret }, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = '', stderr = ''
  child.stdout.on('data', (chunk) => { stdout += chunk }); child.stderr.on('data', (chunk) => { stderr += chunk })
  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }))
  })
  return { child, done }
}

describe('[COMP:crm/manifest] Actual manifest preview, apply and recovery', () => {
  afterAll(async () => {
    await Promise.all(servers.map((server) => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()) })))
    await Promise.all([...new Set([pool, appPool])].map((item) => item.end()))
  })

  it('applies every resource in both modes, preserves omitted values and makes zero commands/versions/audit on reapply', async () => {
    for (const mode of ['member', 'integration']) {
      const f = await fixture(), manifest = input(), before = await snapshot(f.workspaceId)
      const preview = await runManifest(f.client(mode), manifest)
      expect(preview).toMatchObject({ status: 'preview', commandsIssued: 0 })
      expect(preview.changes).toHaveLength(9)
      expect(await snapshot(f.workspaceId)).toEqual(before)
      const first = await runManifest(f.client(mode), manifest, { apply: true })
      expect(first, JSON.stringify({ error: first.error, residual: first.residual, failed: first.failed })).toMatchObject({ status: 'applied', commandsIssued: 9, residual: [] })
      expect(first.completed).toHaveLength(9)
      const initial = await snapshot(f.workspaceId)
      expect(await runManifest(f.client(mode), manifest, { apply: true })).toMatchObject({ status: 'applied', commandsIssued: 0, changes: [], residual: [] })
      expect(await snapshot(f.workspaceId)).toEqual(initial)
      const catalog = await discoverManifestCatalogs(f.client(mode), manifest)
      manifest.recordFields[0].value.label = 'Topics'
      manifest.pipelines[0].id = catalog.pipelines[0].id; manifest.pipelines[0].value.name = 'Applications'
      manifest.pipelineStages[0].id = catalog.pipelines[0].stages.find((stage: { name: string }) => stage.name === 'Review').id
      manifest.pipelineStages[0].value.name = 'Assess'
      manifest.consentPurposes[0].value.label = 'Updates'
      manifest.entitlementPlans[0].value.name = 'Community access'
      manifest.events[0].value.title = 'Orientation session'; delete manifest.events[0].value.venue
      manifest.intakeDefinitions[0].value.label = 'Apply to join'
      manifest.segments[0].value.name = 'People with interests'
      manifest.segments[0].value.predicate.items = [{ type: 'rule', family: 'custom', field: 'interests', operator: 'contains', value: 'Learning' }]
      await pool.query(`UPDATE association_membership_plans SET eligibility_note='Existing fixture note' WHERE workspace_id=$1`, [f.workspaceId])
      const updated = await runManifest(f.client(mode), manifest, { apply: true })
      expect(updated, JSON.stringify({ error: updated.error, residual: updated.residual, failed: updated.failed })).toMatchObject({ status: 'applied', commandsIssued: 8, residual: [] })
      const current = await discoverManifestCatalogs(f.client(mode), manifest)
      expect(current.entitlementPlans[0].eligibilityNote).toBe('Existing fixture note')
      expect(current.events[0].venue).toBe('Fictional community room')
      expect(current.intakeDefinitions[0].currentVersion).toBe(2)
      expect(current.segments[0].version).toBe(2)
      const changed = await snapshot(f.workspaceId)
      expect(await runManifest(f.client(mode), manifest, { apply: true })).toMatchObject({ status: 'applied', commandsIssued: 0 })
      expect(await snapshot(f.workspaceId)).toEqual(changed)
    }
  }, 120_000)

  it('validates projected dependencies before mutation and refuses denied catalogs or writes', async () => {
    const f = await fixture(), before = await snapshot(f.workspaceId)
    for (const alter of [
      (value: ReturnType<typeof input>) => { value.intakeDefinitions[0].value.definition.fields[2].mapping.fieldKey = 'absent' },
      (value: ReturnType<typeof input>) => { value.intakeDefinitions[0].value.definition.fields[2].type = 'text' },
      (value: ReturnType<typeof input>) => { value.intakeDefinitions[0].value.definition.consentMappings[0].purposeKey = 'absent' },
      (value: ReturnType<typeof input>) => { value.intakeDefinitions[0].value.definition.consentMappings[0].locale = 'ja' },
      (value: ReturnType<typeof input>) => { value.intakeDefinitions[0].value.definition.consentMappings[0].grantedValue = 'yes' },
      (value: ReturnType<typeof input>) => { value.segments[0].value.predicate.items[0] = { type: 'rule', family: 'custom', field: 'absent', operator: 'eq', value: 'Value' } },
    ]) {
      const manifest = input(); alter(manifest)
      const result = await runManifest(f.client(), manifest, { apply: true })
      expect(result.status).toBe('failed'); expect(result.commandsIssued).toBe(0)
      expect(await snapshot(f.workspaceId)).toEqual(before)
    }
    const projected = input()
    projected.segments[0].value.predicate.items = [
      { type: 'rule', family: 'custom', field: 'interests', operator: 'contains', value: 'Learning' },
      { type: 'rule', family: 'consent', field: 'community_news', operator: 'eq', value: 'granted' },
      { type: 'rule', family: 'entitlement', field: 'community', operator: 'eq', value: 'active' },
      { type: 'rule', family: 'participation', field: 'community-orientation', operator: 'eq', value: 'registered' },
    ]
    expect(await runManifest(f.client(), projected)).toMatchObject({ status: 'preview', commandsIssued: 0 })
    const deniedRead = await fixture(grants.filter((grant) => grant.operation !== 'crm.catalog.read'))
    expect(await runManifest(deniedRead.client(), input(), { apply: true })).toMatchObject({ status: 'failed', commandsIssued: 0, error: { status: 403 } })
    const deniedWrite = await fixture(grants.filter((grant) => grant.operation !== 'crm.catalog.configure'))
    const deniedBefore = await snapshot(deniedWrite.workspaceId)
    expect(await runManifest(deniedWrite.client(), input(), { apply: true })).toMatchObject({ status: 'failed', commandsIssued: 1, completed: [], error: { status: 403 } })
    expect(await snapshot(deniedWrite.workspaceId)).toEqual(deniedBefore)
  }, 60_000)

  it('finds and updates a later-page identity instead of attempting a duplicate create', async () => {
    const f = await fixture()
    await pool.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,position)
      SELECT $1,CASE n%3 WHEN 0 THEN 'person' WHEN 1 THEN 'company' ELSE 'deal' END,
        'fixture_'||n,'Existing','text',n FROM generate_series(1,120) n`, [f.workspaceId])
    const manifest = { schemaVersion: 1, sourceLabel: 'Later page fixture', recordFields: [{ ref: 'late', value: {
      entityKind: 'person', fieldKey: 'fixture_120', label: 'Later field', fieldType: 'text',
    } }] }
    const existing = (await pool.query(`SELECT id FROM crm_field_definitions WHERE workspace_id=$1 AND field_key='fixture_120'`, [f.workspaceId])).rows[0].id
    const before = await snapshot(f.workspaceId), preview = await runManifest(f.client(), manifest)
    expect(preview.status).toBe('preview')
    expect(preview.changes).toMatchObject([{ action: 'update', id: existing }])
    expect(await snapshot(f.workspaceId)).toEqual(before)
    expect(await runManifest(f.client(), manifest, { apply: true })).toMatchObject({ status: 'applied', commandsIssued: 1 })
    expect((await pool.query('SELECT count(*)::int AS n FROM crm_field_definitions WHERE workspace_id=$1', [f.workspaceId])).rows[0].n).toBe(120)
  }, 60_000)

  it('recovers a partial apply and a lost committed response without duplicate resources or versions', async () => {
    const f = await fixture(); let posts = 0
    const failing: typeof fetch = async (url, init) => {
      if (init?.method !== 'GET' && ++posts === 3) return new Response('', { status: 503 })
      return fetch(url, init)
    }
    const partial = await runManifest(f.client('integration', failing), input(), { apply: true })
    expect(partial).toMatchObject({ status: 'failed', commandsIssued: 3, failed: { ref: 'membership_review', uncertain: true } })
    expect(partial.completed).toHaveLength(2)
    expect(await runManifest(f.client(), input(), { apply: true })).toMatchObject({ status: 'applied', commandsIssued: 7 })
    const lost = await fixture(); let lostOnce = false
    const lostResponse: typeof fetch = async (url, init) => {
      const result = await fetch(url, init)
      if (!lostOnce && init?.method === 'POST' && JSON.parse(String(init.body)).kind === 'save_consent_purpose') {
        lostOnce = true; await result.arrayBuffer(); throw new Error(lost.key.oneTimeSecret)
      }
      return result
    }
    const recovered = await runManifest(lost.client('integration', lostResponse), input(), { apply: true })
    expect(recovered).toMatchObject({ status: 'applied', commandsIssued: 9 })
    expect(recovered.completed).toContainEqual(expect.objectContaining({ ref: 'community_news', outcome: 'reconciled_by_read' }))
    expect(JSON.stringify(recovered)).not.toContain(lost.key.oneTimeSecret)
    expect((await pool.query('SELECT count(*)::int AS n FROM crm_consent_purpose_versions WHERE workspace_id=$1', [lost.workspaceId])).rows[0].n).toBe(1)
  }, 60_000)

  it('reconciles an equivalent concurrent create and refuses to overwrite a different one', async () => {
    for (const equivalent of [true, false]) {
      const f = await fixture(), manifest = { schemaVersion: 1, sourceLabel: 'Concurrent fixture', recordFields: input().recordFields }
      let raced = false
      const racing: typeof fetch = async (url, init) => {
        if (!raced && init?.method === 'POST') {
          raced = true
          await f.run({ kind: 'create_record_field', ...manifest.recordFields[0].value, ...(equivalent ? {} : { label: 'Concurrent different label' }) })
        }
        return fetch(url, init)
      }
      const result = await runManifest(f.client('integration', racing), manifest, { apply: true })
      expect(result.status).toBe(equivalent ? 'applied' : 'failed')
      expect(result.commandsIssued).toBe(1)
      if (equivalent) expect(result.completed[0].outcome).toBe('reconciled_by_read')
      else expect((await discoverManifestCatalogs(f.client(), manifest)).recordFields[0].label).toBe('Concurrent different label')
    }
  }, 60_000)

  it('runs the actual CLI as preview by default and recovers after SIGINT with private JSON output', async () => {
    let posts = 0, release!: () => void, reached!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const waiting = new Promise<void>((resolve) => { reached = resolve })
    const f = await fixture(grants, async (req, res) => {
      if (req.method === 'POST' && ++posts === 3) { reached(); await gate; res.status(503).json({ error: 'fixture_interruption' }); return true }
      return false
    })
    const before = await snapshot(f.workspaceId)
    const preview = await cli(f).done
    expect(preview.code).toBe(0); expect(JSON.parse(preview.stdout).status).toBe('preview')
    expect(await snapshot(f.workspaceId)).toEqual(before)
    const applying = cli(f, true)
    try {
      await Promise.race([waiting, applying.done.then(() => { throw new Error('CLI ended before interruption point') })])
      applying.child.kill('SIGINT')
      const interrupted = await applying.done
      expect(interrupted.code).toBe(130)
      expect(JSON.parse(interrupted.stdout)).toMatchObject({ status: 'failed', commandsIssued: 3, error: { code: 'interrupted' } })
      expect(JSON.parse(interrupted.stdout).completed).toHaveLength(2)
      expect(interrupted.stdout + interrupted.stderr).not.toContain(f.key.oneTimeSecret)
    } finally { release(); if (applying.child.exitCode === null && applying.child.signalCode === null) applying.child.kill('SIGKILL') }
    const resumed = await cli(f, true).done
    expect(resumed.code, resumed.stdout).toBe(0); expect(JSON.parse(resumed.stdout)).toMatchObject({ status: 'applied', commandsIssued: 7 })
    const after = await snapshot(f.workspaceId), repeated = await cli(f, true).done
    expect(repeated.code).toBe(0); expect(JSON.parse(repeated.stdout).commandsIssued).toBe(0)
    expect(await snapshot(f.workspaceId)).toEqual(after)
  }, 120_000)
})
