import { createHash,randomUUID,randomBytes } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it,vi } from 'vitest'
import type { PoolClient } from 'pg'
import { getAppPool,getPool,applyRLSGucs } from '../../db/client.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { createMemory,getMemoryById,countMemories,getMemoryIndex,getMemoryStats,searchMemories } from '../../db/memories.js'
import { readApplicationFieldAncestors } from '../../application-platform/field-evidence.js'
import { defineNativeApplicationFieldPolicy,decideNativeApplicationFields,ContextScopeAccumulator,executionToolContext,NOOP_TURN_LEDGER,boundScopeSources,
  type NativeApplicationFieldFacts,type ScopeSource,type ExecutionContext,type LLMProvider } from '@use-brian/core'
import { findAssistantById,findOrCreateUser } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { runAssistantTurn } from '../../turn/kernel.js'
import type { ApplicationAccessGrant,ApplicationGrantMaximum,ApplicationRecordProjection,ApplicationQuery } from '@use-brian/shared'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { hashSecret } from '../../db/api-key-store.js'
import { authenticateApplicationCredential,mintApplicationCredentialSecret } from '../../application-platform/credentials.js'
import { loadApplicationCredentialStateSystem } from '../../application-platform/auth-store.js'
import { authenticateApplicationOAuth } from '../../application-platform/oauth-auth.js'
import { applyApplicationRLSContext,releaseApplicationTransactionBinding,resolveApplicationExecutionContext } from '../../application-platform/execution-context.js'
import { ApplicationPlatformService } from '../../application-platform/service.js'
import { createCanonicalGenericApplicationModule } from '../../application-platform/generic-adapter.js'
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
  async function catalogType(module = 'epoch_fixture') {
    const schema = await store.createEntityType({ workspaceId,name: `Fictional purchases ${randomUUID()}`,createdBy: ownerId,
      properties: [{ name: 'title',config: { kind: 'text' } },{ name: 'cost',config: { kind: 'number',format: 'decimal' } }] })
    const origin = { kind: 'generic' as const,entityTypeId: schema.id },type = `record.${schema.id}`
    await owner.query('INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,$2,$3,$4)',[workspaceId,origin,type,module])
    await owner.query('INSERT INTO application_epoch_fixture_catalog(type_id,fields) VALUES($1,$2)',[schema.id,JSON.stringify(fields())])
    return { schema,origin,type }
  }
  async function record(includeCost = true,module = 'epoch_fixture') {
    const catalog = await catalogType(module),{ schema } = catalog
    const row = await store.createEntity({ workspaceId,entityTypeId: schema.id,createdBy: ownerId,lastEditedBy: ownerId,sourceApp: 'api',
      data: { title: { kind: 'text',value: 'Fictional request' },...(includeCost ? { cost: { kind: 'number' as const,value: 42 } } : {}) } })
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
  async function nativeExecution(userId = memberId) {
    return (await resolveExecutionContextSystem({ userId,workspaceId,assistant: (await findAssistantById(assistantId))!,memberMode: 'member',
      identity: { kind: 'attended',principal: { kind: 'workspace_member',userId,authenticationKind: 'native_session' } },
      ownership: { kind: 'workspace',workspaceId },lifecycle: { sessionId: randomUUID(),sessionPersisted: false,
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
  async function runModel(actor: ExecutionContext,provider: LLMProvider) {
    return runAssistantTurn({ sessionId: actor.lifecycle.sessionId,policy: { admission: 'personal' },sink: { kind: 'return' },lease: { mode: 'none' },
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
    if (mode === 'missing') await owner.query("UPDATE application_native_field_contracts SET configuration_reader=NULL WHERE module_key='epoch_fixture'")
    if (mode === 'invalid_revision') await owner.query(`CREATE OR REPLACE FUNCTION application_epoch_fixture_configuration_reader(w uuid) RETURNS text
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$ SELECT ''::text $$`)
    if (mode === 'invalid_acl') await owner.query('GRANT EXECUTE ON FUNCTION application_epoch_fixture_configuration_reader(uuid) TO app_user')
    try {
      await expect(queryRecords(fixture,{},execution)).rejects.toMatchObject({ reason: 'authority_changed' })
      await expect(nativeExecution()).rejects.toMatchObject({ reason: 'authority_changed' })
      const app = await application(fixture,'member')
      await expect(resolveApplicationExecutionContext(app.authentication)).rejects.toMatchObject({ reason: 'authority_changed' })
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

})
