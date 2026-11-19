import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { z } from 'zod'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { defineApplicationModules, type ApplicationModuleDefinition } from '@use-brian/core/application-platform/contracts.js'
import { defineWorkspaceModuleRegistry } from '@use-brian/shared'
import { createWorkspaceModulesStore, lockWorkspaceModule, requireWorkspaceModuleAdmission } from '../workspace-modules-store.js'
import { bootstrapConnectionString } from '../../__tests__/fixtures/bootstrap-role.js'

const fixtureScript = new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
const { assertLocalFixture } = await import(fixtureScript)
// Never let the general integration config's fallback target reach this suite.
await assertLocalFixture()
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 8, application_name: 'assurance-owner' })
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP, max: 8, application_name: 'assurance-member' })
// Lock-wait observation only: the ordinary owner cannot read an app_user session's
// wait_event_type or query in pg_stat_activity.
const observer = new pg.Pool({ connectionString: await bootstrapConnectionString(), max: 2, application_name: 'assurance-observer' })
const testRegistry = defineWorkspaceModuleRegistry({ test_module: { key: 'test_module', defaultState: 'disabled' } } as const)
const modules = createWorkspaceModulesStore(owner, app, { registry: testRegistry })

async function workspace(v2 = true) {
  const userId = randomUUID()
  const memberId = randomUUID()
  const workspaceId = randomUUID()
  await owner.query(`INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text),($2::uuid,$2::text)`, [userId, memberId])
  await owner.query(`INSERT INTO workspaces (id,name,owner_user_id,department_read_v2) VALUES ($1,'Fixture modules',$2,$3)`, [workspaceId, userId, v2])
  await owner.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [workspaceId, userId, memberId])
  return { workspaceId, userId, memberId, actor: { credentialKind: 'user' as const, credentialId: userId } }
}

describe('[COMP:api/workspace-modules] Actual lifecycle and admission transactions', () => {
  beforeAll(async () => { await owner.query('SELECT 1') })
  afterAll(async () => { await Promise.all([owner.end(), app.end(), observer.end()]) })

  it('starts disabled, requires admin and audits only versioned changes (M1/M2)', async () => {
    const f = await workspace()
    const initial = await modules.listForMember(f.workspaceId, f.memberId)
    expect(initial[0]).toMatchObject({ state: 'disabled', version: 0 })
    await expect(modules.act(f.workspaceId, f.memberId, 'test_module', { action: 'enable', expectedVersion: 0 })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(modules.listForMember(f.workspaceId, randomUUID())).rejects.toMatchObject({ code: 'not_authorized' })
    const enabled = await modules.act(f.workspaceId, f.userId, 'test_module', { action: 'enable', expectedVersion: 0 })
    expect(enabled).toMatchObject({ changed: true, module: { state: 'enabled', version: 2 } })
    expect(await modules.act(f.workspaceId, f.userId, 'test_module', { action: 'enable', expectedVersion: 2 })).toMatchObject({ changed: false })
    await expect(modules.act(f.workspaceId, f.userId, 'test_module', { action: 'request_disable', expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'stale_module_version' })
    expect((await owner.query(`SELECT details FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='workspace.module_changed'`, [f.workspaceId])).rows)
      .toEqual([{ details: { moduleKey: 'test_module', action: 'enable', from: 'disabled', to: 'enabled', version: 2 } }])
  })

  it('runs a second test module through the same registry, store and blocker seam', async () => {
    const f = await workspace()
    let blockingCount = 2
    const testModules = createWorkspaceModulesStore(owner, app, {
      registry: testRegistry,
      lifecycles: { test_module: { readBlockingWork: async () => [{ key: 'pending_jobs', count: blockingCount }] } },
    })
    expect(await testModules.listForMember(f.workspaceId, f.memberId))
      .toEqual([expect.objectContaining({ moduleKey: 'test_module', state: 'disabled', version: 0 })])
    expect(await testModules.act(f.workspaceId, f.userId, 'test_module', { action: 'enable', expectedVersion: 0 }))
      .toMatchObject({ changed: true, module: { moduleKey: 'test_module', state: 'enabled', version: 2 } })
    expect(await testModules.act(f.workspaceId, f.userId, 'test_module', { action: 'request_disable', expectedVersion: 2 }))
      .toMatchObject({ changed: true, module: { state: 'draining', version: 3 },
        blockingWork: [{ key: 'pending_jobs', count: 2 }] })
    await expect(testModules.act(f.workspaceId, f.userId, 'test_module', { action: 'finish_disable', expectedVersion: 3 }))
      .rejects.toMatchObject({ code: 'module_drain_pending', details: {
        moduleKey: 'test_module', blockingWork: [{ key: 'pending_jobs', count: 2 }],
      } })
    blockingCount = 0
    expect(await testModules.act(f.workspaceId, f.userId, 'test_module', { action: 'finish_disable', expectedVersion: 3 }))
      .toMatchObject({ changed: true, module: { state: 'disabled', version: 4 } })
  })

  it('enriches a persisted draining lifecycle without replacing its identity, state or blocker adapter', async () => {
    const f = await workspace(), key = 'fictional_shipments'
    const compatibility = { field: 'pendingShipments', blockerKey: 'pending_shipments' }
    const lifecycle = defineWorkspaceModuleRegistry({
      [key]: { key, defaultState: 'disabled', blockingCountCompatibility: compatibility },
      unrelated: { key: 'unrelated', defaultState: 'enabled' },
    })
    let blockingCount = 2, blockerCalls = 0
    const roleProofs: unknown[] = []
    const adapter = { readBlockingWork: async (client: pg.PoolClient, workspaceId: string) => {
      expect(workspaceId).toBe(f.workspaceId); blockerCalls++
      const role = (await client.query(`SELECT session_user,current_user,r.rolsuper,r.rolbypassrls,r.rolinherit,
        (SELECT count(*)::int FROM pg_auth_members m WHERE m.member=r.oid OR m.roleid=r.oid) AS memberships,
        c.relowner=r.oid AS owns_modules FROM pg_roles r JOIN pg_class c ON c.oid='workspace_modules'::regclass WHERE r.rolname=session_user`)).rows[0]
      expect(role).toEqual({ session_user: 'app_user', current_user: 'app_user', rolsuper: false, rolbypassrls: false, rolinherit: false, memberships: 0, owns_modules: false })
      roleProofs.push(role)
      return [{ key: compatibility.blockerKey, count: blockingCount }]
    } }
    const lifecycles = { [key]: adapter }
    const original = createWorkspaceModulesStore(owner, app, { registry: lifecycle, lifecycles })
    expect((await original.listForMember(f.workspaceId, f.memberId)).find(row => row.moduleKey === key))
      .toMatchObject({ state: 'disabled', version: 0 })
    expect(await original.act(f.workspaceId, f.userId, key, { action: 'enable', expectedVersion: 0 }))
      .toMatchObject({ changed: true, module: { moduleKey: key, state: 'enabled', version: 2 } })
    const draining = await original.act(f.workspaceId, f.userId, key, { action: 'request_disable', expectedVersion: 2 })
    expect(draining).toMatchObject({ changed: true, module: { moduleKey: key, state: 'draining', version: 3 }, blockingWork: [{ key: compatibility.blockerKey, count: 2 }] })
    const snapshot = async () => ({
      rows: (await owner.query('SELECT to_jsonb(m) AS value FROM workspace_modules m WHERE workspace_id=$1 ORDER BY module_key', [f.workspaceId])).rows,
      audit: (await owner.query("SELECT to_jsonb(a) AS value FROM workspace_audit_log a WHERE workspace_id=$1 AND event_type='workspace.module_changed' ORDER BY id", [f.workspaceId])).rows,
    })
    const before = await snapshot(), callsBefore = blockerCalls
    expect(before.rows.filter(row => row.value.module_key === key)).toHaveLength(1)
    expect(before.audit).toHaveLength(2)
    const definition: ApplicationModuleDefinition<pg.PoolClient> = {
      key, defaultState: 'disabled',
      application: { version: '1', dependencies: [], resources: [], queries: ['status'], commands: ['settle'], events: ['shipments.changed'], policyCapabilities: [], backgroundHandlers: [], uiContributions: [] },
      queries: { status: { input: z.object({}).strict(), authorize: async () => {}, execute: async () => [] } },
      commands: { settle: { input: z.object({}).strict(), eventKey: 'shipments.changed', operationClass: 'existing_recovery', authorize: async () => {}, execute: async () => [], authorizeResult: async () => {} } },
    }
    const registered = defineApplicationModules([definition], lifecycle)
    expect(registered.workspaceModules[key]).toMatchObject(lifecycle[key])
    expect(registered.workspaceModules.unrelated).toEqual(lifecycle.unrelated)
    expect(registered.applications.get(key)?.blockingCountCompatibility).toEqual(compatibility)
    expect(registered.applications.get(key)?.queries.status.execute).toBe(definition.queries.status.execute)
    expect(registered.applications.get(key)?.commands.settle.execute).toBe(definition.commands.settle.execute)
    expect(definition.blockingCountCompatibility).toBeUndefined()
    const enriched = createWorkspaceModulesStore(owner, app, { registry: registered.workspaceModules, lifecycles })
    expect(await enriched.get(f.workspaceId, key)).toEqual(draining.module)
    expect((await enriched.listForMember(f.workspaceId, f.memberId)).find(row => row.moduleKey === key)).toEqual(draining.module)
    expect(await snapshot()).toEqual(before); expect(blockerCalls).toBe(callsBefore)
    await expect(enriched.act(f.workspaceId, f.userId, key, { action: 'finish_disable', expectedVersion: 3 }))
      .rejects.toMatchObject({ code: 'module_drain_pending', details: { moduleKey: key, blockingWork: [{ key: registered.workspaceModules[key].blockingCountCompatibility!.blockerKey, count: 2 }] } })
    expect(blockerCalls).toBe(callsBefore + 1); expect(await snapshot()).toEqual(before)
    blockingCount = 0
    const disabled = await enriched.act(f.workspaceId, f.userId, key, { action: 'finish_disable', expectedVersion: 3 })
    expect(disabled).toMatchObject({ changed: true, module: { moduleKey: key, state: 'disabled', version: 4 }, blockingWork: [{ key: compatibility.blockerKey, count: 0 }] })
    const after = await snapshot()
    expect(after.rows.filter(row => row.value.module_key === key)).toHaveLength(1)
    expect(after.rows.filter(row => row.value.module_key !== key)).toEqual(before.rows.filter(row => row.value.module_key !== key))
    expect(after.audit).toHaveLength(3)
    expect(after.audit.filter(row => !before.audit.some(old => old.value.id === row.value.id))[0].value.details)
      .toEqual({ moduleKey: key, action: 'finish_disable', from: 'draining', to: 'disabled', version: 4 })
    expect(await enriched.act(f.workspaceId, f.userId, key, { action: 'finish_disable', expectedVersion: 4 }))
      .toMatchObject({ changed: false, module: disabled.module })
    expect(await snapshot()).toEqual(after)
    expect(roleProofs).toHaveLength(callsBefore + 3)
  })

  it('fails closed on missing rows and provisions only under owner lifecycle authority', async () => {
    const f = await workspace()
    await owner.query('DELETE FROM workspace_modules WHERE workspace_id=$1', [f.workspaceId])
    expect(await modules.get(f.workspaceId, 'test_module')).toMatchObject({ state: 'disabled', version: 0 })
    expect(await modules.act(f.workspaceId, f.userId, 'test_module', { action: 'enable', expectedVersion: 0 }))
      .toMatchObject({ changed: true, module: { state: 'enabled', version: 2 } })
  })

  it.each(['admission', 'shutdown'] as const)('[S2-06] orders lazy missing-row admission with first shutdown when %s wins', async winner => {
    const f = await workspace(), key = 'fictional_lazy_lifecycle'
    const registry = defineWorkspaceModuleRegistry({ [key]: { key, defaultState: 'enabled' } })
    expect((await owner.query('SELECT 1 FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2', [f.workspaceId, key])).rows).toEqual([])
    let reached!: () => void, resume!: () => void, shutdownPid = 0
    const paused = new Promise<void>(resolve => { reached = resolve }), release = new Promise<void>(resolve => { resume = resolve })
    const lifecyclePool = { connect: async () => {
      const client = await app.connect(); shutdownPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      return new Proxy(client, { get(target, property) {
        const value = Reflect.get(target, property)
        if (property === 'query') return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args)
          if (winner === 'shutdown' && args[0] === 'SELECT id FROM workspaces WHERE id=$1 FOR UPDATE') { reached(); await release }
          return result
        }
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } } as unknown as pg.Pool
    const lifecycle = createWorkspaceModulesStore(owner, lifecyclePool, { registry })
    const client = await app.connect(), admissionPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
    await client.query('BEGIN'); await client.query("SELECT set_config('app.current_user_id',$1,true)", [f.userId])
    let transition: ReturnType<typeof lifecycle.act> | undefined, admission: ReturnType<typeof lockWorkspaceModule> | undefined
    const waitFor = async (blocker: number, fragment: string) => {
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const result = await observer.query(`SELECT pid,query,wait_event,pg_blocking_pids(pid) AS blockers FROM pg_stat_activity
          WHERE datname=current_database() AND wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid)) AND position($2 in query)>0`, [blocker, fragment])
        if (result.rows[0]) { console.info('[S2-06] lazy-row waiter', JSON.stringify({ winner, blocker, ...result.rows[0] })); return }
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      throw new Error('Expected an actual lazy-row lock waiter')
    }
    try {
      if (winner === 'admission') {
        const initial = await lockWorkspaceModule(client, f.workspaceId, key, registry)
        expect(initial).toMatchObject({ state: 'enabled', version: 0 }); requireWorkspaceModuleAdmission(initial, 'new_work')
        transition = lifecycle.act(f.workspaceId, f.userId, key, { action: 'request_disable', expectedVersion: 0 }); void transition.catch(() => undefined)
        await waitFor(admissionPid, 'SELECT id FROM workspaces WHERE id=$1 FOR UPDATE')
        await client.query('COMMIT')
      } else {
        transition = lifecycle.act(f.workspaceId, f.userId, key, { action: 'request_disable', expectedVersion: 0 }); void transition.catch(() => undefined)
        await Promise.race([paused, transition.then(() => { throw new Error('Expected first shutdown to pause before lazy insertion') })])
        admission = lockWorkspaceModule(client, f.workspaceId, key, registry); void admission.catch(() => undefined)
        await waitFor(shutdownPid, 'SELECT id FROM workspaces WHERE id=$1 FOR SHARE')
        resume(); await transition
        const observed = await admission
        expect(observed).toMatchObject({ state: 'disabled', version: 2 })
        expect(() => requireWorkspaceModuleAdmission(observed, 'new_work')).toThrowError(expect.objectContaining({ code: 'module_disabled' }))
        await client.query('COMMIT')
      }
      expect(await transition).toMatchObject({ changed: true, module: { state: 'disabled', version: 2 } })
      expect((await owner.query('SELECT state,version FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2', [f.workspaceId, key])).rows).toEqual([{ state: 'disabled', version: 2 }])
      expect((await owner.query("SELECT details FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='workspace.module_changed'", [f.workspaceId])).rows)
        .toEqual([{ details: { moduleKey: key, action: 'request_disable', from: 'enabled', to: 'disabled', version: 2 } }])
    } finally {
      resume(); await client.query('ROLLBACK'); client.release()
      await Promise.allSettled([...(transition ? [transition] : []), ...(admission ? [admission] : [])])
      await owner.query('DELETE FROM workspaces WHERE id=$1', [f.workspaceId]); await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[f.userId, f.memberId]])
    }
  })

  it('enforces module RLS for app-role read/write and prevents member escalation', async () => {
    const f = await workspace()
    const other = await workspace()
    await modules.act(f.workspaceId, f.userId, 'test_module', { action: 'enable', expectedVersion: 0 })
    await modules.act(other.workspaceId, other.userId, 'test_module', { action: 'enable', expectedVersion: 0 })
    const client = await app.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_user_id',$1,true)`, [f.memberId])
      expect((await client.query('SELECT workspace_id FROM workspace_modules')).rows).toEqual([{ workspace_id: f.workspaceId }])
      expect((await client.query(`UPDATE workspace_modules SET state='enabled' WHERE workspace_id=$1`, [f.workspaceId])).rowCount).toBe(0)
      expect((await client.query(`UPDATE workspace_modules SET state='enabled' WHERE workspace_id=$1`, [other.workspaceId])).rowCount).toBe(0)
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_user_id',$1,true)`, [f.userId])
      await expect(client.query(`INSERT INTO workspace_modules (workspace_id,module_key) VALUES ($1,'test_module')`, [other.workspaceId])).rejects.toThrow(/row-level security/)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
