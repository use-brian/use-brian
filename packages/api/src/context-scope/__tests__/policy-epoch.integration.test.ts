import { randomUUID,randomBytes } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest'
import type { PoolClient } from 'pg'
import { getAppPool,getPool,applyRLSGucs } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { createMemory, updateMemory } from '../../db/memories.js'
import { ContextScopeAccumulator,executionToolContext,NOOP_TURN_LEDGER,boundScopeSources,
  type ExecutionContext,type LLMProvider } from '@use-brian/core'
import { findAssistantById,findOrCreateUser } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { runAssistantTurn } from '../../turn/kernel.js'
import type { ApplicationAccessGrant,ApplicationGrantMaximum,ApplicationRecordProjection,ApplicationQuery } from '@use-brian/shared'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { hashSecret } from '../../db/api-key-store.js'
import { authenticateApplicationCredential,mintApplicationCredentialSecret } from '../../application-platform/credentials.js'
import { loadApplicationCredentialStateSystem } from '../../application-platform/auth-store.js'
import { authenticateApplicationOAuth } from '../../application-platform/oauth-auth.js'
import { resolveApplicationExecutionContext } from '../../application-platform/execution-context.js'
import { ApplicationPlatformService } from '../../application-platform/service.js'
import { createCanonicalGenericApplicationModule } from '../../application-platform/generic-adapter.js'
import { parseManifest } from '@use-brian/brian-app'
import { findOrCreateSession } from '../../db/sessions.js'
import { authenticateApplicationHome } from '../../application-platform/home-auth.js'
import { mintBridgeToken } from '../../home-apps/tokens.js'
import { createWorkspaceStore,type WorkspacePickerPreferenceUpdate } from '../../db/workspace-store.js'
import { ApplicationManagementService } from '../../application-platform/management.js'
import { assertSourceModelInputAuthority } from '../../application-platform/model-source-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/policy-epoch] canonical invocation policy epochs', () => {
  const owner = getPool(),workspaceId = randomUUID(),otherWorkspaceId = randomUUID()
  const ownerId = randomUUID(),memberId = randomUUID(),otherId = randomUUID(),assistantId = randomUUID(),externalId = randomUUID(),adminId = randomUUID()
  const userIds: string[] = [ownerId,memberId,otherId,externalId,adminId],oauthClients: string[] = []
  const store = createDbDocEntityStore({ actorUserId: ownerId })
  beforeAll(async () => {
    for (const id of userIds) await owner.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[id])
    for (const id of [workspaceId,otherWorkspaceId]) {
      await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional field policy workspace',$2,false)",[id,ownerId])
      for (const [user,role] of [[ownerId,'owner'],[memberId,'member'],[otherId,'member'],[adminId,'admin']]) await owner.query(
        'INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)',[id,user,role,role === 'owner' || role === 'admin' ? 'confidential' : 'internal'])
    }
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional policy assistant',$2,$3,'primary','confidential')",[assistantId,ownerId,workspaceId])
    await owner.query(`CREATE TABLE application_epoch_fixture_metadata (
      resource_id uuid PRIMARY KEY,fields jsonb NOT NULL,policy_version text NOT NULL DEFAULT '1')`)
    await owner.query(`CREATE FUNCTION application_epoch_fixture_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE r entity_instances; schema entity_types; policy application_epoch_fixture_metadata;
      BEGIN
        SELECT * INTO r FROM entity_instances WHERE workspace_id=w AND id=i::uuid AND entity_type_id=(o->>'entityTypeId')::uuid;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO schema FROM entity_types WHERE id=r.entity_type_id AND workspace_id=w;
        SELECT * INTO policy FROM application_epoch_fixture_metadata WHERE resource_id=r.id;
        RETURN jsonb_build_object('moduleKey',(SELECT module_key FROM application_native_resource_owners WHERE workspace_id=w AND origin=o AND resource_type=t),
          'origin',o,'typeKey','record.'||schema.id,'schemaVersion',schema.schema_version::text,
          'policyVersion',policy.policy_version,'recordVersion',r.record_version::text,
          'fieldKeys',(SELECT jsonb_agg(p->'name' ORDER BY p->>'name') FROM jsonb_array_elements(schema.properties) p),
          'fields',policy.fields,'source',read_scope_source(w,'entity_instance',r.id));
      END $$`)
    await owner.query('REVOKE ALL ON FUNCTION application_epoch_fixture_reader(uuid,jsonb,text,text) FROM PUBLIC')
    await owner.query(`CREATE TABLE application_epoch_fixture_catalog (
      type_id uuid PRIMARY KEY REFERENCES entity_types(id) ON DELETE CASCADE,fields jsonb NOT NULL,
      policy_version text NOT NULL DEFAULT '1',override jsonb NOT NULL DEFAULT '{}')`)
    await owner.query(`CREATE FUNCTION application_epoch_fixture_catalog_reader(w uuid,o jsonb,t text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE schema entity_types; policy application_epoch_fixture_catalog;
      BEGIN
        SELECT * INTO schema FROM entity_types WHERE workspace_id=w AND id=(o->>'entityTypeId')::uuid;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO policy FROM application_epoch_fixture_catalog WHERE type_id=schema.id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        RETURN jsonb_build_object('moduleKey',(SELECT module_key FROM application_native_resource_owners WHERE workspace_id=w AND origin=o AND resource_type=t),
          'origin',o,'typeKey','record.'||schema.id,'schemaVersion',schema.schema_version::text,
          'policyVersion',policy.policy_version,'fieldKeys',(SELECT jsonb_agg(p->'name' ORDER BY p->>'name') FROM jsonb_array_elements(schema.properties) p),
          'fields',policy.fields,'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,
            'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb))||policy.override;
      END $$`)
    await owner.query('REVOKE ALL ON FUNCTION application_epoch_fixture_catalog_reader(uuid,jsonb,text) FROM PUBLIC')
    await owner.query(`CREATE SEQUENCE application_epoch_fixture_revision`)
    await owner.query(`CREATE TABLE application_epoch_fixture_configuration (
      workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
      revision bigint NOT NULL DEFAULT nextval('application_epoch_fixture_revision'),state text NOT NULL DEFAULT 'initial')`)
    await owner.query(`INSERT INTO application_epoch_fixture_configuration(workspace_id) VALUES($1)`,[workspaceId])
    await owner.query(`CREATE FUNCTION application_epoch_fixture_configuration_changed() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
      NEW.revision:=nextval('public.application_epoch_fixture_revision'); RETURN NEW; END $$`)
    await owner.query(`CREATE TRIGGER application_epoch_fixture_configuration_changed BEFORE UPDATE ON application_epoch_fixture_configuration
      FOR EACH ROW EXECUTE FUNCTION application_epoch_fixture_configuration_changed()`)
    await owner.query(`CREATE FUNCTION application_epoch_fixture_configuration_reader(w uuid) RETURNS text
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      SELECT revision::text FROM public.application_epoch_fixture_configuration WHERE workspace_id=w $$`)
    await owner.query('REVOKE ALL ON FUNCTION application_epoch_fixture_configuration_reader(uuid) FROM PUBLIC')
    await owner.query(`CREATE FUNCTION application_epoch_fixture_catalog_changed() RETURNS trigger
      LANGUAGE plpgsql SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
      UPDATE public.application_epoch_fixture_configuration SET state=state; RETURN NULL; END $$`)
    await owner.query(`CREATE TRIGGER application_epoch_fixture_catalog_changed AFTER UPDATE ON application_epoch_fixture_catalog
      FOR EACH ROW EXECUTE FUNCTION application_epoch_fixture_catalog_changed()`)
    for (const module of ['epoch_fixture','epoch_fixture_other']) await owner.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader,configuration_required,configuration_reader)
      VALUES($1,'1',ARRAY['finance','approver'],'application_epoch_fixture_reader(uuid,jsonb,text,text)'::regprocedure,
        CASE WHEN $1='epoch_fixture' THEN 'application_epoch_fixture_catalog_reader(uuid,jsonb,text)'::regprocedure ELSE NULL END,true,'application_epoch_fixture_configuration_reader(uuid)'::regprocedure)`,[module])
  })
  afterAll(async () => {
    await owner.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[[workspaceId,otherWorkspaceId]])
    await owner.query('DELETE FROM application_native_field_contracts WHERE module_key=ANY($1::text[])',[['epoch_fixture','epoch_fixture_other']])
    await owner.query('DROP FUNCTION application_epoch_fixture_reader(uuid,jsonb,text,text)')
    await owner.query('DROP FUNCTION application_epoch_fixture_catalog_reader(uuid,jsonb,text)')
    await owner.query('DROP FUNCTION application_epoch_fixture_configuration_reader(uuid)')
    await owner.query('DROP TABLE application_epoch_fixture_configuration')
    await owner.query('DROP FUNCTION application_epoch_fixture_configuration_changed()')
    await owner.query('DROP SEQUENCE application_epoch_fixture_revision')
    await owner.query('DROP TABLE application_epoch_fixture_metadata')
    await owner.query('DROP TABLE application_epoch_fixture_catalog')
    await owner.query('DROP FUNCTION application_epoch_fixture_catalog_changed()')
    if (oauthClients.length) await owner.query('DELETE FROM oauth_clients WHERE client_id=ANY($1::text[])',[oauthClients])
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[userIds])
    await getAppPool().end();await owner.end()
  })
  function fields() {
    return [
      { key: 'title',read: [],write: [],releaseReadTo: ['external_user','service'],releaseWriteTo: ['service'] },
      { key: 'cost',read: [['finance']],write: [['finance'],['approver']],releaseReadTo: [],releaseWriteTo: [] },
    ]
  }
  async function catalogType(module = 'epoch_fixture',claim = true) {
    const schema = await store.createEntityType({ workspaceId,name: `Fictional purchases ${randomUUID()}`,createdBy: ownerId,
      properties: [{ name: 'title',config: { kind: 'text' } },{ name: 'cost',config: { kind: 'number',format: 'decimal' } }] })
    const origin = { kind: 'generic' as const,entityTypeId: schema.id },type = `record.${schema.id}`
    const catalog = { schema,origin,type }
    if (claim) await claimCatalog(catalog,module)
    return catalog
  }
  async function claimCatalog(catalog: { schema: { id: string };origin: { kind: 'generic';entityTypeId: string };type: string },module: string) {
    await owner.query('INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,$2,$3,$4)',[workspaceId,catalog.origin,catalog.type,module])
    await owner.query('INSERT INTO application_epoch_fixture_catalog(type_id,fields) VALUES($1,$2)',[catalog.schema.id,JSON.stringify(fields())])
  }
  async function record(includeCost = true,module = 'epoch_fixture') {
    const catalog = await catalogType(module,false),{ schema } = catalog
    const row = await store.createEntity({ workspaceId,entityTypeId: schema.id,createdBy: ownerId,lastEditedBy: ownerId,sourceApp: 'api',
      data: { title: { kind: 'text',value: 'Fictional request' },...(includeCost ? { cost: { kind: 'number' as const,value: 42 } } : {}) } })
    // Establish existing synthetic data before attaching its protected module.
    // The owner principal receives no implicit field role from this setup.
    await claimCatalog(catalog,module)
    const recordVersion = row.recordVersion
    if (!recordVersion) throw new Error('The canonical fixture requires its persisted record version.')
    await owner.query('INSERT INTO application_epoch_fixture_metadata(resource_id,fields) VALUES($1,$2)',[row.id,JSON.stringify(fields())])
    return { ...catalog,row: { ...row,recordVersion } }
  }
  async function asMember<T>(userId: string,operation: (client: PoolClient) => Promise<T>) {
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN');await applyRLSGucs(client,userId)
      expect((await client.query(`SELECT r.rolsuper,r.rolbypassrls,c.relowner=r.oid AS owns
        FROM pg_roles r,pg_class c WHERE r.rolname=current_user AND c.oid='application_native_role_assignments'::regclass`)).rows[0])
        .toEqual({ rolsuper: false,rolbypassrls: false,owns: false })
      const result = await operation(client);await client.query('COMMIT');return result
    } finally { await client.query('ROLLBACK');client.release() }
  }
  async function assign(role = 'finance',user = memberId,module = 'epoch_fixture',workspace = workspaceId,starts = '2020-01-01T00:00:00Z',expires: string | null = null) {
    return (await owner.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id,starts_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[workspace,module,user,role,ownerId,starts,expires])).rows[0].id as string
  }
  async function clearRoles() { await owner.query('DELETE FROM application_native_role_assignments WHERE workspace_id=ANY($1::uuid[])',[[workspaceId,otherWorkspaceId]]) }
  async function nativeExecution(userId = memberId,session?: Awaited<ReturnType<typeof findOrCreateSession>>) {
    return (await resolveExecutionContextSystem({ userId,workspaceId,assistant: (await findAssistantById(assistantId))!,memberMode: 'member',
      identity: { kind: 'attended',principal: { kind: 'workspace_member',userId,authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace',workspaceId },...(session ? { session,sessionAuthority: session } : {}),lifecycle: { sessionId: session?.id ?? randomUUID(),sessionPersisted: !!session,
        channelId: 'native-field-fixture',channelType: 'test',abortSignal: new AbortController().signal } })).executionContext
  }
  async function application(fixture: Awaited<ReturnType<typeof catalogType>> & { row?: { id: string } },kind: 'member' | 'external_user' | 'service',parentIssuer?: string,
    actions: ApplicationAccessGrant['actions'] = ['read','query','history','patch'],selector?: ApplicationAccessGrant['selector']) {
    const appId = randomUUID(),grantId = randomUUID(),parentId = parentIssuer ? randomUUID() : null
    const selection = selector ?? (fixture.row ? { kind: 'ids' as const,ids: [fixture.row.id] } : undefined)
    if (!selection) throw new Error('The fixture requires an explicit selector for an empty type.')
    let userId: string = kind === 'member' ? memberId : externalId
    if (kind === 'service') {
      userId = (await findOrCreateUser({ authProvider: 'channel',authProviderId: `app-service:${appId}:${randomUUID()}`,
        name: 'Fictional policy service',onboarding: 'application' })).user.id
      userIds.push(userId)
    }
    await owner.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id,origins)
      VALUES($1,$2,'records','Fictional policy client','api_client',$3,$4,ARRAY['https://frontend.example'])`,[appId,workspaceId,assistantId,ownerId])
    const grant = (id: string,parentGrantId: string | null): ApplicationAccessGrant => ({ id,appId,workspaceId,principal: { kind,userId },origin: fixture.origin,typeKey: fixture.type,
      actions,readFields: ['title','cost'],writeFields: ['title','cost'],selector: selection,
      version: 1,status: 'active',startsAt: '2020-01-01T00:00:00.000Z',expiresAt: null,parentGrantId,compartments: [],projectIds: [],clearance: 'confidential' })
    const path = [grant(grantId,parentId),...(parentId ? [grant(parentId,null)] : [])]
    for (const value of [...path].reverse()) await owner.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
      resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance,parent_grant_id,starts_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$11,'{}','{}','confidential',$12,$13)`,[
      value.id,appId,workspaceId,kind,userId,value.id === parentId ? parentIssuer : ownerId,fixture.origin,fixture.type,value.actions,value.readFields,value.selector,value.parentGrantId,value.startsAt,
    ])
    const maximum: ApplicationGrantMaximum = { version: 1,grants: path }
    if (kind === 'service') {
      const material = await mintApplicationCredentialSecret()
      await owner.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
        VALUES($1,$2,$3,$4,$5,'Fictional scoped policy service','service',$6,$7,now()+interval '1 hour')`,[material.id,appId,workspaceId,ownerId,userId,material.secretHash,grantId])
      await owner.query('INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)',[material.id,appId,workspaceId,grantId,maximum])
      const credential = await authenticateApplicationCredential(material.token,appId,loadApplicationCredentialStateSystem)
      expect(credential).not.toBeNull()
      return { authentication: { credential: credential! },appId,grantId,parentId,userId }
    }
    const client = await createDbOAuthClientStore().register({ clientName: 'Fictional field portal',clientUri: 'https://portal.example',redirectUris: ['https://portal.example/callback'],tokenEndpointAuthMethod: 'none' })
    oauthClients.push(client.clientId)
    await owner.query('UPDATE application_clients SET oauth_client_id=$2 WHERE id=$1',[appId,client.clientId])
    const id = randomUUID(),secret = randomBytes(32).toString('base64url')
    await owner.query(`INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,audience,application_client_id,access_token_hash,access_token_expires_at)
      VALUES($1,$2,$3,$4,'read_write','application',$5,$6,now()+interval '10 minutes')`,[id,client.clientId,userId,workspaceId,appId,await hashSecret(secret)])
    await owner.query(`INSERT INTO application_oauth_bindings(authorization_id,app_id,workspace_id,principal_user_id,parent_grant_id,maximum_grants)
      VALUES($1,$2,$3,$4,$5,$6)`,[id,appId,workspaceId,userId,grantId,JSON.stringify([maximum])])
    const user = await authenticateApplicationOAuth(`oat_${id}_${secret}`,appId)
    expect(user).not.toBeNull()
    return { authentication: { user: user! },appId,grantId,parentId,userId }
  }
  async function queryRecords(fixture: Awaited<ReturnType<typeof catalogType>>,query: Partial<ApplicationQuery> = {},execution?: ExecutionContext) {
    return new ApplicationPlatformService([createCanonicalGenericApplicationModule()]).query(execution ?? await nativeExecution(),'records','query',
      { type: fixture.type,query }) as Promise<{ records: ApplicationRecordProjection[];aggregates?: Array<{ field: string;operation: string;value: string | null }>;nextCursor?: string }>
  }
  async function applicationCatalog(app: Awaited<ReturnType<typeof application>>) {
    return new ApplicationPlatformService([createCanonicalGenericApplicationModule()]).catalog(await resolveApplicationExecutionContext(app.authentication))
  }
  it.each(['native','application'] as const)('C02 rejects %s role gain before its first protected read',async kind => {
    await clearRoles()
    const fixture = await record()
    await assign('finance',ownerId)
    const app = await application(fixture,'member')
    const execution = kind === 'native' ? await nativeExecution() : await resolveApplicationExecutionContext(app.authentication)
    await assign()
    await expect(queryRecords(fixture,{ fields: ['cost'] },execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    const fresh = kind === 'native' ? await nativeExecution() : await resolveApplicationExecutionContext(app.authentication)
    expect((await queryRecords(fixture,{ fields: ['cost'] },fresh)).records[0].values).toEqual({ cost: { kind: 'number',value: 42 } })
  })
  const epoch = async () => (await owner.query('SELECT read_application_policy_epoch($1,$2,$3) AS value',
    [workspaceId,memberId,assistantId])).rows[0].value
  const context = async (kind: 'native' | 'application',fixture: Awaited<ReturnType<typeof record>>) => kind === 'native'
    ? nativeExecution() : resolveApplicationExecutionContext((await application(fixture,'member')).authentication)
  async function runModel(actor: ExecutionContext,provider: LLMProvider,output?: string[]) {
    return runAssistantTurn({ sessionId: actor.lifecycle.sessionId,policy: { admission: 'personal' },sink: { kind: 'return',
      onEvent: event => { if (event.type === 'text_delta') output?.push(event.text) },
    },lease: { mode: 'none' },
      abortController: new AbortController(),model: { provider,model: 'fixture-model',configuredProviders: undefined,customLlm: null },
      loop: { ledger: NOOP_TURN_LEDGER,context: executionToolContext(actor,{ appId: 'epoch-fixture' }),
        systemPrompt: 'Fictional policy epoch fixture',messages: [{ role: 'user',content: 'Respond after the policy check.' }],tools: new Map(),maxTurns: 1 } })
  }
  const neverProvider = () => ({ name: 'fixture',models: ['fixture-model'],createSession: vi.fn(() => { throw new Error('Provider must not start') }),
    stream: () => { throw new Error('Provider must not stream') } }) satisfies LLMProvider
  it.each(['native','application'] as const)('C01 unchanged %s context reads exactly admitted fields',async kind => {
    await clearRoles();const fixture = await record(),execution = await context(kind,fixture)
    const result = await queryRecords(fixture,{ fields: ['title'] },execution)
    expect(result.records[0].values).toEqual({ title: { kind: 'text',value: 'Fictional request' } })
    await expect(queryRecords(fixture,{ fields: ['cost'] },execution)).rejects.toMatchObject({ code: 'access_unavailable' })
  })
  it('C01 ordinary generic native context needs no registered owner',async () => {
    const schema = await store.createEntityType({ workspaceId,name: 'Fictional ordinary type',createdBy: ownerId,
      properties: [{ name: 'title',config: { kind: 'text' } }] })
    const row = await store.createEntity({ workspaceId,entityTypeId: schema.id,createdBy: ownerId,lastEditedBy: ownerId,sourceApp: 'api',
      data: { title: { kind: 'text',value: 'Ordinary generic value' } } })
    expect((await queryRecords({ schema,origin: { kind: 'generic',entityTypeId: schema.id },type: `record.${schema.id}` },{},await nativeExecution()))
      .records[0].ref.id).toBe(row.id)
  })
  it.each(['native','application'] as const)('C03 %s role loss before first read starts no provider',async kind => {
    await clearRoles();const fixture = await record();await assign('finance',ownerId);const role = await assign()
    const execution = await context(kind,fixture),provider = neverProvider()
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role])
    await expect(queryRecords(fixture,{ fields: ['cost'] },execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    await expect(runModel(execution,provider)).rejects.toMatchObject({ retrySafe: false })
    expect(provider.createSession).not.toHaveBeenCalled()
    expect((await queryRecords(fixture,{},await context(kind,fixture))).records[0].fields).toEqual(['title'])
  })
  it.each(['start','expiry'] as const)('C04 SQL-time role %s changes authority with no metadata write',async transition => {
    await clearRoles();const fixture = await record();await assign('finance',ownerId)
    const role = (await owner.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id,starts_at,expires_at)
      VALUES($1,'epoch_fixture',$2,'finance',$3,
        CASE WHEN $4='start' THEN clock_timestamp()+interval '2 seconds' ELSE clock_timestamp()-interval '1 hour' END,
        CASE WHEN $4='expiry' THEN clock_timestamp()+interval '2 seconds' ELSE NULL END) RETURNING id`,[workspaceId,memberId,ownerId,transition])).rows[0].id
    const app = await application(fixture,'member')
    const executions = [await nativeExecution(),await resolveApplicationExecutionContext(app.authentication)]
    const before = await epoch()
    await owner.query("SELECT pg_sleep(greatest(0,extract(epoch FROM (CASE WHEN $2='start' THEN starts_at ELSE expires_at END)-clock_timestamp()))+0.02) FROM application_native_role_assignments WHERE id=$1",[role,transition])
    const after = await epoch()
    expect(after.workspaceRevision).toBe(before.workspaceRevision);expect(after.timedState).not.toBe(before.timedState)
    for (const execution of executions) await expect(queryRecords(fixture,{},execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    const fresh = await queryRecords(fixture,{},await nativeExecution())
    expect(fresh.records[0].fields.sort()).toEqual(transition === 'start' ? ['cost','title'] : ['title'])
  })
  it.each(['native','application'] as const)('C05 %s configuration change/restore invalidates before data',async kind => {
    const fixture = await record(),execution = await context(kind,fixture)
    const before = await epoch()
    await owner.query("UPDATE application_epoch_fixture_configuration SET state='changed' WHERE workspace_id=$1",[workspaceId])
    await owner.query("UPDATE application_epoch_fixture_configuration SET state='initial' WHERE workspace_id=$1",[workspaceId])
    expect((await epoch()).modules).not.toEqual(before.modules)
    await expect(queryRecords(fixture,{},execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect((await queryRecords(fixture,{},await context(kind,fixture))).records).toHaveLength(1)
  })
  it.each(['missing','invalid_revision','invalid_acl'] as const)('C05 registered %s configuration holds old and fresh factories',async mode => {
    const fixture = await record(),execution = await nativeExecution()
    expect((await store.getEntity(workspaceId,fixture.row.id))?.data.title).toEqual(fixture.row.data.title)
    if (mode === 'missing') await owner.query("UPDATE application_native_field_contracts SET configuration_reader=NULL WHERE module_key='epoch_fixture'")
    if (mode === 'invalid_revision') await owner.query(`CREATE OR REPLACE FUNCTION application_epoch_fixture_configuration_reader(w uuid) RETURNS text
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT ''::text $$`)
    if (mode === 'invalid_acl') await owner.query('GRANT EXECUTE ON FUNCTION application_epoch_fixture_configuration_reader(uuid) TO app_user')
    try {
      await expect(queryRecords(fixture,{},execution)).rejects.toMatchObject({ reason: 'authority_changed' })
      await expect(nativeExecution()).rejects.toMatchObject({ reason: 'authority_changed' })
      const app = await application(fixture,'member')
      await expect(resolveApplicationExecutionContext(app.authentication)).rejects.toMatchObject({ reason: 'authority_changed' })
      // The same real private monotonic port also restricts legacy callers
      // that do not construct an assistant invocation around their SQL read.
      await expect(store.getEntity(workspaceId,fixture.row.id)).rejects.toMatchObject({ code: 'access_unavailable' })
      await expect(store.getEntityType(workspaceId,fixture.schema.id)).rejects.toMatchObject({ code: 'access_unavailable' })
      await expect(store.queryEntities(workspaceId,fixture.schema.id)).rejects.toMatchObject({ code: 'access_unavailable' })
      await expect(store.updateEntity(workspaceId,fixture.row.id,{ data: { title: { kind: 'text',value: 'Fictional held configuration patch' } },lastEditedBy: ownerId }))
        .rejects.toMatchObject({ code: 'access_unavailable' })
      expect((await owner.query('SELECT record_version::text AS version FROM entity_instances WHERE id=$1',[fixture.row.id])).rows[0].version).toBe(fixture.row.recordVersion)
    } finally {
      await owner.query('REVOKE ALL ON FUNCTION application_epoch_fixture_configuration_reader(uuid) FROM app_user')
      await owner.query(`CREATE OR REPLACE FUNCTION application_epoch_fixture_configuration_reader(w uuid) RETURNS text
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        SELECT revision::text FROM public.application_epoch_fixture_configuration WHERE workspace_id=w $$`)
      await owner.query("UPDATE application_native_field_contracts SET configuration_reader='application_epoch_fixture_configuration_reader(uuid)'::regprocedure WHERE module_key='epoch_fixture'")
    }
  })
  it.each(['schema','owner','contract'] as const)('C06 %s revision invalidates both factories before first data',async change => {
    const fixture = await record(),app = await application(fixture,'member')
    if (change === 'schema') { await assign('finance',ownerId);await assign('approver',ownerId) }
    const executions = [await nativeExecution(),await resolveApplicationExecutionContext(app.authentication)]
    if (change === 'schema') await store.updateEntityType(workspaceId,fixture.schema.id,{ name: 'Fictional renamed schema' })
    if (change === 'owner') {
      await owner.query('DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND origin=$2',[workspaceId,fixture.origin])
      await owner.query("INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,$2,$3,'epoch_fixture')",[workspaceId,fixture.origin,fixture.type])
    }
    if (change === 'contract') await owner.query("UPDATE application_native_field_contracts SET contract_version=(contract_version::int+1)::text WHERE module_key='epoch_fixture'")
    for (const execution of executions) await expect(queryRecords(fixture,{},execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect((await queryRecords(fixture,{},await nativeExecution())).records).toHaveLength(1)
  })

  async function homeApplication(fixture: Awaited<ReturnType<typeof record>>) {
    const app = await application(fixture,'member'),homeId = randomUUID(),secret = 'fictional-policy-home-signing-secret'
    const parsed = parseManifest({ manifestVersion: 1,name: 'Fictional epoch viewer',entry: 'index.html',scopes: { data: 'none',application: {
      moduleKey: 'records',resources: [{ typeKey: fixture.type,actions: ['read','query'],readFields: ['title','cost'],writeFields: [] }],
    } } })
    if (!parsed.ok) throw new Error('Invalid fixture manifest')
    await owner.query(`INSERT INTO workspace_home_apps(id,workspace_id,kind,name,manifest,granted_scopes,granted_by,status,daily_call_limit)
      VALUES($1,$2,'assistant','Fictional epoch viewer',$3,$4,$5,'active',100)`,[homeId,workspaceId,parsed.manifest,parsed.manifest.scopes,ownerId])
    await owner.query("UPDATE application_clients SET client_mode='home_app',home_app_id=$2 WHERE id=$1",[app.appId,homeId])
    const binding = (await owner.query(`INSERT INTO application_home_bindings(app_id,workspace_id,home_app_id,principal_user_id,maximum_grants,maximum_hash,home_state_hash,expires_at)
      VALUES($1,$2,$3,$4,$5,'','',statement_timestamp()+interval '10 minutes') RETURNING id`,
      [app.appId,workspaceId,homeId,memberId,JSON.stringify([{ grants: [{ id: app.grantId }] }])])).rows[0]
    const token = mintBridgeToken({ appId: homeId,workspaceId,userId: memberId,scope: 'none',applicationBindingId: binding.id,maxClearance: null,secret })
    const home = await authenticateApplicationHome(token,app.appId,secret)
    expect(home).not.toBeNull()
    return { ...app,authentication: { home: home! } }
  }
  it('C05 catalog configuration change/restore uses the compiled revision port',async () => {
    const fixture = await record(),execution = await nativeExecution(),before = await epoch()
    await owner.query("UPDATE application_epoch_fixture_catalog SET policy_version='changed' WHERE type_id=$1",[fixture.schema.id])
    await owner.query("UPDATE application_epoch_fixture_catalog SET policy_version='1' WHERE type_id=$1",[fixture.schema.id])
    expect((await epoch()).modules).not.toEqual(before.modules)
    await expect(queryRecords(fixture,{},execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect((await queryRecords(fixture,{},await nativeExecution())).records).toHaveLength(1)
  })
  it.each(['member_oauth','service','home'] as const)('C07 branded %s path shares field/config epoch checks',async profile => {
    await clearRoles();const fixture = await record();await assign('finance',ownerId);await assign()
    const app = profile === 'home' ? await homeApplication(fixture) : await application(fixture,profile === 'service' ? 'service' : 'member')
    const execution = await resolveApplicationExecutionContext(app.authentication)
    const before = await queryRecords(fixture,{},execution)
    expect(before.records[0].fields.sort()).toEqual(profile === 'service' ? ['title'] : ['cost','title'])
    await owner.query("UPDATE application_epoch_fixture_configuration SET state='new' WHERE workspace_id=$1",[workspaceId])
    await expect(queryRecords(fixture,{},execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect((await queryRecords(fixture,{},await resolveApplicationExecutionContext(app.authentication))).records[0].fields.sort())
      .toEqual(profile === 'service' ? ['title'] : ['cost','title'])
  })
  it('C07 actual member behind external profile retains its native field ceiling',async () => {
    await clearRoles();const fixture = await record(),app = await application(fixture,'external_user')
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')",[workspaceId,externalId])
    try {
      await assign('finance',ownerId)
      const execution = await resolveApplicationExecutionContext(app.authentication)
      expect((await queryRecords(fixture,{},execution)).records[0].fields).toEqual(['title'])
      const role = await assign('finance',externalId)
      await expect(queryRecords(fixture,{},execution)).rejects.toMatchObject({ reason: 'authority_changed' })
      // Its native role now permits cost, but its explicit external release still does not.
      expect((await queryRecords(fixture,{},await resolveApplicationExecutionContext(app.authentication))).records[0].fields).toEqual(['title'])
      await owner.query('DELETE FROM application_native_role_assignments WHERE id=$1',[role])
    } finally { await owner.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,externalId]) }
  })
  it.each(['issuer','parent_issuer'] as const)('C07 each current %s field ceiling invalidates before first read',async subject => {
    await clearRoles();const fixture = await record(),app = await application(fixture,'member',adminId)
    const issuer = await assign('finance',ownerId),parent = await assign('finance',adminId);await assign()
    const execution = await resolveApplicationExecutionContext(app.authentication)
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[subject === 'issuer' ? issuer : parent])
    await expect(queryRecords(fixture,{ fields: ['cost'] },execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect((await queryRecords(fixture,{},await resolveApplicationExecutionContext(app.authentication))).records[0].fields).toEqual(['title'])
  })
  it('C07 canonical native session lease pins policy before first data',async () => {
    await clearRoles();const fixture = await record()
    const session = await findOrCreateSession({ userId: memberId,assistantId,workspaceId,channelType: 'web',channelId: randomUUID() })
    const execution = await nativeExecution(memberId,session)
    expect((await queryRecords(fixture,{},execution)).records[0].fields).toEqual(['title'])
    await assign()
    await expect(queryRecords(fixture,{ fields: ['cost'] },execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect((await queryRecords(fixture,{ fields: ['cost'] },await nativeExecution(memberId,session))).records[0].fields).toEqual(['cost'])
  })
  it.each(['native','application'] as const)('C08 %s rejection survives role restoration',async kind => {
    await clearRoles();const fixture = await record();await assign('finance',ownerId);const role = await assign()
    const execution = await context(kind,fixture)
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role])
    await expect(queryRecords(fixture,{},execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    await assign()
    await expect(queryRecords(fixture,{},execution)).rejects.toMatchObject({ reason: 'authority_changed' })
    expect((await queryRecords(fixture,{ fields: ['cost'] },await context(kind,fixture))).records[0].fields).toEqual(['cost'])
  })
  it.each(['native','application'] as const)('C09 %s awaited operation stops output and retains uncertainty without retries',async kind => {
    await clearRoles();const fixture = await record(),execution = await context(kind,fixture),provider = neverProvider()
    const effect = vi.fn(async () => {
      await owner.query("UPDATE application_epoch_fixture_configuration SET state='awaited-change' WHERE workspace_id=$1",[workspaceId])
      return 'Protected effect output'
    })
    await expect(execution.security.authority.execute(effect)).rejects.toMatchObject({ reason: 'authority_changed',operationMayHaveExecuted: true,retrySafe: false })
    expect(effect).toHaveBeenCalledOnce()
    await expect(runModel(execution,provider)).rejects.toMatchObject({ retrySafe: false })
    expect(provider.createSession).not.toHaveBeenCalled()
    await expect(execution.security.authority.assertCurrent()).rejects.toMatchObject({ operationMayHaveExecuted: true })
  })
  it('C09 policy mutation while provider awaits suppresses further output and session retries',async () => {
    await record();const execution = await nativeExecution(),output: string[] = [];let sessions = 0,requests = 0
    const provider: LLMProvider = { name: 'fixture',models: ['fixture-model'],createSession: () => {
      sessions++
      return { send: () => (async function* () {
        requests++
        await owner.query("UPDATE application_epoch_fixture_configuration SET state='provider-change' WHERE workspace_id=$1",[workspaceId])
        yield { type: 'message_start' as const,model: 'fixture-model' }
        yield { type: 'text_delta' as const,text: 'Protected provider output' }
        yield { type: 'message_end' as const,stopReason: 'end_turn' as const,usage: { inputTokens: 1,outputTokens: 1 } }
      })() }
    },stream: () => { throw new Error('No fallback') } }
    await expect(runModel(execution,provider,output)).rejects.toMatchObject({ retrySafe: false })
    expect({ sessions,requests }).toEqual({ sessions: 1,requests: 1 })
    expect(output).toEqual([])
    await expect(runModel(execution,provider)).rejects.toMatchObject({ retrySafe: false })
    expect({ sessions,requests }).toEqual({ sessions: 1,requests: 1 })
  })
  it.each(['native','application'] as const)('C10 %s business writes preserve epoch while source versions refuse delayed results',async kind => {
    const fixture = await record(),app = await application(fixture,'member'),execution = kind === 'native' ? await nativeExecution() : await resolveApplicationExecutionContext(app.authentication)
    const observed = await new ApplicationPlatformService([createCanonicalGenericApplicationModule()]).query(execution,'records','get',
      { type: fixture.type,id: fixture.row.id }) as ApplicationRecordProjection,before = await epoch()
    expect(boundScopeSources(observed).length).toBeGreaterThan(0)
    await store.updateEntity(workspaceId,fixture.row.id,{ data: { title: { kind: 'text',value: 'Changed ordinary value' } },lastEditedBy: ownerId })
    expect(await epoch()).toEqual(before)
    await expect(execution.security.authority.assertCurrent()).resolves.toBeUndefined()
    expect((await queryRecords(fixture,{ fields: ['title'] },execution)).records[0].values.title).toEqual({ kind: 'text',value: 'Changed ordinary value' })
    // Resume a result genuinely read before the await. The real dispatcher and
    // canonical result authorizer must refuse its stale record/source version,
    // independently of policy epochs. Retained historical reads have a separate
    // D1 contract and are not equivalent to publishing a current query result.
    const base = createCanonicalGenericApplicationModule()
    const delayed = new ApplicationPlatformService([{ ...base,queries: { ...base.queries,get: { ...base.queries.get,
      execute: async () => observed,
    } } }])
    await expect(delayed.query(execution,'records','get',{ type: fixture.type,id: fixture.row.id }))
      .rejects.toMatchObject({ code: 'access_unavailable' })
  })
  it('C11 fresh independent reader consumes unchanged canonical field/query observations after another loses a role',async () => {
    await clearRoles();const fixture = await record(),role = await assign();await assign('finance',otherId)
    const first = await nativeExecution(),observed = await queryRecords(fixture,{ fields: ['cost'],aggregate: [{ field: 'cost',operation: 'sum' }] },first)
    const sources = boundScopeSources(observed)
    expect(sources.length).toBeGreaterThan(0)
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role])
    await expect(first.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    const independent = await nativeExecution(otherId)
    await expect(assertSourceModelInputAuthority({ ...executionToolContext(independent,{ appId: 'epoch-fixture' }),
      scopeAccumulator: new ContextScopeAccumulator({ sources }) })).resolves.toBeUndefined()
    const same = await queryRecords(fixture,{ fields: ['cost'],aggregate: [{ field: 'cost',operation: 'sum' }] },independent)
    expect(boundScopeSources(same)).toEqual(sources)
    expect(JSON.stringify(sources)).not.toContain(role)
  })
  it('C10 native memory supersession/source bookkeeping preserves both factory epochs',async () => {
    const fixture = await record(),app = await application(fixture,'member')
    const executions = [await nativeExecution(),await resolveApplicationExecutionContext(app.authentication)],before = await epoch()
    // Existing canonical worker writes use its internal transaction; keep the
    // actual actor GUC and finite member ceiling, with no owner data admission.
    const writer = await owner.connect()
    try {
      await writer.query('BEGIN');await applyRLSGucs(writer,memberId)
      const memory = await createMemory({ workspaceId,userId: null,assistantId,createdByUserId: memberId,
        summary: 'Fictional ordinary memory',sensitivity: 'internal' },undefined,writer)
      const successor = await updateMemory(memory.id,{ summary: 'Fictional superseded memory' },executions[0].security.access,writer)
      expect(successor?.id).not.toBe(memory.id)
      await writer.query('COMMIT')
    } finally { await writer.query('ROLLBACK');writer.release() }
    expect(await epoch()).toEqual(before)
    for (const execution of executions) await expect(execution.security.authority.assertCurrent()).resolves.toBeUndefined()
    const beforeConfiguration = await nativeExecution()
    await owner.query("INSERT INTO workspace_access_policies(workspace_id) VALUES($1) ON CONFLICT DO NOTHING",[workspaceId])
    await owner.query("UPDATE workspace_access_policies SET classification_mode='review' WHERE workspace_id=$1",[workspaceId])
    await owner.query("UPDATE workspace_access_policies SET classification_mode='legacy' WHERE workspace_id=$1",[workspaceId])
    await expect(beforeConfiguration.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    await expect((await nativeExecution()).security.authority.assertCurrent()).resolves.toBeUndefined()
  })
  it.each(['native','application'] as const)('C10 %s navigation preferences and existing member admission preserve current reads',async kind => {
    const fixture = await record(),app = await application(fixture,'member'),workspaces = createWorkspaceStore()
    // Complete any genuine first admission before pinning the invocation.
    await workspaces.ensureMemberSystem(workspaceId,memberId)
    const execution = kind === 'native' ? await nativeExecution() : await resolveApplicationExecutionContext(app.authentication)
    const before = await epoch()
    const navigationUpdates: readonly WorkspacePickerPreferenceUpdate[] = [{ pinned: true },{ hidden: true },{ opened: true },{ hidden: false },{ pinned: false }]
    for (const preferences of navigationUpdates) {
      expect(await workspaces.updatePickerPreferences(memberId,workspaceId,preferences)).not.toBeNull()
      expect(await epoch()).toEqual(before)
      await expect(execution.security.authority.assertCurrent()).resolves.toBeUndefined()
      expect((await queryRecords(fixture,{ fields: ['title'] },execution)).records[0].values.title)
        .toEqual({ kind: 'text',value: 'Fictional request' })
    }
    expect((await workspaces.ensureMemberSystem(workspaceId,memberId)).userId).toBe(memberId)
    expect(await epoch()).toEqual(before)
    await expect(execution.security.authority.assertCurrent()).resolves.toBeUndefined()
    expect((await queryRecords(fixture,{ fields: ['title'] },execution)).records).toHaveLength(1)
  })
  it('C10 management spanning a real picker update keeps its current native lease',async () => {
    const workspaces = createWorkspaceStore()
    await workspaces.ensureMemberSystem(workspaceId,ownerId)
    const service = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    class NavigationDuringManagementRead extends ApplicationManagementService {
      override async list(actor: string,workspace: string) {
        const clients = await super.list(actor,workspace)
        // This actual store write occurs after overview constructs its real native
        // context, and before its unchanged final lease/administrator checks.
        expect(await workspaces.updatePickerPreferences(actor,workspace,{ opened: true })).not.toBeNull()
        await workspaces.ensureMemberSystem(workspace,actor)
        return clients
      }
    }
    const before = await epoch(),overview = await new NavigationDuringManagementRead(service).overview(ownerId,workspaceId)
    expect(overview.actor).toEqual({ userId: ownerId,assistantId })
    expect(overview.readiness.qualified).toBe(false)
    expect(await epoch()).toEqual(before)
  })
  it.each([
    ['role',"role='admin'",'role'],
    ['clearance',"clearance='confidential'",'clearance'],
    ['compartments',"compartments=ARRAY['fixture:policy']::text[]",'compartments'],
    ['drafting','can_draft=NOT can_draft','can_draft'],
    ['team scope',"team_scope_mode='assigned'",'team_scope_mode'],
    ['member identity','id=gen_random_uuid()','id'],
    ['membership metadata',"joined_at=joined_at+interval '1 second'",'joined_at'],
  ])('C10 member %s changes and restoration still invalidate both factories',async (_name,assignment,column) => {
    const fixture = await record(),app = await application(fixture,'member')
    const original = (await owner.query('SELECT * FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,memberId])).rows[0]
    const executions = [await nativeExecution(),await resolveApplicationExecutionContext(app.authentication)],before = await epoch()
    // Assignment/column names are a closed test table, never user SQL.
    try {
      await owner.query(`UPDATE workspace_members SET ${assignment} WHERE workspace_id=$1 AND user_id=$2`,[workspaceId,memberId])
      expect((await epoch()).workspaceRevision).not.toBe(before.workspaceRevision)
      for (const execution of executions) await expect(queryRecords(fixture,{ fields: ['title'] },execution))
        .rejects.toMatchObject({ reason: 'authority_changed' })
    } finally {
      await owner.query(`UPDATE workspace_members SET ${column}=$3 WHERE workspace_id=$1 AND user_id=$2`,[workspaceId,memberId,original[column]])
    }
    // Restoring the same authority does not revive a refused invocation.
    for (const execution of executions) await expect(execution.security.authority.assertCurrent())
      .rejects.toMatchObject({ reason: 'authority_changed' })
    for (const fresh of [await nativeExecution(),await resolveApplicationExecutionContext(app.authentication)]) {
      expect((await queryRecords(fixture,{ fields: ['title'] },fresh)).records).toHaveLength(1)
    }
  })
  it('C10 member home Department change and restoration keep epoch rejection sticky',async () => {
    const department = randomUUID()
    await owner.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional policy Department',$3,'team',$1::text,$4)",
      [department,workspaceId,ownerId,`team:${department}`])
    const fixture = await record(),app = await application(fixture,'member')
    const executions = [await nativeExecution(),await resolveApplicationExecutionContext(app.authentication)],before = await epoch()
    try {
      await owner.query('UPDATE workspace_members SET home_department_id=$3 WHERE workspace_id=$1 AND user_id=$2',[workspaceId,memberId,department])
      expect((await epoch()).workspaceRevision).not.toBe(before.workspaceRevision)
      for (const execution of executions) await expect(execution.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    } finally {
      await owner.query('UPDATE workspace_members SET home_department_id=NULL WHERE workspace_id=$1 AND user_id=$2',[workspaceId,memberId])
      // The workspace fixture's afterAll cascade removes this Department.
      // Department rows obey the product's archive-only lifecycle.
    }
    for (const execution of executions) await expect(execution.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    expect((await queryRecords(fixture,{ fields: ['title'] },await nativeExecution())).records).toHaveLength(1)
  })
  it.each(['insert','delete','replace'] as const)('C10 member %s remains revision-sensitive',async change => {
    const user = randomUUID();userIds.push(user)
    await owner.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[user])
    if (change !== 'insert') await createWorkspaceStore().ensureMemberSystem(workspaceId,user)
    const fixture = await record(),app = await application(fixture,'member')
    const executions = [await nativeExecution(),await resolveApplicationExecutionContext(app.authentication)],before = await epoch()
    try {
      if (change !== 'insert') await owner.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,user])
      if (change !== 'delete') await createWorkspaceStore().ensureMemberSystem(workspaceId,user)
      expect((await epoch()).workspaceRevision).not.toBe(before.workspaceRevision)
      for (const execution of executions) await expect(queryRecords(fixture,{ fields: ['title'] },execution))
        .rejects.toMatchObject({ reason: 'authority_changed' })
      expect((await queryRecords(fixture,{ fields: ['title'] },await nativeExecution())).records).toHaveLength(1)
    } finally {
      await owner.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,user])
    }
  })
  it('C10 a future member authority column is not silently excluded from epochs',async () => {
    // Disposable-schema evolution proves the comparison excludes only the three
    // named navigation fields rather than an allowlist of current authority.
    await owner.query('ALTER TABLE workspace_members ADD COLUMN application_epoch_fixture_authority text')
    try {
      const fixture = await record(),app = await application(fixture,'member')
      const executions = [await nativeExecution(),await resolveApplicationExecutionContext(app.authentication)],before = await epoch()
      await owner.query("UPDATE workspace_members SET application_epoch_fixture_authority='changed' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,memberId])
      expect((await epoch()).workspaceRevision).not.toBe(before.workspaceRevision)
      for (const execution of executions) await expect(execution.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
      await owner.query('UPDATE workspace_members SET application_epoch_fixture_authority=NULL WHERE workspace_id=$1 AND user_id=$2',[workspaceId,memberId])
      for (const execution of executions) await expect(execution.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
      expect((await queryRecords(fixture,{ fields: ['title'] },await nativeExecution())).records).toHaveLength(1)
    } finally { await owner.query('ALTER TABLE workspace_members DROP COLUMN application_epoch_fixture_authority') }
  })
  it('C10 management spanning a real administrator loss still refuses before return',async () => {
    const service = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    class AdministrationChangesDuringRead extends ApplicationManagementService {
      override async list(actor: string,workspace: string) {
        const clients = await super.list(actor,workspace)
        await owner.query("UPDATE workspace_members SET role='member' WHERE workspace_id=$1 AND user_id=$2",[workspace,actor])
        return clients
      }
    }
    try {
      await expect(new AdministrationChangesDuringRead(service).overview(ownerId,workspaceId))
        .rejects.toMatchObject({ code: 'access_unavailable' })
    } finally {
      await owner.query("UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,ownerId])
    }
    expect((await new ApplicationManagementService(service).overview(ownerId,workspaceId)).readiness.qualified).toBe(false)
  })
  it('C12 runtime/tampered metadata and owner fallback cannot mint authority; issuance stays disabled',async () => {
    const fixture = await record(),execution = await nativeExecution(),app = await application(fixture,'member')
    await expect(resolveApplicationExecutionContext({ user: { ...app.authentication.user! } })).rejects.toMatchObject({ code: 'grant_revoked' })
    await expect(asMember(memberId,client => client.query('SELECT read_application_policy_epoch($1,$2,$3)',[workspaceId,memberId,assistantId])))
      .rejects.toMatchObject({ code: '42501' })
    const before = await epoch()
    for (const sql of [
      'UPDATE application_policy_workspace_epochs SET revision=999999 WHERE workspace_id=$1',
      "UPDATE application_native_field_contracts SET configuration_reader=NULL WHERE module_key='epoch_fixture'",
    ]) expect((await asMember(memberId,client => client.query(sql,sql.includes('$1') ? [workspaceId] : []))).rowCount).toBe(0)
    expect(await epoch()).toEqual(before)
    await expect(asMember(memberId,client => client.query("INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,'{}','record.forged','epoch_fixture')",[workspaceId])))
      .rejects.toMatchObject({ code: '42501' })
    const fresh = await nativeExecution()
    await expect(new ApplicationPlatformService([createCanonicalGenericApplicationModule()],owner).query(fresh,'records','query',{ type: fixture.type,query: {} }))
      .rejects.toMatchObject({ code: 'access_unavailable' })
    expect((await owner.query("SELECT application_runtime_qualified($1,'application_data') AS ready",[workspaceId])).rows[0].ready).toBe(false)
    expect(Object.keys(await epoch()).sort()).toEqual(['assistantId','contractRevision','modules','principalId','timedState','version','workspaceId','workspaceRevision'])
    expect((await queryRecords(fixture,{ fields: ['title'] },fresh)).records).toHaveLength(1)
    expect(execution.security.access.userId).toBe(memberId)
  })

  it.each(['native','application'] as const)('C06 %s detects a real concurrent change across construction',async kind => {
    await clearRoles();const fixture = await record(),app = await application(fixture,'member'),blocker = await owner.connect()
    const lock = 180214
    await owner.query(`CREATE OR REPLACE FUNCTION application_epoch_fixture_configuration_reader(w uuid) RETURNS text
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ BEGIN
      PERFORM pg_advisory_xact_lock(180214::bigint);
      RETURN (SELECT revision::text FROM public.application_epoch_fixture_configuration WHERE workspace_id=w); END $$`)
    try {
      await blocker.query('SELECT pg_advisory_lock($1::bigint)',[lock])
      const constructing = (kind === 'native' ? nativeExecution() : resolveApplicationExecutionContext(app.authentication))
        .then(value => ({ value,error: undefined }),error => ({ value: undefined,error }))
      let waiting = false
      for (let n=0;n<100 && !waiting;n++) {
        waiting = (await owner.query("SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND objid=$1 AND NOT granted) AS waiting",[lock])).rows[0].waiting
        if (!waiting) await owner.query('SELECT pg_sleep(0.01)')
      }
      expect(waiting).toBe(true)
      await assign()
      await blocker.query('SELECT pg_advisory_unlock($1::bigint)',[lock])
      expect((await constructing).error).toMatchObject({ reason: 'authority_changed' })
    } finally {
      await blocker.query('SELECT pg_advisory_unlock_all()');blocker.release()
      await owner.query(`CREATE OR REPLACE FUNCTION application_epoch_fixture_configuration_reader(w uuid) RETURNS text
        LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
        SELECT revision::text FROM public.application_epoch_fixture_configuration WHERE workspace_id=w $$`)
    }
    expect((await queryRecords(fixture,{ fields: ['cost'] },await nativeExecution())).records[0].fields).toEqual(['cost'])
  })

})
