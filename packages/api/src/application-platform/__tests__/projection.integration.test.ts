import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { AsyncLocalStorage } from 'node:async_hooks'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import express from 'express'
import request from 'supertest'
import type { Pool,PoolClient } from 'pg'
import { ContextScopeAccumulator, executionToolContext, boundScopeSources, type ApplicationModuleDefinition, type ScopeSource } from '@use-brian/core'
import { applicationResourceSchema, type ApplicationAccessGrant, type ApplicationGrantMaximum, type ApplicationJson } from '@use-brian/shared'
import { getAppPool, getPool, queryWithRLS } from '../../db/client.js'
import { consumeHomeAppBudget } from '../../db/home-apps-store.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { findOrCreateUser } from '../../db/users.js'
import { hashSecret } from '../../db/api-key-store.js'
import { authenticateApplicationCredential, mintApplicationCredentialSecret } from '../credentials.js'
import { loadApplicationCredentialStateSystem } from '../auth-store.js'
import { authenticateApplicationOAuth } from '../oauth-auth.js'
import { getApplicationExecutionBinding, resolveApplicationExecutionContext,runWithApplicationReadTransaction } from '../execution-context.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalNativeApplicationModule } from '../native-adapters.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'
import { createCompany,getCompanyById,getContactById } from '../../db/crm.js'
import { createEntity } from '../../db/entities-store.js'
import { updateCrmCustomFields } from '../../db/crm-r2.js'
import { applicationPlatformRoutes } from '../../routes/application-platform.js'
import { createApiCorsMiddleware } from '../../cors-policy.js'
import { ApplicationManagementService } from '../management.js'
import { requireAuth } from '../../auth/middleware.js'
import { authSessionStore } from '../../db/auth-session-store.js'
import { createTokens } from '../../auth/jwt.js'
import { assertSourceModelInputAuthority } from '../model-source-authority.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-auth] database application projections and live authority', () => {
  const pool = getPool(), ownerId = randomUUID(), memberId = randomUUID(), externalId = randomUUID(), workspaceId = randomUUID(), assistantId = randomUUID()
  const store = createDbDocEntityStore({ actorUserId: ownerId })
  const users: string[] = [ownerId, memberId, externalId], clients: string[] = []
  let schemaId: string, recordId: string, otherId: string
  beforeAll(async () => {
    for (const id of users) await pool.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)", [id])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Application projection fixture',$2)", [workspaceId, ownerId])
    for (const [id, role, clearance] of [[ownerId, 'owner', 'confidential'], [memberId, 'member', 'internal']]) {
      await pool.query('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)', [workspaceId, id, role, clearance])
    }
    await pool.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Projection assistant',$2,$3,'primary','confidential')", [assistantId, ownerId, workspaceId])
    const schema = await store.createEntityType({ workspaceId, name: 'Requests', properties: [
      { name: 'title', config: { kind: 'text' }, required: true }, { name: 'cost', config: { kind: 'number', format: 'decimal' } },
    ], createdBy: ownerId })
    schemaId = schema.id
    for (const [index, title] of ['Visible request', 'Another customer request'].entries()) {
      const record = await store.createEntity({ workspaceId, entityTypeId: schemaId, data: {
        title: { kind: 'text', value: title }, cost: { kind: 'number', value: 1250 },
      }, sourceApp: 'api', createdBy: ownerId, lastEditedBy: ownerId })
      if (index === 0) recordId = record.id; else otherId = record.id
    }
  })
  afterAll(async () => {
    await pool.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    if (clients.length) await pool.query('DELETE FROM oauth_clients WHERE client_id=ANY($1::text[])', [clients])
    await pool.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [users])
    await getAppPool().end(); await pool.end()
  })
  const input = z.object({ type: z.literal('request').optional(), id: z.string().uuid().optional(), requiredFields: z.array(z.string()).default([]) }).strict()
  function service() {
    const module: ApplicationModuleDefinition<PoolClient> = { key: 'records', defaultState: 'enabled', application: {
      version: '1', dependencies: [], resources: [{ typeKey: 'request', origin: { kind: 'generic', entityTypeId: schemaId }, schemaVersion: '1',
        fields: [{ key: 'title', kind: 'text', label: 'Title' }, { key: 'cost', kind: 'number', label: 'Cost' }] }],
      queries: ['get', 'raw', 'metadata', 'module_state', 'field_capture', 'field_snapshot'], commands: ['verify'], events: ['request.checked'], policyCapabilities: ['canonical_generic'], backgroundHandlers: [], uiContributions: [],
    }, resolveResources: async ({ transaction }) => {
      const result = await transaction.query<{ resource: unknown }>("SELECT application_generic_catalog('request') AS resource")
      return result.rows.map(row => applicationResourceSchema.parse(row.resource))
    }, queries: {
      get: { input, authorize: async ({ transaction }) => {
        const result = await transaction.query('SELECT application_context_admitted($1) AS admitted', [workspaceId])
        if (!result.rows[0]?.admitted) throw new Error('access_unavailable')
      }, execute: async ({ transaction, execution }, raw) => {
        const parsed = input.parse(raw)
        const result = await transaction.query(`SELECT id,data,record_version::text FROM application_generic_projection($1,'request','query',$2,$3) ORDER BY id`,
          [schemaId, parsed.id ?? null, parsed.requiredFields])
        expect((await transaction.query("SELECT current_setting('app.current_user_id') AS actor")).rows[0].actor).toBe(execution.security.access.userId)
        return result.rows
      } },
      raw: { input, authorize: async () => {}, execute: async ({ transaction }) => (await transaction.query('SELECT data FROM entity_instances WHERE entity_type_id=$1', [schemaId])).rows },
      metadata: { input, authorize: async () => {}, execute: async ({ transaction }) => (await transaction.query("SELECT created_at,created_by,last_edited_at,last_edited_by FROM application_generic_projection($1,'request','read',$2)", [schemaId, recordId])).rows },
      module_state: { input, authorize: async () => {}, execute: async ({ transaction }) => (await transaction.query("SELECT state FROM application_lock_module($1,'records')", [workspaceId])).rows },
      field_capture: { input, authorize: async () => {}, execute: async ({ transaction }, raw) => {
        const parsed = input.parse(raw)
        return (await transaction.query('SELECT observe_application_field_projection($1,$2,$3,$4,$5,$6,$7,$8) AS value',
          [workspaceId,{ kind: 'generic', entityTypeId: schemaId },'request',parsed.id ?? recordId,'1','read',null,parsed.requiredFields])).rows[0].value
      } },
      field_snapshot: { input: z.object({ id: z.string().uuid(), version: z.string() }).strict(), authorize: async () => {}, execute: async ({ transaction }, raw) => {
        const parsed = raw as { id: string; version: string }
        return (await transaction.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value', [workspaceId,parsed.id,parsed.version])).rows[0].value
      } },
    }, commands: { verify: { input: z.object({}).strict(), eventKey: 'request.checked', authorize: async () => {}, authorizeResult: async () => {},
      execute: async () => { throw new Error('Disabled module executed new work') } } } }
    return new ApplicationPlatformService([module])
  }
  async function provision(kind: 'member' | 'external_user' | 'service', fields = ['title'], parentFields?: string[], tamperMaximum = false,
    nativeCompanyId?: string, additionalActions: string[] = [], recordIds: string[] = [recordId], selector?: ApplicationAccessGrant['selector'], oauthScope = 'read_write', compartments: string[] = [], nativeType = 'company',memberActor?:string) {
    const appId = randomUUID(), grantId = randomUUID(), parentId = parentFields ? randomUUID() : null
    let userId: string = kind === 'member' ? memberActor??memberId : externalId
    if (kind === 'service') {
      userId = (await findOrCreateUser({ authProvider: 'channel', authProviderId: `app-service:${appId}:${randomUUID()}`, name: 'Example service' })).user.id
      users.push(userId)
    }
    await pool.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id,origins)
      VALUES($1,$2,$5,'Example records client','api_client',$3,$4,ARRAY['https://frontend.example'])`, [appId, workspaceId, assistantId, ownerId, nativeCompanyId ? 'native' : 'records'])
    const grant = (id: string, readFields: string[], parentGrantId: string | null): ApplicationAccessGrant => ({
      id, appId, workspaceId, principal: { kind, userId }, origin: nativeCompanyId ? { kind: 'native', moduleKey: 'native' } : { kind: 'generic', entityTypeId: schemaId }, typeKey: nativeCompanyId ? nativeType : 'request',
      actions: ['read', 'query', 'history', 'patch', ...additionalActions], readFields, writeFields: readFields, selector: selector ?? { kind: 'ids', ids: nativeCompanyId ? [nativeCompanyId] : recordIds },
      version: 1, status: 'active', startsAt: '2026-01-01T00:00:00.000Z', expiresAt: null, parentGrantId,
      compartments, projectIds: [], clearance: 'confidential',
    })
    const path = [grant(grantId, fields, parentId), ...(parentId ? [grant(parentId, parentFields!, null)] : [])]
    for (const value of [...path].reverse()) await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
      resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance,parent_grant_id,starts_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$13,$8,$9,$9,$10,$14,'{}','confidential',$11,$12)`,
    [value.id, appId, workspaceId, kind, userId, ownerId, value.origin, value.actions, value.readFields, value.selector, value.parentGrantId, value.startsAt, value.typeKey,value.compartments])
    const maximum: ApplicationGrantMaximum = { version: 1, grants: path }
    if (kind === 'service') {
      const material = await mintApplicationCredentialSecret()
      await pool.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
        VALUES($1,$2,$3,$4,$5,'Example scoped service','service',$6,$7,now()+interval '1 hour')`,
      [material.id, appId, workspaceId, ownerId, userId, material.secretHash, grantId])
      await pool.query(`INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)`,
        [material.id, appId, workspaceId, grantId, tamperMaximum ? { version: 1, grants: [{ ...path[0], parentGrantId: null, readFields: ['title', 'cost', 'invented'] }] } : maximum])
      const credential = await authenticateApplicationCredential(material.token, appId, loadApplicationCredentialStateSystem)
      return { authentication: { credential: credential! }, appId, grantId, parentId, userId, token: material.token }
    }
    const oauthClient = await createDbOAuthClientStore().register({ clientName: 'Example portal', clientUri: 'https://portal.example', redirectUris: ['https://portal.example/callback'], tokenEndpointAuthMethod: 'none' })
    clients.push(oauthClient.clientId)
    await pool.query('UPDATE application_clients SET oauth_client_id=$2 WHERE id=$1', [appId, oauthClient.clientId])
    const id = randomUUID(), secret = randomBytes(32).toString('base64url')
    await pool.query(`INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,audience,application_client_id,access_token_hash,access_token_expires_at)
      VALUES($1,$2,$3,$4,$7,'application',$5,$6,now()+interval '10 minutes')`,
    [id, oauthClient.clientId, userId, workspaceId, appId, await hashSecret(secret), oauthScope])
    await pool.query(`INSERT INTO application_oauth_bindings(authorization_id,app_id,workspace_id,principal_user_id,parent_grant_id,maximum_grants) VALUES($1,$2,$3,$4,$5,$6)`,
      [id, appId, workspaceId, userId, grantId, JSON.stringify([maximum])])
    const user = await authenticateApplicationOAuth(`oat_${id}_${secret}`, appId)
    expect(user).not.toBeNull()
    return { authentication: { user: user! }, appId, grantId, parentId, userId, token: `oat_${id}_${secret}` }
  }
  async function historicalNativeAttributes(id:string,attributes:Record<string,unknown>) {
    const fixture=await pool.connect()
    try {
      // This guarded disposable fixture models rows written before value guards.
      // All real source, field and actor admission remains enabled during reads.
      await fixture.query('BEGIN')
      await fixture.query('ALTER TABLE entities DISABLE TRIGGER application_native_entity_values')
      await fixture.query('UPDATE entities SET attributes=$2 WHERE id=$1',[id,attributes])
      await fixture.query('ALTER TABLE entities ENABLE TRIGGER application_native_entity_values')
      await fixture.query('COMMIT')
    } finally {await fixture.query('ROLLBACK');fixture.release()}
  }
  it.each(['member','external_user','service'] as const)('Q02 evaluates only selected native codec values for the actual %s reader',async kind=>{
    const value=await createEntity({workspaceId,kind:'company',displayName:'Fictional selected historical codec',attributes:{},createdByUserId:ownerId,source:'user'})
    await historicalNativeAttributes(value.id,{crm_archived_at:'invalid historical timestamp'})
    const fixture=await provision(kind,['name','archivedAt'],undefined,false,value.id),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const execution=await resolveApplicationExecutionContext(fixture.authentication)
    expect((await dispatcher.query(execution,'native','get',{type:'company',id:value.id,fields:['name']}) as {values:unknown}).values).toEqual({name:value.displayName})
    expect((await dispatcher.query(execution,'native','get',{type:'company',id:value.id,fields:[]}) as {values:unknown}).values).toEqual({})
    const result=await dispatcher.query(execution,'native','query',{type:'company',query:{fields:['name'],aggregate:[{field:'name',operation:'count'}]}}) as {records:Array<{ref:{id:string}}>;aggregates:unknown}
    expect(result.records.map(row=>row.ref.id)).toEqual([value.id]);expect(result.aggregates).toEqual([{field:'name',operation:'count',value:'1'}])
    expect(boundScopeSources(result).length).toBeGreaterThan(1)
    await expect(dispatcher.query(execution,'native','get',{type:'company',id:value.id,fields:['archivedAt']})).rejects.toMatchObject({code:'invalid_value'})
    await expect(dispatcher.query(execution,'native','query',{type:'company',query:{fields:['name'],sort:[{field:'archivedAt',direction:'asc'}]}})).rejects.toMatchObject({code:'invalid_value'})
  })
  it.each((['member','external_user','service'] as const).flatMap(kind=>([
    {type:'company',field:'tags',attributes:{tags:{malformed:true}},valid:[]},
    {type:'deal',field:'stage',attributes:{stage:'unsupported historical value'},valid:'lead'},
  ] as const).map(value=>({...value,kind}))))('Q02 validates consumed historical $type field $field before predicate evaluation for $kind',async({kind,type,field,attributes,valid})=>{
    const value=await createEntity({workspaceId,kind:type,displayName:'Fictional historical typed value',attributes:{},createdByUserId:ownerId,source:'user'})
    await historicalNativeAttributes(value.id,attributes)
    const fixture=await provision(kind,['name',field],undefined,false,value.id,[],[value.id],undefined,'read_write',[],type),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const execution=await resolveApplicationExecutionContext(fixture.authentication)
    expect((await dispatcher.query(execution,'native','get',{type,id:value.id,fields:['name']}) as {values:unknown}).values).toEqual({name:value.displayName})
    const result=await dispatcher.query(execution,'native','query',{type,query:{fields:['name']}}) as {records:Array<{ref:{id:string}}>}
    expect(result.records.map(row=>row.ref.id)).toEqual([value.id])
    await expect(dispatcher.query(execution,'native','get',{type,id:value.id,fields:[field]})).rejects.toMatchObject({code:'invalid_value'})
    await expect(dispatcher.query(execution,'native','query',{type,query:{fields:['name'],filters:[{field,op:'eq',value:valid}]}})).rejects.toMatchObject({code:'invalid_value'})
    await expect(dispatcher.query(execution,'native','query',{type,query:{fields:[field]}})).rejects.toMatchObject({code:'invalid_value'})
  })
  it.each((['member','external_user','service'] as const).flatMap(kind=>(['company','person'] as const).map(type=>({kind,type}))))('Q02/Q03 retains the actual $kind application ceiling through a legacy $type getter',async({kind,type})=>{
    const value=await createEntity({workspaceId,kind:type,displayName:'Fictional legacy application point',attributes:type==='company'?{domain:'fictional.example'}:{email:'fictional@example.com',phone:'555-0100'},createdByUserId:ownerId,source:'user'})
    const fields=['name',...(type==='company'?['domain']:['email','phone','companyId']),'aliases','tags','externalRef','createdAt','updatedAt']
    const full=await provision(kind,fields,undefined,false,value.id,[],[value.id],undefined,'read_write',[],type),narrow=await provision(kind,['name'],undefined,false,value.id,[],[value.id],undefined,'read_write',[],type)
    let retained:(()=>Promise<unknown>)|undefined
    const getter=type==='company'?getCompanyById:getContactById,base=createCanonicalNativeApplicationModule()
    const dispatcher=new ApplicationPlatformService([{...base,application:{...base.application!,queries:[...base.application!.queries,'legacy_get','legacy_spoof','legacy_narrow']},queries:{...base.queries,
      legacy_get:{input:z.object({id:z.string().uuid()}),authorize:async()=>{},execute:({execution},raw)=>{
        const resume=AsyncLocalStorage.snapshot(),id=(raw as {id:string}).id;retained=()=>resume(()=>getter(execution.security.access,id));return getter(execution.security.access,id)}},
      legacy_narrow:{input:z.object({id:z.string().uuid()}),authorize:async()=>{},execute:({execution},raw)=>getter({...execution.security.access,clearance:'public'},(raw as {id:string}).id)},
      legacy_spoof:{input:z.object({id:z.string().uuid()}),authorize:async()=>{},execute:({execution},raw)=>getter({...execution.security.access,userId:ownerId},(raw as {id:string}).id)}}}])
    const record=await dispatcher.query(await resolveApplicationExecutionContext(full.authentication),'native','legacy_get',{id:value.id}) as {id:string}
    expect(record).toMatchObject({id:value.id,...(type==='company'?{domain:'fictional.example'}:{email:'fictional@example.com',phone:'555-0100'})});expect(boundScopeSources(record).length).toBeGreaterThan(0)
    expect(retained).toBeDefined();await expect(retained!()).rejects.toMatchObject({code:'access_unavailable'})
    expect(await dispatcher.query(await resolveApplicationExecutionContext(full.authentication),'native','legacy_narrow',{id:value.id})).toBeNull()
    await expect(dispatcher.query(await resolveApplicationExecutionContext(narrow.authentication),'native','legacy_get',{id:value.id})).rejects.toMatchObject({code:'access_unavailable'})
    await expect(dispatcher.query(await resolveApplicationExecutionContext(full.authentication),'native','legacy_spoof',{id:value.id})).rejects.toMatchObject({code:'access_unavailable'})
  })
  it('Q02/Q03 refuses an in-flight legacy getter before it can borrow another actual application transaction',async()=>{
    const value=await createEntity({workspaceId,kind:'company',displayName:'Fictional in-flight native point',attributes:{domain:'private.example'},createdByUserId:ownerId,source:'user'})
    const fields=['name','domain','aliases','tags','externalRef','createdAt','updatedAt'],narrow=await provision('member',['name'],undefined,false,value.id),broad=await provision('member',fields,undefined,false,value.id)
    const a=await resolveApplicationExecutionContext(narrow.authentication),b=await resolveApplicationExecutionContext(broad.authentication)
    let signalRequested!:()=>void,resumeSql!:()=>void
    const requested=new Promise<void>(resolve=>{signalRequested=resolve}),resumed=new Promise<void>(resolve=>{resumeSql=resolve})
    const connection=await getAppPool().connect();let pause=true,pending:Promise<unknown>|undefined
    // The real SQL/ACL and result run unchanged. Delay dispatch of one requested
    // value read to model transport scheduling across two committed host frames.
    const client={query:async(sql:string,values?:unknown[])=>{
      if(pause&&sql.includes('read_native_application_record(')&&Array.isArray(values?.[3])&&values[3].length){pause=false;signalRequested();await resumed}
      return connection.query(sql,values)
    },release:()=>{}} as unknown as PoolClient
    const base=createCanonicalNativeApplicationModule(),dispatcher=new ApplicationPlatformService([{...base,application:{...base.application!,queries:[...base.application!.queries,'start_unawaited','resume_broader']},queries:{...base.queries,
      start_unawaited:{input:z.object({}).strict(),authorize:async()=>{},execute:async({execution})=>{pending=getCompanyById(execution.security.access,value.id);await requested;return {started:true}}},
      resume_broader:{input:z.object({}).strict(),authorize:async()=>{},execute:async({execution})=>{expect(pending).toBeDefined();resumeSql();await expect(pending!).rejects.toMatchObject({code:'access_unavailable'});return getCompanyById(execution.security.access,value.id)}}}}],{connect:async()=>client} as unknown as Pool)
    try {
      expect(await dispatcher.query(a,'native','start_unawaited',{})).toEqual({started:true})
      expect(await dispatcher.query(b,'native','resume_broader',{})).toMatchObject({id:value.id,domain:'private.example'})
    } finally {resumeSql();await pending?.catch(()=>{});await connection.query('ROLLBACK');connection.release()}
  })
  it('Q02/Q03 permanently expires a read lease across real pooled-client reuse and rejects a different genuine frame',async()=>{
    const value=await createEntity({workspaceId,kind:'company',displayName:'Fictional pooled native read',attributes:{},createdByUserId:ownerId,source:'user'})
    const fields=['name','domain','aliases','tags','externalRef','createdAt','updatedAt'],fixture=await provision('member',fields,undefined,false,value.id)
    const execution=await resolveApplicationExecutionContext(fixture.authentication),other=await resolveApplicationExecutionContext(fixture.authentication)
    expect(other).not.toBe(execution)
    const connection=await getAppPool().connect(),physical=await connection.query<{pid:number}>('SELECT pg_backend_pid() AS pid'),pids:number[]=[]
    // One real nonowner database connection; only pool release is deferred until
    // fixture cleanup so separate committed host transactions reuse the same client.
    const client={query:connection.query.bind(connection),release:()=>{}} as unknown as PoolClient
    const poolView={connect:async()=>client} as unknown as Pool
    let retained:(()=>Promise<unknown>)|undefined
    const base=createCanonicalNativeApplicationModule(),dispatcher=new ApplicationPlatformService([{...base,application:{...base.application!,queries:[...base.application!.queries,'legacy_reuse','legacy_frame']},queries:{...base.queries,
      legacy_reuse:{input:z.object({}).strict(),authorize:async()=>{},execute:async({execution,transaction})=>{
        pids.push((await transaction.query<{pid:number}>('SELECT pg_backend_pid() AS pid')).rows[0].pid)
        if(retained)await expect(retained()).rejects.toMatchObject({code:'access_unavailable'})
        const resume=AsyncLocalStorage.snapshot();retained=()=>resume(()=>getCompanyById(execution.security.access,value.id))
        return getCompanyById(execution.security.access,value.id)
      }},legacy_frame:{input:z.object({}).strict(),authorize:async()=>{},execute:({transaction})=>runWithApplicationReadTransaction(transaction,other,()=>getCompanyById(other.security.access,value.id))}}}],poolView)
    try {
      expect(await dispatcher.query(execution,'native','legacy_reuse',{})).toMatchObject({id:value.id})
      expect(await dispatcher.query(execution,'native','legacy_reuse',{})).toMatchObject({id:value.id})
      expect(pids).toEqual([physical.rows[0].pid,physical.rows[0].pid])
      await expect(dispatcher.query(execution,'native','legacy_frame',{})).rejects.toMatchObject({code:'access_unavailable'})
    } finally {await connection.query('ROLLBACK');connection.release()}
  })
  it('Q02/Q08 preserves narrower shared-audience and v2 ceilings for a genuine owner-member application legacy getter',async()=>{
    const previous=(await pool.query('SELECT department_read_v2 AS value FROM workspaces WHERE id=$1',[workspaceId])).rows[0].value
    await pool.query('UPDATE workspaces SET department_read_v2=true WHERE id=$1',[workspaceId])
    try {
      const value=await createEntity({workspaceId,kind:'company',displayName:'Fictional private native point',attributes:{},userId:ownerId,createdByUserId:ownerId,source:'user'})
      const fields=['name','domain','aliases','tags','externalRef','createdAt','updatedAt'],fixture=await provision('member',fields,undefined,false,value.id,[],[value.id],undefined,'read_write',[],'company',ownerId)
      const base=createCanonicalNativeApplicationModule(),dispatcher=new ApplicationPlatformService([{...base,application:{...base.application!,queries:[...base.application!.queries,'legacy_private']},queries:{...base.queries,legacy_private:{input:z.object({ceiling:z.enum(['normal','shared','department'])}),authorize:async()=>{},execute:({execution},raw)=>{
        const ceiling=(raw as {ceiling:string}).ceiling,access=execution.security.access,grant=access.departmentRead
        if(!grant)throw new Error('The genuine v2 native member ceiling is unavailable.')
        return getCompanyById({...access,...(ceiling==='shared'?{sharedAudience:true}:ceiling==='department'?{departmentRead:{...grant,base:'public' as const,
          departments:Object.fromEntries(Object.keys(grant.departments).map(key=>[key,'public' as const])),cap:'public' as const}}:{})},value.id)
      }}}}])
      const execution=await resolveApplicationExecutionContext(fixture.authentication)
      expect(await dispatcher.query(execution,'native','legacy_private',{ceiling:'normal'})).toMatchObject({id:value.id})
      expect(await dispatcher.query(execution,'native','legacy_private',{ceiling:'shared'})).toBeNull()
      expect(await dispatcher.query(execution,'native','legacy_private',{ceiling:'department'})).toBeNull()
    } finally {await pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1',[workspaceId,previous])}
  })
  it.each([{type:'company',field:'domain',canonical:'fallback.example'},{type:'person',field:'email',canonical:'fallback@example.com'}] as const)('Q02 holds former native $field codec evidence without rewriting its source or observations',async({type,field,canonical})=>{
    const value=await createEntity({workspaceId,kind:type,canonicalId:canonical,displayName:'Fictional fallback codec evidence',attributes:{},createdByUserId:ownerId,source:'user'})
    const fixtures=await Promise.all([0,1].map(()=>provision('service',[field,'name'],undefined,false,value.id,[],[value.id],undefined,'read_write',[],type)))
    const base=createCanonicalNativeApplicationModule(),dispatcher=new ApplicationPlatformService([{...base,application:{...base.application!,queries:[...base.application!.queries,'field_snapshot']},queries:{...base.queries,field_snapshot:{input:z.object({id:z.string().uuid(),version:z.string()}),authorize:async()=>{},execute:async({transaction},raw)=>{const input=raw as {id:string;version:string};return(await transaction.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,input.id,input.version])).rows[0].value}}}}])
    const signature='public.application_native_builtin_field_revision(text,text)',codecSignature='public.application_native_entity_values(text,jsonb)'
    const definition=(await pool.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows[0].definition as string
    const codec=(await pool.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[codecSignature])).rows[0].definition as string
    const revised="WHEN p_type='company' AND p_field='domain' OR p_type='person' AND p_field='email' THEN 2",legacy=definition.replace(revised,revised.replace('THEN 2','THEN 1'))
    expect(legacy).not.toBe(definition)
    const oldCodec=codec.replace("'domain',coalesce(attrs->>'domain',payload->>'canonical_id')","'domain',attrs->'domain'").replace("'email',coalesce(attrs->>'email',payload->>'canonical_id')","'email',attrs->'email'")
    expect(oldCodec).not.toBe(codec)
    let old:ScopeSource|undefined,oldName:ScopeSource|undefined,artifact:unknown
    try{await pool.query(legacy);await pool.query(oldCodec)
      const result=await dispatcher.query(await resolveApplicationExecutionContext(fixtures[0].authentication),'native','get',{type,id:value.id,fields:[field]}) as {values:unknown}
      expect(result.values).toEqual({[field]:null});old=boundScopeSources(result)[0]
      const name=await dispatcher.query(await resolveApplicationExecutionContext(fixtures[0].authentication),'native','get',{type,id:value.id,fields:['name']})
      if(!name||typeof name!=='object')throw new Error('Native codec fixture is unavailable.');oldName=boundScopeSources(name)[0]
      artifact=(await pool.query('SELECT r.field_identity,o.record_version,o.policy_version FROM application_field_resources r JOIN application_field_observations o ON o.resource_id=r.id WHERE r.id=$1 AND o.version=$2',[old.resourceId,old.version])).rows[0]
    }finally{await pool.query(codec);await pool.query(definition)}
    for(const fixture of fixtures){const execution=await resolveApplicationExecutionContext(fixture.authentication)
      expect(await dispatcher.query(execution,'native','field_snapshot',{id:old!.resourceId,version:old!.version})).toMatchObject({held:true})
      expect(await dispatcher.query(execution,'native','field_snapshot',{id:oldName!.resourceId,version:oldName!.version})).toMatchObject({held:false})
      expect((await dispatcher.query(execution,'native','get',{type,id:value.id,fields:[field]}) as {values:unknown}).values).toEqual({[field]:canonical})
    }
    expect((await pool.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version).toBe('1')
    expect((await pool.query('SELECT r.field_identity,o.record_version,o.policy_version FROM application_field_resources r JOIN application_field_observations o ON o.resource_id=r.id WHERE r.id=$1 AND o.version=$2',[old!.resourceId,old!.version])).rows[0]).toEqual(artifact)
  })
  it('Q02 binds native cursors to codec metadata even when field shapes and business versions are unchanged',async()=>{
    const ids:string[]=[]
    for(const canonicalId of ['first.example','second.example'])ids.push((await createEntity({workspaceId,kind:'company',canonicalId,displayName:'Fictional native cursor codec',attributes:{},createdByUserId:ownerId,source:'user'})).id)
    const fixture=await provision('service',['name','domain'],undefined,false,ids[0],[],ids,{kind:'ids',ids}),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const signature='public.application_native_builtin_field_revision(text,text)',definition=(await pool.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows[0].definition as string
    const revised="WHEN p_type='company' AND p_field='domain' OR p_type='person' AND p_field='email' THEN 2",legacy=definition.replace(revised,revised.replace('THEN 2','THEN 1'))
    expect(legacy).not.toBe(definition)
    const query={fields:['name'],sort:[{field:'domain',direction:'asc'}],limit:1};let cursor:string|undefined
    try{await pool.query(legacy)
      const result=await dispatcher.query(await resolveApplicationExecutionContext(fixture.authentication),'native','query',{type:'company',query}) as {nextCursor?:string}
      cursor=result.nextCursor;expect(cursor).toBeDefined()
    }finally{await pool.query(definition)}
    await expect(dispatcher.query(await resolveApplicationExecutionContext(fixture.authentication),'native','query',{type:'company',query:{...query,cursor}})).rejects.toMatchObject({code:'invalid_value'})
    expect((await pool.query('SELECT DISTINCT scope_version::text AS version FROM entities WHERE id=ANY($1::uuid[])',[ids])).rows).toEqual([{version:'1'}])
  })
  it('Q02 consumes native output fields only for selected rows while proving predicates for all candidates',async()=>{
    const ids:string[]=[]
    for(const amount of ['100','0'])ids.push((await createEntity({workspaceId,kind:'deal',displayName:'Fictional native selected output',attributes:{stage:'lead',amount},createdByUserId:ownerId,source:'user'})).id)
    const fixture=await provision('service',['amount'],undefined,false,ids[0],[],ids,{kind:'ids',ids},'read_write',[],'deal')
    const existing=(await pool.query('SELECT credential_id,maximum_grant FROM application_credential_grants WHERE app_id=$1 AND grant_id=$2',[fixture.appId,fixture.grantId])).rows[0]
    const grant={...existing.maximum_grant.grants[0],id:randomUUID(),readFields:['name'],writeFields:[],selector:{kind:'ids',ids:[ids[0]]}}
    await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,actions,read_fields,write_fields,selector,clearance,compartments,project_ids,starts_at)
      VALUES($1,$2,$3,'service',$4,$5,$6,'deal',$7,$8,'{}',$9,'confidential','{}','{}',$10)`,[grant.id,fixture.appId,workspaceId,fixture.userId,ownerId,grant.origin,grant.actions,grant.readFields,grant.selector,grant.startsAt])
    await pool.query('INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)',[existing.credential_id,fixture.appId,workspaceId,grant.id,{version:1,grants:[grant]}])
    const authentication={credential:(await authenticateApplicationCredential(fixture.token,fixture.appId,loadApplicationCredentialStateSystem))!},dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const result=await dispatcher.query(await resolveApplicationExecutionContext(authentication),'native','query',{type:'deal',query:{fields:['name'],filters:[{field:'amount',op:'gt',value:'50'}]}}) as {records:Array<{ref:{id:string};values:unknown}>}
    expect(result.records).toEqual([expect.objectContaining({ref:expect.objectContaining({id:ids[0]}),values:{name:'Fictional native selected output'}})])
    await expect(dispatcher.query(await resolveApplicationExecutionContext(authentication),'native','query',{type:'deal',query:{fields:['name'],filters:[{field:'amount',op:'lt',value:'50'}]}})).rejects.toMatchObject({code:'access_unavailable'})
  })
  it('Q02 paginates native numeric ties and nulls without loss or duplicates and binds the cursor to its declared query',async()=>{
    const amounts=['9007199254740993.000000000000000002','9007199254740993.000000000000000001','9007199254740993.000000000000000002',null],ids:string[]=[]
    for(const amount of amounts) ids.push((await createEntity({workspaceId,kind:'deal',displayName:'Fictional native page',attributes:{stage:'lead',amount},createdByUserId:ownerId,source:'user'})).id)
    const fixture=await provision('service',['name','amount'],undefined,false,ids[0],[],ids,{kind:'ids',ids},'read_write',[],'deal')
    const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),execution=await resolveApplicationExecutionContext(fixture.authentication)
    const input={fields:['amount'],sort:[{field:'amount',direction:'asc' as const}],limit:2}
    const first=await dispatcher.query(execution,'native','query',{type:'deal',query:input}) as {records:Array<{ref:{id:string};values:{amount:string|null}}> ;nextCursor:string}
    const second=await dispatcher.query(execution,'native','query',{type:'deal',query:{...input,cursor:first.nextCursor}}) as typeof first
    const records=[...first.records,...second.records]
    expect(records.map(row=>row.values.amount)).toEqual([amounts[1],amounts[0],amounts[2],null]);expect(new Set(records.map(row=>row.ref.id))).toEqual(new Set(ids))
    expect(second.nextCursor).toBeUndefined()
    const malformed=JSON.parse(Buffer.from(first.nextCursor,'base64url').toString('utf8'));malformed.values[0]='not-a-decimal'
    await expect(dispatcher.query(execution,'native','query',{type:'deal',query:{...input,cursor:Buffer.from(JSON.stringify(malformed)).toString('base64url')}})).rejects.toMatchObject({code:'invalid_value'})
    await expect(dispatcher.query(execution,'native','query',{type:'deal',query:{...input,sort:[{field:'amount',direction:'desc'}],cursor:first.nextCursor}})).rejects.toMatchObject({code:'invalid_value'})
    const total=await dispatcher.query(execution,'native','query',{type:'deal',query:{fields:[],limit:1,aggregate:[{field:'amount',operation:'sum'},{field:'amount',operation:'count'}]}}) as {records:unknown[];aggregates:unknown}
    expect(total.records).toHaveLength(1);expect(total.aggregates).toEqual([{field:'amount',operation:'sum',value:'27021597764222979.000000000000000005'},{field:'amount',operation:'count',value:'3'}])
  })
  it.each(['member','external_user','service'] as const)('Q02 queries native exact decimal predicates and totals through the real %s factory',async kind=>{
    const value=await createEntity({workspaceId,kind:'deal',displayName:'Fictional exact native query',attributes:{stage:'lead',amount:'9007199254740993.123456789012345678'},createdByUserId:ownerId,source:'user'})
    const fixture=await provision(kind,['name','amount'],undefined,false,value.id,[],[value.id],undefined,'read_write',[],'deal')
    const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()]),execution=await resolveApplicationExecutionContext(fixture.authentication)
    const result=await dispatcher.query(execution,'native','query',{type:'deal',query:{fields:['name'],filters:[{field:'amount',op:'gt',value:'9007199254740993'}],aggregate:[{field:'amount',operation:'sum'}]}}) as {records:Array<{ref:{id:string};values:unknown}>;aggregates:unknown}
    expect(result.records).toEqual([expect.objectContaining({ref:expect.objectContaining({id:value.id}),values:{name:value.displayName}})])
    expect(result.aggregates).toEqual([{field:'amount',operation:'sum',value:'9007199254740993.123456789012345678'}])
    expect(boundScopeSources(result).length).toBeGreaterThan(1)
  })
  it.each(['filter','sort','sum','count','exists'] as const)('Q02 refuses a hidden native %s field before evaluating the query',async use=>{
    const value=await createEntity({workspaceId,kind:'deal',displayName:'Fictional hidden native predicate',attributes:{stage:'lead',amount:'42'},createdByUserId:ownerId,source:'user'})
    const fixture=await provision('service',['name'],undefined,false,value.id,[],[value.id],undefined,'read_write',[],'deal')
    const query={fields:['name'],...(use==='filter'?{filters:[{field:'amount',op:'gt',value:'100'}]}:use==='exists'?{filters:[{field:'amount',op:'neq',value:null}]}:use==='sort'?{sort:[{field:'amount',direction:'asc'}]}:{aggregate:[{field:'amount',operation:use}]})}
    const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    await expect(dispatcher.query(await resolveApplicationExecutionContext(fixture.authentication),'native','query',{type:'deal',query})).rejects.toMatchObject({code:'access_unavailable'})
  })
  it('Q02 captures a native empty query and invalidates it when an absent released candidate appears',async()=>{
    const id=randomUUID(),fixture=await provision('service',['name'],undefined,false,id),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const result=await dispatcher.query(await resolveApplicationExecutionContext(fixture.authentication),'native','query',{type:'company',query:{fields:['name']}}) as {records:unknown[]}
    expect(result.records).toEqual([]);expect(boundScopeSources(result).length).toBeGreaterThan(0)
    const source=boundScopeSources(result)[0]
    const base=createCanonicalNativeApplicationModule();const snapshots=new ApplicationPlatformService([{...base,application:{...base.application!,queries:[...base.application!.queries,'field_snapshot']},queries:{...base.queries,field_snapshot:{input:z.object({id:z.string().uuid(),version:z.string()}),authorize:async()=>{},execute:async({transaction},raw)=>{const input=raw as {id:string;version:string};return(await transaction.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,input.id,input.version])).rows[0].value}}}}])
    const snapshot=async(auth=fixture.authentication)=>snapshots.query(await resolveApplicationExecutionContext(auth),'native','field_snapshot',{id:source.resourceId,version:source.version})
    expect(await snapshot()).toMatchObject({held:false})
    await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,source,created_by_user_id) VALUES($1,$2,'company','Fictional formerly absent candidate','user',$3)",[id,workspaceId,ownerId])
    expect(await snapshot()).toMatchObject({held:true})
  })
  it('Q02 keeps native query evidence reader independent and captures predicates for excluded candidates',async()=>{
    const value=await createEntity({workspaceId,kind:'deal',displayName:'Fictional excluded native candidate',attributes:{stage:'lead',amount:'42'},createdByUserId:ownerId,source:'user'})
    const a=await provision('service',['name','amount'],undefined,false,value.id,[],[value.id],undefined,'read_write',[],'deal'),b=await provision('service',['name','amount'],undefined,false,value.id,[],[value.id],undefined,'read_write',[],'deal')
    const base=createCanonicalNativeApplicationModule(),dispatcher=new ApplicationPlatformService([{...base,application:{...base.application!,queries:[...base.application!.queries,'field_snapshot']},queries:{...base.queries,field_snapshot:{input:z.object({id:z.string().uuid(),version:z.string()}),authorize:async()=>{},execute:async({transaction},raw)=>{const input=raw as {id:string;version:string};return(await transaction.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,input.id,input.version])).rows[0].value}}}}])
    const query={type:'deal',query:{fields:['name'],filters:[{field:'amount',op:'gt',value:'100'}]}}
    const result=await dispatcher.query(await resolveApplicationExecutionContext(a.authentication),'native','query',query) as {records:unknown[]};expect(result.records).toEqual([])
    const sources=boundScopeSources(result);expect(sources.length).toBeGreaterThan(1)
    const snapshot=async(fixture:typeof a,source= sources[0])=>dispatcher.query(await resolveApplicationExecutionContext(fixture.authentication),'native','field_snapshot',{id:source.resourceId,version:source.version})
    for(const source of sources) expect(await snapshot(b,source)).toMatchObject({held:false})
    await pool.query("UPDATE application_access_grants SET read_fields=ARRAY['name'] WHERE id=$1",[a.grantId])
    expect(await snapshot(a)).toMatchObject({held:true});expect(await snapshot(b)).toMatchObject({held:false})
    await pool.query("UPDATE entities SET attributes=attributes||'{\"amount\":\"142\"}' WHERE id=$1",[value.id])
    expect(await snapshot(b)).toMatchObject({held:true})
  })
  it('Q02 reads selected canonical native tags, aliases and external references without coercion',async()=>{
    const value=await createEntity({workspaceId,kind:'company',displayName:'Fictional structured native fields',aliases:['fictional structured alias'],
      attributes:{tags:['fictional-tag'],external_ref:{provider:'fictional',id:'fictional-record'}},createdByUserId:ownerId,source:'user'})
    const fields=['tags','aliases','externalRef'],fixture=await provision('service',fields,undefined,false,value.id)
    const execution=await resolveApplicationExecutionContext(fixture.authentication),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const projection=await dispatcher.query(execution,'native','get',{type:'company',id:value.id,fields}) as {values:unknown;fields:string[]}
    expect(projection.values).toEqual({tags:['fictional-tag'],aliases:['fictional structured alias'],externalRef:{provider:'fictional',id:'fictional-record'}})
    expect(projection.fields.sort()).toEqual([...fields].sort())
    expect(boundScopeSources(projection)).toEqual(expect.arrayContaining([expect.objectContaining({resourceKind:'application_field'})]))
    await expect(dispatcher.query(execution,'native','get',{type:'company',id:value.id,fields:['domain']})).rejects.toMatchObject({code:'access_unavailable'})
  })
  it('Q02 reads the finite curated person vocabulary without inventing custom definitions',async()=>{
    const value=await createEntity({workspaceId,kind:'person',displayName:'Fictional curated native fields',
      attributes:{custom_fields:{organisation_name:'Fictional group',position:'Fictional role',mailing_address:'555 Example Lane'}},createdByUserId:ownerId,source:'user'})
    const fields=['custom.organisation_name','custom.position','custom.mailing_address'],fixture=await provision('service',fields,undefined,false,value.id,[],[value.id],undefined,'read_write',[],'person')
    const execution=await resolveApplicationExecutionContext(fixture.authentication),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    expect((await dispatcher.query(execution,'native','get',{type:'person',id:value.id,fields}) as {values:unknown}).values)
      .toEqual({'custom.organisation_name':'Fictional group','custom.position':'Fictional role','custom.mailing_address':'555 Example Lane'})
  })
  it.each([
    {field:'companyId',attribute:'company_id',sourceType:'person',targetType:'company'},
    {field:'contactId',attribute:'contact_id',sourceType:'deal',targetType:'person'},
    {field:'ownerId',attribute:'owner_id',sourceType:'company',targetType:'workspace_member'},
  ] as const)('Q02/Q03 independently admits selected native $field and its captured target',async({field,attribute,sourceType,targetType})=>{
    const targetId=targetType==='workspace_member'?memberId:(await createEntity({workspaceId,kind:targetType,
      displayName:'Fictional native relationship target',createdByUserId:ownerId,source:'user'})).id
    const source=await createEntity({workspaceId,kind:sourceType,displayName:'Fictional native relationship source',
      attributes:{[attribute]:targetId},createdByUserId:ownerId,source:'user'})
    const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const fixtures=await Promise.all([provision('service',[field],undefined,false,source.id,[],[source.id],undefined,'read_write',[],sourceType),
      provision('service',[field],undefined,false,source.id,[],[source.id],undefined,'read_write',[],sourceType)])
    const targets:string[]=[]
    for(const fixture of fixtures) {
      await expect(dispatcher.query(await resolveApplicationExecutionContext(fixture.authentication),'native','get',
        {type:sourceType,id:source.id,fields:[field]})).rejects.toMatchObject({code:'access_unavailable'})
      const targetGrant=randomUUID();targets.push(targetGrant)
      await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
        resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance,starts_at)
        VALUES($1,$2,$3,'service',$4,$5,'{"kind":"native","moduleKey":"native"}',$6,ARRAY['read'],'{}','{}',$7,'{}','{}','confidential',now()-interval '1 hour')`,
        [targetGrant,fixture.appId,workspaceId,fixture.userId,ownerId,targetType,{kind:'ids',ids:[targetId]}])
      await pool.query(`INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,'{}')`,
        [fixture.authentication.credential!.credentialId,fixture.appId,workspaceId,targetGrant])
    }
    const captures=[]
    for(const fixture of fixtures) {
      const projection=await dispatcher.query(await resolveApplicationExecutionContext(fixture.authentication),'native','get',
        {type:sourceType,id:source.id,fields:[field]}) as {values:unknown}
      expect(projection.values).toEqual({[field]:targetId});captures.push(projection)
      expect(boundScopeSources(projection).filter(source=>source.resourceKind==='application_field').length).toBeGreaterThanOrEqual(2)
    }
    await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[targets[0]])
    const first=await resolveApplicationExecutionContext(fixtures[0].authentication),second=await resolveApplicationExecutionContext(fixtures[1].authentication)
    await expect(dispatcher.query(first,'native','get',{type:sourceType,id:source.id,fields:[field]})).rejects.toMatchObject({code:'access_unavailable'})
    expect((await dispatcher.query(second,'native','get',{type:sourceType,id:source.id,fields:[field]}) as {values:unknown}).values).toEqual({[field]:targetId})
    const captured=boundScopeSources(captures[0])[0]
    const module=createCanonicalNativeApplicationModule()
    const reader=new ApplicationPlatformService([{...module,application:{...module.application!,queries:[...module.application!.queries,'snapshot']},queries:{...module.queries,
      snapshot:{input:z.object({}).strict(),authorize:async()=>{},execute:async({transaction})=>(await transaction.query(
        'SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,captured.resourceId,captured.version])).rows[0].value}}}])
    expect(await reader.query(first,'native','snapshot',{})).toMatchObject({held:true})
    expect(await reader.query(second,'native','snapshot',{})).toMatchObject({held:false})
  })
  it.each(['person','deal'] as const)('Q02 discovers an admitted prospective %s schema before its first canonical row',async type=>{
    const fields=type==='person'?['name','email']:['name','stage','amount'],key=type==='person'?'create_contact':'create_deal'
    const fixture=await provision('service',fields,undefined,false,randomUUID(),['create',`command:${key}`],[],{kind:'self'},'read_write',[],type)
    const execution=await resolveApplicationExecutionContext(fixture.authentication),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    expect((await dispatcher.catalog(execution)).resources.find(resource=>resource.typeKey===type)?.fields.map(field=>field.key).sort()).toEqual([...fields].sort())
  })
  it('Q02 pins a lossless native decimal capture to its current builtin codec identity',async()=>{
    const value=await createEntity({workspaceId,kind:'deal',displayName:'Fictional codec identity source',attributes:{stage:'lead',amount:'9007199254740993.000000000000000001'},createdByUserId:ownerId,source:'user'})
    const fixture=await provision('service',['amount'],undefined,false,value.id,[],[value.id],undefined,'read_write',[],'deal')
    const dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const projection=await dispatcher.query(await resolveApplicationExecutionContext(fixture.authentication),'native','get',{type:'deal',id:value.id,fields:['amount']}) as {values:unknown}
    expect(projection.values).toEqual({amount:'9007199254740993.000000000000000001'})
    const source=boundScopeSources(projection)[0]
    const identity=(await pool.query(`SELECT r.field_identity,application_field_digest(jsonb_build_object('origin',r.origin,'type',r.type_key,
      'fields',jsonb_build_array(jsonb_build_object('key','amount','kind','builtin','version',2)))) AS expected FROM application_field_resources r WHERE r.id=$1`,[source.resourceId])).rows[0]
    expect(identity.field_identity).toBe(identity.expected)
  })
  it('Q02 holds old native codec observations for independent readers while unchanged fields remain current',async()=>{
    const value=await createEntity({workspaceId,kind:'deal',displayName:'Fictional immutable codec source',attributes:{stage:'lead',amount:'9007199254740993.000000000000000001'},createdByUserId:ownerId,source:'user'})
    const fixtures=await Promise.all([0,1].map(()=>provision('service',['name','amount'],undefined,false,value.id,[],[value.id],undefined,'read_write',[],'deal')))
    const base=createCanonicalNativeApplicationModule(),snapshotInput=z.object({id:z.string().uuid(),version:z.string()}).strict()
    const dispatcher=new ApplicationPlatformService([{...base,application:{...base.application!,queries:[...base.application!.queries,'field_snapshot']},queries:{...base.queries,
      field_snapshot:{input:snapshotInput,authorize:async()=>{},execute:async({transaction},raw)=>{const input=snapshotInput.parse(raw);return (await transaction.query(
        'SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value',[workspaceId,input.id,input.version])).rows[0].value}}}}])
    const signature='public.application_native_builtin_field_revision(text,text)'
    const definition=(await pool.query('SELECT pg_get_functiondef($1::regprocedure) AS definition',[signature])).rows[0].definition as string
    const revised="WHEN p_type='deal' AND p_field='amount' THEN 2"
    expect(definition).toContain(revised)
    const legacy=definition.replace(revised,"WHEN p_type='deal' AND p_field='amount' THEN 1")
    let oldAmount:ScopeSource|undefined,oldName:ScopeSource|undefined,oldArtifact:unknown
    try {
      // Local migration fixture: only the historical codec metadata changes.
      // Current actor, grant, row/scope and every ACL function remain genuine.
      await pool.query(legacy)
      const execution=await resolveApplicationExecutionContext(fixtures[0].authentication)
      const amountProjection=await dispatcher.query(execution,'native','get',{type:'deal',id:value.id,fields:['amount']})
      const nameProjection=await dispatcher.query(execution,'native','get',{type:'deal',id:value.id,fields:['name']})
      if(!amountProjection || typeof amountProjection!=='object' || !nameProjection || typeof nameProjection!=='object') throw new Error('Canonical native fixture projections are unavailable.')
      oldAmount=boundScopeSources(amountProjection)[0]
      oldName=boundScopeSources(nameProjection)[0]
      oldArtifact=(await pool.query('SELECT r.field_identity,o.record_version,o.policy_version FROM application_field_resources r JOIN application_field_observations o ON o.resource_id=r.id WHERE r.id=$1 AND o.version=$2',[oldAmount.resourceId,oldAmount.version])).rows[0]
    } finally {await pool.query(definition)}
    expect(oldAmount).toBeDefined();expect(oldName).toBeDefined()
    const rowVersion=(await pool.query('SELECT scope_version::text AS version FROM entities WHERE id=$1',[value.id])).rows[0].version
    expect(rowVersion).toBe('1')
    let currentIdentity:string|undefined
    for(const fixture of fixtures) {
      const execution=await resolveApplicationExecutionContext(fixture.authentication)
      expect(await dispatcher.query(execution,'native','field_snapshot',{id:oldAmount!.resourceId,version:oldAmount!.version})).toMatchObject({held:true})
      expect(await dispatcher.query(execution,'native','field_snapshot',{id:oldName!.resourceId,version:oldName!.version})).toMatchObject({held:false})
      const fresh=await dispatcher.query(execution,'native','get',{type:'deal',id:value.id,fields:['amount']}) as {values:unknown}
      expect(fresh.values).toEqual({amount:'9007199254740993.000000000000000001'})
      expect(boundScopeSources(fresh)[0].resourceId).not.toBe(oldAmount!.resourceId)
      if(currentIdentity) expect(boundScopeSources(fresh)[0].resourceId).toBe(currentIdentity)
      else currentIdentity=boundScopeSources(fresh)[0].resourceId
    }
    expect((await pool.query('SELECT r.field_identity,o.record_version,o.policy_version FROM application_field_resources r JOIN application_field_observations o ON o.resource_id=r.id WHERE r.id=$1 AND o.version=$2',[oldAmount!.resourceId,oldAmount!.version])).rows[0]).toEqual(oldArtifact)
  })
  it('Q04 keeps a canonical JSON numeric deal amount lossless across an actual application projection',async () => {
    const id=randomUUID(),amount='9007199254740993.123456789012345678'
    await pool.query(`INSERT INTO entities(id,workspace_id,kind,display_name,attributes,created_by_user_id,source)
      VALUES($1,$2,'deal','Fictional precise deal',jsonb_build_object('stage','lead','amount',$3::numeric),$4,'user')`,[id,workspaceId,amount,ownerId])
    const fixture=await provision('service',['amount'],undefined,false,id,[],[id],undefined,'read_write',[],'deal')
    const execution=await resolveApplicationExecutionContext(fixture.authentication),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    expect((await dispatcher.query(execution,'native','get',{type:'deal',id}) as {values:Record<string,unknown>}).values).toEqual({amount})
  })
  it('[COMP:api/application-field-evidence] retains the same observation under fresh independent app authority after contraction', async () => {
    const first = await provision('member'), second = await provision('external_user'), dispatcher = service()
    const firstExecution = await resolveApplicationExecutionContext(first.authentication)
    const secondExecution = await resolveApplicationExecutionContext(second.authentication)
    const captured = await dispatcher.query(firstExecution,'records','field_capture',{ requiredFields: ['title'] }) as {
      values: unknown; sources: Array<{ resourceId: string; version: string }>; policyVersion: string
    }
    const same = await dispatcher.query(secondExecution,'records','field_capture',{ requiredFields: ['title'] }) as typeof captured
    expect(captured.values).toEqual({ title: { kind: 'text', value: 'Visible request' } })
    expect(same).toEqual(captured)
    const input = { id: captured.sources[0].resourceId, version: captured.sources[0].version }
    expect(await dispatcher.query(secondExecution,'records','field_snapshot',input)).toMatchObject({ held: false })
    const modelContext = { ...executionToolContext(secondExecution,{ appId: 'field-fixture' }),
      scopeAccumulator: new ContextScopeAccumulator({ sources: captured.sources as ScopeSource[] }) }
    await expect(assertSourceModelInputAuthority(modelContext)).resolves.toBeUndefined()
    await expect(dispatcher.query(secondExecution,'records','field_capture',{ requiredFields: ['cost'] })).rejects.toMatchObject({ code: 'access_unavailable' })
    await pool.query("UPDATE application_access_grants SET read_fields='{}' WHERE id=$1", [first.grantId])
    await expect(dispatcher.query(firstExecution,'records','field_snapshot',input)).rejects.toThrow()
    const contracted = await resolveApplicationExecutionContext(first.authentication)
    expect(await dispatcher.query(contracted,'records','field_snapshot',input)).toMatchObject({ held: true })
    await expect(dispatcher.query(secondExecution,'records','field_snapshot',input)).rejects.toMatchObject({ reason: 'authority_changed' })
    const independent = await resolveApplicationExecutionContext(second.authentication)
    expect(await dispatcher.query(independent,'records','field_snapshot',input)).toMatchObject({ held: false })
  })
  it.each(['member', 'external_user', 'service'] as const)('enforces exact record/field projections as a real non-bypass %s', async kind => {
    const fixture = await provision(kind), execution = await resolveApplicationExecutionContext(fixture.authentication), dispatcher = service()
    const result = await dispatcher.query(execution, 'records', 'get', {})
    expect(result).toEqual([{ id: recordId, data: { title: { kind: 'text', value: 'Visible request' } }, record_version: '1' }])
    expect(await dispatcher.query(execution, 'records', 'get', { id: otherId })).toEqual([])
    expect(await dispatcher.query(execution, 'records', 'raw', {})).toEqual([])
    expect(await dispatcher.query(execution, 'records', 'metadata', {})).toEqual([{ created_at: null, created_by: null, last_edited_at: null, last_edited_by: null }])
    await expect(dispatcher.query(execution, 'records', 'get', { requiredFields: ['cost'] })).rejects.toMatchObject({ code: 'access_unavailable' })
    const http = express(); http.use(createApiCorsMiddleware(['https://host.example']))
    http.use('/api/applications', applicationPlatformRoutes({ service: dispatcher,home: { signingSecret: 'fictional-home-origin-fixture',consumeBudget: consumeHomeAppBudget } }))
    const base = `/api/applications/${fixture.appId}`
    const read = await request(http).get(`${base}/records/request/${recordId}`).set('Authorization', `Bearer ${fixture.token}`)
    expect(read.status).toBe(200); expect(read.body).toEqual(result)
    const catalog = await request(http).get(`${base}/catalog`).set('Authorization', `Bearer ${fixture.token}`)
    expect(catalog.status).toBe(200); expect(catalog.body.resources[0].fields.map((field: { key: string }) => field.key)).toEqual(['title'])
    expect(catalog.body.operationSchemas.queries.get).toMatchObject({ type: 'object', properties: {
      input: { type: 'object', properties: { id: { type: 'string', format: 'uuid' } } },
    } })
    expect(catalog.body.operationSchemas.commands).toEqual({})
    expect((await request(http).get(`${base}/catalog`).set('Origin','null').set('Authorization',`Bearer ${fixture.token}`)).status).toBe(403)
    const spoof = await request(http).post(`${base}/queries/get`).set('Authorization', `Bearer ${fixture.token}`).send({ userId: ownerId, roles: ['owner'] })
    expect(spoof.status).toBe(400)
    expect((await request(http).get(`${base}/catalog`).set('Authorization', `Bearer ${fixture.token}`).set('X-UseBrian-User-Authorization', 'Bearer fictional-user')).status).toBe(401)
    const admitted = await request(http).options(`${base}/catalog`).set('Origin', 'https://frontend.example').set('Access-Control-Request-Headers', 'authorization')
    expect(admitted.status).toBe(204); expect(admitted.headers['access-control-allow-origin']).toBe('https://frontend.example')
    expect(admitted.headers['access-control-allow-credentials']).toBeUndefined()
    const refused = await request(http).options(`${base}/catalog`).set('Origin', 'https://unregistered.example')
    expect(refused.status).toBe(403); expect(refused.headers['access-control-allow-origin']).toBeUndefined()
    expect((await request(http).get(`${base}/catalog`)).status).toBe(401)
    if (kind !== 'member') expect((await pool.query('SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, fixture.userId])).rows).toEqual([])
  })
  it('rejects copied authentication/context metadata and cross-module calls', async () => {
    const fixture = await provision('service'), auth = fixture.authentication.credential!
    await expect(resolveApplicationExecutionContext({ credential: { ...auth } })).rejects.toMatchObject({ code: 'grant_revoked' })
    const execution = await resolveApplicationExecutionContext(fixture.authentication)
    expect(Reflect.set(execution.identity, 'kind', 'system')).toBe(false)
    expect(Object.isFrozen(execution.security.access.compartments)).toBe(true)
    const metadata = getApplicationExecutionBinding(execution)!
    metadata.state.principal.userId = ownerId
    expect(getApplicationExecutionBinding(execution)!.state.principal.userId).toBe(fixture.userId)
    await expect(service().query({ ...execution }, 'records', 'get', {})).rejects.toMatchObject({ code: 'authentication_required' })
    await expect(service().query(execution, 'native', 'get', {})).rejects.toMatchObject({ code: 'access_unavailable' })
    await expect(queryWithRLS(fixture.userId, 'SELECT department_principal_grant_snapshot($1)', [ownerId])).rejects.toMatchObject({ code: '42501' })
    await expect(queryWithRLS(fixture.userId, 'SELECT member_principal_operation_grants($1,false,$2)', [ownerId, workspaceId])).rejects.toMatchObject({ code: '42501' })
  })
  it('serves canonical get/query/history and full-set aggregates through the production module and HTTP router', async () => {
    const fixture = await provision('external_user', ['title', 'cost'], undefined, false, undefined, [], [recordId, otherId])
    const execution = await resolveApplicationExecutionContext(fixture.authentication)
    const dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const http = express(); http.use('/api/applications', applicationPlatformRoutes({ service: dispatcher }))
    const base = `/api/applications/${fixture.appId}`, headers = { Authorization: `Bearer ${fixture.token}` }
    const first = await request(http).get(`${base}/records/request/${recordId}`).set(headers)
    expect(first.status).toBe(200); expect(first.body.ref.id).toBe(recordId)
    expect(first.body.values.cost).toEqual({ kind: 'number', value: 1250 })
    const page = await request(http).post(`${base}/records/request/query`).set(headers).send({ limit: 1, fields: ['title'], aggregate: [{ field: 'cost', operation: 'sum' }] })
    expect(page.status).toBe(200); expect(page.body.records).toHaveLength(1)
    expect(page.body.records[0].fields).toEqual(['title']); expect(page.body.aggregates).toEqual([{ field: 'cost', operation: 'sum', value: '2500' }])
    const second = await request(http).post(`${base}/records/request/query`).set(headers).send({ limit: 1, fields: ['title'], cursor: page.body.nextCursor })
    expect(second.status).toBe(200); expect(second.body.records).toHaveLength(1)
    expect(second.body.records[0].ref.id).not.toBe(page.body.records[0].ref.id)
    const history = await request(http).get(`${base}/records/request/${recordId}/history`).set(headers)
    expect(history.status).toBe(200); expect(history.body).toHaveLength(1)
    expect(history.body[0].values.cost).toEqual({ kind: 'number', value: 1250 })
    const narrow = await provision('service', ['title'])
    for (const query of [{ fields: ['cost'] }, { filters: [{ field: 'cost', op: 'gt', value: 1 }] },
      { sort: [{ field: 'cost', direction: 'asc' }] }, { aggregate: [{ field: 'cost', operation: 'count' }] }]) {
      expect((await request(http).post(`/api/applications/${narrow.appId}/records/request/query`).set('Authorization', `Bearer ${narrow.token}`).send(query)).status).toBe(403)
    }
    const masked = await request(http).get(`/api/applications/${narrow.appId}/records/request/${recordId}/history`).set('Authorization', `Bearer ${narrow.token}`)
    expect(masked.status).toBe(200); expect(masked.body[0].values).toEqual({ title: { kind: 'text', value: 'Visible request' } })
  })
  it.each(['member', 'external_user', 'service'] as const)('uses one canonical transactional writer with field masks, CAS, rollback and deletion replay for %s', async kind => {
    const id = randomUUID(), firstBatchId = randomUUID(), invalidBatchId = randomUUID()
    const fixture = await provision(kind, ['title'], undefined, false, undefined,
      ['create', 'delete', 'command:record_create', 'command:record_patch', 'command:record_delete', 'command:record_batch'], [id, firstBatchId, invalidBatchId])
    const dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const http = express(); http.use('/api/applications', applicationPlatformRoutes({ service: dispatcher }))
    const headers = { Authorization: `Bearer ${fixture.token}` }, base = `/api/applications/${fixture.appId}`
    const command = (key: string, input: unknown, idempotencyKey = randomUUID()) => request(http).post(`${base}/commands/${key}`).set(headers).send({ input, idempotencyKey })
    const createInput = { operation: 'create', type: 'request', id, data: { title: { kind: 'text' as const, value: 'Created through canonical command' } } }
    const createKey = randomUUID(), created = await command('record_create', createInput, createKey)
    expect(created.status).toBe(200); expect(created.body.resources[0]).toMatchObject({ id, version: '1' })
    const replay = await command('record_create', createInput, createKey)
    expect(replay.status).toBe(200); expect(replay.body.id).toBe(created.body.id)
    expect((await pool.query('SELECT created_by FROM entity_instances WHERE id=$1', [id])).rows[0].created_by).toBe(fixture.userId)
    const hidden = await command('record_patch', { operation: 'patch', type: 'request', id, expectedVersion: '1', data: { cost: { kind: 'number', value: 3 } } })
    expect(hidden.status).toBe(403)
    await store.updateEntity(workspaceId, id, { data: { ...createInput.data, cost: { kind: 'number', value: 1250 } } }, { actorUserId: ownerId, expectedRecordVersion: '1' })
    const changed = await command('record_patch', { operation: 'patch', type: 'request', id, expectedVersion: '2', data: { title: { kind: 'text', value: 'Visible patch' } } })
    expect(changed.status).toBe(200); expect(changed.body.resources[0].version).toBe('3')
    expect((await store.getEntity(workspaceId, id))?.data.cost).toEqual({ kind: 'number', value: 1250 })
    const races = await Promise.all(['First winner', 'Second winner'].map(value => command('record_patch',
      { operation: 'patch', type: 'request', id, expectedVersion: '3', data: { title: { kind: 'text', value } } })))
    expect(races.map(result => result.status).sort()).toEqual([200, 409])
    const before = await store.getEntity(workspaceId, id), failKey = randomUUID()
    const deniedBatch = await command('record_batch', { operations: [
      { operation: 'patch', type: 'request', id, expectedVersion: '4', data: { title: { kind: 'text', value: 'Must roll back' } } },
      { operation: 'patch', type: 'request', id: otherId, expectedVersion: '1', data: { title: { kind: 'text', value: 'Unavailable record' } } },
    ] }, failKey)
    expect(deniedBatch.status).toBe(403); expect((await store.getEntity(workspaceId, id))?.data).toEqual(before?.data)
    expect((await pool.query('SELECT id FROM application_operation_receipts WHERE idempotency_key=$1', [failKey])).rows).toEqual([])
    const invalidKey = randomUUID(), invalidBatch = await command('record_batch', { operations: [
      { operation: 'create', type: 'request', id: firstBatchId, data: { title: { kind: 'text', value: 'Must roll back' } } },
      { operation: 'create', type: 'request', id: invalidBatchId, data: {} },
    ] }, invalidKey)
    expect(invalidBatch.status).toBe(400)
    expect((await pool.query('SELECT id FROM entity_instances WHERE id=ANY($1::uuid[])', [[firstBatchId, invalidBatchId]])).rows).toEqual([])
    expect((await pool.query('SELECT id FROM application_operation_receipts WHERE idempotency_key=$1', [invalidKey])).rows).toEqual([])
    const deleteKey = randomUUID(), deleteInput = { operation: 'delete', type: 'request', id, expectedVersion: '4' }
    const deleted = await command('record_delete', deleteInput, deleteKey)
    expect(deleted.status).toBe(200); expect(deleted.body.resources[0]).toMatchObject({ id, version: '5' })
    const deleteReplay = await command('record_delete', deleteInput, deleteKey)
    expect(deleteReplay.status).toBe(200); expect(deleteReplay.body.id).toBe(deleted.body.id)
    expect((await pool.query('SELECT id FROM application_record_tombstones WHERE id=$1', [id])).rows).toEqual([{ id }])
    expect((await request(http).get(`${base}/records/request/${id}`).set(headers)).status).toBe(403)
    const receiptEffects = await pool.query(`SELECT (SELECT count(*)::int FROM application_command_audit WHERE receipt_id=$1) AS audit,
      (SELECT count(*)::int FROM application_committed_events WHERE receipt_id=$1) AS events`, [created.body.id])
    expect(receiptEffects.rows[0]).toEqual({ audit: 1, events: 1 })
    await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1", [fixture.grantId])
    expect((await command('record_delete', deleteInput, deleteKey)).status).toBeGreaterThanOrEqual(400)
  })
  it('classifies a new canonical application record with its explicit resource scope instead of General', async () => {
    const before = (await pool.query('SELECT department_read_v2 FROM workspaces WHERE id=$1', [workspaceId])).rows[0].department_read_v2
    await pool.query('UPDATE workspaces SET department_read_v2=false WHERE id=$1', [workspaceId])
    try {
      const fixture = await provision('service', ['title'], undefined, false, undefined, ['create','command:record_create'], [], { kind: 'self' }, 'read_write', ['app_scope_fixture'])
      const execution = await resolveApplicationExecutionContext(fixture.authentication), dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
      const receipt = await dispatcher.command(execution, 'records', 'record_create', { idempotencyKey: randomUUID(), input: {
        operation: 'create', type: 'request', data: { title: { kind: 'text', value: 'Explicitly classified request' } },
      } })
      expect((await pool.query('SELECT compartments,project_ids,sensitivity,created_by FROM entity_instances WHERE id=$1', [receipt.resources[0].id])).rows[0])
        .toEqual({ compartments: ['app_scope_fixture'], project_ids: [], sensitivity: 'internal', created_by: fixture.userId })
      expect((await dispatcher.query(execution, 'records', 'get', { type: 'request', id: receipt.resources[0].id }) as { values: unknown }).values)
        .toEqual({ title: { kind: 'text', value: 'Explicitly classified request' } })
    } finally { await pool.query('UPDATE workspaces SET department_read_v2=$2 WHERE id=$1', [workspaceId,before]) }
  })
  it('withholds a generic payload whose canonical version changes between execution and result admission', async () => {
    const record = await store.createEntity({ workspaceId, entityTypeId: schemaId, data: { title: { kind: 'text', value: 'Before change' } },
      sourceApp: 'api', createdBy: ownerId, lastEditedBy: ownerId })
    const fixture = await provision('service', ['title'], undefined, false, undefined, [], [record.id])
    const module = createCanonicalGenericApplicationModule(), execute = module.queries.get.execute
    const dispatcher = new ApplicationPlatformService([{ ...module, queries: { ...module.queries, get: { ...module.queries.get,
      execute: async (context, input) => {
        const result = await execute(context, input)
        await queryWithRLS(ownerId, `UPDATE entity_instances SET data=$2::jsonb,last_edited_by=$3 WHERE id=$1`,
          [record.id, { title: { kind: 'text', value: 'After change' } }, ownerId])
        return result
      },
    } } }])
    const http = express(); http.use('/api/applications', applicationPlatformRoutes({ service: dispatcher }))
    const result = await request(http).get(`/api/applications/${fixture.appId}/records/request/${record.id}`).set('Authorization', `Bearer ${fixture.token}`)
    expect(result.status).toBe(403); expect(JSON.stringify(result.body)).not.toContain('Before change')
    expect((await store.getEntity(workspaceId, record.id))?.data.title.value).toBe('After change')
  })
  it.each(['member', 'external_user', 'service'] as const)('uses the shared real MCP transport with current record/field and command authority for %s', async kind => {
    const row = await store.createEntity({ workspaceId, entityTypeId: schemaId, sourceApp: 'api', createdBy: ownerId, lastEditedBy: ownerId,
      data: { title: { kind: 'text', value: 'MCP request' }, cost: { kind: 'number', value: 12 } } })
    const fixture = await provision(kind, ['title'], undefined, false, undefined, ['command:record_patch'], [row.id])
    const http = express(); http.use('/api/applications', applicationPlatformRoutes({ service: new ApplicationPlatformService([createCanonicalGenericApplicationModule()]) }))
    const endpoint = `/api/applications/${fixture.appId}/mcp`
    function rpc(method: string, params?: unknown, token = fixture.token) {
      return request(http).post(endpoint).set('Authorization', `Bearer ${token}`).set('Accept', 'application/json, text/event-stream')
        .set('MCP-Protocol-Version', '2025-11-25').send({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) })
    }
    function decode(response: { body: unknown; text: string }) {
      const line = response.text.split('\n').find(line => line.startsWith('data: '))
      return line ? JSON.parse(line.slice(6)) : response.body
    }
    const initialized = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'Example application client', version: '1' } })
    expect(initialized.status).toBe(200); expect(decode(initialized).result.serverInfo.name).toBe('use-brian-application')
    const listed = await rpc('tools/list')
    expect(listed.status).toBe(200); expect(decode(listed).result.tools.map((tool: { name: string }) => tool.name)).toEqual(['applicationCatalog', 'applicationQuery', 'applicationCommand'])
    const read = await rpc('tools/call', { name: 'applicationQuery', arguments: { queryKey: 'get', input: { type: 'request', id: row.id } } })
    expect(read.status).toBe(200)
    expect(JSON.parse(decode(read).result.content[0].text).values).toEqual({ title: { kind: 'text', value: 'MCP request' } })
    const denied = await rpc('tools/call', { name: 'applicationQuery', arguments: { queryKey: 'query', input: { type: 'request', query: { filters: [{ field: 'cost', op: 'gt', value: 1 }] } } } })
    expect(decode(denied).result.isError).toBe(true); expect(JSON.parse(decode(denied).result.content[0].text).error).toBe('access_unavailable')
    const args = { name: 'applicationCommand', arguments: { commandKey: 'record_patch', command: { idempotencyKey: randomUUID(), input: {
      operation: 'patch', type: 'request', id: row.id, expectedVersion: '1', data: { title: { kind: 'text', value: 'MCP committed' } },
    } } } }
    const changed = await rpc('tools/call', args), replay = await rpc('tools/call', args)
    expect(decode(changed).result.isError).toBeUndefined()
    expect(JSON.parse(decode(replay).result.content[0].text)).toEqual(JSON.parse(decode(changed).result.content[0].text))
    expect((await store.getEntity(workspaceId, row.id))?.recordVersion).toBe('2')
    expect((await rpc('tools/list', undefined, `sk_brain_${randomUUID()}_fictional-secret`)).status).toBe(401)
    expect((await request(http).get(endpoint).set('Authorization', `Bearer ${fixture.token}`)).status).toBe(405)
  })
  it('does not advertise command tools for an independently read-only app OAuth binding', async () => {
    const fixture = await provision('external_user', ['title'], undefined, false, undefined, ['command:record_patch'], [recordId], undefined, 'read')
    const http = express(); http.use('/api/applications', applicationPlatformRoutes({ service: new ApplicationPlatformService([createCanonicalGenericApplicationModule()]) }))
    const result = await request(http).post(`/api/applications/${fixture.appId}/mcp`).set('Authorization', `Bearer ${fixture.token}`)
      .set('Accept', 'application/json, text/event-stream').set('MCP-Protocol-Version', '2025-11-25').send({ jsonrpc: '2.0', id: 1, method: 'tools/list' })
    expect(result.status).toBe(200)
    const decoded = JSON.parse(result.text.split('\n').find(line => line.startsWith('data: '))!.slice(6))
    expect(decoded.result.tools.map((tool: { name: string }) => tool.name)).toEqual(['applicationCatalog', 'applicationQuery'])
  })
  it('pins parent consent maxima across expansion and stops a running context after contraction', async () => {
    const fixture = await provision('service', ['title', 'cost'], ['title'], true), execution = await resolveApplicationExecutionContext(fixture.authentication)
    const saved = (await pool.query('SELECT maximum_grant FROM application_credential_grants WHERE credential_id=$1', [fixture.authentication.credential!.credentialId])).rows[0].maximum_grant
    expect(saved.grants).toHaveLength(2)
    expect(saved.grants[1].readFields).toEqual(['title'])
    await expect(pool.query("UPDATE application_credential_grants SET maximum_grant='{}' WHERE credential_id=$1", [fixture.authentication.credential!.credentialId])).rejects.toMatchObject({ code: '22023' })
    await pool.query("UPDATE application_access_grants SET read_fields=ARRAY['title','cost'] WHERE id=$1", [fixture.parentId])
    await expect(service().query(execution, 'records', 'get', {})).rejects.toThrow('Access changed')
    const fresh = await resolveApplicationExecutionContext(fixture.authentication)
    expect(JSON.stringify(await service().query(fresh, 'records', 'get', {}))).not.toContain('1250')
    await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1", [fixture.parentId])
    await expect(service().query(fresh, 'records', 'get', {})).rejects.toThrow('Access changed')
    await expect(resolveApplicationExecutionContext(fixture.authentication)).rejects.toMatchObject({ code: 'grant_revoked' })
  })
  it('retains the current native member floor despite an application release with higher clearance', async () => {
    const fixture = await provision('member', ['title', 'cost'])
    await pool.query("UPDATE entity_instances SET sensitivity='confidential' WHERE id=$1", [recordId])
    try {
      const execution = await resolveApplicationExecutionContext(fixture.authentication)
      expect(await service().query(execution, 'records', 'get', {})).toEqual([])
    } finally { await pool.query("UPDATE entity_instances SET sensitivity='internal' WHERE id=$1", [recordId]) }
  })
  it('projects the existing canonical CRM identity without disclosing a hidden attribute', async () => {
    const company = await createCompany(ownerId, { workspaceId, name: 'Example supplier', domain: 'supplier.example',
      sensitivity: 'internal', compartments: [], projectIds: [], createdByAssistantId: assistantId,
      access: { workspaceId, userId: ownerId, assistantId, assistantKind: 'primary', clearance: 'confidential', compartments: [], projectIds: [] } })
    const fixture = await provision('external_user', ['name'], undefined, false, company.id)
    const execution = await resolveApplicationExecutionContext(fixture.authentication)
    const dispatcher = new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const result = await dispatcher.query(execution, 'native', 'get', { type: 'company', id: company.id })
    expect(result).toMatchObject({ ref: { id: company.id, origin: { kind: 'native', moduleKey: 'native' } }, values: { name: 'Example supplier' }, fields: ['name'] })
    expect(JSON.stringify(result)).not.toContain('supplier.example')
    expect((await pool.query('SELECT id FROM entities WHERE id=$1 AND kind=$2', [company.id, 'company'])).rows).toEqual([{ id: company.id }])
    const http = express(); http.use('/api/applications', applicationPlatformRoutes({ service: dispatcher }))
    const read = await request(http).get(`/api/applications/${fixture.appId}/records/company/${company.id}`).set('Authorization', `Bearer ${fixture.token}`)
    expect(read.status).toBe(200); expect(read.body.values).toEqual({ name: 'Example supplier' })
    const denied = await request(http).post(`/api/applications/${fixture.appId}/commands/create_company`).set('Authorization', `Bearer ${fixture.token}`)
      .send({ idempotencyKey: 'no-create-capability', input: { name: 'Forbidden company' } })
    expect(denied.status).toBe(403); expect(denied.body.effect).toBe('none')
    expect((await pool.query("SELECT id FROM entities WHERE workspace_id=$1 AND display_name='Forbidden company'", [workspaceId])).rows).toEqual([])
  })
  it.each(['member','external_user','service'] as const)('creates canonical company/task rows and idempotent receipts as the real %s without substituting the credential owner', async kind => {
    for (const type of ['company','task'] as const) {
      const fields = type === 'company' ? ['name','domain'] : ['title'], commandKey = `create_${type}`
      const fixture = await provision(kind, fields, undefined, false, randomUUID(), ['create',`command:${commandKey}`], [], { kind: 'self' }, 'read_write', [], type)
      const dispatcher = new ApplicationPlatformService([createCanonicalNativeApplicationModule()]), http = express()
      http.use('/api/applications', applicationPlatformRoutes({ service: dispatcher }))
      const input = type === 'company' ? { name: 'Example application company', domain: 'application-company.example' } : { title: 'Example application task' }
      const command = { idempotencyKey: randomUUID(), input }, base = `/api/applications/${fixture.appId}`
      const catalog = await request(http).get(`${base}/catalog`).set('Authorization', `Bearer ${fixture.token}`)
      expect(catalog.status).toBe(200)
      expect(catalog.body.resources.find((resource: { typeKey: string }) => resource.typeKey === type)?.fields.map((field: { key: string }) => field.key)).toEqual(fields)
      const result = await request(http).post(`${base}/commands/${commandKey}`).set('Authorization', `Bearer ${fixture.token}`).send(command)
      expect(result.status).toBe(200); expect(result.body.resources).toHaveLength(1)
      const ref = result.body.resources[0]
      expect(ref).toMatchObject({ workspaceId, origin: { kind: 'native', moduleKey: 'native' }, typeKey: type, version: '1' })
      const table = type === 'company' ? 'entities' : 'tasks'
      const canonical = (await pool.query(`SELECT id,created_by_user_id,created_by_assistant_id FROM ${table} WHERE id=$1 AND workspace_id=$2`, [ref.id,workspaceId])).rows[0]
      expect(canonical).toEqual({ id: ref.id, created_by_user_id: fixture.userId, created_by_assistant_id: assistantId })
      expect((await request(http).post(`${base}/commands/${commandKey}`).set('Authorization', `Bearer ${fixture.token}`).send(command)).body).toEqual(result.body)
      const read = await request(http).get(`${base}/records/${type}/${ref.id}`).set('Authorization', `Bearer ${fixture.token}`)
      expect(read.status).toBe(200); expect(read.body.values).toEqual(input)
      expect((await pool.query('SELECT id FROM application_command_audit WHERE receipt_id=$1', [result.body.id])).rows).toHaveLength(1)
      if (kind !== 'member') expect((await pool.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId,fixture.userId])).rows).toEqual([])
    }
  })
  it.each(['member','external_user','service'] as const)('Q03/Q04/Q05 creates canonical contact and deal rows through the real %s application principal',async kind => {
    for (const type of ['person','deal'] as const) {
      const fields=type==='person'?['name','email']:['name','stage','amount'],commandKey=type==='person'?'create_contact':'create_deal'
      const fixture=await provision(kind,fields,undefined,false,randomUUID(),['create',`command:${commandKey}`],[],{kind:'self'},'read_write',[],type)
      const execution=await resolveApplicationExecutionContext(fixture.authentication),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
      const input: Record<string,string>=type==='person'?{name:'Fictional application contact',email:'contact@native.example'}:{stage:'lead',amount:'9007199254740993.000000000000000001'}
      const command={idempotencyKey:randomUUID(),input},http=express()
      http.use('/api/applications',applicationPlatformRoutes({service:dispatcher}))
      const before=(await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND created_by_user_id=$2 AND kind=$3',[workspaceId,fixture.userId,type])).rows[0].count
      const responses=await Promise.all([0,1].map(()=>request(http).post(`/api/applications/${fixture.appId}/commands/${commandKey}`).set('Authorization',`Bearer ${fixture.token}`).send(command)))
      expect(responses.map(response=>response.status)).toEqual([200,200]);expect(responses[1].body).toEqual(responses[0].body)
      const receipt=responses[0].body
      expect((await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND created_by_user_id=$2 AND kind=$3',[workspaceId,fixture.userId,type])).rows[0].count).toBe(before+1)
      expect(receipt.resources).toHaveLength(1);const ref=receipt.resources[0]
      expect(ref).toMatchObject({workspaceId,origin:{kind:'native',moduleKey:'native'},typeKey:type,version:'1'})
      expect((await pool.query('SELECT id,kind,created_by_user_id,created_by_assistant_id FROM entities WHERE id=$1 AND workspace_id=$2',[ref.id,workspaceId])).rows)
        .toEqual([{id:ref.id,kind:type,created_by_user_id:fixture.userId,created_by_assistant_id:assistantId}])
      const projection=await dispatcher.query(execution,'native','get',{type,id:ref.id}) as {values:unknown}
      expect(projection.values).toEqual(type==='person'?input:{name:'Deal',...input})
      expect(await dispatcher.command(execution,'native',commandKey,command)).toEqual(receipt)
      expect((await pool.query('SELECT id FROM application_command_audit WHERE receipt_id=$1',[receipt.id])).rows).toHaveLength(1)
      expect((await pool.query('SELECT event_key,resources FROM application_committed_events WHERE receipt_id=$1',[receipt.id])).rows).toEqual([{event_key:type==='person'?'native.contact.created':'native.deal.created',resources:receipt.resources}])
      if(kind!=='member') expect((await pool.query('SELECT user_id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',[workspaceId,fixture.userId])).rows).toEqual([])
    }
  })
  it.each(['person','deal'] as const)('Q03/Q05/Q06 replays a write-only canonical %s creation without a readable DTO and refuses revoked rights',async type => {
    const fields=type==='person'?['name']:['name','stage'],commandKey=type==='person'?'create_contact':'create_deal'
    const fixture=await provision('service',fields,undefined,false,randomUUID(),['create',`command:${commandKey}`],[],{kind:'self'},'read_write',[],type)
    await pool.query("UPDATE application_access_grants SET actions=ARRAY['create',$2::text],read_fields='{}' WHERE id=$1",[fixture.grantId,`command:${commandKey}`])
    const execution=await resolveApplicationExecutionContext(fixture.authentication),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const input: Record<string,string>=type==='person'?{name:'Fictional write-only contact'}:{stage:'lead'}
    const command={idempotencyKey:randomUUID(),input}
    const receipt=await dispatcher.command(execution,'native',commandKey,command)
    expect(await dispatcher.command(execution,'native',commandKey,command)).toEqual(receipt)
    await expect(dispatcher.query(execution,'native','get',{type,id:receipt.resources[0].id})).rejects.toMatchObject({code:'access_unavailable'})
    await pool.query("UPDATE application_access_grants SET write_fields='{}' WHERE id=$1",[fixture.grantId])
    const current=await resolveApplicationExecutionContext(fixture.authentication)
    await expect(dispatcher.command(current,'native',commandKey,command)).rejects.toMatchObject({code:'access_unavailable'})
    expect((await pool.query('SELECT id FROM entities WHERE id=$1',[receipt.resources[0].id])).rows).toEqual([{id:receipt.resources[0].id}])
  })
  it.each(['person','deal'] as const)('Q04 refuses original invalid canonical %s application creation frames without effects',async type => {
    const fields=type==='person'?['name','email']:['name','stage','amount'],key=type==='person'?'create_contact':'create_deal'
    const fixture=await provision('service',fields,undefined,false,randomUUID(),['create',`command:${key}`],[],{kind:'self'},'read_write',[],type)
    const execution=await resolveApplicationExecutionContext(fixture.authentication),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const before=(await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND created_by_user_id=$2',[workspaceId,fixture.userId])).rows[0].count
    const frames:Record<string,ApplicationJson>[]=type==='person'?[{name:'Fictional unknown field',unexpected_key:true},{name:42},{name:'Fictional invalid email type',email:12}]
      :[{stage:'lead',unexpected_key:true},{stage:'invented'},{stage:'lead',amount:'1e8'}]
    for(const frame of frames) await expect(dispatcher.command(execution,'native',key,{idempotencyKey:randomUUID(),input:frame})).rejects.toMatchObject({code:'invalid_value',effect:'none'})
    expect((await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND created_by_user_id=$2',[workspaceId,fixture.userId])).rows[0].count).toBe(before)
  })
  it.each(['person','deal'] as const)('Q05/Q06 rolls back canonical %s application creation on audit failure and retries exactly once',async type => {
    const fields=type==='person'?['name']:['name','stage'],key=type==='person'?'create_contact':'create_deal'
    const fixture=await provision('service',fields,undefined,false,randomUUID(),['create',`command:${key}`],[],{kind:'self'},'read_write',[],type)
    const execution=await resolveApplicationExecutionContext(fixture.authentication),dispatcher=new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const input:Record<string,string>=type==='person'?{name:'Fictional rolled-back contact'}:{stage:'lead'},command={idempotencyKey:randomUUID(),input}
    const before=(await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND created_by_user_id=$2',[workspaceId,fixture.userId])).rows[0].count
    await pool.query(`ALTER TABLE application_command_audit ADD CONSTRAINT native_creator_audit_fixture CHECK(module_key<>'native' OR operation_key<>'${key}') NOT VALID`)
    try {
      await expect(dispatcher.command(execution,'native',key,command)).rejects.toMatchObject({code:'invalid_value',effect:'none'})
      expect((await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND created_by_user_id=$2',[workspaceId,fixture.userId])).rows[0].count).toBe(before)
      expect((await pool.query('SELECT id FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=$2',[workspaceId,command.idempotencyKey])).rows).toEqual([])
    } finally {await pool.query('ALTER TABLE application_command_audit DROP CONSTRAINT native_creator_audit_fixture')}
    const receipt=await dispatcher.command(execution,'native',key,command)
    expect(await dispatcher.command(execution,'native',key,command)).toEqual(receipt)
    expect((await pool.query('SELECT count(*)::int AS count FROM entities WHERE workspace_id=$1 AND created_by_user_id=$2',[workspaceId,fixture.userId])).rows[0].count).toBe(before+1)
    expect((await pool.query('SELECT id FROM application_command_audit WHERE receipt_id=$1',[receipt.id])).rows).toHaveLength(1)
  })
  it('reviews prospective native self grants without releasing payloads and supports write-only canonical creation', async () => {
    const fixture = await provision('service', ['name'], undefined, false, randomUUID(), ['create','command:create_company'], [], { kind: 'self' })
    const dispatcher = new ApplicationPlatformService([createCanonicalNativeApplicationModule()]), management = new ApplicationManagementService(dispatcher)
    const proposal = { principal: { kind: 'service', userId: fixture.userId }, origin: { kind: 'native', moduleKey: 'native' }, typeKey: 'company',
      actions: ['create','command:create_company'], readFields: [], writeFields: ['name'], selector: { kind: 'self' }, compartments: [], projectIds: [], clearance: 'internal', parentGrantId: null, expiresAt: null }
    expect(await management.reviewGrant(ownerId, workspaceId, fixture.appId, proposal)).toMatchObject({ proposal, canIssue: false })
    await pool.query("UPDATE application_access_grants SET actions=ARRAY['create','command:create_company'],read_fields='{}' WHERE id=$1", [fixture.grantId])
    const execution = await resolveApplicationExecutionContext(fixture.authentication), command = { idempotencyKey: randomUUID(), input: { name: 'Example write-only company' } }
    const receipt = await dispatcher.command(execution, 'native', 'create_company', command)
    expect(receipt.resources).toHaveLength(1)
    expect(await dispatcher.command(execution, 'native', 'create_company', command)).toEqual(receipt)
    await expect(dispatcher.query(execution, 'native', 'get', { type: 'company', id: receipt.resources[0].id })).rejects.toMatchObject({ code: 'access_unavailable' })
    expect((await pool.query('SELECT id FROM entities WHERE id=$1 AND created_by_user_id=$2', [receipt.resources[0].id,fixture.userId])).rows).toEqual([{ id: receipt.resources[0].id }])
  })
  it('rejects an ungranted native field and rolls back canonical native rows when receipt audit cannot commit', async () => {
    const fixture = await provision('service', ['name'], undefined, false, randomUUID(), ['create','command:create_company'], [], { kind: 'self' })
    const execution = await resolveApplicationExecutionContext(fixture.authentication), dispatcher = new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    await expect(dispatcher.command(execution, 'native', 'create_company', { idempotencyKey: randomUUID(), input: {
      name: 'Example forbidden native field', domain: 'forbidden-field.example',
    } })).rejects.toMatchObject({ code: 'access_unavailable' })
    const idempotencyKey = randomUUID()
    await pool.query("ALTER TABLE application_command_audit ADD CONSTRAINT fixture_native_audit_failure CHECK(module_key<>'native' OR operation_key<>'create_company') NOT VALID")
    try {
      await expect(dispatcher.command(execution, 'native', 'create_company', { idempotencyKey, input: { name: 'Example rolled back native company' } }))
        .rejects.toMatchObject({ code: 'invalid_value', effect: 'none' })
      expect((await pool.query("SELECT id FROM entities WHERE workspace_id=$1 AND display_name=ANY($2::text[])",
        [workspaceId,['Example forbidden native field','Example rolled back native company']])).rows).toEqual([])
      expect((await pool.query('SELECT id FROM application_operation_receipts WHERE workspace_id=$1 AND idempotency_key=$2', [workspaceId,idempotencyKey])).rows).toEqual([])
    } finally { await pool.query('ALTER TABLE application_command_audit DROP CONSTRAINT fixture_native_audit_failure') }
  })
  it('withdraws a native release when the issuer loses the private-owner floor even if the recipient becomes the private owner', async () => {
    const company = await createCompany(ownerId, { name: 'Example private source', workspaceId, mergeByName: false })
    const fixture = await provision('member', ['name'], undefined, false, company.id)
    const execution = await resolveApplicationExecutionContext(fixture.authentication), dispatcher = new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    expect((await dispatcher.query(execution, 'native', 'get', { type: 'company', id: company.id }) as { values: unknown }).values).toEqual({ name: 'Example private source' })
    await pool.query('UPDATE entities SET user_id=$2 WHERE id=$1', [company.id,memberId])
    await expect(dispatcher.query(execution, 'native', 'get', { type: 'company', id: company.id })).rejects.toMatchObject({ code: 'access_unavailable' })
    const current = await resolveApplicationExecutionContext(fixture.authentication)
    await expect(dispatcher.query(current, 'native', 'get', { type: 'company', id: company.id })).rejects.toMatchObject({ code: 'access_unavailable' })
    expect((await dispatcher.catalog(current)).resources).toEqual([])
  })
  it('prepares clients and revokes access through native governance without issuing broader rights or returning secrets', async () => {
    const fixture = await provision('service'), dispatcher = service(), management = new ApplicationManagementService(dispatcher)
    const secret = 'fictional-management-session-secret'
    async function nativeToken(userId: string) {
      const session = await authSessionStore.create(userId, { deviceLabel: 'Fixture browser', userAgent: 'Fixture browser', ipAddress: '127.0.0.1' })
      return createTokens(userId, secret, session!).accessToken
    }
    const ownerToken = await nativeToken(ownerId), memberToken = await nativeToken(memberId)
    const http = express(); http.use('/api/applications', applicationPlatformRoutes({ service: dispatcher,
      management: { service: management, requireAuth: requireAuth(secret), origins: ['https://host.example'] } }))
    const base = `/api/applications/workspaces/${workspaceId}`
    expect((await request(http).get(`${base}/clients`).set('Authorization', `Bearer ${fixture.token}`)).status).toBe(401)
    expect((await request(http).get(`${base}/clients`).set('Authorization', `Bearer ${memberToken}`)).status).toBe(403)
    const prepared = await request(http).post(`${base}/clients`).set('Authorization', `Bearer ${ownerToken}`).send({
      workspaceId, moduleKey: 'records', name: 'Prepared example application', mode: 'api_client', origins: [], redirectUris: [], executingAssistantId: assistantId,
    })
    expect(prepared.status).toBe(200)
    expect(prepared.body).toMatchObject({ workspaceId, moduleKey: 'records', executingAssistantId: assistantId })
    expect((await pool.query('SELECT id FROM application_access_grants WHERE app_id=$1', [prepared.body.id])).rows).toEqual([])
    const listed = await request(http).get(`${base}/clients`).set('Authorization', `Bearer ${ownerToken}`)
    expect(listed.status).toBe(200); expect(listed.body.every((client: { qualified: boolean }) => !client.qualified)).toBe(true)
    const summaries = await request(http).get(`${base}/clients/${fixture.appId}/credentials`).set('Authorization', `Bearer ${ownerToken}`)
    expect(summaries.status).toBe(200); expect(summaries.body[0]).toMatchObject({ kind: 'service', serviceUserId: fixture.userId })
    expect(JSON.stringify(summaries.body)).not.toMatch(/secret|hash|sk_app_/i)
    const revoked = await request(http).post(`${base}/clients/${fixture.appId}/credentials/${fixture.authentication.credential!.credentialId}/revoke`)
      .set('Authorization', `Bearer ${ownerToken}`).send({})
    expect(revoked.status).toBe(200); expect(revoked.body).toEqual({ revoked: true })
    expect((await request(http).get(`/api/applications/${fixture.appId}/catalog`).set('Authorization', `Bearer ${fixture.token}`)).status).toBe(401)
    await expect(new ApplicationManagementService(dispatcher, pool).list(ownerId, workspaceId)).rejects.toMatchObject({ code: 'access_unavailable' })
  })
  it('persists actor-bound native grant reviews, refuses stale or invented rights and keeps issuance behind qualification', async () => {
    const row = await store.createEntity({ workspaceId, entityTypeId: schemaId, sourceApp: 'api', createdBy: ownerId, lastEditedBy: ownerId,
      data: { title: { kind: 'text', value: 'Grant review request' } } })
    const fixture = await provision('service'), dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const management = new ApplicationManagementService(dispatcher), secret = 'fictional-grant-review-session-secret'
    const session = await authSessionStore.create(ownerId, { deviceLabel: 'Grant reviewer', userAgent: 'Fixture browser', ipAddress: '127.0.0.1' })
    const token = createTokens(ownerId, secret, session!).accessToken
    const http = express(); http.use('/api/applications', applicationPlatformRoutes({ service: dispatcher,
      management: { service: management, requireAuth: requireAuth(secret), origins: ['https://host.example'] } }))
    const base = `/api/applications/workspaces/${workspaceId}/clients/${fixture.appId}/grants`
    const proposal = { principal: { kind: 'external_user', userId: externalId }, origin: { kind: 'generic', entityTypeId: schemaId }, typeKey: 'request',
      actions: ['read', 'query'], readFields: ['title'], writeFields: [], selector: { kind: 'ids', ids: [row.id] },
      compartments: [], projectIds: [], clearance: 'internal', parentGrantId: null, expiresAt: null }
    const review = await request(http).post(`${base}/review`).set('Authorization', `Bearer ${token}`).send(proposal)
    expect(review.status).toBe(200); expect(review.body).toMatchObject({ proposal, canIssue: false })
    expect(JSON.stringify(review.body)).not.toMatch(/authority_hash|scope_version|secret_hash/)
    const apply = () => request(http).post(`${base}/reviews/${review.body.id}/apply`).set('Authorization', `Bearer ${token}`).send({})
    expect((await apply()).status).toBe(403)
    expect((await pool.query('SELECT id FROM application_access_grants WHERE app_id=$1 AND principal_user_id=$2', [fixture.appId,externalId])).rows).toEqual([])
    await expect(management.applyGrantReview(memberId, workspaceId, fixture.appId, review.body.id)).rejects.toMatchObject({ code: 'access_unavailable' })
    expect((await queryWithRLS(ownerId, "UPDATE application_grant_reviews SET proposed_grant='{}' WHERE id=$1", [review.body.id])).rowCount).toBe(0)
    expect((await pool.query('SELECT proposed_grant FROM application_grant_reviews WHERE id=$1', [review.body.id])).rows[0].proposed_grant).toEqual(proposal)
    for (const invalid of [{ ...proposal, readFields: ['undeclared_secret'] }, { ...proposal, actions: ['command:invented'] },
      { ...proposal, selector: { kind: 'ids', ids: [randomUUID()] } }, { ...proposal, principal: { kind: 'member', userId: externalId } }]) {
      expect((await request(http).post(`${base}/review`).set('Authorization', `Bearer ${token}`).send(invalid)).status).toBeGreaterThanOrEqual(400)
    }
    await store.updateEntity(workspaceId, row.id, { data: { title: { kind: 'text', value: 'Changed after review' } }, lastEditedBy: ownerId })
    const stale = await apply(); expect(stale.status).toBe(409); expect(stale.body.error).toBe('record_version_conflict')
    expect((await pool.query('SELECT consumed_grant_id FROM application_grant_reviews WHERE id=$1', [review.body.id])).rows[0].consumed_grant_id).toBeNull()
  })
  it('limits a reviewed child grant to its complete current parent resource, action, field and selector ceiling', async () => {
    const fixture = await provision('service'), management = new ApplicationManagementService(new ApplicationPlatformService([createCanonicalGenericApplicationModule()]))
    const proposal = { principal: { kind: 'external_user', userId: externalId }, origin: { kind: 'generic', entityTypeId: schemaId }, typeKey: 'request',
      actions: ['read'], readFields: ['title'], writeFields: [], selector: { kind: 'ids', ids: [recordId] },
      compartments: [], projectIds: [], clearance: 'internal', parentGrantId: fixture.grantId, expiresAt: null }
    expect(await management.reviewGrant(ownerId, workspaceId, fixture.appId, proposal)).toMatchObject({ proposal, canIssue: false })
    for (const invalid of [{ ...proposal, readFields: ['cost'] }, { ...proposal, actions: ['delete'] },
      { ...proposal, selector: { kind: 'ids', ids: [otherId] } }, { ...proposal, selector: { kind: 'self' } }]) {
      await expect(management.reviewGrant(ownerId, workspaceId, fixture.appId, invalid)).rejects.toMatchObject({ code: 'access_unavailable' })
    }
    await management.revokeGrant(ownerId, workspaceId, fixture.appId, fixture.grantId)
    await expect(management.reviewGrant(ownerId, workspaceId, fixture.appId, proposal)).rejects.toMatchObject({ code: 'access_unavailable' })
  })
  it('prepares named services without membership and binds credential review to current native release authority', async () => {
    const fixture = await provision('service'), dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const management = new ApplicationManagementService(dispatcher), serviceInput = { name: 'Example purchase service', idempotencyKey: randomUUID() }
    const subject = await management.prepareServiceSubject(ownerId, workspaceId, fixture.appId, serviceInput)
    users.push(subject.serviceUserId)
    expect(await management.prepareServiceSubject(ownerId, workspaceId, fixture.appId, serviceInput)).toEqual(subject)
    expect((await pool.query('SELECT workspace_id FROM workspace_members WHERE user_id=$1', [subject.serviceUserId])).rows).toEqual([])
    expect((await pool.query('SELECT id FROM workspaces WHERE owner_user_id=$1', [subject.serviceUserId])).rows).toEqual([])
    await expect(management.prepareServiceSubject(memberId, workspaceId, fixture.appId, serviceInput)).rejects.toMatchObject({ code: 'access_unavailable' })
    const proposal = { name: 'Example reviewed key', kind: 'service', serviceUserId: fixture.userId, grantIds: [fixture.grantId], expiresAt: new Date(Date.now()+3_600_000).toISOString() }
    const review = await management.reviewCredential(ownerId, workspaceId, fixture.appId, proposal)
    expect(review).toMatchObject({ proposal, canIssue: false }); expect(JSON.stringify(review)).not.toMatch(/secret_hash|sk_app_|maximum_grant/)
    await expect(management.applyCredentialReview(ownerId, workspaceId, fixture.appId, review.id)).rejects.toMatchObject({ code: 'access_unavailable' })
    expect((await pool.query('SELECT id FROM application_api_credentials WHERE app_id=$1', [fixture.appId])).rows).toHaveLength(1)
    expect((await queryWithRLS(ownerId, "UPDATE application_credential_reviews SET proposal='{}' WHERE id=$1", [review.id])).rowCount).toBe(0)
    for (const invalid of [{ ...proposal, serviceUserId: externalId }, { ...proposal, grantIds: [randomUUID()] },
      { ...proposal, grantIds: [fixture.grantId,fixture.grantId] }, { ...proposal, expiresAt: '2020-01-01T00:00:00.000Z' }]) {
      await expect(management.reviewCredential(ownerId, workspaceId, fixture.appId, invalid)).rejects.toBeInstanceOf(Error)
    }
    await management.revokeGrant(ownerId, workspaceId, fixture.appId, fixture.grantId)
    await expect(management.applyCredentialReview(ownerId, workspaceId, fixture.appId, review.id)).rejects.toMatchObject({ code: 'record_version_conflict' })
    expect((await pool.query("SELECT action FROM application_authority_events WHERE app_id=$1", [fixture.appId])).rows).toEqual([{ action: 'grant_revoked' }])
  })
  it('intersects an explicitly delegated key with independent same-app user OAuth and keeps the actual user as actor', async () => {
    const user = await provision('external_user', ['title', 'cost']), grantId = randomUUID()
    const serviceUser = (await findOrCreateUser({ authProvider: 'channel', authProviderId: `app-service:${user.appId}:${randomUUID()}`, name: 'Example delegated service' })).user.id
    users.push(serviceUser)
    await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
      resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance)
      VALUES($1,$2,$3,'service',$4,$5,$6,'request',ARRAY['read','query'],ARRAY['title'],'{}',$7,'{}','{}','internal')`,
    [grantId, user.appId, workspaceId, serviceUser, ownerId, { kind: 'generic', entityTypeId: schemaId }, { kind: 'ids', ids: [recordId] }])
    const material = await mintApplicationCredentialSecret()
    await pool.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
      VALUES($1,$2,$3,$4,$5,'Example delegated key','delegated',$6,$7,now()+interval '1 hour')`,
    [material.id, user.appId, workspaceId, ownerId, serviceUser, material.secretHash, grantId])
    await pool.query('INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)',
      [material.id, user.appId, workspaceId, grantId, {}])
    const credential = (await authenticateApplicationCredential(material.token, user.appId, loadApplicationCredentialStateSystem))!
    await expect(resolveApplicationExecutionContext({ credential })).rejects.toMatchObject({ code: 'grant_revoked' })
    const execution = await resolveApplicationExecutionContext({ credential, user: user.authentication.user! })
    expect(execution.security.access.userId).toBe(externalId)
    expect(execution.identity).toMatchObject({ kind: 'programmatic', principal: { actorUserId: externalId, serviceUserId: serviceUser }, credentialOwnerUserId: ownerId })
    const dispatcher = service(), http = express(); http.use('/api/applications', applicationPlatformRoutes({ service: dispatcher }))
    const path = `/api/applications/${user.appId}/records/request/${recordId}`
    expect((await request(http).get(path).set('Authorization', `Bearer ${material.token}`)).status).toBe(401)
    const admitted = await request(http).get(path).set('Authorization', `Bearer ${material.token}`).set('X-UseBrian-User-Authorization', `Bearer ${user.token}`)
    expect(admitted.status).toBe(200); expect(admitted.body[0].data).toEqual({ title: { kind: 'text', value: 'Visible request' } })
    const foreign = await provision('external_user')
    expect((await request(http).get(path).set('Authorization', `Bearer ${material.token}`).set('X-UseBrian-User-Authorization', `Bearer ${foreign.token}`)).status).toBe(401)
    await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1", [user.grantId])
    await expect(execution.security.authority.assertCurrent()).rejects.toThrow('Access changed')
    expect((await request(http).get(path).set('Authorization', `Bearer ${material.token}`).set('X-UseBrian-User-Authorization', `Bearer ${user.token}`)).status).toBe(401)
  })
  it('observes canonical module disable state for a non-member without granting a raw workspace row', async () => {
    const fixture = await provision('service', ['title'], undefined, false, undefined, ['command:verify'])
    await pool.query("INSERT INTO workspace_modules(workspace_id,module_key,state,updated_by_user_id) VALUES($1,'records','disabled',$2)", [workspaceId, ownerId])
    try {
      const execution = await resolveApplicationExecutionContext(fixture.authentication), dispatcher = service()
      expect(await dispatcher.query(execution, 'records', 'module_state', {})).toEqual([{ state: 'disabled' }])
      await expect(dispatcher.command(execution, 'records', 'verify', { idempotencyKey: 'disabled-no-new-work', input: {} })).rejects.toMatchObject({ code: 'module_disabled' })
    } finally { await pool.query("DELETE FROM workspace_modules WHERE workspace_id=$1 AND module_key='records'", [workspaceId]) }
  })
  it('keeps a canonical generic review hold effective through the app projection', async () => {
    const fixture = await provision('external_user'), execution = await resolveApplicationExecutionContext(fixture.authentication)
    await pool.query(`INSERT INTO scope_resource_states(workspace_id,resource_kind,resource_id,resource_version,review_state,classification_revision,holding_reason)
      SELECT $1,'entity_instance',$2,read_scope_review_source($1,'entity_instance',$2)->>'version','held',1,'Fixture evidence review'`, [workspaceId, recordId])
    try { expect(await service().query(execution, 'records', 'get', { id: recordId })).toEqual([]) }
    finally { await pool.query("DELETE FROM scope_resource_states WHERE workspace_id=$1 AND resource_kind='entity_instance' AND resource_id=$2", [workspaceId, recordId]) }
  })
  it('resolves only a declared canonical relationship with an independently released exact anchor', async () => {
    const company = await createCompany(ownerId, { name: 'Example anchor company', workspaceId, mergeByName: false })
    const another = await createCompany(ownerId, { name: 'Example unrelated company', workspaceId, mergeByName: false })
    const schema = (await store.getEntityType(workspaceId, schemaId))!
    await store.updateEntityType(workspaceId, schemaId, { properties: [...schema.properties,
      { name: 'company', config: { kind: 'relation', targetEntityTypeRef: { kind: 'builtin', name: 'company' } } }] }, { actorUserId: ownerId, expectedSchemaVersion: schema.schemaVersion })
    const rows: string[] = []
    for (const target of [company, another]) {
      const row = await store.createEntity({ workspaceId, entityTypeId: schemaId, sourceApp: 'api', createdBy: ownerId, lastEditedBy: ownerId,
        data: { title: { kind: 'text', value: 'A related request' }, company: { kind: 'relation', value: target.id } } })
      rows.push(row.id)
    }
    const resolverKey = `relation.${createHash('sha256').update('company').digest('hex')}`
    const fixture = await provision('service', ['title', 'company'], undefined, false, undefined, ['create', 'command:record_create'], [],
      { kind: 'relationship', resolverKey, anchorId: company.id })
    const dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const before = await resolveApplicationExecutionContext(fixture.authentication)
    const metadata = (await dispatcher.catalog(before)).resources
    expect(metadata).toHaveLength(1)
    expect(metadata[0].fields.find(field => field.key === 'company')).toMatchObject({ relationshipResolverKey: resolverKey })
    await expect(dispatcher.query(before, 'records', 'get', { type: 'request', id: rows[0] })).rejects.toMatchObject({ code: 'access_unavailable' })
    const anchorGrant = randomUUID()
    await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
      resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance,starts_at)
      VALUES($1,$2,$3,'service',$4,$5,'{"kind":"native","moduleKey":"native"}','company',ARRAY['read'],ARRAY['name'],'{}',$6,'{}','{}','confidential',now()-interval '1 hour')`,
    [anchorGrant, fixture.appId, workspaceId, fixture.userId, ownerId, { kind: 'ids', ids: [company.id] }])
    await pool.query(`INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,'{}')`,
      [fixture.authentication.credential!.credentialId, fixture.appId, workspaceId, anchorGrant])
    const execution = await resolveApplicationExecutionContext(fixture.authentication)
    const catalog = await dispatcher.catalog(execution)
    expect(catalog.resources[0].fields.find(field => field.key === 'company')).toMatchObject({ relationshipResolverKey: resolverKey })
    const result = await dispatcher.query(execution, 'records', 'query', { type: 'request', query: {} }) as { records: Array<{ ref: { id: string } }> }
    expect(result.records.map(record => record.ref.id)).toEqual([rows[0]])
    const sources = boundScopeSources(result)
    const domain = (await pool.query<{ id: string }>("SELECT id FROM application_field_resources WHERE id=ANY($1::uuid[]) AND selection='query_domain'",
      [sources.map(source => source.resourceId)])).rows[0]
    expect(domain).toBeDefined()
    const domainSource = sources.find(source => source.resourceId === domain.id)!
    expect(await service().query(execution,'records','field_snapshot',{ id: domainSource.resourceId,version: domainSource.version })).toMatchObject({ held: false })
    const empty = await dispatcher.query(execution,'records','query',{ type: 'request',query: {
      fields: ['title'],filters: [{ field: 'title',op: 'eq',value: 'Fictional unmatched request' }],aggregate: [{ field: 'title',operation: 'count' }],
    } }) as { records: unknown[];aggregates: Array<{ value: string }> }
    expect(empty.records).toEqual([]);expect(empty.aggregates[0].value).toBe('0')
    const emptySources = boundScopeSources(empty)
    const emptyDomain = (await pool.query<{ id: string }>("SELECT id FROM application_field_resources WHERE id=ANY($1::uuid[]) AND selection='query_domain'",
      [emptySources.map(source => source.resourceId)])).rows[0]
    const emptyDomainSource = emptySources.find(source => source.resourceId === emptyDomain.id)!
    expect(await service().query(execution,'records','field_snapshot',{ id: emptyDomainSource.resourceId,version: emptyDomainSource.version })).toMatchObject({ held: false })
    await expect(dispatcher.query(execution, 'records', 'get', { type: 'request', id: rows[1] })).rejects.toMatchObject({ code: 'access_unavailable' })
    const related = await dispatcher.command(execution, 'records', 'record_create', { idempotencyKey: randomUUID(), input: {
      operation: 'create', type: 'request', data: { title: { kind: 'text', value: 'New linked request' }, company: { kind: 'relation', value: company.id } },
    } })
    expect(related.resources).toHaveLength(1)
    await expect(dispatcher.command(execution, 'records', 'record_create', { idempotencyKey: randomUUID(), input: {
      operation: 'create', type: 'request', data: { title: { kind: 'text', value: 'Invalid linked request' }, company: { kind: 'relation', value: another.id } },
    } })).rejects.toMatchObject({ code: 'access_unavailable' })
    await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1", [anchorGrant])
    await expect(dispatcher.query(execution, 'records', 'get', { type: 'request', id: rows[0] })).rejects.toThrow('Access changed')
    const current = await resolveApplicationExecutionContext(fixture.authentication)
    expect((await dispatcher.catalog(current)).resources).toEqual(metadata)
    await expect(dispatcher.query(current, 'records', 'get', { type: 'request', id: rows[0] })).rejects.toMatchObject({ code: 'access_unavailable' })
    expect(await service().query(current,'records','field_snapshot',{ id: domainSource.resourceId,version: domainSource.version })).toMatchObject({ held: true })
    expect(await service().query(current,'records','field_snapshot',{ id: emptyDomainSource.resourceId,version: emptyDomainSource.version })).toMatchObject({ held: true })
  })
  it('projects canonical native custom metadata/values while preserving IDs and withholding hidden or archived fields', async () => {
    const company = await createCompany(ownerId, { name: 'Example custom company', workspaceId, mergeByName: false })
    for (const [position, [key, fieldType, options]] of ([['region', 'text', []], ['channels', 'multi_select', ['direct', 'partner']], ['private_cost', 'number', []]] as const).entries()) {
      await pool.query(`INSERT INTO crm_field_definitions(workspace_id,entity_kind,field_key,label,field_type,options,created_by,position)
        VALUES($1,'company',$2,$2,$3,$4,$5,$6)`, [workspaceId, key, fieldType, JSON.stringify(options), ownerId, position])
    }
    await updateCrmCustomFields({ ctx: { workspaceId, userId: ownerId, assistantId, assistantKind: 'primary', clearance: 'confidential', compartments: null, mutationCompartments: null, projectIds: null },
      entityId: company.id, values: { region: 'Northern', channels: ['partner', 'direct'], private_cost: 750 } })
    const fixture = await provision('service', ['name', 'custom.region', 'custom.channels'], undefined, false, company.id)
    const dispatcher = new ApplicationPlatformService([createCanonicalNativeApplicationModule()]), execution = await resolveApplicationExecutionContext(fixture.authentication)
    const catalog = await dispatcher.catalog(execution)
    expect(catalog.resources).toHaveLength(1)
    expect(catalog.resources[0].fields.map(field => field.key)).toEqual(['name', 'custom.region', 'custom.channels'])
    expect(catalog.resources[0].fields[1]).toMatchObject({ kind: 'crm', definition: { fieldKey: 'region', fieldType: 'text' } })
    const row = await dispatcher.query(execution, 'native', 'get', { type: 'company', id: company.id }) as { ref: { id: string }; values: unknown }
    expect(row.ref.id).toBe(company.id)
    expect(row.values).toEqual({ name: 'Example custom company', 'custom.region': 'Northern', 'custom.channels': ['partner', 'direct'] })
    await pool.query("UPDATE crm_field_definitions SET archived_at=now() WHERE workspace_id=$1 AND field_key='region'", [workspaceId])
    const next = await dispatcher.query(execution, 'native', 'get', { type: 'company', id: company.id }) as { values: Record<string, unknown> }
    expect(next.values).not.toHaveProperty('custom.region'); expect(next.values).not.toHaveProperty('custom.private_cost')
    expect((await pool.query("SELECT attributes->'custom_fields'->>'private_cost' AS cost FROM entities WHERE id=$1", [company.id])).rows[0].cost).toBe('750')
  })
  it.each(['person', 'files'] as const)('requires a separate canonical target grant for %s cells, writes and historical projections', async kind => {
    const fileId = randomUUID(), field = kind === 'person' ? 'reviewer' : 'attachments'
    const reference = { bucket: 'example-fixture', path: `${randomUUID()}/review.txt`, name: 'review.txt', mimeType: 'text/plain', sizeBytes: 12 }
    if (kind === 'files') await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,mime,size_bytes,storage_uri,created_by_user_id)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [fileId, workspaceId, `/${reference.path}`, reference.name, reference.mimeType, reference.sizeBytes,
      `gs://${reference.bucket}/${reference.path}`, ownerId])
    const schema = (await store.getEntityType(workspaceId, schemaId))!
    await store.updateEntityType(workspaceId, schemaId, { properties: [...schema.properties, { name: field, config: { kind } }] },
      { actorUserId: ownerId, expectedSchemaVersion: schema.schemaVersion })
    const cell = kind === 'person' ? { kind, value: memberId } : { kind, value: [reference] }
    const row = await store.createEntity({ workspaceId, entityTypeId: schemaId, sourceApp: 'api', createdBy: ownerId, lastEditedBy: ownerId,
      data: { title: { kind: 'text', value: 'Reference request' }, [field]: cell } })
    const fixture = await provision('service', ['title', field], undefined, false, undefined, ['command:record_patch'], [row.id])
    const dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
    const unavailable = await resolveApplicationExecutionContext(fixture.authentication)
    expect((await dispatcher.query(unavailable, 'records', 'get', { type: 'request', id: row.id }) as { values: unknown }).values).not.toHaveProperty(field)
    const targetGrantId = randomUUID(), targetId = kind === 'person' ? memberId : fileId
    await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
      resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance,starts_at)
      VALUES($1,$2,$3,'service',$4,$5,'{"kind":"native","moduleKey":"native"}',$6,ARRAY['read'],$8,'{}',$7,'{}','{}','confidential',now()-interval '1 hour')`,
    [targetGrantId, fixture.appId, workspaceId, fixture.userId, ownerId, kind === 'person' ? 'workspace_member' : 'file', { kind: 'ids', ids: [targetId] },
      kind === 'person' ? [] : ['name','mimeType','sizeBytes','storageRef']])
    await pool.query(`INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,'{}')`,
      [fixture.authentication.credential!.credentialId, fixture.appId, workspaceId, targetGrantId])
    const execution = await resolveApplicationExecutionContext(fixture.authentication)
    expect((await dispatcher.query(execution, 'records', 'get', { type: 'request', id: row.id }) as { values: Record<string, unknown> }).values[field]).toEqual(cell)
    const updated = await dispatcher.command(execution, 'records', 'record_patch', { idempotencyKey: randomUUID(), expectedVersion: '1', input: {
      operation: 'patch', type: 'request', id: row.id, data: { [field]: cell },
    } })
    expect(updated.resources[0].version).toBe('2')
    if (kind === 'files') await expect(dispatcher.command(execution, 'records', 'record_patch', { idempotencyKey: randomUUID(), expectedVersion: '2', input: {
      operation: 'patch', type: 'request', id: row.id, data: { [field]: { kind, value: [{ ...reference, name: 'invented-name.txt' }] } },
    } })).rejects.toMatchObject({ code: 'access_unavailable' })
    if (kind === 'files') {
      await pool.query("UPDATE application_access_grants SET read_fields=ARRAY['name','mimeType','sizeBytes'] WHERE id=$1", [targetGrantId])
      const narrowed = await resolveApplicationExecutionContext(fixture.authentication)
      expect((await dispatcher.query(narrowed, 'records', 'get', { type: 'request', id: row.id }) as { values: unknown }).values).not.toHaveProperty(field)
      const narrowedHistory = await dispatcher.query(narrowed, 'records', 'history', { type: 'request', id: row.id }) as Array<{ values: unknown }>
      for (const revision of narrowedHistory) expect(revision.values).not.toHaveProperty(field)
    }
    await pool.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1", [targetGrantId])
    const current = await resolveApplicationExecutionContext(fixture.authentication)
    expect((await dispatcher.query(current, 'records', 'get', { type: 'request', id: row.id }) as { values: unknown }).values).not.toHaveProperty(field)
    const history = await dispatcher.query(current, 'records', 'history', { type: 'request', id: row.id }) as Array<{ values: unknown }>
    expect(history).toHaveLength(2); for (const revision of history) expect(revision.values).not.toHaveProperty(field)
    await expect(dispatcher.command(current, 'records', 'record_patch', { idempotencyKey: randomUUID(), expectedVersion: '2', input: {
      operation: 'patch', type: 'request', id: row.id, data: { [field]: cell },
    } })).rejects.toMatchObject({ code: 'access_unavailable' })
  })
  it('projects native file metadata and member IDs through the same exact grant boundary without releasing identity profiles or file bytes', async () => {
    const company = await createCompany(ownerId, { name: 'Example metadata client', workspaceId, mergeByName: false })
    const fixture = await provision('service', ['name'], undefined, false, company.id), fileId = randomUUID()
    await pool.query(`INSERT INTO workspace_files(id,workspace_id,path,name,mime,size_bytes,storage_uri,created_by_user_id)
      VALUES($1,$2,$3,'example-review.txt','text/plain',16,$4,$5)`, [fileId,workspaceId,`/${fileId}/example-review.txt`,`gs://example-fixture/${fileId}/example-review.txt`,ownerId])
    for (const [typeKey, id, readFields] of [['file', fileId, ['name','mimeType']], ['workspace_member', memberId, ['id']]] as const) {
      const grantId = randomUUID()
      await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
        resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance,starts_at)
        VALUES($1,$2,$3,'service',$4,$5,'{"kind":"native","moduleKey":"native"}',$6,ARRAY['read'],$7,'{}',$8,'{}','{}','confidential',now()-interval '1 hour')`,
      [grantId,fixture.appId,workspaceId,fixture.userId,ownerId,typeKey,readFields,{ kind: 'ids', ids: [id] }])
      await pool.query(`INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,'{}')`,
        [fixture.authentication.credential!.credentialId,fixture.appId,workspaceId,grantId])
    }
    const execution = await resolveApplicationExecutionContext(fixture.authentication), dispatcher = new ApplicationPlatformService([createCanonicalNativeApplicationModule()])
    const catalog = await dispatcher.catalog(execution)
    expect(catalog.resources.find(resource => resource.typeKey === 'file')?.fields.map(field => field.key)).toEqual(['name','mimeType'])
    expect((await dispatcher.query(execution, 'native', 'get', { type: 'file', id: fileId }) as { values: unknown }).values).toEqual({ name: 'example-review.txt', mimeType: 'text/plain' })
    expect((await dispatcher.query(execution, 'native', 'get', { type: 'workspace_member', id: memberId }) as { values: unknown }).values).toEqual({ id: memberId })
    await expect(dispatcher.query(execution, 'native', 'get', { type: 'workspace_member', id: ownerId })).rejects.toMatchObject({ code: 'access_unavailable' })
  })
  it('withholds a canonical relation ID and forbidden predicates when its independently released target disappears during a read', async () => {
    const targetType = await store.createEntityType({ workspaceId, name: 'Example lookup records', properties: [{ name: 'title', config: { kind: 'text' }, required: true }], createdBy: ownerId })
    const target = await store.createEntity({ workspaceId, entityTypeId: targetType.id, sourceApp: 'api', createdBy: ownerId, lastEditedBy: ownerId,
      data: { title: { kind: 'text', value: 'Exact released target' } } })
    const schema = (await store.getEntityType(workspaceId, schemaId))!
    await store.updateEntityType(workspaceId, schemaId, { properties: [...schema.properties,
      { name: 'linked', config: { kind: 'relation', targetEntityTypeRef: { kind: 'user_defined', entityTypeId: targetType.id } } }] },
    { actorUserId: ownerId, expectedSchemaVersion: schema.schemaVersion })
    const source = await store.createEntity({ workspaceId, entityTypeId: schemaId, sourceApp: 'api', createdBy: ownerId, lastEditedBy: ownerId,
      data: { title: { kind: 'text', value: 'Reference source' }, linked: { kind: 'relation', value: target.id } } })
    const fixture = await provision('service', ['title', 'linked'], undefined, false, undefined, [], [source.id]), targetGrantId = randomUUID()
    await pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,
      resource_origin,resource_type,actions,read_fields,write_fields,selector,compartments,project_ids,clearance,starts_at)
      VALUES($1,$2,$3,'service',$4,$5,$6,'lookup',ARRAY['read'],'{}','{}',$7,'{}','{}','confidential',now()-interval '1 hour')`,
    [targetGrantId, fixture.appId, workspaceId, fixture.userId, ownerId, { kind: 'generic', entityTypeId: targetType.id }, { kind: 'ids', ids: [target.id] }])
    await pool.query(`INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,'{}')`,
      [fixture.authentication.credential!.credentialId, fixture.appId, workspaceId, targetGrantId])
    const execution = await resolveApplicationExecutionContext(fixture.authentication), module = createCanonicalGenericApplicationModule(), original = module.queries.get.execute
    const ordinary = new ApplicationPlatformService([module])
    const before = await ordinary.query(execution, 'records', 'get', { type: 'request', id: source.id }) as { values: Record<string, unknown> }
    expect(before.values.linked).toEqual({ kind: 'relation', value: target.id })
    const concurrent = new ApplicationPlatformService([{ ...module, queries: { ...module.queries, get: { ...module.queries.get,
      execute: async (context, input) => {
        const value = await original(context, input)
        await queryWithRLS(ownerId, 'DELETE FROM entity_instances WHERE id=$1 AND workspace_id=$2', [target.id, workspaceId])
        return value
      },
    } } }])
    await expect(concurrent.query(execution, 'records', 'get', { type: 'request', id: source.id })).rejects.toMatchObject({ code: 'access_unavailable' })
    const after = await ordinary.query(execution, 'records', 'get', { type: 'request', id: source.id }) as { values: Record<string, unknown>; ref: { version: string } }
    expect(after.ref.version).toBe('1'); expect(after.values).not.toHaveProperty('linked')
    await expect(ordinary.query(execution, 'records', 'query', { type: 'request', query: { filters: [{ field: 'linked', op: 'eq', value: target.id }] } })).rejects.toMatchObject({ code: 'access_unavailable' })
    const history = await ordinary.query(execution, 'records', 'history', { type: 'request', id: source.id }) as Array<{ values: Record<string, unknown> }>
    expect(history[0].values).not.toHaveProperty('linked')
  })
})
