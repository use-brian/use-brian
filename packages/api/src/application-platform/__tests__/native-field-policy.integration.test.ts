import { randomUUID,randomBytes } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import type { PoolClient } from 'pg'
import { getAppPool,getPool,applyRLSGucs } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { defineNativeApplicationFieldPolicy,decideNativeApplicationFields,ContextScopeAccumulator,executionToolContext,NOOP_TURN_LEDGER,boundScopeSources,
  type NativeApplicationFieldFacts,type ScopeSource,type ExecutionContext,type LLMProvider } from '@use-brian/core'
import { findAssistantById,findOrCreateUser } from '../../db/users.js'
import { resolveExecutionContextSystem } from '../../context-scope/execution-context.js'
import { runAssistantTurn } from '../../turn/kernel.js'
import type { ApplicationAccessGrant,ApplicationGrantMaximum,ApplicationRecordProjection } from '@use-brian/shared'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { hashSecret } from '../../db/api-key-store.js'
import { authenticateApplicationCredential,mintApplicationCredentialSecret } from '../credentials.js'
import { loadApplicationCredentialStateSystem } from '../auth-store.js'
import { authenticateApplicationOAuth } from '../oauth-auth.js'
import { resolveApplicationExecutionContext } from '../execution-context.js'
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
        RETURN jsonb_build_object('moduleKey','operations','origin',o,'typeKey','record.'||schema.id,'schemaVersion',schema.schema_version::text,
          'policyVersion',policy.policy_version,'recordVersion',r.record_version::text,
          'fieldKeys',(SELECT jsonb_agg(p->'name' ORDER BY p->>'name') FROM jsonb_array_elements(schema.properties) p),
          'fields',policy.fields,'source',read_scope_source(w,'entity_instance',r.id));
      END $$`)
    await owner.query('REVOKE ALL ON FUNCTION application_native_policy_fixture_reader(uuid,jsonb,text,text) FROM PUBLIC')
    for (const module of ['operations','other_operations']) await owner.query(`INSERT INTO application_native_field_contracts(module_key,contract_version,role_keys,metadata_reader)
      VALUES($1,'1',ARRAY['finance','approver'],'application_native_policy_fixture_reader(uuid,jsonb,text,text)'::regprocedure)`,[module])
  })
  afterAll(async () => {
    await owner.query('DELETE FROM workspaces WHERE id=ANY($1::uuid[])',[[workspaceId,otherWorkspaceId]])
    await owner.query('DELETE FROM application_native_field_contracts WHERE module_key=ANY($1::text[])',[['operations','other_operations']])
    await owner.query('DROP FUNCTION application_native_policy_fixture_reader(uuid,jsonb,text,text)')
    await owner.query('DROP TABLE application_native_policy_fixture_metadata')
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
  async function record(includeCost = true) {
    const schema = await store.createEntityType({ workspaceId,name: `Fictional purchases ${randomUUID()}`,createdBy: ownerId,
      properties: [{ name: 'title',config: { kind: 'text' } },{ name: 'cost',config: { kind: 'number',format: 'decimal' } }] })
    const row = await store.createEntity({ workspaceId,entityTypeId: schema.id,createdBy: ownerId,lastEditedBy: ownerId,sourceApp: 'api',
      data: { title: { kind: 'text',value: 'Fictional request' },...(includeCost ? { cost: { kind: 'number' as const,value: 42 } } : {}) } })
    const recordVersion = row.recordVersion
    if (!recordVersion) throw new Error('The canonical fixture requires its persisted record version.')
    const origin = { kind: 'generic' as const,entityTypeId: schema.id },type = `record.${schema.id}`
    await owner.query("INSERT INTO application_native_resource_owners(workspace_id,origin,resource_type,module_key) VALUES($1,$2,$3,'operations')",[workspaceId,origin,type])
    await owner.query('INSERT INTO application_native_policy_fixture_metadata(resource_id,fields) VALUES($1,$2)',[row.id,JSON.stringify(fields())])
    return { schema,row: { ...row,recordVersion },origin,type }
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
  async function application(fixture: Awaited<ReturnType<typeof record>>,kind: 'member' | 'external_user' | 'service',parentIssuer?: string) {
    const appId = randomUUID(),grantId = randomUUID(),parentId = parentIssuer ? randomUUID() : null
    let userId: string = kind === 'member' ? memberId : externalId
    if (kind === 'service') {
      userId = (await findOrCreateUser({ authProvider: 'channel',authProviderId: `app-service:${appId}:${randomUUID()}`,
        name: 'Fictional policy service',onboarding: 'application' })).user.id
      userIds.push(userId)
    }
    await owner.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id,origins)
      VALUES($1,$2,'records','Fictional policy client','api_client',$3,$4,ARRAY['https://frontend.example'])`,[appId,workspaceId,assistantId,ownerId])
    const grant = (id: string,parentGrantId: string | null): ApplicationAccessGrant => ({ id,appId,workspaceId,principal: { kind,userId },origin: fixture.origin,typeKey: fixture.type,
      actions: ['read','query','history','patch'],readFields: ['title','cost'],writeFields: ['title','cost'],selector: { kind: 'ids',ids: [fixture.row.id] },
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
})
