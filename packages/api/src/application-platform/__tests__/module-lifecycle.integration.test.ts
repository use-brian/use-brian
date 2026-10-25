/** Real reviewed generic-module credentials retain recovery through lifecycle changes. */
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { z } from 'zod'
import express from 'express'
import request from 'supertest'
import type { Pool, PoolClient } from 'pg'
import type { ApplicationModuleDefinition, ApplicationOperationContext } from '@use-brian/core'
import { ApplicationPlatformError, type ApplicationRecordProjection, type WorkspaceModuleAction } from '@use-brian/shared'
import { createApplicationClient } from '@use-brian/brian-app/application'
import { createServiceTransport } from '@use-brian/brian-app/module'
import { getPool, getAppPool } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { createWorkspaceModulesStore } from '../../db/workspace-modules-store.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { applicationPlatformRoutes } from '../../routes/application-platform.js'
import { ApplicationPlatformService } from '../service.js'
import { ApplicationManagementService } from '../management.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
import { canonicalGenericResource } from '../generic-reader.js'
import { assertApplicationModuleRole, lockApplicationModuleRecords } from '../module-runtime.js'
import { authenticateApplicationCredential } from '../credentials.js'
import { loadApplicationCredentialStateSystem } from '../auth-store.js'
import { resolveApplicationExecutionContext } from '../execution-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const moduleKey = 'fictional_lifecycle'
const properties = [{ name: 'title', required: true, config: { kind: 'text' as const } },
  { name: 'state', required: true, config: { kind: 'text' as const } },
  { name: 'blocksShutdown', required: true, config: { kind: 'checkbox' as const } }]
const fields = properties.map(field => field.name)
const text = (value: string) => ({ kind: 'text' as const, value })
type Context = ApplicationOperationContext<PoolClient>

describe.sequential('[COMP:api/application-auth] [COMP:api/application-records] scoped module lifecycle recovery', () => {
  const owner = getPool(), ownerId = randomUUID(), secret = 'fictional-lifecycle-native-session'
  const store = createDbDocEntityStore({ actorUserId: ownerId })
  let workspaceId: string, assistantId: string, typeId: string, typeKey: string, appId: string, serviceUserId: string
  let platform: ApplicationPlatformService, management: ApplicationManagementService
  let modules: ReturnType<typeof createWorkspaceModulesStore>, http: ReturnType<typeof express>
  let server: ReturnType<ReturnType<typeof express>['listen']>, apiOrigin: string, nativeToken: string
  let issued: { secret: string; credentialId: string }, parentGrantId: string, rows: string[]
  const serviceUsers: string[] = []
  const oauthClients: string[] = []
  const callbacks = new Map<string, number>()
  const input = z.object({ id: z.string().uuid() }).strict()
  function definition(): ApplicationModuleDefinition<PoolClient> {
    const base = createCanonicalGenericApplicationModule()
    const mutation = (kind: 'create' | 'patch', raw: unknown) => {
      const value = input.parse(raw)
      return kind === 'create' ? { operation: kind, type: typeKey, id: value.id,
        data: { title: text('Fictional new work'), state: text('open'), blocksShutdown: { kind: 'checkbox', value: true } } }
        : { operation: kind, type: typeKey, id: value.id, data: { state: text('closed'), blocksShutdown: { kind: 'checkbox', value: false } } }
    }
    const handler = (recover: boolean) => {
      const canonical = recover ? base.commands.record_patch : base.commands.record_create
      return { input, eventKey: 'fictional.changed',
        authorize: async (context: Context, raw: unknown) => {
          await assertApplicationModuleRole(context, moduleKey, 'operator')
          await canonical.authorize(context, mutation(recover ? 'patch' : 'create', raw))
        },
        execute: async (context: Context, raw: unknown) => {
          if (recover) {
            const selected = { type: typeKey, id: input.parse(raw).id }
            await base.queries.get.authorize(context, selected)
            await lockApplicationModuleRecords(context, moduleKey, [selected.id])
            const existing = await base.queries.get.execute(context, selected) as ApplicationRecordProjection
            if ((existing.values.state as { value: string }).value !== 'open') {
              throw new ApplicationPlatformError('record_version_conflict', 'Existing work is not recoverable.')
            }
          }
          const result = await canonical.execute(context, mutation(recover ? 'patch' : 'create', raw))
          context.afterCommit(() => { callbacks.set(context.idempotencyKey, (callbacks.get(context.idempotencyKey) ?? 0) + 1) })
          return result
        }, authorizeResult: canonical.authorizeResult }
    }
    return { key: moduleKey, defaultState: 'enabled', application: { version: '1', dependencies: ['records'],
      resources: [canonicalGenericResource({ id: typeId, schemaVersion: 1, properties })],
      queries: ['get'], commands: ['new_item', 'commerce_item', 'recover_item'], events: ['fictional.changed'],
      policyCapabilities: ['canonical_module_roles'], backgroundHandlers: [], uiContributions: [] },
      queries: { get: base.queries.get }, commands: { new_item: handler(false),
        commerce_item: { ...handler(false), operationClass: 'new_commerce' },
        recover_item: { ...handler(true), operationClass: 'existing_recovery' } } }
  }
  beforeAll(async () => {
    await owner.query("INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)", [ownerId])
    await owner.query(`CREATE TABLE module_lifecycle_fixture_config(workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,schema_id uuid NOT NULL,revision bigint NOT NULL DEFAULT nextval('application_policy_revision_seq'));
      ALTER TABLE module_lifecycle_fixture_config ENABLE ROW LEVEL SECURITY; REVOKE ALL ON module_lifecycle_fixture_config FROM PUBLIC;
      CREATE FUNCTION module_lifecycle_fixture_revision(w uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        SELECT coalesce((SELECT revision::text FROM public.module_lifecycle_fixture_config WHERE workspace_id=w),'unconfigured') $$;
      REVOKE ALL ON FUNCTION module_lifecycle_fixture_revision(uuid) FROM PUBLIC;
      CREATE FUNCTION module_lifecycle_fixture_configure(w uuid,input jsonb) RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE selected_schema uuid:=(input->>'schemaId')::uuid;r text; BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.entity_types t JOIN public.application_native_resource_owners o ON o.workspace_id=t.workspace_id AND o.origin=jsonb_build_object('kind','generic','entityTypeId',t.id)
          WHERE t.id=selected_schema AND t.workspace_id=w AND o.module_key='fictional_lifecycle') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
        INSERT INTO public.module_lifecycle_fixture_config(workspace_id,schema_id) VALUES(w,selected_schema) ON CONFLICT(workspace_id) DO UPDATE SET schema_id=selected_schema,revision=nextval('public.application_policy_revision_seq') RETURNING revision::text INTO r;RETURN r;END $$;
      REVOKE ALL ON FUNCTION module_lifecycle_fixture_configure(uuid,jsonb) FROM PUBLIC;
      CREATE FUNCTION module_lifecycle_fixture_catalog(w uuid,o jsonb,t text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE s public.entity_types;keys jsonb;fields jsonb;BEGIN
        SELECT * INTO s FROM public.entity_types WHERE workspace_id=w AND id=(o->>'entityTypeId')::uuid;
        IF s.id IS NULL OR t<>'record.'||s.id::text THEN RETURN NULL;END IF;
        SELECT jsonb_agg(p->'name' ORDER BY p->>'name'),jsonb_agg(jsonb_build_object('key',p->>'name','read','[["operator"]]'::jsonb,'write','[["operator"]]'::jsonb,'releaseReadTo','["service"]'::jsonb,'releaseWriteTo','["service"]'::jsonb) ORDER BY p->>'name') INTO keys,fields FROM jsonb_array_elements(s.properties) p;
        RETURN jsonb_build_object('moduleKey','fictional_lifecycle','origin',o,'typeKey',t,'schemaVersion',s.schema_version::text,'policyVersion',public.module_lifecycle_fixture_revision(w),'fieldKeys',keys,'fields',fields,
          'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));END $$;
      REVOKE ALL ON FUNCTION module_lifecycle_fixture_catalog(uuid,jsonb,text) FROM PUBLIC;
      CREATE FUNCTION module_lifecycle_fixture_metadata(w uuid,o jsonb,t text,i text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE catalog jsonb;source jsonb;BEGIN
        IF NOT EXISTS(SELECT 1 FROM public.entity_instances WHERE id=i::uuid AND workspace_id=w AND entity_type_id=(o->>'entityTypeId')::uuid) THEN RETURN NULL;END IF;
        catalog:=public.module_lifecycle_fixture_catalog(w,o,t);source:=public.read_scope_source(w,'entity_instance',i::uuid);
        IF source IS NULL THEN RETURN NULL;END IF;RETURN (catalog-'scope')||jsonb_build_object('recordVersion',source->>'version','source',source);END $$;
      REVOKE ALL ON FUNCTION module_lifecycle_fixture_metadata(uuid,jsonb,text,text) FROM PUBLIC;
      INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required,configuration_reader)
        VALUES('fictional_lifecycle','1',ARRAY['operator'],'module_lifecycle_fixture_metadata(uuid,jsonb,text,text)'::regprocedure,'module_lifecycle_fixture_catalog(uuid,jsonb,text)'::regprocedure,true,'module_lifecycle_fixture_revision(uuid)'::regprocedure);
      INSERT INTO application_deployed_module_capabilities(module_key,contract_version,commands,queries,dependencies)
        VALUES('fictional_lifecycle','1',ARRAY['new_item','commerce_item','recover_item'],ARRAY['get'],ARRAY['records']);
      INSERT INTO application_native_configuration_operations(module_key,operation_key,input_fields,required_role_keys,apply_handler)
        VALUES('fictional_lifecycle','set_schema','[{"key":"schemaId","kind":"text","required":true,"maxLength":36}]',ARRAY['operator'],'module_lifecycle_fixture_configure(uuid,jsonb)'::regprocedure)`)
  })
  beforeEach(async () => {
    callbacks.clear()
    workspaceId = randomUUID(); assistantId = randomUUID(); rows = []
    await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional lifecycle workspace',$2)", [workspaceId, ownerId])
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId, ownerId])
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional lifecycle assistant',$2,$3,'primary','confidential')", [assistantId, ownerId, workspaceId])
    const schema = await store.createEntityType({ workspaceId, name: 'Fictional existing work', properties, createdBy: ownerId })
    typeId = schema.id; typeKey = 'record.' + typeId
    for (let index = 0; index < 4; index++) rows.push((await store.createEntity({ workspaceId, entityTypeId: typeId,
      data: { title: text('Fictional existing work'), state: text('open'), blocksShutdown: { kind: 'checkbox', value: false } }, sourceApp: 'api', createdBy: ownerId, lastEditedBy: ownerId })).id)
    platform = new ApplicationPlatformService([createCanonicalGenericApplicationModule(), definition()]); management = new ApplicationManagementService(platform)
    http = express(); http.use(express.json()); http.use('/api/applications', applicationPlatformRoutes({ service: platform,
      management: { service: management, requireAuth: requireAuth(secret), origins: ['https://host.example'] } }))
    server = http.listen(0, '127.0.0.1'); if (!server.listening) await once(server, 'listening')
    apiOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    const session = await authSessionStore.create(ownerId, { deviceLabel: 'Fictional lifecycle browser', userAgent: 'Fixture', ipAddress: '127.0.0.1' })
    nativeToken = createTokens(ownerId, secret, session!).accessToken
    await govern({ kind: 'assign_role', userId: ownerId, roleKey: 'operator', startsAt: '2020-01-01T00:00:00Z', expiresAt: null })
    await govern({ kind: 'bind_owner', entityTypeId: typeId })
    await govern({ kind: 'configure', operationKey: 'set_schema', input: { schemaId: typeId } })
    appId = (await checked({ kind: 'register', input: { moduleKey, name: 'Fictional recovery application', mode: 'api_client', origins: [], redirectUris: [] } })).id
    await activate(appId)
    serviceUserId = (await checked({ kind: 'service.prepare', appId, input: { name: 'Fictional recovery service', idempotencyKey: randomUUID() } })).serviceUserId
    await govern({ kind: 'assign_role', userId: serviceUserId, roleKey: 'operator', startsAt: '2020-01-01T00:00:00Z', expiresAt: null })
    serviceUsers.push(serviceUserId)
    const selection = { kind: 'ids' as const, ids: rows }
    parentGrantId = await grant(null, selection); const leaf = await grant(parentGrantId, selection)
    const ownParent = await grant(null); const ownLeaf = await grant(ownParent)
    const review = await checked({ kind: 'credential.review', appId, input: { name: 'Fictional recovery key', kind: 'service', serviceUserId, grantIds: [leaf, ownLeaf], expiresAt: new Date(Date.now() + 3600_000).toISOString() } })
    expect(review.canIssue).toBe(true); issued = await checked({ kind: 'credential.deliver', appId, reviewId: review.id })
    modules = createWorkspaceModulesStore(owner, getAppPool(), { registry: platform.registry.workspaceModules, lifecycles: { [moduleKey]: {
      readBlockingWork: async client => [{ key: 'open_work', count: Number((await client.query("SELECT count(*) FROM entity_instances WHERE workspace_id=$1 AND entity_type_id=$2 AND data#>>'{blocksShutdown,value}'='true' AND data#>>'{state,value}'='open'", [workspaceId, typeId])).rows[0].count) }],
    } } })
    expect((await getAppPool().query('SELECT current_user AS actor,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{ actor: 'app_user', rolsuper: false, rolbypassrls: false }])
  }, 60_000)
  afterEach(async () => {
    server?.closeAllConnections(); if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    await owner.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    if (serviceUsers.length) await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [serviceUsers.splice(0)])
    if (oauthClients.length) await owner.query('DELETE FROM oauth_clients WHERE client_id=ANY($1::text[])', [oauthClients.splice(0)])
  })
  afterAll(async () => {
    await owner.query("DELETE FROM application_native_configuration_operations WHERE module_key='fictional_lifecycle';DELETE FROM application_deployed_module_capabilities WHERE module_key='fictional_lifecycle';DELETE FROM application_native_field_contracts WHERE module_key='fictional_lifecycle'")
    await owner.query('DROP FUNCTION module_lifecycle_fixture_metadata(uuid,jsonb,text,text);DROP FUNCTION module_lifecycle_fixture_catalog(uuid,jsonb,text);DROP FUNCTION module_lifecycle_fixture_configure(uuid,jsonb);DROP FUNCTION module_lifecycle_fixture_revision(uuid);DROP TABLE module_lifecycle_fixture_config')
    await owner.query('DELETE FROM users WHERE id=$1', [ownerId]); await getAppPool().end(); await owner.end()
  })
  const command = (value: Record<string, unknown>) => request(http).post(`/api/applications/workspaces/${workspaceId}/management/commands`)
    .set('Authorization', 'Bearer ' + nativeToken).set('Origin', 'https://host.example').send(value)
  async function checked(value: Record<string, unknown>) { const response = await command(value); expect(response.status, JSON.stringify({ kind: value.kind, body: response.body })).toBe(200); return response.body }
  async function govern(operation: unknown) { const catalog = await checked({ kind: 'governance.catalog', input: { moduleKey } }); const review = await checked({ kind: 'governance.preview', input: { moduleKey, expectedRevision: catalog.revision, operation } }); return checked({ kind: 'governance.apply', reviewId: review.id, input: {} }) }
  async function activate(id: string, profile?: 'canonical_app_delegation_v1') { const review = await checked({ kind: 'activation.review', appId: id, ...(profile ? { profile } : {}) }); await checked({ kind: 'activation.apply', appId: id, reviewId: review.id }); return review }
  async function grant(parent: string | null, selector: { kind: 'self' } | { kind: 'ids'; ids: string[] } = { kind: 'self' }) { const review = await checked({ kind: 'grant.review', appId, input: { principal: { kind: 'service', userId: serviceUserId }, origin: { kind: 'generic', entityTypeId: typeId }, typeKey, actions: ['read', 'query', 'create', 'patch', 'command:new_item', 'command:commerce_item', 'command:recover_item'], readFields: fields, writeFields: fields, selector, parentGrantId: parent, expiresAt: null, compartments: [], projectIds: [], clearance: 'internal' } }); expect(review.canIssue).toBe(true); return (await checked({ kind: 'grant.apply', appId, reviewId: review.id })).grantId as string }
  const sdk = () => createApplicationClient({ appId, transport: createServiceTransport({ apiOrigin, credential: async () => ({ kind: 'service', token: issued.secret }) }) })
  const recover = (id: string, key = randomUUID()) => ({ idempotencyKey: key, expectedVersion: '1', input: { id } })
  async function lifecycle(action: WorkspaceModuleAction) { return modules.act(workspaceId, ownerId, moduleKey, { action, expectedVersion: (await modules.get(workspaceId, moduleKey)).version }) }
  const native = (key: string, value: unknown) => request(http).post(`/api/applications/workspaces/${workspaceId}/modules/command`).set('Authorization', 'Bearer ' + nativeToken).send({ moduleKey, commandKey: key, command: value })
  async function mcp(nativeAudience: boolean, name: string, key: string, value: unknown) {
    const path = nativeAudience ? `/api/applications/workspaces/${workspaceId}/modules/mcp?moduleKey=${moduleKey}` : `/api/applications/${appId}/mcp`
    const response = await request(http).post(path).set('Authorization', 'Bearer ' + (nativeAudience ? nativeToken : issued.secret))
      .set('Accept', 'application/json, text/event-stream').send({ jsonrpc: '2.0', id: randomUUID(), method: 'tools/call', params: { name, arguments: { commandKey: key, command: value } } })
    expect(response.status, response.text).toBe(200)
    const line = response.text.split('\n').find(item => item.startsWith('data: '))
    return JSON.parse(line ? line.slice(6) : response.text).result
  }
  async function observeTransportRefusal(key: string, code: 'module_draining' | 'module_disabled') {
    const value = { idempotencyKey: randomUUID(), input: { id: randomUUID() } }
    const serviceResponse = await request(http).post(`/api/applications/${appId}/commands/${key}`).set('Authorization', 'Bearer ' + issued.secret).send(value)
    expect(serviceResponse.status).toBe(409)
    expect(serviceResponse.body).toEqual({ error: code, effect: 'none', retrySafe: false })
    const nativeResponse = await native(key, value)
    expect(nativeResponse.status).toBe(409)
    expect(nativeResponse.body).toEqual({ error: code, effect: 'none', retrySafe: false })
    for (const nativeAudience of [false, true]) {
      const result = await mcp(nativeAudience, nativeAudience ? 'nativeModuleCommand' : 'applicationCommand', key, value)
      expect(result.isError).toBe(true)
      expect(JSON.parse(result.content[0].text)).toEqual({ error: code, effect: 'none', retrySafe: false })
    }
  }
  async function pinned() { const credential = await authenticateApplicationCredential(issued.secret, appId, loadApplicationCredentialStateSystem); expect(credential).not.toBeNull(); return resolveApplicationExecutionContext({ credential: credential! }) }
  async function generation() { return (await owner.query('SELECT a.version::text AS activation,k.activation_version::text AS credential_activation,k.version::text AS credential,a.deployed_snapshot FROM application_scoped_activations a JOIN application_api_credentials k ON k.app_id=a.app_id WHERE a.app_id=$1 AND k.id=$2', [appId, issued.credentialId])).rows[0] }

  function schedulingPool(match: (sql: string) => boolean) {
    let reached!: () => void, release!: () => void, pid = 0, armed = true
    const ready = new Promise<void>(resolve => { reached = resolve }), pause = new Promise<void>(resolve => { release = resolve })
    const pool = { connect: async () => {
      const client = await getAppPool().connect(); pid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      return new Proxy(client, { get(target, key) {
        const value = Reflect.get(target, key)
        if (key === 'query') return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args)
          if (armed && typeof args[0] === 'string' && match(args[0])) { armed = false; reached(); await pause }
          return result
        }
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } } as unknown as Pool
    return { pool, ready, release: () => release(), pid: () => pid }
  }
  function lifecycleWith(pool: Pool) {
    return createWorkspaceModulesStore(owner, pool, { registry: platform.registry.workspaceModules, lifecycles: { [moduleKey]: {
      readBlockingWork: async client => [{ key: 'open_work', count: Number((await client.query("SELECT count(*) FROM entity_instances WHERE workspace_id=$1 AND entity_type_id=$2 AND data#>>'{blocksShutdown,value}'='true' AND data#>>'{state,value}'='open'", [workspaceId, typeId])).rows[0].count) }],
    } } })
  }
  async function existingModule() { if ((await modules.get(workspaceId, moduleKey)).version === 0) await lifecycle('enable'); return modules.get(workspaceId, moduleKey) }
  async function operationState(id: string, key: string) {
    const row = (await owner.query('SELECT record_version::text AS version,data FROM entity_instances WHERE workspace_id=$1 AND id=$2', [workspaceId, id])).rows[0] ?? null
    const totals = (await owner.query(`SELECT
      (SELECT count(*)::int FROM application_operation_receipts WHERE workspace_id=$1 AND module_key=$2 AND idempotency_key=$3) AS receipts,
      (SELECT count(*)::int FROM application_command_audit a JOIN application_operation_receipts r ON r.id=a.receipt_id WHERE r.workspace_id=$1 AND r.module_key=$2 AND r.idempotency_key=$3) AS audit,
      (SELECT count(*)::int FROM application_committed_events e JOIN application_operation_receipts r ON r.id=e.receipt_id WHERE r.workspace_id=$1 AND r.module_key=$2 AND r.idempotency_key=$3) AS events`, [workspaceId, moduleKey, key])).rows[0]
    return { row, ...totals, callbacks: callbacks.get(key) ?? 0 }
  }
  async function waitForBlocker(blocker: number, fragments: string[], finished?: () => boolean) {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      if (finished?.()) return undefined
      const result = await owner.query(`SELECT a.pid,a.query,a.wait_event AS "waitEvent",pg_blocking_pids(a.pid) AS blockers,
        coalesce((SELECT jsonb_agg(jsonb_build_object('relation',l.relation::regclass::text,'mode',l.mode,'granted',l.granted)) FROM pg_locks l WHERE l.pid=a.pid),'[]'::jsonb) AS locks
        FROM pg_stat_activity a WHERE a.datname=current_database() AND a.wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(a.pid))`, [blocker])
      const row = result.rows.find(row => fragments.some(fragment => row.query.includes(fragment)))
      if (row) { console.info('[S2-06] actual operation waiter', JSON.stringify({ blocker, ...row, locks: row.locks.filter((lock: { relation: string | null }) => ['workspaces', 'workspace_modules', 'entity_instances'].includes(lock.relation ?? '')) })); return row }
      await new Promise<void>(resolve => setImmediate(resolve))
    }
    throw new Error('Expected an actual operation lock waiter')
  }
  async function noNewWork(code: 'module_draining' | 'module_disabled') {
    for (const name of ['new_item', 'commerce_item']) {
      const id = randomUUID(), command = { idempotencyKey: randomUUID(), input: { id } }
      await expect(sdk().command(name, command)).rejects.toMatchObject({ code, status: 409, effect: 'none', retrySafe: false })
      expect(await operationState(id, command.idempotencyKey)).toEqual({ row: null, receipts: 0, audit: 0, events: 0, callbacks: 0 })
    }
  }
  async function settledBlocker() {
    await existingModule()
    const id = randomUUID(); await sdk().command('new_item', { idempotencyKey: randomUUID(), input: { id } })
    expect((await lifecycle('request_disable')).module.state).toBe('draining')
    await sdk().command('recover_item', recover(id))
    expect((await modules.get(workspaceId, moduleKey)).state).toBe('draining')
  }

  it.each(['command', 'shutdown'] as const)('[S2-06] orders genuine new work with request-disable when %s wins', async winner => {
    const initial = await existingModule(), savedGeneration = await generation(), id = randomUUID()
    const command = { idempotencyKey: randomUUID(), input: { id } }, execution = await pinned()
    const pause = schedulingPool(sql => winner === 'command' ? sql.startsWith('INSERT INTO application_committed_events') : sql.startsWith('UPDATE workspace_modules'))
    const service = new ApplicationPlatformService([createCanonicalGenericApplicationModule(), definition()], winner === 'command' ? pause.pool : getAppPool())
    let operation: ReturnType<typeof service.command> | undefined, shutdown: ReturnType<typeof modules.act> | undefined
    let waiter: Awaited<ReturnType<typeof waitForBlocker>>
    try {
      if (winner === 'command') {
        operation = service.command(execution, moduleKey, 'new_item', command); void operation.catch(() => undefined)
        await Promise.race([pause.ready, operation.then(() => { throw new Error('Expected staged new work') })])
        shutdown = lifecycle('request_disable'); void shutdown.catch(() => undefined)
        waiter = await waitForBlocker(pause.pid(), ['module_key=$2 FOR UPDATE'])
      } else {
        shutdown = lifecycleWith(pause.pool).act(workspaceId, ownerId, moduleKey, { action: 'request_disable', expectedVersion: initial.version }); void shutdown.catch(() => undefined)
        await Promise.race([pause.ready, shutdown.then(() => { throw new Error('Expected uncommitted shutdown') })])
        operation = service.command(execution, moduleKey, 'new_item', command); void operation.catch(() => undefined)
        waiter = await waitForBlocker(pause.pid(), ['FROM application_lock_module('])
      }
      expect(waiter).toBeDefined()
    } finally { pause.release(); await Promise.allSettled([...(operation ? [operation] : []), ...(shutdown ? [shutdown] : [])]) }
    if (winner === 'command') {
      const receipt = await operation!
      expect(await shutdown).toMatchObject({ changed: true, module: { state: 'draining' }, blockingWork: [{ key: 'open_work', count: 1 }] })
      expect(await operationState(id, command.idempotencyKey)).toMatchObject({ row: { version: '1', data: { state: text('open'), blocksShutdown: { kind: 'checkbox', value: true } } }, receipts: 1, audit: 1, events: 1, callbacks: 1 })
      expect(await sdk().command('new_item', command)).toEqual(receipt)
      await noNewWork('module_draining')
    } else {
      const outcome = await operation!.then(() => ({ success: true, code: undefined, reason: undefined }), (error: { code?: string; reason?: string }) => ({ success: false, code: error.code, reason: error.reason }))
      expect(outcome.success).toBe(false)
      expect(outcome.code === 'module_disabled' || outcome.reason === 'authority_changed', JSON.stringify(outcome)).toBe(true)
      expect(await shutdown).toMatchObject({ changed: true, module: { state: 'disabled' } })
      expect(await operationState(id, command.idempotencyKey)).toEqual({ row: null, receipts: 0, audit: 0, events: 0, callbacks: 0 })
      await noNewWork('module_disabled')
    }
    expect(await generation()).toEqual(savedGeneration)
  }, 60_000)

  it.each(['recovery', 'shutdown'] as const)('[S2-06] orders first recovery with finish-disable when %s wins', async winner => {
    await settledBlocker()
    const savedGeneration = await generation(), id = rows[0], command = recover(id), before = await operationState(id, command.idempotencyKey)
    expect(before).toMatchObject({ row: { version: '1', data: { state: text('open') } }, receipts: 0, audit: 0, events: 0, callbacks: 0 })
    const initial = await modules.get(workspaceId, moduleKey), execution = await pinned()
    const pause = schedulingPool(sql => winner === 'recovery' ? sql.startsWith('INSERT INTO application_committed_events') : sql.startsWith('UPDATE workspace_modules'))
    const service = new ApplicationPlatformService([createCanonicalGenericApplicationModule(), definition()], winner === 'recovery' ? pause.pool : getAppPool())
    let operation: ReturnType<typeof service.command> | undefined, shutdown: ReturnType<typeof modules.act> | undefined
    try {
      if (winner === 'recovery') {
        operation = service.command(execution, moduleKey, 'recover_item', command); void operation.catch(() => undefined)
        await Promise.race([pause.ready, operation.then(() => { throw new Error('Expected staged first recovery') })])
        shutdown = lifecycle('finish_disable'); void shutdown.catch(() => undefined)
        const waiter = await waitForBlocker(pause.pid(), ['application_prepare_native_module_lifecycle(', 'module_key=$2 FOR UPDATE'])
        expect(waiter).toBeDefined()
      } else {
        shutdown = lifecycleWith(pause.pool).act(workspaceId, ownerId, moduleKey, { action: 'finish_disable', expectedVersion: initial.version }); void shutdown.catch(() => undefined)
        await Promise.race([pause.ready, shutdown.then(() => { throw new Error('Expected uncommitted finish-disable') })])
        operation = service.command(execution, moduleKey, 'recover_item', command); void operation.catch(() => undefined)
        expect(await waitForBlocker(pause.pid(), ['FROM application_lock_module('])).toBeDefined()
      }
    } finally { pause.release(); await Promise.allSettled([...(operation ? [operation] : []), ...(shutdown ? [shutdown] : [])]) }
    expect(await shutdown).toMatchObject({ changed: true, module: { state: 'disabled' }, blockingWork: [{ key: 'open_work', count: 0 }] })
    if (winner === 'shutdown') {
      await expect(operation).rejects.toMatchObject({ reason: 'authority_changed' })
      expect(await operationState(id, command.idempotencyKey)).toEqual(before)
    } else expect(await operation).toMatchObject({ effect: 'committed' })
    // A fresh lease on the SAME credential/envelope is the first execution if
    // the pre-transition invocation rolled back; otherwise it is exact replay.
    const receipt = await sdk().command('recover_item', command)
    expect(await sdk().command('recover_item', command)).toEqual(receipt)
    expect(await sdk().reconcile('recover_item', command)).toEqual({ state: 'applied', receipt })
    expect(await operationState(id, command.idempotencyKey)).toMatchObject({ row: { version: '2', data: { state: text('closed') } }, receipts: 1, audit: 1, events: 1, callbacks: 1 })
    const fresh = recover(rows[1]); expect(await sdk().command('recover_item', fresh)).toMatchObject({ effect: 'committed' })
    expect(await operationState(rows[1], fresh.idempotencyKey)).toMatchObject({ row: { version: '2' }, receipts: 1, audit: 1, events: 1, callbacks: 1 })
    expect(await generation()).toEqual(savedGeneration)
    await noNewWork('module_disabled')
  }, 60_000)

  it.each(['credential', 'parent'] as const)('[S2-06] rolls back staged recovery when committed %s revocation wins before the final lease', async kind => {
    await settledBlocker()
    const id = rows[0], commandValue = recover(id), before = await operationState(id, commandValue.idempotencyKey)
    const pause = schedulingPool(sql => sql.startsWith('INSERT INTO application_committed_events'))
    const service = new ApplicationPlatformService([createCanonicalGenericApplicationModule(), definition()], pause.pool)
    const operation = service.command(await pinned(), moduleKey, 'recover_item', commandValue); void operation.catch(() => undefined)
    let revoked: Promise<Awaited<ReturnType<typeof command>>> | undefined, finished = false
    try {
      await Promise.race([pause.ready, operation.then(() => { throw new Error('Expected staged recovery before revocation') })])
      revoked = command(kind === 'credential' ? { kind: 'credential.revoke', appId, credentialId: issued.credentialId } : { kind: 'grant.revoke', appId, grantId: parentGrantId })
        .then(response => { finished = true; return response }, error => { finished = true; throw error })
      void revoked.catch(() => undefined)
      const waiter = await waitForBlocker(pause.pid(), ['UPDATE application_api_credentials', 'UPDATE application_access_grants'], () => finished)
      expect(waiter, 'Revocation must commit before releasing the final lease boundary').toBeUndefined()
      expect((await revoked).status).toBe(200)
    } finally { pause.release(); await Promise.allSettled([operation, ...(revoked ? [revoked] : [])]) }
    await expect(operation).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(await operationState(id, commandValue.idempotencyKey)).toEqual(before)
    await expect(sdk().command('recover_item', commandValue)).rejects.toBeDefined()
    expect(await operationState(id, commandValue.idempotencyKey)).toEqual(before)
  }, 60_000)

  it.each(['recovery', 'revocation'] as const)('[S2-06] orders role revocation without deadlock when %s wins', async winner => {
    await settledBlocker()
    const catalog = await checked({ kind: 'governance.catalog', input: { moduleKey } })
    const assignment = catalog.roleAssignments.find((row: { userId: string }) => row.userId === serviceUserId)
    const review = await checked({ kind: 'governance.preview', input: { moduleKey, expectedRevision: catalog.revision,
      operation: { kind: 'revoke_role', assignmentId: assignment.id, expectedVersion: assignment.version } } })
    const id = rows[0], commandValue = recover(id), before = await operationState(id, commandValue.idempotencyKey)
    // Role apply owns workspace UPDATE; a revocation-first pause must precede
    // service workspace SHARE, rather than manufacturing a circular wait.
    const pause = schedulingPool(sql => winner === 'recovery' ? sql.startsWith('INSERT INTO application_committed_events') : sql === 'BEGIN')
    const service = new ApplicationPlatformService([createCanonicalGenericApplicationModule(), definition()], pause.pool)
    const operation = service.command(await pinned(), moduleKey, 'recover_item', commandValue); void operation.catch(() => undefined)
    let revoked: Promise<Awaited<ReturnType<typeof command>>> | undefined
    try {
      await Promise.race([pause.ready, operation.then(() => { throw new Error('Expected a scheduled recovery boundary') })])
      revoked = command({ kind: 'governance.apply', reviewId: review.id, input: {} }).then(response => response); void revoked.catch(() => undefined)
      if (winner === 'recovery') {
        expect(await waitForBlocker(pause.pid(), ['application_apply_native_governance_review('])).toBeDefined()
        expect((await owner.query('SELECT status FROM application_native_role_assignments WHERE id=$1', [assignment.id])).rows[0].status).toBe('active')
      } else expect((await revoked).status).toBe(200)
    } finally { pause.release(); await Promise.allSettled([operation, ...(revoked ? [revoked] : [])]) }
    expect((await revoked!).status).toBe(200)
    expect((await owner.query('SELECT status FROM application_native_role_assignments WHERE id=$1', [assignment.id])).rows[0].status).toBe('revoked')
    if (winner === 'revocation') {
      await expect(operation).rejects.toMatchObject({ reason: 'authority_changed' })
      expect(await operationState(id, commandValue.idempotencyKey)).toEqual(before)
    } else {
      expect(await operation).toMatchObject({ effect: 'committed' })
      expect(await operationState(id, commandValue.idempotencyKey)).toMatchObject({ row: { version: '2', data: { state: text('closed') } }, receipts: 1, audit: 1, events: 1, callbacks: 1 })
    }
    const denied = recover(rows[1]); const untouched = await operationState(rows[1], denied.idempotencyKey)
    await expect(sdk().command('recover_item', denied)).rejects.toBeDefined()
    expect(await operationState(rows[1], denied.idempotencyKey)).toEqual(untouched)
  }, 60_000)

  it('keeps the same genuine service generation for first recovery in draining and disabled while refusing new work and stale leases', async () => {
    const client = sdk(), created = randomUUID(), savedGeneration = await generation()
    await client.command('new_item', { idempotencyKey: randomUUID(), input: { id: created } })
    const stale = await pinned(); expect((await lifecycle('request_disable')).module.state).toBe('draining')
    await expect(stale.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    for (const key of ['new_item', 'commerce_item']) {
      await expect(client.command(key, { idempotencyKey: randomUUID(), input: { id: randomUUID() } })).rejects.toMatchObject({ code: 'module_draining', status: 409, effect: 'none', retrySafe: false })
      await expect(platform.command(await pinned(), moduleKey, key, { idempotencyKey: randomUUID(), input: { id: randomUUID() } })).rejects.toMatchObject({ code: 'module_draining' })
      await observeTransportRefusal(key, 'module_draining')
    }
    const request = recover(rows[0]), receipt = await client.command('recover_item', request)
    expect(await client.command('recover_item', request)).toEqual(receipt)
    expect(await client.reconcile('recover_item', request)).toEqual({ state: 'applied', receipt })
    const checked = await mcp(false, 'applicationReconcile', 'recover_item', request)
    expect(checked.isError).not.toBe(true); expect(JSON.parse(checked.content[0].text)).toEqual({ state: 'applied', receipt })
    expect((await native('recover_item', recover(rows[1]))).status).toBe(200)
    await client.command('recover_item', recover(created))
    const drainingLease = await pinned(); expect((await lifecycle('finish_disable')).module.state).toBe('disabled')
    await expect(drainingLease.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(await client.command('recover_item', recover(rows[2]))).toMatchObject({ effect: 'committed' })
    expect((await native('recover_item', recover(rows[3]))).status).toBe(200)
    for (const key of ['new_item', 'commerce_item']) {
      await expect(client.command(key, { idempotencyKey: randomUUID(), input: { id: randomUUID() } })).rejects.toMatchObject({ code: 'module_disabled', status: 409, effect: 'none', retrySafe: false })
      await expect(platform.command(await pinned(), moduleKey, key, { idempotencyKey: randomUUID(), input: { id: randomUUID() } })).rejects.toMatchObject({ code: 'module_disabled' })
      await observeTransportRefusal(key, 'module_disabled')
    }
    expect(await generation()).toEqual(savedGeneration)
    expect((await owner.query('SELECT count(*)::int AS count FROM application_operation_receipts WHERE id=$1', [receipt.id])).rows[0].count).toBe(1)
    expect((await owner.query("SELECT application_runtime_qualified($1,'application_data') AS ready", [workspaceId])).rows[0].ready).toBe(false)
  }, 60_000)
  it('keeps service, frontend and reviewed delegation qualification distinct from inactive activation and exact pending reviews', async () => {
    const apps = [appId], pending: Array<{ id: string; reviewId: string }> = []
    pending.push({ id: appId, reviewId: (await checked({ kind: 'activation.review', appId })).id })
    for (const delegated of [false, true]) {
      const app = await checked({ kind: 'register', input: { moduleKey, name: 'Fictional recovery browser', mode: 'external_frontend', origins: ['https://portal.example'], redirectUris: ['https://portal.example/callback'] } })
      oauthClients.push(app.oauthClientId); apps.push(app.id); await activate(app.id, delegated ? 'canonical_app_delegation_v1' : undefined)
      pending.push({ id: app.id, reviewId: (await checked({ kind: 'activation.review', appId: app.id, ...(delegated ? { profile: 'canonical_app_delegation_v1' } : {}) })).id })
    }
    expect((await lifecycle('request_disable')).module.state).toBe('disabled')
    for (const id of apps) {
      expect((await owner.query('SELECT application_scoped_qualified($1,$2) AS ready', [workspaceId, id])).rows[0].ready).toBe(true)
      expect((await command({ kind: 'activation.review', appId: id })).status).toBe(403)
    }
    for (const value of pending) expect((await command({ kind: 'activation.apply', appId: value.id, reviewId: value.reviewId })).status).not.toBe(200)
    await lifecycle('enable')
    for (const value of pending) expect((await command({ kind: 'activation.apply', appId: value.id, reviewId: value.reviewId })).status).not.toBe(200)
  }, 60_000)
  it.each(['draining', 'disabled'] as const)('holds new grants, keys, pending issuance and service-role authority while %s', async state => {
    if (state === 'draining') await sdk().command('new_item', { idempotencyKey: randomUUID(), input: { id: randomUUID() } })
    const proposal = (await owner.query('SELECT proposed_grant FROM application_grant_reviews WHERE app_id=$1 LIMIT 1', [appId])).rows[0].proposed_grant
    const credential = (await owner.query('SELECT proposal FROM application_credential_reviews WHERE app_id=$1 LIMIT 1', [appId])).rows[0].proposal
    const pendingGrant = await checked({ kind: 'grant.review', appId, input: proposal })
    const pendingKey = await checked({ kind: 'credential.review', appId, input: credential })
    expect(pendingGrant.canIssue).toBe(true); expect(pendingKey.canIssue).toBe(true)
    const target = (await checked({ kind: 'service.prepare', appId, input: { name: 'Fictional inactive target', idempotencyKey: randomUUID() } })).serviceUserId
    serviceUsers.push(target)
    const beforeRoleCatalog = await checked({ kind: 'governance.catalog', input: { moduleKey } })
    const roleProposal = { kind: 'assign_role', userId: target, roleKey: 'operator', startsAt: '2020-01-01T00:00:00Z', expiresAt: null }
    const pendingRole = await checked({ kind: 'governance.preview', input: { moduleKey, expectedRevision: beforeRoleCatalog.revision, operation: roleProposal } })
    const counts = async () => (await owner.query('SELECT (SELECT count(*)::int FROM application_access_grants WHERE app_id=$1) AS grants,(SELECT count(*)::int FROM application_api_credentials WHERE app_id=$1) AS keys', [appId])).rows[0]
    const before = await counts()
    expect((await lifecycle('request_disable')).module.state).toBe(state)
    for (const value of [{ kind: 'grant.review', appId, input: proposal }, { kind: 'credential.review', appId, input: credential }]) {
      const response = await command(value)
      expect.soft(response.status === 403 || response.status === 200 && response.body.canIssue === false,
        JSON.stringify({ kind: value.kind, status: response.status, canIssue: response.body.canIssue })).toBe(true)
    }
    expect.soft((await command({ kind: 'grant.apply', appId, reviewId: pendingGrant.id })).status).not.toBe(200)
    expect.soft((await command({ kind: 'credential.deliver', appId, reviewId: pendingKey.id })).status).not.toBe(200)
    expect((await command({ kind: 'governance.apply', reviewId: pendingRole.id, input: {} })).status).not.toBe(200)
    expect(await counts()).toEqual(before)
    const catalog = await checked({ kind: 'governance.catalog', input: { moduleKey } })
    expect((await command({ kind: 'governance.preview', input: { moduleKey, expectedRevision: catalog.revision,
      operation: roleProposal } })).status).toBe(403)
    expect((await owner.query('SELECT id FROM application_native_role_assignments WHERE workspace_id=$1 AND user_id=$2', [workspaceId, target])).rows).toEqual([])
  }, 60_000)
  it.each(['grant', 'credential', 'activation'] as const)('refuses pending %s authority when an existing-row shutdown wins admission', async kind => {
    // Materialize only through the normal lifecycle API; this schedule requires
    // an existing module row, whose transition does not take workspace UPDATE.
    if ((await modules.get(workspaceId, moduleKey)).version === 0) await lifecycle('enable')
    const existing = (await owner.query('SELECT state,version FROM workspace_modules WHERE workspace_id=$1 AND module_key=$2', [workspaceId, moduleKey])).rows
    expect(existing).toHaveLength(1); expect(existing[0].state).toBe('enabled')
    const pending = kind === 'activation' ? await checked({ kind: 'activation.review', appId })
      : kind === 'grant' ? await checked({ kind: 'grant.review', appId, input: (await owner.query('SELECT proposed_grant FROM application_grant_reviews WHERE app_id=$1 ORDER BY created_at,id LIMIT 1', [appId])).rows[0].proposed_grant })
      : await checked({ kind: 'credential.review', appId, input: (await owner.query('SELECT proposal FROM application_credential_reviews WHERE app_id=$1 ORDER BY created_at,id LIMIT 1', [appId])).rows[0].proposal })
    if (kind === 'activation') expect(pending.profile).toBe('canonical_module_service_v1')
    else expect(pending.canIssue).toBe(true)
    const authority = async () => (await owner.query(`SELECT
      (SELECT count(*)::int FROM application_access_grants WHERE app_id=$1) AS grants,
      (SELECT count(*)::int FROM application_api_credentials WHERE app_id=$1) AS credentials,
      (SELECT count(*)::int FROM application_authority_events WHERE app_id=$1) AS events,
      (SELECT consumed_grant_id FROM application_grant_reviews WHERE id=$2) AS "consumedGrant",
      (SELECT consumed_credential_id FROM application_credential_reviews WHERE id=$2) AS "consumedCredential",
      (SELECT consumed FROM application_activation_reviews WHERE id=$2) AS "consumedActivation",
      (SELECT to_jsonb(a) FROM application_scoped_activations a WHERE app_id=$1) AS activation`, [appId, pending.id])).rows[0]
    const before = await authority()
    expect(before.consumedGrant).toBeNull(); expect(before.consumedCredential).toBeNull()
    expect(before.consumedActivation).toBe(kind === 'activation' ? false : null)
    const mutation = kind === 'grant' ? 'grant.apply' : kind === 'credential' ? 'credential.deliver' : 'activation.apply'
    const entry = kind === 'grant' ? 'application_apply_grant_review(' : kind === 'credential' ? 'application_apply_credential_review(' : 'application_apply_activation('
    let pauseReached!: () => void, releasePause!: () => void, shutdownPid = 0
    const reached = new Promise<void>(resolve => { pauseReached = resolve })
    const pause = new Promise<void>(resolve => { releasePause = resolve })
    const pausedPool = { connect: async () => {
      const client = await getAppPool().connect()
      shutdownPid = Number((await client.query('SELECT pg_backend_pid() AS pid')).rows[0].pid)
      return new Proxy(client, { get(target, key) {
        const value = Reflect.get(target, key)
        if (key === 'query') return async (...args: unknown[]) => {
          const result = await Reflect.apply(value, target, args)
          // Scheduling only: the real protected UPDATE and its epoch trigger
          // have completed, and their row locks remain held until COMMIT.
          if (typeof args[0] === 'string' && args[0].startsWith('UPDATE workspace_modules')) { pauseReached(); await pause }
          return result
        }
        return typeof value === 'function' ? value.bind(target) : value
      } })
    } } as unknown as Pool
    const shutdownStore = createWorkspaceModulesStore(owner, pausedPool, { registry: platform.registry.workspaceModules, lifecycles: { [moduleKey]: {
      readBlockingWork: async client => [{ key: 'open_work', count: Number((await client.query("SELECT count(*) FROM entity_instances WHERE workspace_id=$1 AND entity_type_id=$2 AND data#>>'{blocksShutdown,value}'='true' AND data#>>'{state,value}'='open'", [workspaceId, typeId])).rows[0].count) }],
    } } })
    const shutdown = shutdownStore.act(workspaceId, ownerId, moduleKey, { action: 'request_disable', expectedVersion: Number(existing[0].version) })
    void shutdown.catch(() => undefined)
    let applying: Promise<Awaited<ReturnType<typeof command>>> | undefined
    let observed: { pid: number; waitEventType: string; waitEvent: string; blockers: number[]; locks: Array<{ relation: string | null; mode: string; granted: boolean; locktype: string }> } | undefined
    try {
      await Promise.race([reached, shutdown.then(() => { throw new Error('Shutdown committed before the scheduling boundary') })])
      applying = command({ kind: mutation, appId, reviewId: pending.id }).then(response => response)
      void applying.catch(() => undefined)
      const deadline = Date.now() + 10_000
      while (Date.now() < deadline) {
        const activity = await owner.query(`SELECT a.pid,a.wait_event_type AS "waitEventType",a.wait_event AS "waitEvent",pg_blocking_pids(a.pid) AS blockers,
          coalesce((SELECT jsonb_agg(jsonb_build_object('relation',l.relation::regclass::text,'mode',l.mode,'granted',l.granted,'locktype',l.locktype)) FROM pg_locks l WHERE l.pid=a.pid),'[]'::jsonb) AS locks
          FROM pg_stat_activity a WHERE a.datname=current_database() AND a.pid<>pg_backend_pid()
          AND position($1 in a.query)>0 AND a.wait_event_type='Lock'`, [entry])
        observed = activity.rows.find(row => row.blockers.includes(shutdownPid))
        if (observed) break
        // Yield between actual lock observations; elapsed delay is never proof.
        await new Promise<void>(resolve => setImmediate(resolve))
      }
      expect(observed, `Expected ${mutation} to wait on the uncommitted shutdown`).toBeDefined()
      expect(observed!.waitEvent).toBe('transactionid')
      expect(observed!.locks.some(lock => lock.relation === 'workspace_modules' && lock.mode === 'RowShareLock' && lock.granted)).toBe(true)
      expect(await authority()).toEqual(before)
      console.info('[S2-05] observed issuance module waiter', JSON.stringify({ mutation, shutdownPid, ...observed, locks: observed!.locks.filter(lock => lock.locktype === 'transactionid' || ['application_policy_workspace_epochs', 'workspace_modules', 'application_access_grants', 'application_api_credentials', 'application_scoped_activations'].includes(lock.relation ?? '')) }))
    } finally {
      releasePause()
      await Promise.allSettled([shutdown, ...(applying ? [applying] : [])])
    }
    const transitioned = await shutdown, response = await applying!, after = await authority()
    console.info('[S2-05] shutdown/apply outcome', JSON.stringify({ mutation, shutdown: transitioned, status: response.status, error: response.body.error, unchangedAuthority: JSON.stringify(before) === JSON.stringify(after) }))
    expect(transitioned).toMatchObject({ changed: true, module: { state: 'disabled', version: Number(existing[0].version) + 1 } })
    expect((await modules.get(workspaceId, moduleKey)).state).toBe('disabled')
    expect(response.status, JSON.stringify({ error: response.body.error, effect: response.body.effect })).toBe(403)
    expect(response.body).toEqual({ error: 'access_unavailable', effect: 'none', retrySafe: true })
    expect(after).toEqual(before)
  }, 60_000)
  it('refuses unknown saved metadata and current schema, configuration and port drift without normalizing other keys', async () => {
    const original = (await generation()).deployed_snapshot
    await owner.query("UPDATE application_scoped_activations SET deployed_snapshot=deployed_snapshot||'{\"unexpected\":true}'::jsonb WHERE app_id=$1", [appId])
    try { await expect(sdk().get(typeKey, rows[0])).rejects.toBeDefined() } finally { await owner.query('UPDATE application_scoped_activations SET deployed_snapshot=$2 WHERE app_id=$1', [appId, original]) }
    expect(await sdk().get(typeKey, rows[0])).toBeDefined()
    const definition = (await owner.query("SELECT pg_get_functiondef('module_lifecycle_fixture_metadata(uuid,jsonb,text,text)'::regprocedure) AS definition")).rows[0].definition as string
    await owner.query(definition.replace('DECLARE catalog jsonb;', 'DECLARE catalog jsonb; /* Fictional deployed drift */'))
    try { await expect(sdk().get(typeKey, rows[0])).rejects.toBeDefined() } finally { await owner.query(definition) }
    expect(await sdk().get(typeKey, rows[0])).toBeDefined()
    const preview = await management.previewSchema(ownerId, workspaceId, typeId, { expectedVersion: 1, properties: [...properties, { name: 'note', config: { kind: 'text' } }] })
    await management.applySchema(ownerId, workspaceId, preview.id, {})
    await expect(sdk().get(typeKey, rows[0])).rejects.toBeDefined()
  }, 60_000)
  it('refuses a changed verified configuration with the original credential', async () => {
    expect(await sdk().get(typeKey, rows[0])).toBeDefined()
    await govern({ kind: 'configure', operationKey: 'set_schema', input: { schemaId: typeId } })
    await expect(sdk().get(typeKey, rows[0])).rejects.toBeDefined()
  })
  it.each(['credential', 'parent', 'role'] as const)('keeps %s revocation effective for otherwise lifecycle-admitted recovery', async kind => {
    await lifecycle('request_disable'); expect(await sdk().get(typeKey, rows[0])).toBeDefined()
    if (kind === 'credential') await checked({ kind: 'credential.revoke', appId, credentialId: issued.credentialId })
    if (kind === 'parent') await checked({ kind: 'grant.revoke', appId, grantId: parentGrantId })
    if (kind === 'role') {
      const catalog = await checked({ kind: 'governance.catalog', input: { moduleKey } })
      const role = catalog.roleAssignments.find((row: { userId: string }) => row.userId === serviceUserId)
      await govern({ kind: 'revoke_role', assignmentId: role.id, expectedVersion: role.version })
    }
    await expect(sdk().command('recover_item', recover(rows[0]))).rejects.toBeDefined()
    expect((await owner.query('SELECT data FROM entity_instances WHERE id=$1', [rows[0]])).rows[0].data.state.value).toBe('open')
  })
})
