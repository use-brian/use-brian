import { createHash,randomUUID,randomBytes } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import type { PoolClient } from 'pg'
import { getAppPool,getPool,applyRLSGucs } from '../../db/client.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { createMemory,getMemoryById,countMemories,getMemoryIndex,getMemoryStats,searchMemories } from '../../db/memories.js'
import { readApplicationFieldAncestors } from '../field-evidence.js'
import { defineNativeApplicationFieldPolicy,decideNativeApplicationFields,ContextScopeAccumulator,executionToolContext,NOOP_TURN_LEDGER,boundScopeSources,
  type NativeApplicationFieldFacts,type ScopeSource,type ExecutionContext,type LLMProvider } from '@use-brian/core'
import { findAssistantById,findOrCreateUser } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { runAssistantTurn } from '../../turn/kernel.js'
import type { ApplicationAccessGrant,ApplicationGrantMaximum,ApplicationRecordProjection,ApplicationQuery } from '@use-brian/shared'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { hashSecret } from '../../db/api-key-store.js'
import { authenticateApplicationCredential,mintApplicationCredentialSecret } from '../credentials.js'
import { loadApplicationCredentialStateSystem } from '../auth-store.js'
import { authenticateApplicationOAuth } from '../oauth-auth.js'
import { applyApplicationRLSContext,releaseApplicationTransactionBinding,resolveApplicationExecutionContext } from '../execution-context.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
import { assertSourceModelInputAuthority } from '../model-source-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

// The fixture deploys a metadata-only module port. The reader and role/scope
// decisions are production SQL under a separate login with no owner/RLS bypass.
describe('[COMP:security/native-field-policy] current canonical native field masks', () => {
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
    await owner.query(`CREATE TABLE application_native_policy_fixture_metadata (
      resource_id uuid PRIMARY KEY,fields jsonb NOT NULL,policy_version text NOT NULL DEFAULT '1')`)
    await owner.query(`CREATE FUNCTION application_native_policy_fixture_reader(w uuid,o jsonb,t text,i text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE r entity_instances; schema entity_types; policy application_native_policy_fixture_metadata;
      BEGIN
        SELECT * INTO r FROM entity_instances WHERE workspace_id=w AND id=i::uuid AND entity_type_id=(o->>'entityTypeId')::uuid;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO schema FROM entity_types WHERE id=r.entity_type_id AND workspace_id=w;
        SELECT * INTO policy FROM application_native_policy_fixture_metadata WHERE resource_id=r.id;
        RETURN jsonb_build_object('moduleKey',(SELECT module_key FROM application_native_resource_owners WHERE workspace_id=w AND origin=o AND resource_type=t),
          'origin',o,'typeKey','record.'||schema.id,'schemaVersion',schema.schema_version::text,
          'policyVersion',policy.policy_version,'recordVersion',r.record_version::text,
          'fieldKeys',(SELECT jsonb_agg(p->'name' ORDER BY p->>'name') FROM jsonb_array_elements(schema.properties) p),
          'fields',policy.fields,'source',read_scope_source(w,'entity_instance',r.id));
      END $$`)
    await owner.query('REVOKE ALL ON FUNCTION application_native_policy_fixture_reader(uuid,jsonb,text,text) FROM PUBLIC')
    await owner.query(`CREATE TABLE application_native_policy_fixture_catalog (
      type_id uuid PRIMARY KEY REFERENCES entity_types(id) ON DELETE CASCADE,fields jsonb NOT NULL,
      policy_version text NOT NULL DEFAULT '1',override jsonb NOT NULL DEFAULT '{}')`)
    await owner.query(`CREATE FUNCTION application_native_policy_fixture_catalog_reader(w uuid,o jsonb,t text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE schema entity_types; policy application_native_policy_fixture_catalog;
      BEGIN
        SELECT * INTO schema FROM entity_types WHERE workspace_id=w AND id=(o->>'entityTypeId')::uuid;
        IF NOT FOUND THEN RETURN NULL; END IF;
        SELECT * INTO policy FROM application_native_policy_fixture_catalog WHERE type_id=schema.id;
        IF NOT FOUND THEN RETURN NULL; END IF;
        RETURN jsonb_build_object('moduleKey',(SELECT module_key FROM application_native_resource_owners WHERE workspace_id=w AND origin=o AND resource_type=t),
          'origin',o,'typeKey','record.'||schema.id,'schemaVersion',schema.schema_version::text,
          'policyVersion',policy.policy_version,'fieldKeys',(SELECT jsonb_agg(p->'name' ORDER BY p->>'name') FROM jsonb_array_elements(schema.properties) p),
          'fields',policy.fields,'scope',jsonb_build_object('workspaceId',w,'userId',NULL,'assistantId',NULL,
            'sensitivity','internal','compartments','[]'::jsonb,'projectIds','[]'::jsonb))||policy.override;
      END $$`)
    await owner.query('REVOKE ALL ON FUNCTION application_native_policy_fixture_catalog_reader(uuid,jsonb,text) FROM PUBLIC')
    for (const module of ['operations','other_operations']) await owner.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader,catalog_reader)
      VALUES($1,'1',ARRAY['finance','approver'],'application_native_policy_fixture_reader(uuid,jsonb,text,text)'::regprocedure,
        CASE WHEN $1='operations' THEN 'application_native_policy_fixture_catalog_reader(uuid,jsonb,text)'::regprocedure ELSE NULL END)`,[module])
    await owner.query(`CREATE FUNCTION application_native_policy_fixture_domain(w uuid,o jsonb,t text) RETURNS jsonb
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      SELECT public.application_compile_query_catalog_domain(w,public.application_current_query_catalog(w,o,t)) $$`)
    await owner.query('REVOKE ALL ON FUNCTION application_native_policy_fixture_domain(uuid,jsonb,text) FROM PUBLIC')
    await owner.query('GRANT EXECUTE ON FUNCTION application_native_policy_fixture_domain(uuid,jsonb,text) TO app_user')
    await owner.query(`CREATE FUNCTION application_native_policy_fixture_contains(w uuid,o jsonb,t text,original jsonb,required text[]) RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      SELECT public.application_query_domain_contains(public.application_compile_query_catalog_domain(w,public.application_current_query_catalog(w,o,t)),original,required) $$`)
    await owner.query(`CREATE FUNCTION application_native_policy_fixture_native_contains(w uuid,o jsonb,t text,original jsonb,required text[]) RETURNS boolean
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE mask jsonb; bounds jsonb;
      BEGIN
       mask:=public.read_native_application_field_catalog(w,o,t);bounds:=public.application_native_query_bounds(w);
       IF mask IS NULL OR bounds IS NULL THEN RETURN false; END IF;
       RETURN public.application_query_domain_contains(jsonb_build_object('kind','application_query','version',1,'clauses',jsonb_build_array(
        jsonb_build_object('scope',bounds,'read',mask->'readFields','selector',jsonb_build_object('ids','null'::jsonb,'ownerId',NULL,'relationships','[]'::jsonb,'empty',false)))),original,required);
      END $$`)
    await owner.query(`CREATE FUNCTION application_native_policy_fixture_native_domain(w uuid,o jsonb,t text) RETURNS jsonb
      LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      DECLARE mask jsonb; bounds jsonb;
      BEGIN
       mask:=public.read_native_application_field_catalog(w,o,t);bounds:=public.application_native_query_bounds(w);
       IF mask IS NULL OR bounds IS NULL THEN RETURN NULL; END IF;
       RETURN jsonb_build_object('kind','application_query','version',1,'clauses',jsonb_build_array(jsonb_build_object('scope',bounds,'read',mask->'readFields',
        'selector',jsonb_build_object('ids','null'::jsonb,'ownerId',NULL,'relationships','[]'::jsonb,'empty',false))));
      END $$`)
    await owner.query(`CREATE FUNCTION application_native_policy_fixture_scope_union(original jsonb,scopes jsonb) RETURNS boolean
      LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog,public,pg_temp AS $$
      SELECT (public.application_query_scope_union_contains(original,scopes,4096)->>'contains')::boolean $$`)
    for (const signature of ['application_native_policy_fixture_contains(uuid,jsonb,text,jsonb,text[])','application_native_policy_fixture_native_contains(uuid,jsonb,text,jsonb,text[])']) {
      await owner.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO app_user`)
    }
    for (const signature of ['application_native_policy_fixture_native_domain(uuid,jsonb,text)','application_native_policy_fixture_scope_union(jsonb,jsonb)']) {
      await owner.query(`REVOKE ALL ON FUNCTION ${signature} FROM PUBLIC`);await owner.query(`GRANT EXECUTE ON FUNCTION ${signature} TO app_user`)
    }
  })
  afterAll(async () => {
    await owner.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[[workspaceId,otherWorkspaceId]])
    await owner.query('DELETE FROM application_native_field_contracts WHERE module_key=ANY($1::text[])',[['operations','other_operations']])
    await owner.query('DROP FUNCTION application_native_policy_fixture_reader(uuid,jsonb,text,text)')
    await owner.query('DROP FUNCTION application_native_policy_fixture_catalog_reader(uuid,jsonb,text)')
    await owner.query('DROP FUNCTION application_native_policy_fixture_domain(uuid,jsonb,text)')
    await owner.query('DROP FUNCTION application_native_policy_fixture_contains(uuid,jsonb,text,jsonb,text[])')
    await owner.query('DROP FUNCTION application_native_policy_fixture_native_contains(uuid,jsonb,text,jsonb,text[])')
    await owner.query('DROP FUNCTION application_native_policy_fixture_native_domain(uuid,jsonb,text)')
    await owner.query('DROP FUNCTION application_native_policy_fixture_scope_union(jsonb,jsonb)')
    await owner.query('DROP TABLE application_native_policy_fixture_metadata')
    await owner.query('DROP TABLE application_native_policy_fixture_catalog')
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
  async function catalogType(module = 'operations') {
    const schema = await store.createEntityType({ workspaceId,name: `Fictional purchases ${randomUUID()}`,createdBy: ownerId,
      properties: [{ name: 'title',config: { kind: 'text' } },{ name: 'cost',config: { kind: 'number',format: 'decimal' } }] })
    const origin = { kind: 'generic' as const,entityTypeId: schema.id },type = `record.${schema.id}`
    await owner.query('INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,$2,$3,$4)',[workspaceId,origin,type,module])
    await owner.query('INSERT INTO application_native_policy_fixture_catalog(type_id,fields) VALUES($1,$2)',[schema.id,JSON.stringify(fields())])
    return { schema,origin,type }
  }
  async function record(includeCost = true,module = 'operations') {
    const catalog = await catalogType(module),{ schema } = catalog
    const row = await store.createEntity({ workspaceId,entityTypeId: schema.id,createdBy: ownerId,lastEditedBy: ownerId,sourceApp: 'api',
      data: { title: { kind: 'text',value: 'Fictional request' },...(includeCost ? { cost: { kind: 'number' as const,value: 42 } } : {}) } })
    const recordVersion = row.recordVersion
    if (!recordVersion) throw new Error('The canonical fixture requires its persisted record version.')
    await owner.query('INSERT INTO application_native_policy_fixture_metadata(resource_id,fields) VALUES($1,$2)',[row.id,JSON.stringify(fields())])
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
  const maskOn = async (client: PoolClient,fixture: Awaited<ReturnType<typeof record>>,type = fixture.type,version = fixture.row.recordVersion) =>
    (await client.query('SELECT read_native_application_field_mask($1,$2,$3,$4,$5) AS value',[workspaceId,fixture.origin,type,fixture.row.id,version])).rows[0].value as
      { moduleKey: string;schemaVersion: string;recordVersion: string;policyVersion: string;readFields: string[];writeFields: string[] } | null
  const mask = async (fixture: Awaited<ReturnType<typeof record>>,userId = memberId) => asMember(userId,client => maskOn(client,fixture))
  async function assign(role = 'finance',user = memberId,module = 'operations',workspace = workspaceId,starts = '2020-01-01T00:00:00Z',expires: string | null = null) {
    return (await owner.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id,starts_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,[workspace,module,user,role,ownerId,starts,expires])).rows[0].id as string
  }
  async function clearRoles() { await owner.query('DELETE FROM application_native_role_assignments WHERE workspace_id=ANY($1::uuid[])',[[workspaceId,otherWorkspaceId]]) }
  const catalogOn = async (client: PoolClient,fixture: Awaited<ReturnType<typeof catalogType>>,type = fixture.type) =>
    (await client.query('SELECT read_native_application_field_catalog($1,$2,$3) AS value',[workspaceId,fixture.origin,type])).rows[0].value as
      { moduleKey: string;schemaVersion: string;policyVersion: string;readFields: string[];writeFields: string[] } | null
  const catalogMask = (fixture: Awaited<ReturnType<typeof catalogType>>,user = memberId) => asMember(user,client => catalogOn(client,fixture))
  async function capture(fixture: Awaited<ReturnType<typeof record>>,selected: string[],user = memberId,
    origin = fixture.origin,type = fixture.type) {
    return asMember(user,async client => (await client.query('SELECT observe_application_field_projection($1,$2,$3,$4,$5,$6,$7,$8) AS value',
      [workspaceId,origin,type,fixture.row.id,fixture.row.recordVersion,'read',null,selected])).rows[0].value as
      { values: Record<string,unknown>;sources: ScopeSource[];policyVersion: string })
  }
  const fieldSnapshot = (source: ScopeSource,user = memberId) => asMember(user,async client =>
    (await client.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,source.resourceId,source.version])).rows[0].value)
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
  it.each(['member','external_user','service'] as const)('discovers a real empty query-only %s catalog without create or schema grants',async kind => {
    await clearRoles();const fixture = await catalogType(),app = await application(fixture,kind,undefined,['query'],{ kind: 'self' })
    const catalog = await applicationCatalog(app),resource = catalog.resources.find(resource => resource.typeKey === fixture.type)
    expect(resource?.fields.map(field => field.key)).toEqual(['title'])
    expect((await owner.query('SELECT count(*)::int AS count FROM entity_instances WHERE entity_type_id=$1',[fixture.schema.id])).rows[0].count).toBe(0)
    expect(JSON.stringify(catalog)).not.toContain('Fictional request')
    expect((await owner.query('SELECT actions FROM application_access_grants WHERE id=$1',[app.grantId])).rows[0].actions).toEqual(['query'])
  })
  it('uses the current issuer and member role floors for an empty application query catalog',async () => {
    await clearRoles();const fixture = await catalogType(),app = await application(fixture,'member',undefined,['query'],{ kind: 'self' })
    const issuer = await assign('finance',ownerId),member = await assign()
    const keys = async () => (await applicationCatalog(app)).resources.find(resource => resource.typeKey === fixture.type)?.fields.map(field => field.key).sort()
    expect(await keys()).toEqual(['cost','title'])
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[issuer])
    expect(await keys()).toEqual(['title'])
    await assign('finance',ownerId)
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[member])
    expect(await keys()).toEqual(['title'])
  })
  it('keeps every parent issuer role floor and independent app release policy in empty query catalogs',async () => {
    await clearRoles();const fixture = await catalogType(),app = await application(fixture,'member',adminId,['query'],{ kind: 'self' })
    await assign();await assign('finance',ownerId)
    const keys = async () => (await applicationCatalog(app)).resources.find(resource => resource.typeKey === fixture.type)?.fields.map(field => field.key).sort()
    expect(await keys()).toEqual(['title'])
    await assign('finance',adminId);expect(await keys()).toEqual(['cost','title'])
    const external = await application(fixture,'external_user',undefined,['query'],{ kind: 'self' })
    expect((await applicationCatalog(external)).resources.find(resource => resource.typeKey === fixture.type)?.fields.map(field => field.key)).toEqual(['title'])
  })
  it('keeps a missing registered catalog held instead of using generic metadata defaults',async () => {
    await clearRoles();const fixture = await catalogType('other_operations'),app = await application(fixture,'member',undefined,['query'],{ kind: 'self' })
    expect((await applicationCatalog(app)).resources.find(resource => resource.typeKey === fixture.type)).toBeUndefined()
  })
  it('uses declared ordinary generic metadata without creating a business row or native module owner',async () => {
    const schema = await store.createEntityType({ workspaceId,name: `Fictional ordinary catalog ${randomUUID()}`,createdBy: ownerId,
      properties: [{ name: 'title',config: { kind: 'text' } },{ name: 'cost',config: { kind: 'number',format: 'decimal' } }] })
    const fixture = { schema,origin: { kind: 'generic' as const,entityTypeId: schema.id },type: `record.${schema.id}` }
    const app = await application(fixture,'external_user',undefined,['query'],{ kind: 'self' })
    const resource = (await applicationCatalog(app)).resources.find(resource => resource.typeKey === fixture.type)
    expect(resource?.fields.map(field => field.key).sort()).toEqual(['cost','title'])
    expect((await owner.query('SELECT count(*)::int AS count FROM application_native_resource_owners WHERE workspace_id=$1 AND origin=$2',[workspaceId,fixture.origin])).rows[0].count).toBe(0)
    expect((await owner.query('SELECT count(*)::int AS count FROM entity_instances WHERE entity_type_id=$1',[schema.id])).rows[0].count).toBe(0)
  })
  async function asApplication<T>(app: Awaited<ReturnType<typeof application>>,operation: (client: PoolClient) => Promise<T>) {
    const execution = await resolveApplicationExecutionContext(app.authentication),client = await getAppPool().connect()
    try {
      return await runWithAgentAccess(execution.security.access,async () => {
        await client.query('BEGIN');await applyRLSGucs(client,execution.security.access.userId);await applyApplicationRLSContext(client,execution)
        expect((await client.query(`SELECT r.rolsuper,r.rolbypassrls,c.relowner=r.oid AS owns FROM pg_roles r,pg_class c
          WHERE r.rolname=current_user AND c.oid='public.entity_types'::regclass`)).rows[0]).toEqual({ rolsuper: false,rolbypassrls: false,owns: false })
        const value = await operation(client);await execution.security.authority.assertCurrent();await client.query('COMMIT');return value
      })
    } finally { releaseApplicationTransactionBinding(client);await client.query('ROLLBACK');client.release() }
  }
  it('admits ID-selected empty query metadata without claiming that the selected record exists',async () => {
    await clearRoles();const fixture = await catalogType(),id = randomUUID()
    const app = await application(fixture,'external_user',undefined,['query'],{ kind: 'ids',ids: [id] })
    expect((await applicationCatalog(app)).resources.find(resource => resource.typeKey === fixture.type)?.fields.map(field => field.key)).toEqual(['title'])
    expect((await owner.query('SELECT count(*)::int AS count FROM entity_instances WHERE id=$1',[id])).rows[0].count).toBe(0)
  })
  const appQuery = async (app: Awaited<ReturnType<typeof application>>,fixture: { type: string },query: Partial<ApplicationQuery> = {}) =>
    new ApplicationPlatformService([createCanonicalGenericApplicationModule()]).query(await resolveApplicationExecutionContext(app.authentication),
      'records','query',{ type: fixture.type,query }) as Promise<{ records: ApplicationRecordProjection[];aggregates?: Array<{ value: string | null }> }>
  const appFieldSnapshot = (app: Awaited<ReturnType<typeof application>>,source: ScopeSource) => asApplication(app,async client =>
    (await client.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,source.resourceId,source.version])).rows[0].value)
  it.each(['member','external_user','service'] as const)('retains an actually empty %s query under independent current authority',async kind => {
    await clearRoles();const fixture = await catalogType(),id = randomUUID(),selector = { kind: 'ids' as const,ids: [id] }
    const original = await application(fixture,kind,undefined,['query'],selector)
    const result = await appQuery(original,fixture,{ fields: ['title'],aggregate: [{ field: 'title',operation: 'count' }] })
    expect(result.records).toEqual([]);expect(result.aggregates?.[0].value).toBe('0')
    const sources = boundScopeSources(result);expect(sources).toHaveLength(1)
    const frozen = (await owner.query(`SELECT d.domain FROM application_query_domains d JOIN application_field_resources f ON f.resource_id=d.id
      WHERE f.id=$1 AND f.selection='query_domain'`,[sources[0].resourceId])).rows[0].domain
    expect(frozen).toMatchObject({ kind: 'application_query_points',version: 1,queryPoints: [],candidates: [],
      remaining: { kind: 'application_selector_domain',version: 1,requiredFields: [],formula: { kind: 'application_query' } } })
    for (const identity of [original.appId,original.grantId,ownerId]) expect(JSON.stringify(frozen)).not.toContain(identity)
    expect(JSON.stringify(result)).not.toContain('application_field')
    expect(await appFieldSnapshot(original,sources[0])).toMatchObject({ held: false })
    const independent = await application(fixture,kind,undefined,['query'],selector)
    await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[original.grantId])
    expect(await appFieldSnapshot(independent,sources[0])).toMatchObject({ held: false })
    expect(await fieldSnapshot(sources[0],ownerId)).toMatchObject({ held: false })
    expect(await fieldSnapshot(sources[0],otherId)).toMatchObject({ held: kind === 'member' ? false : true })
    expect((await owner.query('SELECT count(*)::int AS count FROM entity_instances WHERE entity_type_id=$1',[fixture.schema.id])).rows[0].count).toBe(0)
  })
  it('preserves an empty self domain instead of replacing it with the currently observed finite IDs',async () => {
    await clearRoles();const fixture = await catalogType(),original = await application(fixture,'external_user',undefined,['query'],{ kind: 'self' })
    const result = await appQuery(original,fixture,{ fields: ['title'] }),source = boundScopeSources(result)[0]
    expect(result.records).toEqual([])
    const equivalent = await application(fixture,'external_user',undefined,['query'],{ kind: 'self' })
    const finite = await application(fixture,'external_user',undefined,['query'],{ kind: 'ids',ids: [randomUUID()] })
    const unrelated = await application(fixture,'service',undefined,['query'],{ kind: 'self' })
    expect(await appFieldSnapshot(equivalent,source)).toMatchObject({ held: false })
    expect(await appFieldSnapshot(finite,source)).toMatchObject({ held: true })
    expect(await appFieldSnapshot(unrelated,source)).toMatchObject({ held: true })
    expect(await fieldSnapshot(source,ownerId)).toMatchObject({ held: false })
  })
  it('captures an ordinary empty generic app domain without a native module owner or fake business row',async () => {
    const schema = await store.createEntityType({ workspaceId,name: `Fictional generic query ${randomUUID()}`,createdBy: ownerId,
      properties: [{ name: 'title',config: { kind: 'text' } },{ name: 'cost',config: { kind: 'number',format: 'decimal' } }] })
    const fixture = { schema,origin: { kind: 'generic' as const,entityTypeId: schema.id },type: `record.${schema.id}` }
    const app = await application(fixture,'external_user',undefined,['query'],{ kind: 'self' })
    const result = await appQuery(app,fixture,{ fields: ['title'] }),source = boundScopeSources(result)[0]
    expect(result.records).toEqual([]);expect(source.resourceKind).toBe('application_field')
    expect(await appFieldSnapshot(app,source)).toMatchObject({ held: false })
    expect(await fieldSnapshot(source,ownerId)).toMatchObject({ held: false })
    expect((await owner.query('SELECT count(*)::int AS count FROM application_native_resource_owners WHERE workspace_id=$1 AND origin=$2',[workspaceId,fixture.origin])).rows[0].count).toBe(0)
  })
  it('retains empty-query predicate fields without making an unused role an evidence dependency',async () => {
    await clearRoles();const fixture = await catalogType(),assignment = await assign();await assign('finance',ownerId);await assign('finance',otherId)
    const app = await application(fixture,'member',undefined,['query'],{ kind: 'self' })
    const predicate = await appQuery(app,fixture,{ fields: ['title'],filters: [{ field: 'cost',op: 'eq',value: 42 }] })
    const ordinary = await appQuery(app,fixture,{ fields: ['title'] })
    expect(predicate.records).toEqual([]);expect(ordinary.records).toEqual([])
    const protectedSource = boundScopeSources(predicate)[0],ordinarySource = boundScopeSources(ordinary)[0]
    const modelContext = { ...executionToolContext(await resolveApplicationExecutionContext(app.authentication),{ appId: 'query-domain-fixture' }),
      scopeAccumulator: new ContextScopeAccumulator({ sources: boundScopeSources(predicate) }) }
    await expect(assertSourceModelInputAuthority(modelContext)).resolves.toBeUndefined()
    expect(await appFieldSnapshot(app,protectedSource)).toMatchObject({ held: false })
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment])
    expect(await appFieldSnapshot(app,protectedSource)).toMatchObject({ held: true })
    expect(await appFieldSnapshot(app,ordinarySource)).toMatchObject({ held: false })
    expect(await fieldSnapshot(protectedSource,otherId)).toMatchObject({ held: false })
    await expect(assertSourceModelInputAuthority(modelContext)).rejects.toMatchObject({ code: 'source_unavailable',retrySafe: false })
  })
  it('admits an independently readable finite query point without requiring the unused original grant ceiling',async () => {
    await clearRoles();const fixture = await record(),app = await application(fixture,'external_user',undefined,['query'])
    const original = await appQuery(app,fixture,{ fields: ['title'] })
    const independent = await queryRecords(fixture,{ fields: ['title'] })
    expect(original.records.map(row => row.ref.id)).toEqual([fixture.row.id])
    expect(independent.records.map(row => row.ref.id)).toEqual([fixture.row.id])
    const sources = boundScopeSources(original)
    const domain = (await owner.query<{ id: string }>("SELECT id FROM application_field_resources WHERE id=ANY($1::uuid[]) AND selection='query_domain'",
      [sources.map(source => source.resourceId)])).rows[0]
    expect(domain).toBeDefined()
    for (const source of sources.filter(source => source.resourceId !== domain.id)) expect(await fieldSnapshot(source,memberId)).toMatchObject({ held: false })
    expect(await fieldSnapshot(sources.find(source => source.resourceId === domain.id)!,memberId)).toMatchObject({ held: false })
  })
  it('retains an ordinary native empty generic query without requiring a native module owner',async () => {
    await clearRoles()
    const schema = await store.createEntityType({ workspaceId,name: `Fictional native generic query ${randomUUID()}`,createdBy: ownerId,
      properties: [{ name: 'title',config: { kind: 'text' } },{ name: 'cost',config: { kind: 'number',format: 'decimal' } }] })
    const fixture = { schema,origin: { kind: 'generic' as const,entityTypeId: schema.id },type: `record.${schema.id}` }
    const result = await queryRecords(fixture,{ fields: ['title'],aggregate: [{ field: 'title',operation: 'count' }] })
    expect(result.records).toEqual([]);expect(result.aggregates?.[0].value).toBe('0')
    const source = boundScopeSources(result)[0]
    expect(source.resourceKind).toBe('application_field')
    expect(await fieldSnapshot(source,otherId)).toMatchObject({ held: false })
    expect((await owner.query('SELECT count(*)::int AS count FROM application_native_resource_owners WHERE workspace_id=$1 AND origin=$2',[workspaceId,fixture.origin])).rows[0].count).toBe(0)
    await owner.query("UPDATE workspace_members SET clearance='public' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,memberId])
    try {
      expect(await fieldSnapshot(source,memberId)).toMatchObject({ held: true })
      expect(await fieldSnapshot(source,otherId)).toMatchObject({ held: false })
    } finally { await owner.query("UPDATE workspace_members SET clearance='internal' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,memberId]) }
  })
  it('keeps absent finite IDs as domain obligations while refining admitted points',async () => {
    await clearRoles();const fixture = await record(),absent = randomUUID()
    const app = await application(fixture,'external_user',undefined,['query'],{ kind: 'ids',ids: [fixture.row.id,absent] })
    const result = await appQuery(app,fixture,{ fields: ['title'] }),source = boundScopeSources(result)[0]
    expect(result.records.map(row => row.ref.id)).toEqual([fixture.row.id])
    expect(await appFieldSnapshot(app,source)).toMatchObject({ held: false })
    expect(await fieldSnapshot(source,memberId)).toMatchObject({ held: true })
    expect(await fieldSnapshot(source,ownerId)).toMatchObject({ held: false })
    const narrower = await application(fixture,'external_user',undefined,['query'])
    expect(await appFieldSnapshot(narrower,source)).toMatchObject({ held: true })
  })
  it('preserves predicate-field authority on each finite point for independent readers',async () => {
    await clearRoles();const fixture = await record(),assignment = await assign();await assign('finance',ownerId);await assign('finance',otherId)
    const app = await application(fixture,'member',undefined,['query'])
    const result = await appQuery(app,fixture,{ fields: ['title'],filters: [{ field: 'cost',op: 'eq',value: 42 }] })
    expect(result.records).toHaveLength(1)
    const source = boundScopeSources(result)[0]
    expect(await appFieldSnapshot(app,source)).toMatchObject({ held: false })
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment])
    expect(await appFieldSnapshot(app,source)).toMatchObject({ held: true })
    expect(await fieldSnapshot(source,otherId)).toMatchObject({ held: false })
  })
  it('rejects finite candidate ID, version and phantom drift against the original admitted read',async () => {
    await clearRoles();const fixture = await record(),absent = randomUUID()
    const app = await application(fixture,'external_user',undefined,['query'],{ kind: 'ids',ids: [fixture.row.id,absent] })
    const result = await appQuery(app,fixture,{ fields: ['title'] }),source = boundScopeSources(result)[0]
    const original = [{ id: fixture.row.id,version: fixture.row.recordVersion }]
    await asApplication(app,async client => {
      const valid = async (candidates: Array<{ id: string;version: string }>) => (await client.query(
        'SELECT assert_generic_application_query_candidates($1,$2,$3,$4,$5) AS admitted',
        [workspaceId,fixture.schema.id,source.resourceId,source.version,JSON.stringify(candidates)])).rows[0].admitted
      expect(await valid(original)).toBe(true)
      expect(await valid([])).toBe(false)
      expect(await valid([{ ...original[0],version: '999' }])).toBe(false)
      expect(await valid([...original,...original])).toBe(false)
      await owner.query(`INSERT INTO entity_instances(id,workspace_id,entity_type_id,data,created_by,last_edited_by)
        VALUES($1,$2,$3,'{"title":{"kind":"text","value":"Fictional late record"}}',$4,$4)`,[absent,workspaceId,fixture.schema.id,ownerId])
      await owner.query('INSERT INTO application_native_policy_fixture_metadata(resource_id,fields) VALUES($1,$2)',[absent,JSON.stringify(fields())])
      expect((await client.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,source.resourceId,source.version])).rows[0].value)
        .toMatchObject({ held: false })
      const current = (await client.query<{ id: string;version: string }>("SELECT id,record_version::text AS version FROM application_generic_projection($1,$2,'query',NULL)",
        [fixture.schema.id,fixture.type])).rows
      expect(current.map(row => row.id).sort()).toEqual([fixture.row.id,absent].sort())
      expect(await valid(current)).toBe(false)
    })
    // Canonical source readers hold row locks until their transaction commits.
    await owner.query("UPDATE entity_instances SET data=jsonb_set(data,'{title,value}',to_jsonb('Fictional changed point'::text)) WHERE id=$1",[fixture.row.id])
    await asApplication(app,async client => {
      expect((await client.query('SELECT assert_generic_application_query_candidates($1,$2,$3,$4,$5) AS admitted',
        [workspaceId,fixture.schema.id,source.resourceId,source.version,JSON.stringify(original)])).rows[0].admitted).toBe(false)
    })
  })
  it('uses a declared relationship resolver for empty query metadata without serializing its anchor',async () => {
    const anchor = await record()
    const schema = await store.createEntityType({ workspaceId,name: `Fictional relationship catalog ${randomUUID()}`,createdBy: ownerId,
      properties: [{ name: 'title',config: { kind: 'text' } },{ name: 'cost',config: { kind: 'number',format: 'decimal' } },
        { name: 'company',config: { kind: 'relation',targetEntityTypeRef: { kind: 'user_defined',entityTypeId: anchor.schema.id } } }] })
    const fixture = { schema,origin: { kind: 'generic' as const,entityTypeId: schema.id },type: `record.${schema.id}` }
    const app = await application(fixture,'external_user',undefined,['query'],{ kind: 'relationship',
      resolverKey: `relation.${createHash('sha256').update('company').digest('hex')}`,anchorId: anchor.row.id })
    const catalog = await applicationCatalog(app)
    expect(catalog.resources.find(resource => resource.typeKey === fixture.type)?.fields.map(field => field.key).sort()).toEqual(['cost','title'])
    expect(JSON.stringify(catalog)).not.toContain(anchor.row.id)
    expect((await owner.query('SELECT count(*)::int AS count FROM entity_instances WHERE entity_type_id=$1',[schema.id])).rows[0].count).toBe(0)
    await owner.query("UPDATE application_access_grants SET selector=jsonb_set(selector,'{resolverKey}',to_jsonb('relation.unknown'::text)) WHERE id=$1",[app.grantId])
    expect((await applicationCatalog(app)).resources.find(resource => resource.typeKey === fixture.type)).toBeUndefined()
  })
  it('does not expose a query catalog from another workspace through the actual application role',async () => {
    await clearRoles();const fixture = await catalogType(),app = await application(fixture,'member',undefined,['query'],{ kind: 'self' })
    await asApplication(app,async client => {
      expect((await client.query('SELECT read_application_query_catalog($1,$2,$3) AS value',[workspaceId,fixture.origin,fixture.type])).rows[0].value).not.toBeNull()
      expect((await client.query('SELECT read_application_query_catalog($1,$2,$3) AS value',[otherWorkspaceId,fixture.origin,fixture.type])).rows[0].value).toBeNull()
      expect((await client.query('SELECT * FROM public.entity_types WHERE id=$1',[fixture.schema.id])).rows).toEqual([])
    })
  })
  it('reads canonical query declarations despite a temporary schema table on the actual application backend',async () => {
    await clearRoles();const fixture = await catalogType(),app = await application(fixture,'member',undefined,['query'],{ kind: 'self' })
    await asApplication(app,async client => {
      await client.query('CREATE TEMP TABLE entity_types(id uuid,workspace_id uuid,properties jsonb,schema_version int) ON COMMIT DROP')
      await client.query('INSERT INTO pg_temp.entity_types VALUES($1,$2,$3,1)',[fixture.schema.id,workspaceId,JSON.stringify([{ name: 'title',config: { kind: 'number',format: 'decimal' } }])])
      await client.query('GRANT SELECT ON pg_temp.entity_types TO PUBLIC')
      const value = (await client.query('SELECT read_application_query_catalog($1,$2,$3) AS value',[workspaceId,fixture.origin,fixture.type])).rows[0].value
      expect(value.fields).toHaveLength(1);expect(value.fields[0].property.config.kind).toBe('text')
    })
  })
  async function applicationDomain(app: Awaited<ReturnType<typeof application>>,fixture: Awaited<ReturnType<typeof catalogType>>) {
    return asApplication(app,async client => (await client.query('SELECT application_native_policy_fixture_domain($1,$2,$3) AS value',[workspaceId,fixture.origin,fixture.type])).rows[0].value)
  }
  it.each(['member','external_user','service'] as const)('compiles actual %s self domains without retaining former grants or issuer identity as authority',async kind => {
    await clearRoles();const fixture = await catalogType(),app = await application(fixture,kind,undefined,['query'],{ kind: 'self' })
    const domain = await applicationDomain(app,fixture)
    expect(domain).toMatchObject({ kind: 'application_query',version: 1,clauses: [{
      selector: { ids: null,ownerId: app.userId,relationships: [],empty: false },read: ['title'],
      scope: { kind: 'native_department_v2',tier: kind === 'member' ? 2 : 3,departments: {},contextDepartment: null,projectLabels: [],otherLabels: [],projectIds: [] },
    }] })
    expect(domain.clauses).toHaveLength(1)
    expect(JSON.stringify(domain)).not.toContain(app.grantId);expect(JSON.stringify(domain)).not.toContain(app.appId);expect(JSON.stringify(domain)).not.toContain(ownerId)
    if (kind !== 'member') expect((await owner.query('SELECT count(*)::int AS count FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,app.userId])).rows[0].count).toBe(0)
  })
  it('intersects current and issuance-bound selectors instead of widening a live application domain',async () => {
    await clearRoles();const fixture = await catalogType(),first = randomUUID(),shared = randomUUID(),added = randomUUID()
    const app = await application(fixture,'member',undefined,['query'],{ kind: 'ids',ids: [first,shared] })
    await owner.query('UPDATE application_access_grants SET selector=$2 WHERE id=$1',[app.grantId,{ kind: 'ids',ids: [shared,added] }])
    expect((await applicationDomain(app,fixture)).clauses[0].selector.ids).toEqual([shared])
    await owner.query('UPDATE application_access_grants SET selector=$2 WHERE id=$1',[app.grantId,{ kind: 'ids',ids: [added] }])
    expect((await applicationDomain(app,fixture)).clauses).toEqual([])
  })
  it('keeps arbitrary-principal and formula helpers private on the actual application role',async () => {
    await clearRoles();const fixture = await catalogType(),app = await application(fixture,'member',undefined,['query'],{ kind: 'self' })
    await asApplication(app,async client => {
      for (const signature of ['application_principal_query_bounds(uuid,uuid,boolean)','application_current_query_catalog(uuid,jsonb,text)',
        'application_compile_query_catalog_domain(uuid,jsonb)','application_query_scope_cap(integer,jsonb,jsonb)',
        'application_current_query_catalog_for_origin(uuid,jsonb)','application_query_anchor_reference(uuid,jsonb,text,text)',
        'application_query_domain_state_before_selectors(uuid,jsonb,text,uuid,text[])','application_query_domain_state(uuid,jsonb,text,uuid,text[])',
        'application_query_scope_admits_point(jsonb,jsonb)','application_refine_query_points(uuid,uuid,text,jsonb,text[])',
        'observe_application_query_points(uuid,uuid,text,text[],text[])','application_compute_field_envelope_before_query_points(uuid,jsonb,text,uuid,text,text,text[],integer)']) {
        expect((await client.query('SELECT has_function_privilege(current_user,$1,\'EXECUTE\') AS allowed',[`public.${signature}`])).rows[0].allowed).toBe(false)
      }
    })
  })
  async function applicationDomainContains(app: Awaited<ReturnType<typeof application>>,fixture: Awaited<ReturnType<typeof catalogType>>,original: unknown,required: string[] = []) {
    return asApplication(app,async client => (await client.query('SELECT application_native_policy_fixture_contains($1,$2,$3,$4,$5) AS value',
      [workspaceId,fixture.origin,fixture.type,original,required])).rows[0].value as boolean)
  }
  it('uses an independent current app grant after the original query grant is revoked',async () => {
    await clearRoles();const fixture = await catalogType(),originalApp = await application(fixture,'external_user',undefined,['query'],{ kind: 'self' })
    const original = await applicationDomain(originalApp,fixture),independent = await application(fixture,'external_user',undefined,['query'],{ kind: 'self' })
    expect(await applicationDomainContains(independent,fixture,original,['title'])).toBe(true)
    await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[originalApp.grantId])
    expect(await applicationDomainContains(independent,fixture,original,['title'])).toBe(true)
    expect(await applicationDomainContains(independent,fixture,original,['cost'])).toBe(false)
  })
  it('does not use a different self subject to cover the original application scope',async () => {
    await clearRoles();const fixture = await catalogType(),originalApp = await application(fixture,'member',undefined,['query'],{ kind: 'self' })
    const original = await applicationDomain(originalApp,fixture),different = await application(fixture,'external_user',undefined,['query'],{ kind: 'self' })
    expect(await applicationDomainContains(different,fixture,original)).toBe(false)
    expect(await asMember(otherId,async client => (await client.query('SELECT application_native_policy_fixture_native_contains($1,$2,$3,$4,$5) AS value',
      [workspaceId,fixture.origin,fixture.type,original,['title']])).rows[0].value)).toBe(true)
    const external = await application(fixture,'external_user',undefined,['query'],{ kind: 'self' }),protectedScope = await applicationDomain(external,fixture)
    expect(await asMember(otherId,async client => (await client.query('SELECT application_native_policy_fixture_native_contains($1,$2,$3,$4,$5) AS value',
      [workspaceId,fixture.origin,fixture.type,protectedScope,['title']])).rows[0].value)).toBe(false)
    expect(await asMember(ownerId,async client => (await client.query('SELECT application_native_policy_fixture_native_contains($1,$2,$3,$4,$5) AS value',
      [workspaceId,fixture.origin,fixture.type,protectedScope,['title']])).rows[0].value)).toBe(true)
  })
  it('rejects malformed original formula evidence instead of treating missing restrictions as empty scope',async () => {
    await clearRoles();const fixture = await catalogType(),app = await application(fixture,'member',undefined,['query'],{ kind: 'self' })
    const original = await applicationDomain(app,fixture)
    expect(await applicationDomainContains(app,fixture,original,['title'])).toBe(true)
    for (const corrupt of [
      (value: typeof original) => { value.version = '1' },
      (value: typeof original) => { delete value.clauses[0].scope.projectIds },
      (value: typeof original) => { delete value.clauses[0].selector.ownerId },
      (value: typeof original) => { value.clauses[0].scope.unrecognizedFloor = [] },
      (value: typeof original) => { value.clauses[0].read = [42] },
    ]) {
      const invalid = structuredClone(original);corrupt(invalid)
      expect(await applicationDomainContains(app,fixture,invalid,['title'])).toBe(false)
    }
  })
  it('proves Department-context union coverage against the canonical SQL row predicate',async () => {
    await withDepartmentQueryFixture(async (fixture,_departments,project) => {
      const snapshot = (context?: string) => asMember(memberId,async client => {
        if (context) await client.query("SELECT set_config('app.v2_context_department',$1,true)",[context])
        return (await client.query('SELECT application_native_policy_fixture_native_domain($1,$2,$3) AS value',[workspaceId,fixture.origin,fixture.type])).rows[0].value.clauses[0].scope
      })
      const original = await snapshot(),departments = Object.keys(original.departments),alternatives = []
      expect(departments.length).toBeGreaterThan(1);expect(departments.length).toBeLessThan(8)
      for (const department of departments) alternatives.push(await snapshot(department))
      const raw = (scope: typeof original) => ({ [workspaceId]: { b: scope.tier,d: scope.departments,c: scope.contextDepartment,k: null,p: scope.projectLabels,o: [],u: memberId } })
      const rows: { sensitivity: string; compartments: string[] }[] = []
      for (let bits = 0;bits < 2 ** departments.length;bits++) for (const sensitivity of ['public','internal','confidential']) {
        const teams = departments.filter((_department,index) => bits & 2 ** index).map(id => `team:${id}`)
        rows.push({ sensitivity,compartments: teams },{ sensitivity,compartments: [...teams,`project:${project}`] })
      }
      for (const scopes of [alternatives,alternatives.slice(1)]) await asMember(memberId,async client => {
        const oracle = (await client.query(`SELECT NOT EXISTS(SELECT 1 FROM jsonb_to_recordset($1::jsonb) row(sensitivity text,compartments text[])
          WHERE public.department_row_allows($2::jsonb,$3,row.sensitivity,row.compartments,NULL)
           AND NOT EXISTS(SELECT 1 FROM jsonb_array_elements($4::jsonb) grants
            WHERE public.department_row_allows(grants,$3,row.sensitivity,row.compartments,NULL))) AS covers`,
        [JSON.stringify(rows),raw(original),workspaceId,JSON.stringify(scopes.map(raw))])).rows[0].covers
        const proved = (await client.query('SELECT application_native_policy_fixture_scope_union($1,$2) AS covers',[original,JSON.stringify(scopes)])).rows[0].covers
        expect(proved).toBe(oracle);expect(proved).toBe(scopes.length === alternatives.length)
      })
    })
  })
  it('keeps native member scope after an external profile recipient joins the workspace',async () => {
    await clearRoles();const fixture = await record()
    fixture.row.recordVersion = (await owner.query("UPDATE entity_instances SET sensitivity='confidential' WHERE id=$1 RETURNING record_version::text",[fixture.row.id])).rows[0].record_version
    const app = await application(fixture,'external_user'),service = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const original = await resolveApplicationExecutionContext(app.authentication)
    expect((await service.query(original,'records','get',{ type: fixture.type,id: fixture.row.id }) as ApplicationRecordProjection).values.title).toBeDefined()
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','public')",[workspaceId,externalId])
    try {
      await expect(service.query(await resolveApplicationExecutionContext(app.authentication),'records','get',{ type: fixture.type,id: fixture.row.id }))
        .rejects.toMatchObject({ code: 'access_unavailable' })
      await expect(original.security.authority.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
      await expect(asApplication(app,async client => {
        await client.query("SELECT set_config('app.agent_clearance','confidential',true),set_config('app.v2_cap','confidential',true)")
        return client.query('SELECT read_generic_application_record($1,$2,$3,$4)',[workspaceId,fixture.schema.id,fixture.type,fixture.row.id])
      })).rejects.toMatchObject({ code: '42501' })
    } finally { await owner.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,externalId]) }
  })
  it('keeps native module field roles for a workspace member using an external profile',async () => {
    await clearRoles();const fixture = await record(),policy = fields();policy[1].releaseReadTo = ['external_user']
    await assign('finance',ownerId)
    await owner.query('UPDATE application_native_policy_fixture_catalog SET fields=$2 WHERE type_id=$1',[fixture.schema.id,JSON.stringify(policy)])
    await owner.query('UPDATE application_native_policy_fixture_metadata SET fields=$2 WHERE resource_id=$1',[fixture.row.id,JSON.stringify(policy)])
    const app = await application(fixture,'external_user'),service = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const get = async () => service.query(await resolveApplicationExecutionContext(app.authentication),'records','get',{ type: fixture.type,id: fixture.row.id }) as Promise<ApplicationRecordProjection>
    expect((await get()).values.cost).toEqual({ kind: 'number',value: 42 })
    await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','confidential')",[workspaceId,externalId])
    try {
      expect((await get()).values).toEqual({ title: { kind: 'text',value: 'Fictional request' } })
      expect((await applicationCatalog(app)).resources.find(resource => resource.typeKey === fixture.type)?.fields.map(field => field.key)).toEqual(['title'])
      await assign('finance',externalId);expect((await get()).values.cost).toEqual({ kind: 'number',value: 42 })
    } finally {
      await owner.query('DELETE FROM application_native_role_assignments WHERE workspace_id=$1 AND user_id=$2',[workspaceId,externalId])
      await owner.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,externalId])
    }
  })
  async function addRecord(fixture: Awaited<ReturnType<typeof catalogType>>,title: string,cost = 8,policy = fields()) {
    const row = await store.createEntity({ workspaceId,entityTypeId: fixture.schema.id,createdBy: ownerId,lastEditedBy: ownerId,sourceApp: 'api',
      data: { title: { kind: 'text',value: title },cost: { kind: 'number',value: cost } } })
    await owner.query('INSERT INTO application_native_policy_fixture_metadata(resource_id,fields) VALUES($1,$2)',[row.id,JSON.stringify(policy)])
    return row
  }
  async function observedFields(value: object) {
    const sources = boundScopeSources(value).filter(source => source.resourceKind === 'application_field')
    expect(sources.length).toBeGreaterThan(0)
    return (await owner.query<{ fields: string[] }>("SELECT fields FROM application_field_resources WHERE id=ANY($1::uuid[]) AND selection<>'query_domain'",[sources.map(source => source.resourceId)])).rows.map(row => row.fields)
  }
  async function withDepartmentQueryFixture<T>(operation: (fixture: Awaited<ReturnType<typeof catalogType>>,departments: string[],project: string) => Promise<T>) {
    const departments = [randomUUID(),randomUUID()],project = randomUUID()
    await owner.query('UPDATE workspaces SET department_read_v2=true,project_shared_spaces=true WHERE id=$1',[workspaceId])
    try {
      for (const department of departments) {
        await owner.query("INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional domain Department',$3,'team',$1::text,$4)",[department,workspaceId,ownerId,`team:${department}`])
        await owner.query("INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Fictional domain Department',$3,'team',$4)",[workspaceId,`team:${department}`,ownerId,department])
        for (const user of [memberId,otherId]) await owner.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,$4,'store')",
          [workspaceId,department,user,user === memberId && department === departments[1] ? 'internal' : 'confidential'])
        await owner.query("INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store') ON CONFLICT DO NOTHING",[workspaceId,department,assistantId])
      }
      await owner.query("INSERT INTO workspace_projects(id,workspace_id,name,normalized_name,created_by) VALUES($1::uuid,$2,$1::text,$1::text,$3)",[project,workspaceId,ownerId])
      await owner.query("INSERT INTO project_shared_scopes(project_id,workspace_id,origin,created_by) VALUES($1,$2,'created',$3)",[project,workspaceId,ownerId])
      for (const user of [memberId,otherId]) await owner.query("INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,user_id,origin) VALUES($1,$2,'user',$3,'invited')",[workspaceId,project,user])
      await owner.query("INSERT INTO project_shared_members(workspace_id,project_id,principal_kind,assistant_id,origin) VALUES($1,$2,'assistant',$3,'invited')",[workspaceId,project,assistantId])
      return await operation(await catalogType(),departments,project)
    } finally {
      await owner.query('UPDATE workspaces SET department_read_v2=false,project_shared_spaces=false WHERE id=$1',[workspaceId])
      await owner.query("UPDATE project_shared_scopes SET status='quarantined' WHERE project_id=$1",[project])
      await owner.query("UPDATE workspace_projects SET status='archived' WHERE id=$1",[project])
      await owner.query("UPDATE workspace_groups SET status='archived' WHERE id=ANY($1::uuid[])",[departments])
      // The creator's mandatory owner edge remains until the workspace cascade.
      await owner.query('DELETE FROM department_edges WHERE department_id=ANY($1::uuid[]) AND user_id IS DISTINCT FROM $2',[departments,ownerId])
    }
  }
  async function domainOn(client: PoolClient,fixture: Awaited<ReturnType<typeof catalogType>>,settings: Record<string,string> = {}) {
    for (const [key,value] of Object.entries(settings)) await client.query('SELECT set_config($1,$2,true)',[key,value])
    return (await client.query('SELECT observe_generic_native_query_domain($1,$2,$3) AS value',[workspaceId,fixture.schema.id,['title']])).rows[0].value as { sources: ScopeSource[] }
  }
  async function domainSnapshot(source: ScopeSource,user = memberId,settings: Record<string,string> = {}) {
    return asMember(user,async client => {
      for (const [key,value] of Object.entries(settings)) await client.query('SELECT set_config($1,$2,true)',[key,value])
      return (await client.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,source.resourceId,source.version])).rows[0].value
    })
  }
  it('binds a genuinely empty Department-v2 query to actual Department and Project bounds',async () => {
    await withDepartmentQueryFixture(async (fixture,departments,project) => {
      const value = await queryRecords(fixture,{ fields: ['title'],aggregate: [{ field: 'title',operation: 'count' }] })
      expect(value.records).toEqual([]);expect(value.aggregates?.[0].value).toBe('0')
      const source = boundScopeSources(value)[0]
      const domain = (await owner.query(`SELECT d.domain FROM application_query_domains d JOIN application_field_resources f ON f.resource_id=d.id WHERE f.id=$1`,[source.resourceId])).rows[0].domain
      expect(domain).toMatchObject({ kind: 'native_department_v2',tier: 2,departments: { [departments[0]]: 3,[departments[1]]: 2 },projectLabels: [project] })
      expect(await domainSnapshot(source,otherId)).toMatchObject({ held: false })
      // This owner has actual Department edges and read oversight, without a Project roster edge.
      expect((await owner.query('SELECT count(*)::int AS count FROM project_shared_members WHERE project_id=$1 AND user_id=$2',[project,ownerId])).rows[0].count).toBe(0)
      expect(await domainSnapshot(source,ownerId)).toMatchObject({ held: false })
      await owner.query('DELETE FROM department_edges WHERE workspace_id=$1 AND user_id=$2 AND department_id=$3',[workspaceId,memberId,departments[0]])
      expect(await domainSnapshot(source)).toMatchObject({ held: true })
      expect(await domainSnapshot(source,otherId)).toMatchObject({ held: false })
    })
  })
  it('does not replace Department-v2 combination containment with one matching Department',async () => {
    await withDepartmentQueryFixture(async (fixture,departments) => {
      const full = await asMember(memberId,client => domainOn(client,fixture)),source = full.sources[0]
      expect(await domainSnapshot(source,memberId,{ 'app.v2_context_department': departments[0] })).toMatchObject({ held: true })
      const constrained = await asMember(memberId,client => domainOn(client,fixture,{ 'app.v2_context_department': departments[0] }))
      expect(await domainSnapshot(constrained.sources[0],otherId)).toMatchObject({ held: false })
      expect(await domainSnapshot(constrained.sources[0],otherId,{ 'app.v2_context_department': departments[0] })).toMatchObject({ held: false })
      expect(await domainSnapshot(constrained.sources[0],otherId,{ 'app.v2_context_department': departments[1] })).toMatchObject({ held: true })
    })
  })
  it('keeps Department-v2 binding labels, Project labels and Project IDs independent',async () => {
    await withDepartmentQueryFixture(async (fixture,departments,project) => {
      const source = (await asMember(memberId,client => domainOn(client,fixture))).sources[0]
      const bounds = async (source: ScopeSource) => (await owner.query(`SELECT d.domain FROM application_query_domains d JOIN application_field_resources f ON f.resource_id=d.id WHERE f.id=$1`,[source.resourceId])).rows[0].domain as { departments: Record<string,number>;projectLabels: string[] }
      const original = await bounds(source)
      const completeBinding = [...Object.keys(original.departments),...original.projectLabels]
      expect(completeBinding).toEqual(expect.arrayContaining([...departments,project]))
      expect(await domainSnapshot(source,memberId,{ 'app.v2_binding': JSON.stringify(departments) })).toMatchObject({ held: true })
      const current = await domainSnapshot(source,memberId,{ 'app.v2_binding': JSON.stringify(completeBinding) })
      const rebound = (await asMember(memberId,client => domainOn(client,fixture,{ 'app.v2_binding': JSON.stringify(completeBinding) }))).sources[0]
      expect(await bounds(rebound)).toEqual(original)
      expect(current).toMatchObject({ held: false })
      expect(await domainSnapshot(source,memberId,{ 'app.agent_project_ids': '[]' })).toMatchObject({ held: true })
      const constrained = (await asMember(memberId,client => domainOn(client,fixture,{ 'app.v2_binding': JSON.stringify([departments[0]]),'app.agent_project_ids': '[]' }))).sources[0]
      expect(await domainSnapshot(constrained,otherId)).toMatchObject({ held: false })
      await owner.query('DELETE FROM project_shared_members WHERE project_id=$1 AND user_id=$2',[project,memberId])
      expect(await domainSnapshot(source)).toMatchObject({ held: true })
      expect(await domainSnapshot(source,ownerId)).toMatchObject({ held: false })
    })
  })
  it('matches the extra legacy assistant ceiling on Department-v2 query domains',async () => {
    await withDepartmentQueryFixture(async (fixture) => {
      const source = (await asMember(memberId,client => domainOn(client,fixture))).sources[0]
      const legacy = { 'app.agent_clearance': 'internal' }
      expect(await domainSnapshot(source,memberId,legacy)).toMatchObject({ held: true })
      const generalOnly = (await asMember(memberId,client => domainOn(client,fixture,legacy))).sources[0]
      expect(await domainSnapshot(generalOnly,otherId)).toMatchObject({ held: false })
      expect(await domainSnapshot(generalOnly,memberId,legacy)).toMatchObject({ held: false })
      // Active v2 carries the canonical assistant intersection instead of applying legacy labels again.
      expect(await domainSnapshot(source,memberId,{ ...legacy,'app.v2_active': 'true' })).toMatchObject({ held: false })
    })
  })
  it('admits a required Department-v2 context when the original domain already forces its singleton',async () => {
    await withDepartmentQueryFixture(async (fixture,departments) => {
      const source = (await asMember(memberId,client => domainOn(client,fixture,{ 'app.v2_binding': JSON.stringify([departments[0]]) }))).sources[0]
      expect(await domainSnapshot(source,otherId,{ 'app.v2_context_department': departments[0] })).toMatchObject({ held: false })
      expect(await domainSnapshot(source,otherId,{ 'app.v2_context_department': departments[1] })).toMatchObject({ held: true })
      await owner.query("UPDATE department_edges SET clearance='internal' WHERE department_id=$1 AND user_id=$2",[departments[0],otherId])
      expect(await domainSnapshot(source,otherId)).toMatchObject({ held: true })
      expect(await domainSnapshot(source,memberId)).toMatchObject({ held: false })
    })
  })
  it('distinguishes finite legacy bounds from an unrestricted legacy universe across Department-v2',async () => {
    const legacyFixture = await catalogType()
    const universe = (await asMember(memberId,client => domainOn(client,legacyFixture))).sources[0]
    const general = (await asMember(memberId,client => domainOn(client,legacyFixture,{ 'app.agent_compartments': '[]' }))).sources[0]
    await withDepartmentQueryFixture(async () => {
      expect(await domainSnapshot(universe,otherId)).toMatchObject({ held: true })
      expect(await domainSnapshot(general,otherId)).toMatchObject({ held: false })
    })
  })
  it('allows an independently broader legacy reader of a finite Department-v2 domain while preserving Project restrictions',async () => {
    await withDepartmentQueryFixture(async (fixture,departments) => {
      const broad = (await asMember(memberId,client => domainOn(client,fixture))).sources[0]
      const finite = (await asMember(memberId,client => domainOn(client,fixture,{ 'app.v2_binding': JSON.stringify(departments) }))).sources[0]
      await owner.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1',[workspaceId])
      try {
        expect(await domainSnapshot(broad,ownerId)).toMatchObject({ held: true })
        expect(await domainSnapshot(finite,ownerId)).toMatchObject({ held: false })
        expect(await domainSnapshot(finite,memberId)).toMatchObject({ held: true })
      } finally { await owner.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[workspaceId]) }
    })
  })
  it('returns masked query fields with exact source observations instead of a whole-row binding',async () => {
    await clearRoles();const fixture = await record(),value = await queryRecords(fixture)
    expect(value.records).toHaveLength(1);expect(value.records[0].values).toEqual({ title: { kind: 'text',value: 'Fictional request' } })
    expect(value.records[0].fields).toEqual(['title']);expect(value.records[0].absentFields).toBeUndefined()
    expect(await observedFields(value)).toEqual([['title']])
    await assign();const narrow = await queryRecords(fixture,{ fields: ['title'] })
    expect(narrow.records[0].values).not.toHaveProperty('cost');expect(await observedFields(narrow)).toEqual([['title']])
  })
  it.each(['filter','sort','aggregate','output'] as const)('refuses a forbidden query %s field even when the title predicate matches nothing',async operation => {
    await clearRoles();const fixture = await record()
    const query: Partial<ApplicationQuery> = { filters: [{ field: 'title',op: 'eq',value: 'No fictional match' }] }
    if (operation === 'filter') query.filters!.push({ field: 'cost',op: 'eq',value: 42 })
    if (operation === 'sort') query.sort = [{ field: 'cost',direction: 'asc' }]
    if (operation === 'aggregate') query.aggregate = [{ field: 'cost',operation: 'sum' }]
    if (operation === 'output') query.fields = ['cost']
    await expect(queryRecords(fixture,query)).rejects.toMatchObject({ code: 'access_unavailable' })
  })
  it('retains predicate observations when a permitted nonempty domain produces no matches',async () => {
    await clearRoles();const fixture = await record(),value = await queryRecords(fixture,{ fields: ['title'],filters: [{ field: 'title',op: 'eq',value: 'No fictional match' }] })
    expect(value.records).toEqual([]);expect(await observedFields(value)).toEqual([['title']])
  })
  it('keeps readable query absence separate from withheld fields and records the absence dependency',async () => {
    await clearRoles();const fixture = await record(false);await assign()
    const value = await queryRecords(fixture,{ fields: ['cost'] })
    expect(value.records[0].values).toEqual({});expect(value.records[0].fields).toEqual([]);expect(value.records[0].absentFields).toEqual(['cost'])
    expect(await observedFields(value)).toEqual([['cost']])
  })
  it('includes every aggregate contributor beyond the returned page and rechecks its field authority',async () => {
    await clearRoles();const fixture = await record(),second = await addRecord(fixture,'Second fictional request',8),role = await assign();await assign('finance',otherId)
    const value = await queryRecords(fixture,{ fields: ['title'],limit: 1,aggregate: [{ field: 'cost',operation: 'sum' }] })
    expect(value.records).toHaveLength(1);expect(value.nextCursor).toBeDefined();expect(value.aggregates).toEqual([{ field: 'cost',operation: 'sum',value: '50' }])
    const sources = boundScopeSources(value).filter(source => source.resourceKind === 'application_field')
    expect(sources).toHaveLength(3);expect((await observedFields(value)).every(fields => fields.includes('cost'))).toBe(true)
    expect((await owner.query("SELECT resource_id FROM application_field_resources WHERE id=ANY($1::uuid[]) AND selection<>'query_domain'",[sources.map(source => source.resourceId)])).rows.map(row => row.resource_id).sort())
      .toEqual([fixture.row.id,second.id].sort())
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role])
    for (const source of sources) { expect(await fieldSnapshot(source)).toMatchObject({ held: true });expect(await fieldSnapshot(source,otherId)).toMatchObject({ held: false }) }
  })
  it('does not require an aggregate-only field on a record excluded by a readable predicate',async () => {
    await clearRoles();const fixture = await record(),stricter = fields();stricter[1].read = [['approver']]
    await addRecord(fixture,'Excluded fictional request',99,stricter);await assign()
    const value = await queryRecords(fixture,{ fields: ['title'],filters: [{ field: 'title',op: 'eq',value: 'Fictional request' }],aggregate: [{ field: 'cost',operation: 'sum' }] })
    expect(value.aggregates?.[0].value).toBe('42');expect(value.records).toHaveLength(1)
    expect((await observedFields(value)).sort((a,b) => a.length-b.length)).toEqual([['title'],['cost','title']])
  })
  it('uses canonical system cells only when readable and retains implicit ordering evidence',async () => {
    await clearRoles();const fixture = await record()
    await store.updateEntityType(workspaceId,fixture.schema.id,{ properties: [...fixture.schema.properties,{ name: 'created',config: { kind: 'created_time' } }] })
    const policy = [...fields(),{ key: 'created',read: [['finance']],write: [['finance']],releaseReadTo: [],releaseWriteTo: [] }]
    await owner.query('UPDATE application_native_policy_fixture_metadata SET fields=$2 WHERE resource_id=$1',[fixture.row.id,JSON.stringify(policy)])
    await owner.query('UPDATE application_native_policy_fixture_catalog SET fields=$2 WHERE type_id=$1',[fixture.schema.id,JSON.stringify(policy)])
    await addRecord(fixture,'Second fictional request',8,policy)
    const narrow = await queryRecords(fixture,{ fields: ['title'],limit: 1 })
    expect(narrow.nextCursor).toBeDefined()
    expect(JSON.parse(Buffer.from(narrow.nextCursor!,'base64url').toString()).values[0]).toBeNull()
    expect((await observedFields(narrow)).some(fields => fields.includes('created'))).toBe(false)
    await assign();const wide = await queryRecords(fixture,{ fields: ['title'],limit: 1 })
    expect(JSON.parse(Buffer.from(wide.nextCursor!,'base64url').toString()).values[0]).not.toBeNull()
    expect((await observedFields(wide)).every(fields => fields.includes('created'))).toBe(true)
    const row = await new ApplicationPlatformService([createCanonicalGenericApplicationModule()]).query(await nativeExecution(),'records','get',
      { type: fixture.type,id: fixture.row.id }) as ApplicationRecordProjection
    expect(row.values.created).toMatchObject({ kind: 'created_time',value: expect.any(String) })
    expect(row.absentFields ?? []).not.toContain('created')
  })
  it('captures managed author identity as an original member reference and holds it after membership loss',async () => {
    await clearRoles();const fixture = await catalogType()
    await store.updateEntityType(workspaceId,fixture.schema.id,{ properties: [...fixture.schema.properties,{ name: 'author',config: { kind: 'created_by' } }] })
    const policy = [...fields(),{ key: 'author',read: [],write: [],releaseReadTo: [],releaseWriteTo: [] }]
    await owner.query('UPDATE application_native_policy_fixture_catalog SET fields=$2 WHERE type_id=$1',[fixture.schema.id,JSON.stringify(policy)])
    const row = await createDbDocEntityStore({ actorUserId: otherId }).createEntity({ workspaceId,entityTypeId: fixture.schema.id,createdBy: otherId,lastEditedBy: otherId,
      sourceApp: 'api',data: { title: { kind: 'text',value: 'Fictional authored request' } } })
    await owner.query('INSERT INTO application_native_policy_fixture_metadata(resource_id,fields) VALUES($1,$2)',[row.id,JSON.stringify(policy)])
    const dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const value = await dispatcher.query(await nativeExecution(),'records','get',{ type: fixture.type,id: row.id }) as ApplicationRecordProjection
    expect(value.values.author).toEqual({ kind: 'created_by',value: otherId })
    const sources = boundScopeSources(value).filter(source => source.resourceKind === 'application_field')
    expect(sources).toHaveLength(2)
    expect((await owner.query('SELECT resource_id FROM application_field_resources WHERE id=ANY($1::uuid[])',[sources.map(source => source.resourceId)])).rows.map(row => row.resource_id).sort())
      .toEqual([row.id,otherId].sort())
    await owner.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,otherId])
    try {
      expect(await fieldSnapshot(sources[0])).toMatchObject({ held: true })
      await expect(dispatcher.query(await nativeExecution(),'records','get',{ type: fixture.type,id: row.id })).rejects.toMatchObject({ code: 'access_unavailable' })
    } finally { await owner.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'member','internal')",[workspaceId,otherId]) }
  })
  it.each(['member','external_user','service'] as const)('uses actual query-only %s authority without inventing read permission',async kind => {
    await clearRoles();const fixture = await record(),app = await application(fixture,kind,undefined,['query'])
    const execution = await resolveApplicationExecutionContext(app.authentication)
    const result = await queryRecords(fixture,{ fields: ['title'],filters: [{ field: 'title',op: 'eq',value: 'Fictional request' }] },execution)
    expect(result.records.map(row => row.ref.id)).toEqual([fixture.row.id]);expect(await observedFields(result)).toEqual([['title']])
    await expect(new ApplicationPlatformService([createCanonicalGenericApplicationModule()]).query(execution,'records','get',
      { type: fixture.type,id: fixture.row.id })).rejects.toMatchObject({ code: 'access_unavailable' })
    await expect(queryRecords(fixture,{ aggregate: [{ field: 'cost',operation: 'sum' }] },await resolveApplicationExecutionContext(app.authentication)))
      .rejects.toMatchObject({ code: 'access_unavailable' })
  })
  it('rechecks a query field role after execution before returning its aggregate',async () => {
    await clearRoles();const fixture = await record(),role = await assign();await assign('finance',otherId)
    const base = createCanonicalGenericApplicationModule(),query = base.queries.query
    const dispatcher = new ApplicationPlatformService([{ ...base,queries: { ...base.queries,query: { ...query,execute: async (context,input) => {
      const result = await query.execute(context,input)
      await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role]);return result
    } } } }])
    await expect(dispatcher.query(await nativeExecution(),'records','query',{ type: fixture.type,query: { aggregate: [{ field: 'cost',operation: 'sum' }] } }))
      .rejects.toMatchObject({ code: 'access_unavailable' })
    expect((await queryRecords(fixture,{ aggregate: [{ field: 'cost',operation: 'sum' }] },await nativeExecution(otherId))).aggregates?.[0].value).toBe('42')
  })
  it('binds a genuinely empty native query and count to an immutable domain without a business-row substitute',async () => {
    await clearRoles();const fixture = await catalogType(),value = await queryRecords(fixture,{ fields: ['title'],aggregate: [{ field: 'title',operation: 'count' }] })
    expect(value.records).toEqual([]);expect(value.aggregates).toEqual([{ field: 'title',operation: 'count',value: '0' }])
    const sources = boundScopeSources(value);expect(sources).toHaveLength(1);expect(sources[0].resourceKind).toBe('application_field')
    expect((await owner.query('SELECT selection,resource_id,fields FROM application_field_resources WHERE id=$1',[sources[0].resourceId])).rows[0])
      .toMatchObject({ selection: 'query_domain',fields: ['title'] })
    expect((await owner.query('SELECT count(*)::int AS count FROM entity_instances WHERE entity_type_id=$1',[fixture.schema.id])).rows[0].count).toBe(0)
    expect(await fieldSnapshot(sources[0],otherId)).toMatchObject({ held: false })
    expect(await fieldSnapshot(sources[0],ownerId)).toMatchObject({ held: false })
  })
  it.each(['app.agent_compartments','app.agent_project_ids'])('refuses a narrower empty-domain reader at %s despite readable General catalog metadata',async setting => {
    await clearRoles();const fixture = await catalogType(),value = await queryRecords(fixture,{ fields: ['title'] }),source = boundScopeSources(value)[0]
    await asMember(memberId,async client => {
      await client.query('SELECT set_config($1,$2,true)',[setting,'[]'])
      expect(await catalogOn(client,fixture)).not.toBeNull()
      expect((await client.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,source.resourceId,source.version])).rows[0].value)
        .toMatchObject({ held: true })
    })
    expect(await fieldSnapshot(source,otherId)).toMatchObject({ held: false })
  })
  it('contracts an empty aggregate domain after field-role loss while another actual member retains access',async () => {
    await clearRoles();const fixture = await catalogType(),role = await assign();await assign('finance',otherId)
    const value = await queryRecords(fixture,{ aggregate: [{ field: 'cost',operation: 'sum' }] }),source = boundScopeSources(value)[0]
    expect(value.records).toEqual([]);expect(value.aggregates?.[0].value).toBeNull()
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role])
    expect(await fieldSnapshot(source)).toMatchObject({ held: true })
    expect(await fieldSnapshot(source,otherId)).toMatchObject({ held: false })
  })
  it('preserves empty-domain ancestry through a real memory write and contracts the current reader independently',async () => {
    await clearRoles();const fixture = await catalogType(),role = await assign();await assign('finance',otherId)
    const value = await queryRecords(fixture,{ aggregate: [{ field: 'cost',operation: 'sum' }] }),sources = boundScopeSources(value)
    const derive = () => asMember(memberId,client => createMemory({ workspaceId,userId: null,assistantId,sensitivity: 'internal',createdByUserId: memberId,
      summary: 'Fictional empty-domain aggregate',derivation: { producer: 'query-domain-fixture',sources } },undefined,client))
    const memory = await derive()
    const ordinary = await asMember(memberId,client => createMemory({ workspaceId,userId: null,assistantId,sensitivity: 'internal',createdByUserId: memberId,summary: 'Fictional ordinary control' },undefined,client))
    const memorySource: ScopeSource = { workspaceId,userId: memory.userId,assistantId: memory.assistantId,sensitivity: memory.sensitivity,
      compartments: memory.compartments,projectIds: memory.projectIds,resourceKind: 'memory',resourceId: memory.id,version: memory.scopeVersion }
    expect(await readApplicationFieldAncestors(workspaceId,[memorySource])).toEqual(sources)
    const access = (await nativeExecution()).security.access
    expect(await getMemoryById(access,memory.id)).not.toBeNull()
    expect((await getMemoryIndex(access)).map(row => row.id)).toContain(memory.id)
    expect(await countMemories(access)).toBe(2)
    expect(await getMemoryById({ ...access,systemRead: true },memory.id)).toBeNull()
    expect(await getMemoryById({ ...access,systemRead: true },ordinary.id)).not.toBeNull()
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role])
    expect(await getMemoryById((await nativeExecution()).security.access,memory.id)).toBeNull()
    expect((await getMemoryIndex((await nativeExecution()).security.access)).map(row => row.id)).toEqual([ordinary.id])
    expect(await countMemories((await nativeExecution()).security.access)).toBe(1)
    expect((await getMemoryStats((await nativeExecution()).security.access)).total).toBe(1)
    expect(await searchMemories((await nativeExecution()).security.access,{ searchQuery: 'Fictional empty-domain' })).toEqual([])
    expect(await asMember(memberId,async client => (await client.query('SELECT summary FROM memories WHERE id=$1',[memory.id])).rows)).toEqual([])
    expect(await getMemoryById((await nativeExecution(otherId)).security.access,memory.id)).not.toBeNull()
    expect(await countMemories((await nativeExecution(otherId)).security.access)).toBe(2)
    await expect(derive()).rejects.toThrow('scope_source_changed')
    expect((await owner.query('SELECT count(*)::int AS count FROM memories WHERE workspace_id=$1 AND summary=$2',[workspaceId,'Fictional empty-domain aggregate'])).rows[0].count).toBe(1)
  })
  it('reads canonical memory values despite a caller-owned temporary memory table on the same backend',async () => {
    await clearRoles();const fixture = await catalogType();await assign()
    const result = await queryRecords(fixture,{ aggregate: [{ field: 'cost',operation: 'sum' }] }),sources = boundScopeSources(result)
    const memory = await asMember(memberId,client => createMemory({ workspaceId,userId: null,assistantId,sensitivity: 'internal',createdByUserId: memberId,
      summary: 'Fictional canonical memory',derivation: { producer: 'query-domain-fixture',sources } },undefined,client))
    const access = (await nativeExecution()).security.access,pool = getAppPool()
    const backend = await asMember(memberId,async client => {
      await client.query('CREATE TEMP TABLE memories (LIKE public.memories)')
      await client.query('INSERT INTO pg_temp.memories SELECT * FROM public.memories WHERE id=$1',[memory.id])
      await client.query('UPDATE pg_temp.memories SET summary=$2 WHERE id=$1',[memory.id,'Fictional counterfeit memory'])
      expect((await client.query('SELECT summary FROM memories WHERE id=$1',[memory.id])).rows[0].summary).toBe('Fictional counterfeit memory')
      return (await client.query<{ id: number }>('SELECT pg_backend_pid() AS id')).rows[0].id
    })
    const probes: Array<Promise<number>> = []
    const onAcquire = (client: PoolClient) => { probes.push(client.query<{ id: number }>('SELECT pg_backend_pid() AS id').then(value => value.rows[0].id)) }
    pool.on('acquire',onAcquire)
    try {
      const value = await getMemoryById(access,memory.id)
      expect(await Promise.all(probes)).toEqual([backend])
      expect(value?.summary).toBe('Fictional canonical memory')
    } finally {
      pool.off('acquire',onAcquire)
      const client = await pool.connect()
      try { await client.query('DROP TABLE IF EXISTS pg_temp.memories') } finally { client.release() }
    }
  })
  it('checks empty-domain authority before model session creation and keeps an independently entitled reader usable',async () => {
    await clearRoles();const fixture = await catalogType(),role = await assign();await assign('finance',otherId)
    const value = await queryRecords(fixture,{ aggregate: [{ field: 'cost',operation: 'sum' }] })
    const accumulator = new ContextScopeAccumulator({ sources: boundScopeSources(value) })
    let sessions = 0
    const provider: LLMProvider = { name: 'fixture',models: ['fixture-model'],createSession: () => {
      sessions++;return { send: () => (async function* () {
        yield { type: 'message_start' as const,model: 'fixture-model' };yield { type: 'text_delta' as const,text: 'Fictional checked empty-domain result' }
        yield { type: 'message_end' as const,stopReason: 'end_turn' as const,usage: { inputTokens: 1,outputTokens: 1 } }
      })() }
    },stream: () => { throw new Error('Unexpected fixture provider fallback') } }
    const run = (actor: ExecutionContext) => runAssistantTurn({ sessionId: actor.lifecycle.sessionId,policy: { admission: 'personal' },sink: { kind: 'return' },lease: { mode: 'none' },
      abortController: new AbortController(),model: { provider,model: 'fixture-model',configuredProviders: undefined,customLlm: null },
      loop: { ledger: NOOP_TURN_LEDGER,context: { ...executionToolContext(actor,{ appId: 'query-domain-fixture' }),scopeAccumulator: accumulator },
        systemPrompt: 'Fictional empty-domain policy fixture',runtimeSystemContext: JSON.stringify(value),messages: [{ role: 'user',content: 'Report the fictional total.' }],tools: new Map(),maxTurns: 1 } })
    const actor = await nativeExecution();await expect(run(actor)).resolves.toMatchObject({ selection: { kind: 'text' } });expect(sessions).toBe(1)
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[role])
    await expect(run(actor)).rejects.toMatchObject({ retrySafe: false });expect(sessions).toBe(1)
    await expect(run(await nativeExecution(otherId))).resolves.toMatchObject({ selection: { kind: 'text' } });expect(sessions).toBe(2)
  })
  it('uses deployed ownership and the current canonical schema across app aliases without returning business values',async () => {
    await clearRoles();const fixture = await record(),value = await mask(fixture)
    expect(value).toMatchObject({ moduleKey: 'operations',schemaVersion: String(fixture.schema.schemaVersion),recordVersion: fixture.row.recordVersion,
      readFields: ['title'],writeFields: ['title'] })
    expect(value?.policyVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(JSON.stringify(value)).not.toContain('Fictional request')
    expect(await asMember(memberId,client => maskOn(client,fixture,'portal_alias'))).toEqual(value)
    // The assurance harness grants SELECT after migration. RLS still reveals
    // no registry rows through that deliberately over-granted raw table path.
    expect(await asMember(memberId,async client => (await client.query('SELECT * FROM application_native_resource_owners')).rows)).toEqual([])
  })
  it('resolves current catalog fields for a genuinely empty type without a business-row substitute',async () => {
    await clearRoles();const fixture = await catalogType(),narrow = await catalogMask(fixture)
    expect(narrow).toMatchObject({ moduleKey: 'operations',schemaVersion: String(fixture.schema.schemaVersion),readFields: ['title'],writeFields: ['title'] })
    expect(narrow?.policyVersion).toMatch(/^[a-f0-9]{64}$/)
    expect(await asMember(memberId,client => catalogOn(client,fixture,'portal_alias'))).toEqual(narrow)
    expect((await owner.query('SELECT count(*)::int AS count FROM entity_instances WHERE entity_type_id=$1',[fixture.schema.id])).rows[0].count).toBe(0)
    expect(narrow).not.toHaveProperty('recordVersion');expect(narrow).not.toHaveProperty('values')
    await assign();expect((await catalogMask(fixture))?.readFields).toEqual(['cost','title'])
    expect((await catalogMask(fixture))?.writeFields).toEqual(['title'])
    await assign('approver');expect((await catalogMask(fixture))?.writeFields).toEqual(['cost','title'])
  })
  it('contracts an empty catalog on the same connection while another legitimate member retains its role',async () => {
    await clearRoles();const fixture = await catalogType(),assignment = await assign();await assign('finance',otherId)
    await asMember(memberId,async client => {
      expect((await catalogOn(client,fixture))?.readFields).toContain('cost')
      await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment])
      expect((await catalogOn(client,fixture))?.readFields).toEqual(['title'])
    })
    expect((await catalogMask(fixture,otherId))?.readFields).toContain('cost')
  })
  it('holds a registered missing catalog rather than looking for a usable business row',async () => {
    await clearRoles();const fixture = await record(true,'other_operations')
    expect(await catalogMask(fixture)).toBeNull()
    expect((await mask(fixture))?.readFields).toEqual(['title'])
  })
  it('does not remove a configured catalog to recover weaker per-record admission',async () => {
    await clearRoles();const fixture = await record()
    await expect(owner.query("UPDATE application_native_field_contracts SET catalog_reader=NULL WHERE module_key='operations'")).rejects.toMatchObject({ code: '22023' })
    expect((await catalogMask(fixture))?.readFields).toEqual(['title'])
  })
  it('keeps the compiled catalog role floor when a record-specific policy attempts to weaken it',async () => {
    await clearRoles();const fixture = await record(),weaker = fields()
    weaker[1].read = [];weaker[1].write = []
    await owner.query('UPDATE application_native_policy_fixture_metadata SET fields=$2 WHERE resource_id=$1',[fixture.row.id,JSON.stringify(weaker)])
    expect(await mask(fixture)).toMatchObject({ readFields: ['title'],writeFields: ['title'] })
    await assign();expect(await mask(fixture)).toMatchObject({ readFields: ['cost','title'],writeFields: ['title'] })
    await assign('approver');expect((await mask(fixture))?.writeFields).toEqual(['cost','title'])
  })
  it.each(['external_user','service'] as const)('keeps the catalog release floor for an actual %s despite a wider record policy',async kind => {
    await clearRoles();const fixture = await record(),weaker = fields()
    weaker[1].read = [];weaker[1].write = []
    weaker[1].releaseReadTo = ['external_user','service'];weaker[1].releaseWriteTo = ['external_user','service']
    await owner.query('UPDATE application_native_policy_fixture_metadata SET fields=$2 WHERE resource_id=$1',[fixture.row.id,JSON.stringify(weaker)])
    await assign('finance',ownerId);await assign('approver',ownerId)
    const app = await application(fixture,kind),dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const result = await dispatcher.query(await resolveApplicationExecutionContext(app.authentication),'records','get',
      { type: fixture.type,id: fixture.row.id }) as ApplicationRecordProjection
    expect(result.fields).toEqual(['title']);expect(result.values).not.toHaveProperty('cost')
    expect(boundScopeSources(result)).not.toHaveLength(0)
    expect((await owner.query('SELECT read_fields FROM application_access_grants WHERE id=$1',[app.grantId])).rows[0].read_fields).toContain('cost')
  })
  it('holds an oversized composed role policy instead of truncating either floor',async () => {
    await clearRoles();const fixture = await record(),recordFields = fields(),catalogFields = fields()
    const roles = ['finance','approver','reviewer','auditor']
    const clauses = Array.from({ length: 16 },(_,mask) => roles.filter((_,index) => mask & (1 << index)))
    recordFields[1].read = clauses.slice(0,8);catalogFields[1].read = clauses.slice(8)
    await owner.query("UPDATE application_native_field_contracts SET role_keys=$1 WHERE module_key='operations'",[roles])
    try {
      await owner.query('UPDATE application_native_policy_fixture_metadata SET fields=$2 WHERE resource_id=$1',[fixture.row.id,JSON.stringify(recordFields)])
      await owner.query('UPDATE application_native_policy_fixture_catalog SET fields=$2 WHERE type_id=$1',[fixture.schema.id,JSON.stringify(catalogFields)])
      expect(await mask(fixture)).toBeNull()
    } finally {
      await owner.query('UPDATE application_native_policy_fixture_metadata SET fields=$2 WHERE resource_id=$1',[fixture.row.id,JSON.stringify(fields())])
      await owner.query('UPDATE application_native_policy_fixture_catalog SET fields=$2 WHERE type_id=$1',[fixture.schema.id,JSON.stringify(fields())])
      await owner.query("UPDATE application_native_field_contracts SET role_keys=ARRAY['finance','approver'] WHERE module_key='operations'")
    }
  })
  it.each(['PUBLIC','assurance_app'] as const)('rejects catalog execution grants to %s at registration and use',async grantee => {
    await clearRoles();const fixture = await catalogType()
    await owner.query(`GRANT EXECUTE ON FUNCTION application_native_policy_fixture_catalog_reader(uuid,jsonb,text) TO ${grantee}`)
    try {
      expect(await catalogMask(fixture)).toBeNull()
      await expect(owner.query("UPDATE application_native_field_contracts SET contract_version='2' WHERE module_key='operations'")).rejects.toMatchObject({ code: '22023' })
    } finally { await owner.query(`REVOKE ALL ON FUNCTION application_native_policy_fixture_catalog_reader(uuid,jsonb,text) FROM ${grantee}`) }
    expect((await catalogMask(fixture))?.readFields).toEqual(['title'])
  })
  it.each(['PUBLIC','assurance_app'])('holds a record metadata port with a non-owner EXECUTE grant to %s at registration and use',async grantee => {
    await clearRoles();const fixture = await record()
    await owner.query(`GRANT EXECUTE ON FUNCTION application_native_policy_fixture_reader(uuid,jsonb,text,text) TO ${grantee}`)
    try {
      expect(await mask(fixture)).toBeNull()
      await expect(owner.query("UPDATE application_native_field_contracts SET contract_version='2' WHERE module_key='operations'")).rejects.toMatchObject({ code: '22023' })
    } finally { await owner.query(`REVOKE ALL ON FUNCTION application_native_policy_fixture_reader(uuid,jsonb,text,text) FROM ${grantee}`) }
  })
  it('resolves the empty catalog from canonical schemas despite a caller-created temporary metadata table',async () => {
    await clearRoles();const fixture = await catalogType()
    const wide = fields().map(field => ({ ...field,read: [] }))
    await asMember(memberId,async client => {
      await client.query("CREATE TEMP TABLE application_native_policy_fixture_catalog(type_id uuid PRIMARY KEY,fields jsonb NOT NULL,policy_version text DEFAULT '1',override jsonb DEFAULT '{}') ON COMMIT DROP")
      await client.query('INSERT INTO application_native_policy_fixture_catalog(type_id,fields) VALUES($1,$2)',[fixture.schema.id,JSON.stringify(wide)])
      await client.query('GRANT SELECT ON application_native_policy_fixture_catalog TO PUBLIC')
      expect((await catalogOn(client,fixture))?.readFields).toEqual(['title'])
    })
  })
  it.each(['missing','unknown-role','invalid-release','extra-payload','wrong-schema','wrong-origin','wrong-workspace'])(
    'refuses a malformed %s schema catalog without selecting a business record',async kind => {
      await clearRoles();const fixture = await catalogType(),policy = fields();let override: Record<string,unknown> = {}
      if (kind === 'missing') policy.pop()
      if (kind === 'unknown-role') policy[1].read = [['invented']]
      if (kind === 'invalid-release') policy[1].releaseReadTo = ['invented']
      if (kind === 'extra-payload') override = { values: { cost: 42 } }
      if (kind === 'wrong-schema') override = { schemaVersion: '0' }
      if (kind === 'wrong-origin') override = { origin: { kind: 'generic',entityTypeId: randomUUID() } }
      if (kind === 'wrong-workspace') override = { scope: { workspaceId: otherWorkspaceId,userId: null,assistantId: null,sensitivity: 'internal',compartments: [],projectIds: [] } }
      await owner.query('UPDATE application_native_policy_fixture_catalog SET fields=$2,override=$3 WHERE type_id=$1',[fixture.schema.id,JSON.stringify(policy),override])
      expect(await catalogMask(fixture)).toBeNull()
    })
  it('checks the current catalog scope and refuses native fallback for an application GUC',async () => {
    await clearRoles();const fixture = await catalogType()
    await owner.query('UPDATE application_native_policy_fixture_catalog SET override=$2 WHERE type_id=$1',[fixture.schema.id,
      { scope: { workspaceId,userId: null,assistantId: null,sensitivity: 'confidential',compartments: [],projectIds: [] } }])
    expect(await catalogMask(fixture)).toBeNull()
    expect((await catalogMask(fixture,ownerId))?.readFields).toEqual(['title'])
    await asMember(ownerId,async client => {
      await client.query("SELECT set_config('app.application_id',$1,true)",[randomUUID()])
      expect(await catalogOn(client,fixture)).toBeNull()
    })
  })
  it('checks current member/module roles and keeps read/write conjunctions distinct',async () => {
    await clearRoles();const fixture = await record()
    await assign('finance',otherId);await assign('finance',memberId,'other_operations');await assign('finance',memberId,'operations',otherWorkspaceId)
    expect(await mask(fixture)).toMatchObject({ readFields: ['title'],writeFields: ['title'] })
    await assign()
    expect(await mask(fixture)).toMatchObject({ readFields: ['cost','title'],writeFields: ['title'] })
    await assign('approver')
    expect(await mask(fixture)).toMatchObject({ readFields: ['cost','title'],writeFields: ['cost','title'] })
  })
  it('rechecks revocation on the same connection while another legitimate reader retains access',async () => {
    await clearRoles();const fixture = await record(),assignment = await assign();await assign('finance',otherId)
    await asMember(memberId,async client => {
      expect((await maskOn(client,fixture))?.readFields).toContain('cost')
      await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment])
      expect((await maskOn(client,fixture))?.readFields).toEqual(['title'])
    })
    expect((await mask(fixture,otherId))?.readFields).toContain('cost')
    await expect(owner.query("UPDATE application_native_role_assignments SET status='active' WHERE id=$1",[assignment])).rejects.toMatchObject({ code: '22023' })
  })
  it('enforces native module fields during capture and contracts an existing observation only for the revoked reader',async () => {
    await clearRoles();const fixture = await record(),assignment = await assign();await assign('finance',otherId)
    const wide = await capture(fixture,['cost','title']),source = wide.sources[0]
    expect(wide.values).toEqual({ title: { kind: 'text',value: 'Fictional request' },cost: { kind: 'number',value: 42 } })
    expect(await fieldSnapshot(source)).toMatchObject({ held: false })
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment])
    expect(await fieldSnapshot(source)).toMatchObject({ held: true })
    expect(await fieldSnapshot(source,otherId)).toMatchObject({ held: false })
    expect((await capture(fixture,['title'])).values).toEqual({ title: { kind: 'text',value: 'Fictional request' } })
    await expect(capture(fixture,['cost'])).rejects.toMatchObject({ code: '42501' })
  })
  it('does not bypass a canonical module owner with a generic alias or UUID spelling',async () => {
    await clearRoles();const fixture = await record(),origin = { ...fixture.origin,entityTypeId: fixture.schema.id.toUpperCase() }
    await expect(capture(fixture,['cost'],memberId,origin,'portal_alias')).rejects.toMatchObject({ code: '42501' })
    const canonical = await capture(fixture,['title']),alias = await capture(fixture,['title'],memberId,origin,'portal_alias')
    expect(alias.sources).toEqual(canonical.sources)
  })
  it('returns only current native fields through the production record getter',async () => {
    await clearRoles();const fixture = await record(),dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const get = async () => dispatcher.query(await nativeExecution(),'records','get',{ type: fixture.type,id: fixture.row.id }) as Promise<ApplicationRecordProjection>
    const narrow = await get()
    expect(narrow.fields).toEqual(['title']);expect(narrow.values).not.toHaveProperty('cost')
    expect(narrow.absentFields).toBeUndefined()
    const assignment = await assign(),wide = await get()
    expect(wide.fields.sort()).toEqual(['cost','title'])
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment])
    expect(await fieldSnapshot(boundScopeSources(wide)[0])).toMatchObject({ held: true })
    expect((await get()).fields).toEqual(['title'])
  })
  it('retains readable native absence in evidence without inventing a returned cell',async () => {
    await clearRoles();const fixture = await record(false),assignment = await assign()
    const dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const projected = await dispatcher.query(await nativeExecution(),'records','get',{ type: fixture.type,id: fixture.row.id }) as ApplicationRecordProjection
    expect(projected.fields).toEqual(['title']);expect(projected.values).not.toHaveProperty('cost')
    expect(projected.absentFields).toEqual(['cost'])
    const source = boundScopeSources(projected)[0]
    expect((await owner.query('SELECT fields FROM application_field_resources WHERE id=$1',[source.resourceId])).rows[0].fields).toEqual(['cost','title'])
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment])
    expect(await fieldSnapshot(source)).toMatchObject({ held: true })
    await expect(capture(fixture,['invented'])).rejects.toMatchObject({ code: '42501' })
  })
  it.each([true,false])('rechecks the original native field evidence at result admission (cost present: %s)',async includeCost => {
    await clearRoles();const fixture = await record(includeCost),assignment = await assign();await assign('finance',otherId)
    const base = createCanonicalGenericApplicationModule(),get = base.queries.get
    const dispatcher = new ApplicationPlatformService([{ ...base,queries: { ...base.queries,get: { ...get,execute: async (context,input) => {
      const result = await get.execute(context,input)
      await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment])
      return result
    } } } }])
    await expect(dispatcher.query(await nativeExecution(),'records','get',{ type: fixture.type,id: fixture.row.id })).rejects.toMatchObject({ code: 'access_unavailable' })
    const permitted = new ApplicationPlatformService([base])
    const sameRecord = await permitted.query(await nativeExecution(otherId),'records','get',{ type: fixture.type,id: fixture.row.id }) as ApplicationRecordProjection
    expect(sameRecord.fields.sort()).toEqual(includeCost ? ['cost','title'] : ['title'])
    expect(boundScopeSources(sameRecord)).not.toHaveLength(0)
  })
  it('rechecks the actual field role before the shared kernel creates a model session',async () => {
    await clearRoles();const fixture = await record(),assignment = await assign();await assign('finance',otherId)
    const observed = await capture(fixture,['cost','title'])
    const accumulator = new ContextScopeAccumulator({ sources: observed.sources })
    let sessions = 0,requests = 0
    const provider: LLMProvider = { name: 'fixture',models: ['fixture-model'],createSession: () => {
      sessions++
      return { send: () => (async function* () {
        requests++
        yield { type: 'message_start' as const,model: 'fixture-model' }
        yield { type: 'text_delta' as const,text: 'Fictional checked field result' }
        yield { type: 'message_end' as const,stopReason: 'end_turn' as const,usage: { inputTokens: 1,outputTokens: 1 } }
      })() }
    },stream: () => { throw new Error('Unexpected fixture provider fallback') } }
    const run = (actor: ExecutionContext) => runAssistantTurn({ sessionId: actor.lifecycle.sessionId,policy: { admission: 'personal' },sink: { kind: 'return' },lease: { mode: 'none' },
      abortController: new AbortController(),model: { provider,model: 'fixture-model',configuredProviders: undefined,customLlm: null },
      loop: { ledger: NOOP_TURN_LEDGER,context: { ...executionToolContext(actor,{ appId: 'native-field-fixture' }),scopeAccumulator: accumulator },
        systemPrompt: 'Fictional field policy fixture',runtimeSystemContext: JSON.stringify(observed.values),
        messages: [{ role: 'user',content: 'Report the fictional values.' }],tools: new Map(),maxTurns: 1 } })
    const actor = await nativeExecution(memberId)
    await expect(run(actor)).resolves.toMatchObject({ selection: { kind: 'text' } })
    expect({ sessions,requests }).toEqual({ sessions: 1,requests: 1 })
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment])
    await expect(run(actor)).rejects.toMatchObject({ retrySafe: false })
    expect({ sessions,requests }).toEqual({ sessions: 1,requests: 1 })
    await expect(run(await nativeExecution(otherId))).resolves.toMatchObject({ selection: { kind: 'text' } })
    expect({ sessions,requests }).toEqual({ sessions: 2,requests: 2 })
  })
  it.each(['native','application'] as const)('stops a live %s response after field-role loss without reviving the old context',async lane => {
    await clearRoles();const fixture = await record();await assign('finance',otherId)
    const assignment = await assign('finance',lane === 'native' ? memberId : ownerId)
    if (lane === 'application') await assign('finance',memberId)
    const actor = lane === 'native' ? await nativeExecution() : await resolveApplicationExecutionContext((await application(fixture,'member')).authentication)
    const projected = await new ApplicationPlatformService([createCanonicalGenericApplicationModule()]).query(actor,'records','get',
      { type: fixture.type,id: fixture.row.id }) as ApplicationRecordProjection
    const accumulator = new ContextScopeAccumulator({ sources: boundScopeSources(projected) })
    const events: unknown[] = [];let requests = 0,revoke = true
    const provider: LLMProvider = { name: 'fixture',models: ['fixture-model'],stream: () => { throw new Error('Unexpected fixture fallback') },
      createSession: () => ({ send: () => (async function* () {
        requests++
        yield { type: 'message_start' as const,model: 'fixture-model' }
        yield { type: 'text_delta' as const,text: 'Fictional permitted prefix' }
        if (revoke) await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[assignment])
        yield { type: 'text_delta' as const,text: 'Fictional withheld continuation' }
        yield { type: 'message_end' as const,stopReason: 'end_turn' as const,usage: { inputTokens: 1,outputTokens: 1 } }
      })() }) }
    const run = (execution: ExecutionContext) => runAssistantTurn({ sessionId: execution.lifecycle.sessionId,policy: { admission: 'personal' },
      sink: { kind: 'sse',onEvent: event => { events.push(event) } },lease: { mode: 'none' },abortController: new AbortController(),
      model: { provider,model: 'fixture-model',configuredProviders: undefined,customLlm: null },
      loop: { ledger: NOOP_TURN_LEDGER,context: { ...executionToolContext(execution,{ appId: 'field-output-fixture' }),scopeAccumulator: accumulator },
        systemPrompt: 'Fictional output fixture',runtimeSystemContext: JSON.stringify(projected.values),
        messages: [{ role: 'user',content: 'Report the fictional fields.' }],tools: new Map(),maxTurns: 1 } })
    await expect(run(actor)).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    expect(JSON.stringify(events)).toContain('Fictional permitted prefix')
    expect(JSON.stringify(events)).not.toContain('Fictional withheld continuation')
    revoke = false;await assign('finance',lane === 'native' ? memberId : ownerId)
    await expect(run(actor)).rejects.toMatchObject({ reason: 'authority_changed',retrySafe: false })
    expect(requests).toBe(1)
    // Independently entitled native readers keep the observation; restoring a
    // role does not revive a rejected invocation or cause a provider retry.
    events.length = 0
    await expect(run(await nativeExecution(otherId))).resolves.toMatchObject({ selection: { kind: 'text' } })
    expect(requests).toBe(2);expect(JSON.stringify(events)).toContain('Fictional withheld continuation')
  })
  it.each(['member','external_user','service'] as const)('intersects current module and issuer fields in an actual %s application',async kind => {
    await clearRoles();const fixture = await record();const issuerRole = await assign('finance',ownerId)
    await assign();const app = await application(fixture,kind),dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const run = async () => dispatcher.query(await resolveApplicationExecutionContext(app.authentication),'records','get',{ type: fixture.type,id: fixture.row.id }) as Promise<ApplicationRecordProjection>
    const first = await run()
    expect(first.fields.sort()).toEqual(kind === 'member' ? ['cost','title'] : ['title'])
    expect(first.values).toHaveProperty('title')
    if (kind !== 'member') expect(first.values).not.toHaveProperty('cost')
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[issuerRole])
    const contracted = await run()
    expect(contracted.fields).toEqual(['title']);expect(contracted.values).not.toHaveProperty('cost')
    expect((await owner.query('SELECT read_fields FROM application_access_grants WHERE id=$1',[app.grantId])).rows[0].read_fields).toContain('cost')
  })
  it('keeps a readable absent field in an actual app observation and contracts it after issuer role loss',async () => {
    await clearRoles();const fixture = await record(false),issuerRole = await assign('finance',ownerId);await assign()
    const app = await application(fixture,'member'),dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const execution = await resolveApplicationExecutionContext(app.authentication)
    const projected = await dispatcher.query(execution,'records','get',{ type: fixture.type,id: fixture.row.id }) as ApplicationRecordProjection
    expect(projected.values).not.toHaveProperty('cost')
    expect(projected.absentFields).toEqual(['cost'])
    const source = boundScopeSources(projected)[0]
    expect((await owner.query('SELECT fields FROM application_field_resources WHERE id=$1',[source.resourceId])).rows[0].fields).toEqual(['cost','title'])
    const modelContext = { ...executionToolContext(execution,{ appId: 'field-policy-fixture' }),scopeAccumulator: new ContextScopeAccumulator({ sources: boundScopeSources(projected) }) }
    await expect(assertSourceModelInputAuthority(modelContext)).resolves.toBeUndefined()
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[issuerRole])
    await expect(assertSourceModelInputAuthority(modelContext)).rejects.toMatchObject({ retrySafe: false })
    // This human retains an independent native entitlement. It does not repair
    // the application's revoked issuer floor or its old model context.
    expect(await fieldSnapshot(source)).toMatchObject({ held: false })
    const next = await dispatcher.query(await resolveApplicationExecutionContext(app.authentication),'records','get',{ type: fixture.type,id: fixture.row.id }) as ApplicationRecordProjection
    expect(next.fields).toEqual(['title'])
    expect(boundScopeSources(next)[0].resourceId).not.toBe(source.resourceId)
  })
  it('keeps every parent issuer field floor instead of unioning the child issuer role across the path',async () => {
    await clearRoles();const fixture = await record();await assign('finance',ownerId);await assign()
    const app = await application(fixture,'member',adminId),dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const run = async () => dispatcher.query(await resolveApplicationExecutionContext(app.authentication),'records','get',{ type: fixture.type,id: fixture.row.id }) as Promise<ApplicationRecordProjection>
    expect((await run()).fields).toEqual(['title'])
    const parentRole = await assign('finance',adminId)
    expect((await run()).fields.sort()).toEqual(['cost','title'])
    await owner.query("UPDATE application_native_role_assignments SET status='revoked' WHERE id=$1",[parentRole])
    expect((await run()).fields).toEqual(['title'])
  })
  it('does not count future or expired assignments and rejects unknown role keys',async () => {
    await clearRoles();const fixture = await record()
    await assign('finance',memberId,'operations',workspaceId,'2999-01-01T00:00:00Z')
    await assign('finance',memberId,'operations',workspaceId,'2020-01-01T00:00:00Z','2021-01-01T00:00:00Z')
    expect((await mask(fixture))?.readFields).toEqual(['title'])
    await expect(assign('invented')).rejects.toMatchObject({ code: '22023' })
    await expect(asMember(memberId,client => client.query(`INSERT INTO application_native_role_assignments(workspace_id,module_key,user_id,role_key,issued_by_user_id)
      VALUES($1,'operations',$2,'finance',$2)`,[workspaceId,memberId]))).rejects.toMatchObject({ code: '42501' })
  })
  it('does not read a caller-created temporary role table as module authority',async () => {
    await clearRoles();const fixture = await record()
    await asMember(memberId,async client => {
      await client.query(`CREATE TEMP TABLE application_native_role_assignments (
        workspace_id uuid,module_key text,user_id uuid,role_key text,status text,starts_at timestamptz,expires_at timestamptz)`)
      try {
        await client.query(`INSERT INTO pg_temp.application_native_role_assignments VALUES($1,'operations',$2,'finance','active','2020-01-01',NULL)`,[workspaceId,memberId])
        await client.query('GRANT SELECT ON pg_temp.application_native_role_assignments TO PUBLIC')
        expect((await maskOn(client,fixture))?.readFields).toEqual(['title'])
      } finally { await client.query('DROP TABLE pg_temp.application_native_role_assignments') }
    })
  })
  it('does not let a nested source helper replace a canonical sensitivity with temporary metadata',async () => {
    await clearRoles();const fixture = await record();await assign();await assign('finance',ownerId)
    fixture.row.recordVersion = (await owner.query("UPDATE entity_instances SET sensitivity='confidential' WHERE id=$1 RETURNING record_version::text",[fixture.row.id])).rows[0].record_version
    expect(await mask(fixture)).toBeNull()
    await asMember(memberId,async client => {
      await client.query(`CREATE TEMP TABLE entity_instances (
        id uuid,workspace_id uuid,entity_type_id uuid,record_version bigint,sensitivity text,compartments text[],project_ids uuid[])`)
      try {
        await client.query(`INSERT INTO pg_temp.entity_instances VALUES($1,$2,$3,$4,'public','{}','{}')`,[fixture.row.id,workspaceId,fixture.schema.id,fixture.row.recordVersion])
        await client.query('GRANT SELECT ON pg_temp.entity_instances TO PUBLIC')
        expect(await maskOn(client,fixture)).toBeNull()
      } finally { await client.query('DROP TABLE pg_temp.entity_instances') }
    })
    expect((await mask(fixture,ownerId))?.readFields).toEqual(['cost','title'])
  })
  it('pins nested source, field and scope-floor helpers to the trusted canonical schema path',async () => {
    const signatures = ['read_scope_source(uuid,text,uuid)','read_admitted_native_scope_snapshot(uuid,text,uuid)',
      'application_field_projection_state(uuid,jsonb,text,uuid,text,text,text[])','workflow_evidence_envelope_visible(uuid,jsonb)']
    const rows = await asMember(memberId,async client => (await client.query<{ proconfig: string[] }>(
      'SELECT proconfig FROM pg_proc WHERE oid=ANY($1::regprocedure[])',[signatures])).rows)
    expect(rows).toHaveLength(signatures.length)
    for (const row of rows) expect(row.proconfig).toContain('search_path=pg_catalog, public, pg_temp')
  })
  it('keeps current row and execution clearance floors even for a valid finance role',async () => {
    await clearRoles();const fixture = await record();await assign()
    fixture.row.recordVersion = (await owner.query("UPDATE entity_instances SET sensitivity='confidential' WHERE id=$1 RETURNING record_version::text",[fixture.row.id])).rows[0].record_version
    expect(await mask(fixture)).toBeNull()
    expect((await mask(fixture,ownerId))?.readFields).toEqual(['title'])
    fixture.row.recordVersion = (await owner.query("UPDATE entity_instances SET sensitivity='internal' WHERE id=$1 RETURNING record_version::text",[fixture.row.id])).rows[0].record_version
    await asMember(memberId,async client => {
      await client.query("SELECT set_config('app.agent_clearance','public',true)")
      expect(await maskOn(client,fixture)).toBeNull()
    })
  })
  it('refuses a stale record version, absent ownership and application or owner-login fallback',async () => {
    await clearRoles();const fixture = await record()
    expect(await asMember(memberId,client => maskOn(client,fixture,fixture.type,'999'))).toBeNull()
    await asMember(memberId,async client => {
      await client.query("SELECT set_config('app.application_id',$1,true)",[randomUUID()])
      expect(await maskOn(client,fixture)).toBeNull()
    })
    const client = await owner.connect()
    try { await client.query('BEGIN');await applyRLSGucs(client,memberId);expect(await maskOn(client,fixture)).toBeNull() }
    finally { await client.query('ROLLBACK');client.release() }
    await owner.query('DELETE FROM application_native_resource_owners WHERE workspace_id=$1 AND origin=$2',[workspaceId,fixture.origin])
    expect(await mask(fixture)).toBeNull()
  })
  it('intersects a current execution mutation floor while retaining readable fields',async () => {
    await clearRoles();const fixture = await record();await assign('finance',ownerId);await assign('approver',ownerId)
    await owner.query("INSERT INTO workspace_compartments(workspace_id,key,label) VALUES($1,'operations','Operations') ON CONFLICT DO NOTHING",[workspaceId])
    fixture.row.recordVersion = (await owner.query("UPDATE entity_instances SET compartments=ARRAY['operations'] WHERE id=$1 RETURNING record_version::text",[fixture.row.id])).rows[0].record_version
    await asMember(ownerId,async client => {
      await client.query("SELECT set_config('app.agent_compartments','[\"operations\"]',true),set_config('app.agent_mutation_compartments','[]',true)")
      expect(await maskOn(client,fixture)).toMatchObject({ readFields: ['cost','title'],writeFields: [] })
    })
  })
  it('matches the exported pure contract using actual current native SQL roles and canonical schema',async () => {
    await clearRoles();const fixture = await record();await assign();const actual = (await mask(fixture))!
    const ref = { workspaceId,origin: { kind: 'generic' as const,entityTypeId: fixture.schema.id },typeKey: fixture.type,id: fixture.row.id,version: fixture.row.recordVersion }
    const policy = defineNativeApplicationFieldPolicy({ moduleKey: 'operations',version: actual.policyVersion,roles: ['finance','approver'],resources: [
      { origin: ref.origin,typeKey: ref.typeKey,schemaVersion: actual.schemaVersion,fields: fields() },
    ] },[{ origin: ref.origin,typeKey: ref.typeKey,schemaVersion: actual.schemaVersion,
      fields: fixture.schema.properties.map(property => ({ key: property.name,label: property.name,kind: 'cell' as const,property })) }])
    const roles = (await owner.query<NativeApplicationFieldFacts['roles'][number]>(`SELECT workspace_id AS "workspaceId",module_key AS "moduleKey",user_id AS "userId",role_key AS "roleKey",
      to_char(starts_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS"Z"') AS "startsAt",NULL AS "expiresAt"
      FROM application_native_role_assignments WHERE workspace_id=$1 AND module_key='operations' AND user_id=$2 AND status='active'`,[workspaceId,memberId])).rows
    const pure = decideNativeApplicationFields(policy,ref,{ workspaceId,moduleKey: 'operations',userId: memberId,resource: ref,
      schemaVersion: actual.schemaVersion,policyVersion: actual.policyVersion,profile: 'native_member',roles,
      base: { allowed: true,readFields: ['cost','title'],writeFields: ['cost','title'] } })
    expect(pure).toMatchObject({ allowed: true,readFields: actual.readFields,writeFields: actual.writeFields })
  })
  it.each(['missing','unknown','duplicate','unknown-role','duplicate-clause','invalid-release','extra-payload'])(
    'refuses the complete malformed %s field catalog rather than returning partial permission',async kind => {
      await clearRoles();const fixture = await record(),policy = fields()
      if (kind === 'missing') policy.pop()
      if (kind === 'unknown') policy[1].key = 'invented'
      if (kind === 'duplicate') policy[1].key = 'title'
      if (kind === 'unknown-role') policy[1].read = [['invented']]
      if (kind === 'duplicate-clause') policy[1].read = [['finance','approver'],['approver','finance']]
      if (kind === 'invalid-release') policy[0].releaseReadTo = ['member']
      if (kind === 'extra-payload') Object.assign(policy[0],{ value: 'Fictional withheld value' })
      await owner.query('UPDATE application_native_policy_fixture_metadata SET fields=$2 WHERE resource_id=$1',[fixture.row.id,JSON.stringify(policy)])
      expect(await mask(fixture)).toBeNull()
    })
  it('binds the policy fingerprint to the current schema/contract and never caches role admission',async () => {
    await clearRoles();const fixture = await record(),before = await mask(fixture);await assign()
    const afterRole = await mask(fixture)
    expect(afterRole?.policyVersion).toBe(before?.policyVersion);expect(afterRole?.readFields).toContain('cost')
    await owner.query("UPDATE application_native_policy_fixture_metadata SET policy_version='2' WHERE resource_id=$1",[fixture.row.id])
    expect((await mask(fixture))?.policyVersion).not.toBe(before?.policyVersion)
    await expect(owner.query("UPDATE application_native_resource_owners SET module_key='other_operations' WHERE workspace_id=$1 AND origin=$2",[workspaceId,fixture.origin]))
      .rejects.toMatchObject({ code: '22023' })
  })
  it('preserves Department-v2 query-domain authority through actual memory and model admission',async () => {
    await withDepartmentQueryFixture(async (fixture,departments) => {
      const value = await queryRecords(fixture,{ fields: ['title'],aggregate: [{ field: 'title',operation: 'count' }] })
      const sources = boundScopeSources(value),actor = await nativeExecution()
      const context = (execution: ExecutionContext) => ({ ...executionToolContext(execution,{ appId: 'native-domain-fixture' }),
        scopeAccumulator: new ContextScopeAccumulator({ sources }) })
      const memory = await asMember(memberId,client => createMemory({ workspaceId,userId: null,assistantId,sensitivity: 'internal',createdByUserId: memberId,
        summary: 'Fictional Department domain result',derivation: { producer: 'native-domain-fixture',sources } },undefined,client))
      expect(await getMemoryById(actor.security.access,memory.id)).not.toBeNull()
      await expect(assertSourceModelInputAuthority(context(actor))).resolves.toBeUndefined()
      await owner.query('DELETE FROM department_edges WHERE department_id=$1 AND user_id=$2',[departments[0],memberId])
      expect(await getMemoryById((await nativeExecution()).security.access,memory.id)).toBeNull()
      await expect(assertSourceModelInputAuthority(context(actor))).rejects.toMatchObject({ retrySafe: false })
      const independent = await nativeExecution(otherId)
      expect(await getMemoryById(independent.security.access,memory.id)).not.toBeNull()
      await expect(assertSourceModelInputAuthority(context(independent))).resolves.toBeUndefined()
    })
  })
})
