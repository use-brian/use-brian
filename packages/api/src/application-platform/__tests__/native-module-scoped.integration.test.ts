/** Exact-ID native relational modules use ordinary reviewed service authority. */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import express from 'express'
import request from 'supertest'
import type { PoolClient } from 'pg'
import type { ApplicationModuleDefinition, ApplicationOperationContext } from '@use-brian/core'
import { ApplicationPlatformError, type ApplicationResourceRef } from '@use-brian/shared'
import { applyRLSGucs, getPool, getAppPool } from '../../db/client.js'
import { createWorkspaceModulesStore } from '../../db/workspace-modules-store.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createTokens } from '../../auth/jwt.js'
import { requireAuth } from '../../auth/middleware.js'
import { applicationPlatformRoutes } from '../../routes/application-platform.js'
import { ApplicationPlatformService } from '../service.js'
import { ApplicationManagementService } from '../management.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const moduleKey = 'fictional_native_notes', origin = { kind: 'native' as const, moduleKey }, typeKey = 'note'
type Context = ApplicationOperationContext<PoolClient>
const selection = z.object({ id: z.string().min(1).max(256), fields: z.array(z.string()).default(['label']) }).strict()
const mutation = z.object({ id: z.string().min(1).max(256), label: z.string() }).strict()

describe.sequential('[COMP:api/application-management] [COMP:api/application-records] exact-ID native module service', () => {
  const owner = getPool(), workspaceId = randomUUID(), foreignWorkspaceId = randomUUID(), ownerId = randomUUID(), assistantId = randomUUID()
  const secret = 'fictional-native-note-session', ids = ['107', 'note:opaque/alpha'], callbacks = new Map<string, number>()
  let appId: string, serviceUserId: string, token: string, credential: { secret: string; credentialId: string }, parentGrantId: string, leafGrantId: string
  const http = express(); http.use(express.json())
  const server = http.listen(0, '127.0.0.1'); let apiOrigin: string
  async function read(context: Context, id: string, fields = ['label'], action = 'read') {
    return (await context.transaction.query('SELECT native_note_fixture_access($1,$2,$3,$4,$5,$6::text[],NULL,NULL) AS value',
      [context.execution.security.access.workspaceId, origin, typeKey, id, action, fields])).rows[0].value
  }
  const definition: ApplicationModuleDefinition<PoolClient> = {
    key: moduleKey, defaultState: 'enabled', application: { version: '1', dependencies: [],
      resources: [{ typeKey, origin, schemaVersion: '1', fields: [{ key: 'label', label: 'Purpose label', kind: 'text' }, { key: 'private_note', label: 'Private note', kind: 'text' }] }],
      queries: ['get'], commands: ['rename_note'], events: ['note.renamed'], policyCapabilities: [], backgroundHandlers: [], uiContributions: [] },
    queries: { get: { input: selection, authorize: async (context, raw) => { const input = selection.parse(raw); await read(context, input.id, input.fields) },
      execute: async (context, raw) => { const input = selection.parse(raw); return read(context, input.id, input.fields) },
      authorizeResult: async (context, raw) => { const value = raw as { ref: ApplicationResourceRef }; await read(context, value.ref.id) } } },
    commands: { rename_note: { input: mutation, eventKey: 'note.renamed',
      authorize: async (context, raw) => { await read(context, mutation.parse(raw).id, ['label'], 'command:rename_note') },
      execute: async (context, raw) => {
        const input = mutation.parse(raw), result = (await context.transaction.query('SELECT native_note_fixture_access($1,$2,$3,$4,$5,$6::text[],$7,$8) AS value',
          [context.execution.security.access.workspaceId, origin, typeKey, input.id, 'command:rename_note', ['label'], input.label, context.expectedVersion ?? null])).rows[0].value
        context.afterCommit(() => callbacks.set(context.idempotencyKey, (callbacks.get(context.idempotencyKey) ?? 0) + 1))
        return [result.ref]
      }, authorizeResult: async (context, refs) => { for (const ref of refs) { if (ref.origin.kind !== 'native' || ref.origin.moduleKey !== moduleKey || ref.typeKey !== typeKey) throw new ApplicationPlatformError('access_unavailable', 'Unavailable note.'); await read(context, ref.id) } } } }
  }
  const platform = new ApplicationPlatformService([definition]), management = new ApplicationManagementService(platform)
  const base = `/api/applications/workspaces/${workspaceId}`
  const command = (value: Record<string, unknown>) => request(apiOrigin).post(base + '/management/commands').set('Authorization', 'Bearer ' + token).set('Origin', 'https://host.example').send(value)
  async function checked(value: Record<string, unknown>) { const response = await command(value); expect(response.status, JSON.stringify({ kind: value.kind, body: response.body })).toBe(200); return response.body }
  const proposal = (extra: Record<string, unknown> = {}) => ({ principal: { kind: 'service', userId: serviceUserId }, origin, typeKey,
    actions: ['read', 'command:rename_note'], readFields: ['label'], writeFields: ['label'], selector: { kind: 'ids', ids }, parentGrantId: null,
    expiresAt: null, compartments: [], projectIds: [], clearance: 'internal', ...extra })
  async function grant(input = proposal()) { const review = await checked({ kind: 'grant.review', appId, input }); expect(review.canIssue, JSON.stringify(review)).toBe(true); return (await checked({ kind: 'grant.apply', appId, reviewId: review.id })).grantId as string }
  const service = (path: 'query' | 'command' | 'reconcile', value: { queryKey?: string; input?: object; commandKey?: string; command?: object }, bearer = credential.secret) => {
    const endpoint = path === 'query' ? `queries/${value.queryKey}` : `commands/${value.commandKey}${path === 'reconcile' ? '/reconcile' : ''}`
    return request(apiOrigin).post(`/api/applications/${appId}/${endpoint}`).set('Authorization', 'Bearer ' + bearer).send(path === 'query' ? value.input : value.command)
  }
  const get = (id = ids[0], fields = ['label']) => service('query', { queryKey: 'get', input: { id, fields } })
  const rename = (id: string, label: string, expectedVersion = '1', key = randomUUID()) => service('command', { commandKey: 'rename_note', command: { idempotencyKey: key, expectedVersion, input: { id, label } } })
  const counts = async () => (await owner.query(`SELECT (SELECT count(*)::int FROM application_operation_receipts WHERE workspace_id=$1 AND module_key=$2) AS receipts,
    (SELECT count(*)::int FROM application_command_audit WHERE workspace_id=$1 AND module_key=$2) AS audits,(SELECT count(*)::int FROM application_committed_events WHERE workspace_id=$1 AND module_key=$2) AS events`, [workspaceId, moduleKey])).rows[0]
  beforeAll(async () => {
    if (!server.listening) await once(server, 'listening'); apiOrigin = `http://127.0.0.1:${(server.address() as { port: number }).port}`
    await owner.query("INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)", [ownerId])
    for (const id of [workspaceId, foreignWorkspaceId]) {
      await owner.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional native notes',$2)", [id, ownerId])
      await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [id, ownerId])
    }
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional note assistant',$2,$3,'primary','confidential')", [assistantId, ownerId, workspaceId])
    await owner.query(`CREATE TABLE native_note_fixture_config(workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,revision bigint NOT NULL DEFAULT 1,catalog_version text NOT NULL DEFAULT '1',held boolean NOT NULL DEFAULT false,catalog_user uuid);
      CREATE TABLE native_note_fixture_rows(workspace_id uuid REFERENCES workspaces(id) ON DELETE CASCADE,id text,created_by uuid NOT NULL,label_released boolean NOT NULL DEFAULT true,label text NOT NULL CHECK(length(btrim(label))>0),private_note text NOT NULL,sensitivity text NOT NULL DEFAULT 'internal' CHECK(sensitivity IN('public','internal','confidential')),compartments text[] NOT NULL DEFAULT '{}',project_ids uuid[] NOT NULL DEFAULT '{}',row_user uuid,version bigint NOT NULL DEFAULT 1,policy_version text NOT NULL DEFAULT '1',PRIMARY KEY(workspace_id,id));
      ALTER TABLE native_note_fixture_rows ENABLE ROW LEVEL SECURITY; ALTER TABLE native_note_fixture_config ENABLE ROW LEVEL SECURITY;
      REVOKE ALL ON native_note_fixture_rows,native_note_fixture_config FROM PUBLIC,app_user;
      CREATE FUNCTION native_note_fixture_revision(w uuid) RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT revision::text FROM public.native_note_fixture_config WHERE workspace_id=w $$;
      REVOKE ALL ON FUNCTION native_note_fixture_revision(uuid) FROM PUBLIC;
      CREATE FUNCTION native_note_fixture_catalog(w uuid,o jsonb,t text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE c public.native_note_fixture_config;BEGIN
        SELECT * INTO c FROM public.native_note_fixture_config WHERE workspace_id=w;
        IF c.workspace_id IS NULL OR c.held OR o<>'{"kind":"native","moduleKey":"fictional_native_notes"}'::jsonb OR t<>'note' THEN RETURN NULL;END IF;
        RETURN jsonb_build_object('moduleKey','fictional_native_notes','origin',o,'typeKey',t,'schemaVersion',c.catalog_version,'policyVersion',c.revision::text,'fieldKeys','["label","private_note"]'::jsonb,
          'fields','[{"key":"label","read":[],"write":[],"releaseReadTo":["service"],"releaseWriteTo":["service"]},{"key":"private_note","read":[["private_reader"]],"write":[["private_reader"]],"releaseReadTo":[],"releaseWriteTo":[]}]'::jsonb,
          'scope',jsonb_build_object('workspaceId',w,'userId',c.catalog_user,'assistantId',NULL,'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb));END $$;
      REVOKE ALL ON FUNCTION native_note_fixture_catalog(uuid,jsonb,text) FROM PUBLIC;
      CREATE FUNCTION native_note_fixture_metadata(w uuid,o jsonb,t text,i text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE r public.native_note_fixture_rows;catalog jsonb;BEGIN
        SELECT * INTO r FROM public.native_note_fixture_rows WHERE workspace_id=w AND id=i;
        IF r.id IS NULL THEN RETURN NULL;END IF;catalog:=public.native_note_fixture_catalog(w,o,t);IF catalog IS NULL THEN RETURN NULL;END IF;
        IF NOT r.label_released THEN catalog:=jsonb_set(catalog,'{fields,0,releaseReadTo}','[]'::jsonb);catalog:=jsonb_set(catalog,'{fields,0,releaseWriteTo}','[]'::jsonb);END IF;
        RETURN (catalog-'scope')||jsonb_build_object('policyVersion',r.policy_version,'recordVersion',r.version::text,'source',(catalog->'scope')||jsonb_build_object('version',r.version::text,'held',false,'validTo',NULL,'retractedAt',NULL,'sensitivity',r.sensitivity,'compartments',r.compartments,'projectIds',r.project_ids,'userId',r.row_user));END $$;
      REVOKE ALL ON FUNCTION native_note_fixture_metadata(uuid,jsonb,text,text) FROM PUBLIC;
      CREATE FUNCTION native_note_fixture_access(w uuid,o jsonb,t text,i text,action text,selected text[],new_label text,expected text) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE r public.native_note_fixture_rows;context jsonb;mask jsonb;fields jsonb;BEGIN
        IF EXISTS(SELECT 1 FROM pg_roles role JOIN pg_class storage ON storage.oid='public.native_note_fixture_rows'::regclass WHERE role.rolname=session_user AND (role.rolsuper OR role.rolbypassrls OR pg_has_role(role.oid,storage.relowner,'USAGE')))
          OR o<>'{"kind":"native","moduleKey":"fictional_native_notes"}'::jsonb OR t<>'note' OR action NOT IN('read','command:rename_note') OR selected IS NULL OR cardinality(selected)=0 THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
        context:=public.application_current_maxima();
        IF context IS NULL OR context->>'workspaceId' IS DISTINCT FROM w::text OR NOT EXISTS(SELECT 1 FROM public.application_clients c WHERE c.id=(context->>'appId')::uuid AND c.workspace_id=w AND c.module_key='fictional_native_notes')
          OR action='command:rename_note' AND (current_setting('app.application_command_key',true) IS DISTINCT FROM 'rename_note' OR current_setting('app.deployed_application_module',true) IS DISTINCT FROM 'fictional_native_notes') THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
        SELECT * INTO r FROM public.native_note_fixture_rows WHERE workspace_id=w AND id=i FOR UPDATE;
        IF r.id IS NULL THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
        mask:=public.application_resource_fields(w,o,t,i,r.created_by,r.sensitivity,r.compartments,r.project_ids,r.row_user,action);
        fields:=CASE action WHEN 'read' THEN mask->'read' ELSE mask->'write' END;
        IF fields IS NULL OR NOT to_jsonb(selected)<@fields THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
        IF new_label IS NOT NULL THEN
          IF action<>'command:rename_note' OR selected<>ARRAY['label'] THEN RAISE EXCEPTION 'access_unavailable' USING ERRCODE='42501';END IF;
          IF expected IS DISTINCT FROM r.version::text THEN RAISE EXCEPTION 'record_version_conflict' USING ERRCODE='40001';END IF;
          UPDATE public.native_note_fixture_rows SET label=new_label,version=version+1 WHERE workspace_id=w AND id=i RETURNING * INTO r;
        END IF;
        RETURN jsonb_build_object('ref',jsonb_build_object('workspaceId',w,'origin',o,'typeKey',t,'id',r.id,'version',r.version::text),'values',CASE WHEN selected=ARRAY['label'] THEN jsonb_build_object('label',r.label) ELSE '{}'::jsonb END);
      END $$;
      REVOKE ALL ON FUNCTION native_note_fixture_access(uuid,jsonb,text,text,text,text[],text,text) FROM PUBLIC;
      GRANT EXECUTE ON FUNCTION native_note_fixture_access(uuid,jsonb,text,text,text,text[],text,text) TO app_user;
      INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required,configuration_reader)
        VALUES('fictional_native_notes','1',ARRAY['private_reader'],'native_note_fixture_metadata(uuid,jsonb,text,text)'::regprocedure,'native_note_fixture_catalog(uuid,jsonb,text)'::regprocedure,true,'native_note_fixture_revision(uuid)'::regprocedure);
      INSERT INTO application_deployed_module_capabilities(module_key,contract_version,commands,queries,dependencies) VALUES('fictional_native_notes','1',ARRAY['rename_note'],ARRAY['get'],'{}')`)
    await owner.query('INSERT INTO native_note_fixture_config(workspace_id) VALUES($1),($2)', [workspaceId, foreignWorkspaceId])
    for (const work of [workspaceId, foreignWorkspaceId]) for (const id of ids) await owner.query("INSERT INTO native_note_fixture_rows(workspace_id,id,created_by,label,private_note) VALUES($1,$2,$3,'Existing purpose','Private fixture data')", [work, id, ownerId])
    await owner.query("INSERT INTO native_note_fixture_rows(workspace_id,id,created_by,label,private_note) VALUES($1,'foreign-only',$2,'Foreign purpose','Private foreign data')", [foreignWorkspaceId, ownerId])
    await owner.query('INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,$2,$3,$4)', [workspaceId, origin, typeKey, moduleKey])
    const session = await authSessionStore.create(ownerId, { deviceLabel: 'Fictional note browser', userAgent: 'Fixture', ipAddress: '127.0.0.1' }); token = createTokens(ownerId, secret, session!).accessToken
    http.use('/api/applications', applicationPlatformRoutes({ service: platform, management: { service: management, requireAuth: requireAuth(secret), origins: ['https://host.example'] } }))
    expect((await getAppPool().query(`SELECT session_user,current_user,rolsuper,rolbypassrls,pg_has_role(oid,(SELECT relowner FROM pg_class WHERE oid='native_note_fixture_rows'::regclass),'USAGE') AS owns,pg_has_role(oid,(SELECT relowner FROM pg_class WHERE oid='native_note_fixture_rows'::regclass),'MEMBER') AS owner_member FROM pg_roles WHERE rolname=current_user`)).rows)
      .toEqual([{ session_user: 'app_user', current_user: 'app_user', rolsuper: false, rolbypassrls: false, owns: false, owner_member: false }])
  }, 60_000)
  afterAll(async () => {
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()))
    await owner.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])', [[workspaceId, foreignWorkspaceId]])
    await owner.query("DELETE FROM application_deployed_module_capabilities WHERE module_key='fictional_native_notes';DELETE FROM application_native_field_contracts WHERE module_key='fictional_native_notes'")
    await owner.query('DROP FUNCTION native_note_fixture_access(uuid,jsonb,text,text,text,text[],text,text);DROP FUNCTION native_note_fixture_metadata(uuid,jsonb,text,text);DROP FUNCTION native_note_fixture_catalog(uuid,jsonb,text);DROP FUNCTION native_note_fixture_revision(uuid);DROP TABLE native_note_fixture_rows,native_note_fixture_config')
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ownerId, ...(serviceUserId ? [serviceUserId] : [])]])
    await getAppPool().end(); await owner.end()
  })
  it('preserves the four lifecycle consumers except their private revision call and keeps the new port owner-only', async () => {
    const historical = await readFile(new URL('../../../migrations/8052_application_native_governance_completion.sql', import.meta.url), 'utf8')
    for (const [name, signature, result, runtimeEntry] of [
      ['application_prepare_native_module_lifecycle', 'uuid,text,text,integer,text', 'void', true],
      ['application_guard_native_module_lifecycle', '', 'trigger', false],
      ['application_record_native_module_lifecycle', '', 'trigger', false],
      ['application_finish_native_module_lifecycle', 'uuid,text', 'void', true],
    ] as const) {
      const expectedBody = new RegExp('CREATE FUNCTION ' + name + '\\([^\\n]*\\).*?AS \\$\\$(.*?)\\$\\$;', 's').exec(historical)?.[1]
      expect(expectedBody).toBeTruthy()
      const row = (await owner.query(`SELECT p.prosrc,p.prosecdef,p.provolatile,p.proparallel,p.proisstrict,p.proleakproof,p.proretset,p.prokind,p.prorettype::regtype::text AS result,
        p.proconfig,p.proowner=c.relowner AS owner_matches,
        (SELECT jsonb_agg(jsonb_build_object('role',CASE WHEN a.grantee=p.proowner THEN 'owner' ELSE pg_get_userbyid(a.grantee) END,
          'grantor_matches',a.grantor=p.proowner,'privilege',a.privilege_type,'grant_option',a.is_grantable) ORDER BY a.grantee=p.proowner DESC)
          FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a) AS acl
        FROM pg_proc p JOIN pg_class c ON c.oid='public.application_native_field_contracts'::regclass WHERE p.oid=$1::regprocedure`, [name + '(' + signature + ')'])).rows[0]
      expect(row.prosrc).toBe(expectedBody!.replace('application_native_governance_revision(', 'application_native_module_lifecycle_revision('))
      const { prosrc: _, ...properties } = row
      expect(properties).toEqual({ prosecdef: true, provolatile: 'v', proparallel: 'u', proisstrict: false, proleakproof: false, proretset: false, prokind: 'f', result,
        proconfig: ['search_path=pg_catalog, public, pg_temp'], owner_matches: true,
        acl: [{ role: 'owner', grantor_matches: true, privilege: 'EXECUTE', grant_option: false }, ...(runtimeEntry ? [{ role: 'app_user', grantor_matches: true, privilege: 'EXECUTE', grant_option: false }] : [])] })
    }
    expect((await owner.query(`SELECT p.prosecdef,p.proowner=c.relowner AS owner_matches,
      NOT EXISTS(SELECT 1 FROM aclexplode(coalesce(p.proacl,acldefault('f',p.proowner))) a WHERE a.grantee<>p.proowner) AS private
      FROM pg_proc p JOIN pg_class c ON c.oid='public.application_native_field_contracts'::regclass
      WHERE p.oid='application_native_module_lifecycle_revision(uuid,uuid,text)'::regprocedure`)).rows).toEqual([{ prosecdef: true, owner_matches: true, private: true }])
  })
  it('normally reviews native activation and exact-ID grants before delivering a genuine service key', async () => {
    expect((await owner.query("SELECT application_runtime_qualified($1,'application_data') AS qualified", [workspaceId])).rows[0].qualified).toBe(false)
    appId = (await checked({ kind: 'register', input: { moduleKey, name: 'Fictional native note application', mode: 'api_client', origins: [], redirectUris: [] } })).id
    const review = await checked({ kind: 'activation.review', appId }); expect(review.profile).toBe('canonical_module_service_v1'); expect(review.scope.resources).toEqual(['native'])
    await checked({ kind: 'activation.apply', appId, reviewId: review.id })
    serviceUserId = (await checked({ kind: 'service.prepare', appId, input: { name: 'Fictional note service', idempotencyKey: randomUUID() } })).serviceUserId
    parentGrantId = await grant(); leafGrantId = await grant(proposal({ parentGrantId }))
    const keyReview = await checked({ kind: 'credential.review', appId, input: { kind: 'service', name: 'Fictional note key', serviceUserId, grantIds: [leafGrantId], expiresAt: new Date(Date.now() + 3600_000).toISOString() } })
    expect(keyReview.canIssue).toBe(true); credential = await checked({ kind: 'credential.deliver', appId, reviewId: keyReview.id })
  }, 60_000)

  it('keeps decimal-text and opaque IDs, checks purpose fields and denies raw/private ports', async () => {
    for (const id of ids) { const result = await get(id); expect(result.status, JSON.stringify(result.body)).toBe(200); expect(result.body).toEqual({ ref: { workspaceId, origin, typeKey, id, version: '1' }, values: { label: 'Existing purpose' } }) }
    expect((await get(ids[0], ['private_note'])).status).toBe(403)
    expect((await get('foreign-only')).status).toBe(403)
    expect((await service('query', { queryKey: 'get', input: { id: ids[0], workspaceId: foreignWorkspaceId } })).status).toBe(400)
    for (const sql of ['SELECT label FROM native_note_fixture_rows', 'UPDATE native_note_fixture_rows SET label=label',
      "SELECT native_note_fixture_catalog($1,$2,'note')", "SELECT native_note_fixture_metadata($1,$2,'note','107')",
      "SELECT native_note_fixture_access($1,$2,'note','107','read',ARRAY['label'],NULL,NULL)"]) {
      await expect(getAppPool().query(sql, sql.includes('$1') ? [workspaceId, origin] : [])).rejects.toMatchObject({ code: '42501' })
    }
    expect(await counts()).toEqual({ receipts: 0, audits: 0, events: 0 })
  })
  it('refuses foreign/unknown origins/types, unimplemented actions/selectors and private release fields through normal reviews', async () => {
    const invalid = [proposal({ origin: { kind: 'native', moduleKey: 'foreign_notes' } }), proposal({ typeKey: 'unknown_note' }),
      proposal({ readFields: ['private_note'] }), proposal({ writeFields: ['private_note'] }), proposal({ selector: { kind: 'self' } }),
      proposal({ selector: { kind: 'relationship', resolverKey: 'fictional.link', anchorId: ids[0] } }), proposal({ selector: { kind: 'ids', ids: ['foreign-only'] } }),
      proposal({ actions: ['create'] }), proposal({ actions: ['patch'] }), proposal({ actions: ['command:undeclared'] })]
    for (const input of invalid) { const response = await command({ kind: 'grant.review', appId, input }); expect([403, 409], JSON.stringify({ input, body: response.body })).toContain(response.status) }
    expect((await service('command', { commandKey: 'undeclared', command: { idempotencyKey: randomUUID(), input: { id: ids[0] } } })).status).toBe(403)
    expect((await owner.query('SELECT count(*)::int AS count FROM application_access_grants WHERE app_id=$1', [appId])).rows[0].count).toBe(2)
    expect(await counts()).toEqual({ receipts: 0, audits: 0, events: 0 })
  })
  it('rolls back domain and CAS failures and commits each semantic update, receipt, audit and event once', async () => {
    const before = await counts()
    const domain = await rename(ids[0], ''); expect(domain.status, JSON.stringify(domain.body)).toBe(400); expect(domain.body).toMatchObject({ error: 'invalid_value', effect: 'none' })
    const stale = await rename(ids[0], 'Stale attempt', '0'); expect(stale.status, JSON.stringify(stale.body)).toBe(409); expect(stale.body).toMatchObject({ error: 'record_version_conflict', effect: 'none' })
    await owner.query(`CREATE FUNCTION native_note_fixture_event_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional event refusal' USING ERRCODE='22023';END $$;
      CREATE TRIGGER native_note_fixture_event_refusal BEFORE INSERT ON application_committed_events FOR EACH ROW WHEN (NEW.module_key='fictional_native_notes') EXECUTE FUNCTION native_note_fixture_event_refusal()`)
    try { const refused = await rename(ids[0], 'Must roll back'); expect(refused.status, JSON.stringify(refused.body)).toBe(400); expect(refused.body.effect).toBe('none') }
    finally { await owner.query('DROP TRIGGER native_note_fixture_event_refusal ON application_committed_events;DROP FUNCTION native_note_fixture_event_refusal()') }
    expect(await counts()).toEqual(before); expect((await get()).body.ref.version).toBe('1'); expect(callbacks.size).toBe(0)
    for (const id of ids) {
      const key = randomUUID(), value = { commandKey: 'rename_note', command: { idempotencyKey: key, expectedVersion: '1', input: { id, label: 'Reviewed purpose' } } }
      const first = await service('command', value); expect(first.status, JSON.stringify(first.body)).toBe(200); expect(first.body.resources).toEqual([{ workspaceId, origin, typeKey, id, version: '2' }])
      const replay = await service('command', value); expect(replay.status).toBe(200); expect(replay.body).toEqual(first.body)
      const reconciled = await service('reconcile', value); expect(reconciled.status).toBe(200); expect(reconciled.body).toMatchObject({ state: 'applied', receipt: first.body })
      expect(callbacks.get(key)).toBe(1)
      for (const table of ['application_command_audit', 'application_committed_events']) expect((await owner.query(`SELECT count(*)::int AS count FROM ${table} WHERE receipt_id=$1`, [first.body.id])).rows[0].count).toBe(1)
    }
    expect(await counts()).toEqual({ receipts: 2, audits: 2, events: 2 })
    expect((await owner.query('SELECT id,label,version::text FROM native_note_fixture_rows WHERE workspace_id=$1 ORDER BY id', [workspaceId])).rows).toEqual(ids.map(id => ({ id, label: 'Reviewed purpose', version: '2' })))
    expect((await owner.query('SELECT id,label,version::text FROM native_note_fixture_rows WHERE workspace_id=$1 ORDER BY id', [foreignWorkspaceId])).rows).toEqual([{ id: '107', label: 'Existing purpose', version: '1' }, { id: 'foreign-only', label: 'Foreign purpose', version: '1' }, { id: 'note:opaque/alpha', label: 'Existing purpose', version: '1' }])
  })
  it('refuses changed reviewed source facts before apply without consuming a review or creating authority', async () => {
    const review = await checked({ kind: 'grant.review', appId, input: proposal() }), before = (await owner.query('SELECT count(*)::int AS count FROM application_access_grants WHERE app_id=$1', [appId])).rows[0].count
    await owner.query('UPDATE native_note_fixture_rows SET version=version+1 WHERE workspace_id=$1 AND id=$2', [workspaceId, ids[0]])
    const denied = await command({ kind: 'grant.apply', appId, reviewId: review.id }); expect(denied.status, JSON.stringify(denied.body)).toBe(409); expect(denied.body).toMatchObject({ error: 'record_version_conflict', effect: 'none' })
    expect((await owner.query('SELECT consumed_grant_id FROM application_grant_reviews WHERE id=$1', [review.id])).rows[0].consumed_grant_id).toBeNull()
    expect((await owner.query('SELECT count(*)::int AS count FROM application_access_grants WHERE app_id=$1', [appId])).rows[0].count).toBe(before)
  })
  it('intersects the current row policy at reads and writes and holds config/catalog/issuer drift', async () => {
    const before = await counts()
    await owner.query("UPDATE native_note_fixture_rows SET label_released=false,policy_version='2' WHERE workspace_id=$1 AND id=$2", [workspaceId, ids[0]])
    expect((await get()).status).toBe(403); expect((await rename(ids[0], 'Forbidden policy change', '3')).status).toBe(403)
    await owner.query("UPDATE native_note_fixture_rows SET label_released=true,policy_version='3' WHERE workspace_id=$1 AND id=$2", [workspaceId, ids[0]])
    expect((await get()).status).toBe(200)
    await owner.query("UPDATE native_note_fixture_rows SET sensitivity='confidential' WHERE workspace_id=$1 AND id=$2", [workspaceId, ids[0]])
    try { expect((await get()).status).toBe(403); expect((await rename(ids[0], 'Forbidden source label', '3')).status).toBe(403) }
    finally { await owner.query("UPDATE native_note_fixture_rows SET sensitivity='internal' WHERE workspace_id=$1 AND id=$2", [workspaceId, ids[0]]) }
    expect((await get()).status).toBe(200)
    await owner.query('UPDATE native_note_fixture_config SET held=true WHERE workspace_id=$1', [workspaceId])
    try { expect([401, 403]).toContain((await get()).status) }
    finally { await owner.query('UPDATE native_note_fixture_config SET held=false WHERE workspace_id=$1', [workspaceId]) }
    expect((await get()).status).toBe(200)
    for (const column of ['revision', 'catalog_version']) {
      await owner.query(`UPDATE native_note_fixture_config SET ${column}=${column === 'revision' ? '2' : "'2'"} WHERE workspace_id=$1`, [workspaceId])
      const denied = await get(); expect([401, 403], JSON.stringify(denied.body)).toContain(denied.status)
      await owner.query(`UPDATE native_note_fixture_config SET ${column}=${column === 'revision' ? '1' : "'1'"} WHERE workspace_id=$1`, [workspaceId])
      expect((await get()).status).toBe(200)
    }
    await owner.query('GRANT EXECUTE ON FUNCTION native_note_fixture_catalog(uuid,jsonb,text) TO app_user')
    try { expect([401, 403]).toContain((await get()).status) }
    finally { await owner.query('REVOKE EXECUTE ON FUNCTION native_note_fixture_catalog(uuid,jsonb,text) FROM app_user') }
    expect((await get()).status).toBe(200)
    const port = (await owner.query("SELECT pg_get_functiondef('native_note_fixture_metadata(uuid,jsonb,text,text)'::regprocedure) AS definition")).rows[0].definition as string
    await owner.query(port.replace('DECLARE r public.native_note_fixture_rows;', 'DECLARE /* current deployed body changed */ r public.native_note_fixture_rows;'))
    try { expect([401, 403]).toContain((await get()).status) }
    finally { await owner.query(port) }
    expect((await get()).status).toBe(200)
    await owner.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, ownerId])
    expect([401, 403]).toContain((await get()).status)
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential')", [workspaceId, ownerId])
    expect((await get()).status).toBe(200); expect(await counts()).toEqual(before)
  })
  const nativeModules = (readBlockingWork = async () => [] as Array<{ key: string; count: number }>) => createWorkspaceModulesStore(owner, getAppPool(), {
    registry: { [moduleKey]: { key: moduleKey, defaultState: 'enabled' } }, lifecycles: { [moduleKey]: { readBlockingWork } },
  })
  async function nativeFrame<T>(fn: (client: PoolClient) => Promise<T>, settings: Record<string, string> = {}) {
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client, ownerId)
      for (const [key, value] of Object.entries(settings)) await client.query('SELECT set_config($1,$2,true)', [key, value])
      return await fn(client)
    } finally { await client.query('ROLLBACK'); client.release() }
  }
  const lifecycleRows = async () => (await owner.query('SELECT * FROM application_native_module_lifecycle_reviews WHERE workspace_id=$1', [workspaceId])).rows
  it('controls custom-native manual availability while private fields and complete governance remain denied', async () => {
    const modules = nativeModules(async () => [{ key: 'pending', count: 1 }])
    expect(await nativeFrame(async client => (await client.query("SELECT read_native_application_field_catalog($1,$2,$3) AS value", [workspaceId, origin, typeKey])).rows[0].value))
      .toMatchObject({ readFields: ['label'], writeFields: ['label'] })
    const draining = await modules.act(workspaceId, ownerId, moduleKey, { action: 'request_disable', expectedVersion: 0 })
    expect(draining).toMatchObject({ changed: true, module: { state: 'draining', version: 2 } })
    await expect(modules.act(workspaceId, ownerId, moduleKey, { action: 'finish_disable', expectedVersion: 2 })).rejects.toMatchObject({ code: 'module_drain_pending' })
    expect(await nativeModules().act(workspaceId, ownerId, moduleKey, { action: 'finish_disable', expectedVersion: 2 })).toMatchObject({ module: { state: 'disabled', version: 3 } })
    expect(await nativeModules().act(workspaceId, ownerId, moduleKey, { action: 'enable', expectedVersion: 3 })).toMatchObject({ module: { state: 'enabled', version: 4 } })
    expect(await nativeModules().act(workspaceId, ownerId, moduleKey, { action: 'enable', expectedVersion: 4 })).toMatchObject({ changed: false, module: { state: 'enabled', version: 4 } })
    expect((await get(ids[0], ['private_note'])).status).toBe(403)
    await expect(nativeFrame(client => client.query('SELECT read_native_application_governance_catalog($1,$2,$3,NULL)', [workspaceId, assistantId, moduleKey]))).rejects.toMatchObject({ code: '42501' })
    expect((await owner.query("SELECT count(*)::int AS count FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='workspace.module_changed'", [workspaceId])).rows[0].count).toBe(3)
    expect(await lifecycleRows()).toEqual([])
  })
  it('rejects raw updates, owner sessions, wrong native identities and unknown or stale lifecycle commands', async () => {
    const prepare = (client: PoolClient) => client.query("SELECT application_prepare_native_module_lifecycle($1,$2,'request_disable',4,'enabled')", [workspaceId, moduleKey])
    const deniedSettings: Array<Record<string, string>> = [
      { 'app.current_user_id': randomUUID() }, { 'app.v2_assistant_id': randomUUID() },
      { 'app.application_id': appId }, { 'app.agent_actor_id': randomUUID() }, { 'app.agent_workspace_id': foreignWorkspaceId },
    ]
    for (const settings of deniedSettings) await expect(nativeFrame(prepare, settings)).rejects.toMatchObject({ code: '42501' })
    await expect(nativeFrame(client => client.query("UPDATE workspace_modules SET state='disabled',version=version+1,updated_by_user_id=$2 WHERE workspace_id=$1 AND module_key=$3", [workspaceId, ownerId, moduleKey]))).rejects.toMatchObject({ code: '42501' })
    await expect(nativeFrame(client => client.query('SELECT application_native_module_lifecycle_revision($1,$2,$3)', [workspaceId, assistantId, moduleKey]))).rejects.toMatchObject({ code: '42501' })
    const ownerModules = createWorkspaceModulesStore(owner, owner, { registry: { [moduleKey]: { key: moduleKey, defaultState: 'enabled' } } })
    await expect(ownerModules.act(workspaceId, ownerId, moduleKey, { action: 'request_disable', expectedVersion: 4 })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(nativeModules().act(workspaceId, serviceUserId, moduleKey, { action: 'request_disable', expectedVersion: 4 })).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(nativeModules().act(workspaceId, ownerId, 'unknown_module', { action: 'enable', expectedVersion: 4 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(nativeModules().act(workspaceId, ownerId, moduleKey, { action: 'invented' as never, expectedVersion: 4 })).rejects.toMatchObject({ code: 'invalid_input' })
    await expect(nativeModules().act(workspaceId, ownerId, moduleKey, { action: 'request_disable', expectedVersion: 3 })).rejects.toMatchObject({ code: 'stale_module_version' })
    expect(await lifecycleRows()).toEqual([])
  })
  it('keeps the manual witness private and bound to its action, actor and backend', async () => {
    const prepare = (client: PoolClient) => client.query("SELECT application_prepare_native_module_lifecycle($1,$2,'request_disable',4,'enabled')", [workspaceId, moduleKey])
    await expect(nativeFrame(async client => {
      await prepare(client)
      await client.query("UPDATE workspace_modules SET state='enabled',version=version+1,updated_by_user_id=$2 WHERE workspace_id=$1 AND module_key=$3", [workspaceId, ownerId, moduleKey])
    })).rejects.toMatchObject({ code: '40001' })
    await expect(nativeFrame(async client => {
      await prepare(client); await client.query("SELECT set_config('app.current_user_id',$1,true)", [randomUUID()])
      await client.query('SELECT application_finish_native_module_lifecycle($1,$2)', [workspaceId, moduleKey])
    })).rejects.toMatchObject({ code: '40001' })
    await nativeFrame(async client => {
      await prepare(client)
      await expect(nativeFrame(other => other.query("UPDATE workspace_modules SET state='disabled',version=version+1,updated_by_user_id=$2 WHERE workspace_id=$1 AND module_key=$3", [workspaceId, ownerId, moduleKey]))).rejects.toMatchObject({ code: '42501' })
    })
    await expect(nativeFrame(client => client.query('SELECT * FROM application_native_module_lifecycle_reviews'))).rejects.toMatchObject({ code: '42501' })
    expect(await lifecycleRows()).toEqual([])
  })
  it('refuses every unavailable catalog and mixed owner instead of borrowing one visible catalog', async () => {
    for (const column of ['held', 'catalog_user']) {
      await owner.query(`UPDATE native_note_fixture_config SET ${column}=$2 WHERE workspace_id=$1`, [workspaceId, column === 'held' ? true : randomUUID()])
      try { await expect(nativeModules().act(workspaceId, ownerId, moduleKey, { action: 'request_disable', expectedVersion: 4 })).rejects.toMatchObject({ code: 'not_authorized' }) }
      finally { await owner.query(`UPDATE native_note_fixture_config SET ${column}=$2 WHERE workspace_id=$1`, [workspaceId, column === 'held' ? false : null]) }
    }
    await owner.query('INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,$2,$3,$4)', [workspaceId, origin, 'unknown_note', moduleKey])
    try { await expect(nativeModules().act(workspaceId, ownerId, moduleKey, { action: 'request_disable', expectedVersion: 4 })).rejects.toMatchObject({ code: 'not_authorized' }) }
    finally { await owner.query('DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND origin=$2 AND resource_type=$3', [workspaceId, origin, 'unknown_note']) }
    const schema = await createDbDocEntityStore({ actorUserId: ownerId }).createEntityType({ workspaceId, name: 'Fictional mixed availability', createdBy: ownerId,
      properties: [{ name: 'title', config: { kind: 'text' }, required: true }] })
    const generic = { kind: 'generic', entityTypeId: schema.id }
    await owner.query('INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,$2,$3,$4)', [workspaceId, generic, 'record.' + schema.id, moduleKey])
    try { await expect(nativeModules().act(workspaceId, ownerId, moduleKey, { action: 'request_disable', expectedVersion: 4 })).rejects.toMatchObject({ code: 'not_authorized' }) }
    finally { await owner.query('DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND origin=$2', [workspaceId, generic]) }
    expect(await lifecycleRows()).toEqual([])
  })
  it.each(['configuration', 'policy', 'body', 'acl'] as const)('invalidates the private manual review after %s drift across the actual blocker await', async kind => {
    const port = (await owner.query("SELECT pg_get_functiondef('native_note_fixture_metadata(uuid,jsonb,text,text)'::regprocedure) AS definition")).rows[0].definition as string
    let changed = false
    const modules = nativeModules(async () => {
      if (!changed) {
        changed = true
        if (kind === 'configuration') {
          await owner.query("UPDATE native_note_fixture_config SET catalog_version='changed',revision=revision+1 WHERE workspace_id=$1", [workspaceId])
          await owner.query("UPDATE native_note_fixture_config SET catalog_version='1',revision=revision+1 WHERE workspace_id=$1", [workspaceId])
        }
        if (kind === 'policy') {
          await owner.query("UPDATE application_native_field_contracts SET contract_version='changed' WHERE module_key=$1", [moduleKey])
          await owner.query("UPDATE application_native_field_contracts SET contract_version='1' WHERE module_key=$1", [moduleKey])
        }
        if (kind === 'body') await owner.query(port.replace('DECLARE r public.native_note_fixture_rows;', 'DECLARE /* changed availability witness */ r public.native_note_fixture_rows;'))
        if (kind === 'acl') await owner.query('GRANT EXECUTE ON FUNCTION native_note_fixture_metadata(uuid,jsonb,text,text) TO app_user')
      }
      return []
    })
    try { await expect(modules.act(workspaceId, ownerId, moduleKey, { action: 'request_disable', expectedVersion: 4 })).rejects.toMatchObject({ code: kind === 'acl' ? 'not_authorized' : 'stale_module_version' }) }
    finally {
      if (kind === 'configuration') await owner.query('UPDATE native_note_fixture_config SET revision=1 WHERE workspace_id=$1', [workspaceId])
      if (kind === 'body') await owner.query(port)
      if (kind === 'acl') await owner.query('REVOKE EXECUTE ON FUNCTION native_note_fixture_metadata(uuid,jsonb,text,text) FROM app_user')
    }
    expect(await nativeModules().get(workspaceId, moduleKey)).toMatchObject({ state: 'enabled', version: 4 }); expect(await lifecycleRows()).toEqual([])
  })
  it('rolls module state, audit and private review back together when the canonical audit refuses', async () => {
    await owner.query(`CREATE FUNCTION native_note_fixture_audit_refusal() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fictional availability audit refusal';END $$;
      CREATE TRIGGER native_note_fixture_audit_refusal BEFORE INSERT ON workspace_audit_log FOR EACH ROW WHEN (NEW.workspace_id='${workspaceId}'::uuid) EXECUTE FUNCTION native_note_fixture_audit_refusal()`)
    try { await expect(nativeModules().act(workspaceId, ownerId, moduleKey, { action: 'request_disable', expectedVersion: 4 })).rejects.toThrow('fictional availability audit refusal') }
    finally { await owner.query('DROP TRIGGER native_note_fixture_audit_refusal ON workspace_audit_log;DROP FUNCTION native_note_fixture_audit_refusal()') }
    expect(await nativeModules().get(workspaceId, moduleKey)).toMatchObject({ state: 'enabled', version: 4 }); expect(await lifecycleRows()).toEqual([])
    expect((await owner.query("SELECT count(*)::int AS count FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='workspace.module_changed'", [workspaceId])).rows[0].count).toBe(3)
  })
  it('refuses parent and credential revocation with no new business or operation effects', async () => {
    const before = await counts()
    await checked({ kind: 'grant.revoke', appId, grantId: parentGrantId })
    expect([401, 403]).toContain((await get()).status); expect([401, 403]).toContain((await rename(ids[0], 'Revoked parent', '3')).status)
    const replacement = await grant(), review = await checked({ kind: 'credential.review', appId, input: { kind: 'service', name: 'Fictional replacement key', serviceUserId, grantIds: [replacement], expiresAt: new Date(Date.now() + 3600_000).toISOString() } })
    credential = await checked({ kind: 'credential.deliver', appId, reviewId: review.id }); expect((await get()).status).toBe(200)
    await checked({ kind: 'credential.revoke', appId, credentialId: credential.credentialId })
    expect([401, 403]).toContain((await get()).status); expect([401, 403]).toContain((await rename(ids[0], 'Revoked credential', '3')).status)
    expect(await counts()).toEqual(before)
  })
})
