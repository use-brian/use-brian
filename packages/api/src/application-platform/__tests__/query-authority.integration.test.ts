import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { boundScopeSources, type ScopeSource } from '@use-brian/core'
import type { ApplicationAccessGrant, ApplicationGrantMaximum, ApplicationRecordProjection, ApplicationQuery } from '@use-brian/shared'
import { applyRLSGucs, getAppPool, getPool } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { hashSecret } from '../../db/api-key-store.js'
import { authenticateApplicationCredential, mintApplicationCredentialSecret } from '../credentials.js'
import { loadApplicationCredentialStateSystem } from '../auth-store.js'
import { findOrCreateUser } from '../../db/users.js'
import { authenticateApplicationOAuth } from '../oauth-auth.js'
import type { ApplicationAuthentication } from '../grant-authority.js'
import { resolveApplicationExecutionContext } from '../execution-context.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-records] compound query authority under real principal ceilings', () => {
  const owner = getPool(), workspaceId = randomUUID(), ownerId = randomUUID(), memberId = randomUUID(), assistantId = randomUUID()
  const clients: string[] = [], syntheticUsers: string[] = []
  const store = createDbDocEntityStore({ actorUserId: ownerId })
  const dispatcher = new ApplicationPlatformService([createCanonicalGenericApplicationModule()])
  beforeAll(async () => {
    for (const id of [ownerId, memberId]) await owner.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)", [id])
    await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional compound authority',$2,false)", [workspaceId, ownerId])
    for (const [user, role, clearance] of [[ownerId, 'owner', 'confidential'], [memberId, 'member', 'internal']]) {
      await owner.query('INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)', [workspaceId, user, role, clearance])
    }
    await owner.query("INSERT INTO assistants(id,name,owner_user_id,workspace_id,kind,clearance) VALUES($1,'Fictional query assistant',$2,$3,'primary','confidential')", [assistantId, ownerId, workspaceId])
  })
  afterAll(async () => {
    await owner.query('DELETE FROM workspaces WHERE id=$1', [workspaceId])
    if (clients.length) await owner.query('DELETE FROM oauth_clients WHERE client_id=ANY($1::text[])', [clients])
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ownerId, memberId, ...syntheticUsers]])
    await getAppPool().end(); await owner.end()
  })
  async function records(createdBy: string = ownerId, linked = true) {
    const targetSchema = await store.createEntityType({ workspaceId, name: `Fictional anchors ${randomUUID()}`, createdBy: ownerId,
      properties: [{ name: 'title', config: { kind: 'text' } }] })
    const target = await store.createEntity({ workspaceId, entityTypeId: targetSchema.id, createdBy: ownerId, lastEditedBy: ownerId,
      sourceApp: 'api', data: { title: { kind: 'text', value: 'Fictional anchor' } } })
    const schema = await store.createEntityType({ workspaceId, name: `Fictional requests ${randomUUID()}`, createdBy: ownerId,
      properties: [{ name: 'title', config: { kind: 'text' } }, { name: 'cost', config: { kind: 'number' } },
        { name: 'parent', config: { kind: 'relation', targetEntityTypeRef: { kind: 'user_defined', entityTypeId: targetSchema.id } } }] })
    const author = createDbDocEntityStore({ actorUserId: createdBy })
    const data = { title: { kind: 'text' as const, value: 'Fictional request' }, cost: { kind: 'number' as const, value: 42 }, parent: { kind: 'relation' as const, value: linked ? target.id : null } }
    // Guarded synthetic provisioning only. A nonmember's canonical authored row
    // models a prior authorized application create, never native enrollment.
    const row: {id:string} = ([ownerId,memberId] as string[]).includes(createdBy)
      ? await author.createEntity({workspaceId,entityTypeId:schema.id,createdBy,lastEditedBy:createdBy,sourceApp:'api',data})
      : (await owner.query('INSERT INTO entity_instances(workspace_id,entity_type_id,data,created_by,last_edited_by,source_app) VALUES($1,$2,$3,$4,$4,$5) RETURNING id',
        [workspaceId,schema.id,data,createdBy,'api'])).rows[0]

    const other = await store.createEntity({ workspaceId, entityTypeId: schema.id, createdBy: ownerId, lastEditedBy: ownerId,
      sourceApp: 'api', data: { title: { kind: 'text', value: 'Unreleased fictional request' }, cost: { kind: 'number', value: 43 }, parent: { kind: 'relation', value: target.id } } })
    return { schema, targetSchema, target, row, other, type: `record.${schema.id}`, origin: { kind: 'generic' as const, entityTypeId: schema.id },
      resolver: `relation.${createHash('sha256').update('parent').digest('hex')}` }
  }
  type Fixture = Awaited<ReturnType<typeof records>>
  type Selection = 'ids' | 'self' | 'relationship'
  type PrincipalCase = {kind:'member'|'external_user'|'service';userId:string;appId?:string}
  async function application(fixture: Fixture, selections: Selection[], absent?: string, splitFields?: 'overlap' | 'disjoint',
    principal: PrincipalCase = {kind:'member',userId:ownerId},captureCost=true) {
    const appId = principal.appId ?? randomUUID(), ids = selections.map(() => randomUUID()), anchorId = randomUUID()
    await owner.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id)
      VALUES($1,$2,'records','Fictional compound client',$5,$3,$4)`, [appId, workspaceId, assistantId, ownerId, principal.kind === 'service' ? 'api_client' : 'external_frontend'])
    const grants: ApplicationAccessGrant[] = selections.map((selection, index) => ({
      id: ids[index], appId, workspaceId, principal: {kind:principal.kind,userId:principal.userId}, origin: fixture.origin, typeKey: fixture.type,
      actions: ['read', 'query'], readFields: ['title', 'parent'], writeFields: [],
      selector: selection === 'ids' ? { kind: 'ids', ids: [fixture.row.id, ...(absent ? [absent] : [])] }
        : selection === 'self' ? { kind: 'self' } : { kind: 'relationship', resolverKey: fixture.resolver, anchorId: fixture.target.id },
      version: 1, status: 'active', startsAt: '2020-01-01T00:00:00.000Z', expiresAt: null, parentGrantId: ids[index + 1] ?? null,
      compartments: [], projectIds: [], clearance: 'confidential',
    }))
    const anchor: ApplicationAccessGrant = { ...grants[0], id: anchorId, parentGrantId: null,
      origin: { kind: 'generic', entityTypeId: fixture.targetSchema.id }, typeKey: `record.${fixture.targetSchema.id}`,
      selector: { kind: 'ids', ids: [fixture.target.id] }, readFields: ['title'] }
    const alternatives: ApplicationAccessGrant[] = []
    if (splitFields) {
      grants[0].readFields = ['title']
      alternatives.push({ ...grants[0], id: randomUUID(), parentGrantId: null, readFields: captureCost ? ['cost'] : [],
        selector: { kind: 'ids', ids: [splitFields === 'overlap' ? fixture.row.id : fixture.other.id] } })
    }
    for (const grant of [anchor, ...alternatives, ...[...grants].reverse()]) await owner.query(`INSERT INTO application_access_grants
      (id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,actions,read_fields,write_fields,
       selector,compartments,project_ids,clearance,parent_grant_id,starts_at)
      VALUES($1,$2,$3,$12,$4,$13,$5,$6,$7,$8,'{}',$9,'{}','{}','confidential',$10,$11)`,
    [grant.id, appId, workspaceId, principal.userId, grant.origin, grant.typeKey, grant.actions, grant.readFields, grant.selector, grant.parentGrantId, grant.startsAt,principal.kind,ownerId])
    const maximum: ApplicationGrantMaximum = { version: 1, grants }
    if (principal.kind === 'service') {
      const material=await mintApplicationCredentialSecret()
      await owner.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
        VALUES($1,$2,$3,$4,$5,'Fictional compound service','service',$6,$7,now()+interval '1 hour')`,
        [material.id,appId,workspaceId,ownerId,principal.userId,material.secretHash,ids[0]])
      await owner.query('INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)',
        [material.id,appId,workspaceId,ids[0],maximum])
      await owner.query('INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)',
        [material.id,appId,workspaceId,anchorId,{version:1,grants:[anchor]}])
      for (const alternative of alternatives) await owner.query('INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)',
        [material.id,appId,workspaceId,alternative.id,{version:1,grants:[alternative]}])
      if (!captureCost && alternatives[0]) await owner.query("UPDATE application_access_grants SET read_fields=ARRAY['cost'] WHERE id=$1",[alternatives[0].id])
      const credential=await authenticateApplicationCredential(material.token,appId,loadApplicationCredentialStateSystem)
      expect(credential).not.toBeNull()
      return {authentication:{credential:credential!},appId,alternativeId:alternatives[0]?.id,grantId:ids[0],grantIds:ids,anchorGrantId:anchorId,
        refresh:async ():Promise<ApplicationAuthentication> => {
          const current=await authenticateApplicationCredential(material.token,appId,loadApplicationCredentialStateSystem)
          expect(current).not.toBeNull();return {credential:current!}
        }}
    }
    const oauth = await createDbOAuthClientStore().register({ clientName: 'Fictional compound portal', clientUri: 'https://portal.example',
      redirectUris: ['https://portal.example/callback'], tokenEndpointAuthMethod: 'none' })
    clients.push(oauth.clientId)
    await owner.query('UPDATE application_clients SET oauth_client_id=$2 WHERE id=$1', [appId, oauth.clientId])
    const authorizationId = randomUUID(), secret = randomBytes(32).toString('base64url')
    await owner.query(`INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,audience,application_client_id,access_token_hash,access_token_expires_at)
      VALUES($1,$2,$3,$4,'read_write','application',$5,$6,now()+interval '10 minutes')`,
    [authorizationId, oauth.clientId, principal.userId, workspaceId, appId, await hashSecret(secret)])
    await owner.query(`INSERT INTO application_oauth_bindings(authorization_id,app_id,workspace_id,principal_user_id,parent_grant_id,maximum_grants)
      VALUES($1,$2,$3,$4,$5,$6)`, [authorizationId, appId, workspaceId, principal.userId, ids[0],
        JSON.stringify([maximum, ...alternatives.map(grant => ({ version: 1, grants: [grant] })), { version: 1, grants: [anchor] }])])
    if (!captureCost && alternatives[0]) await owner.query("UPDATE application_access_grants SET read_fields=ARRAY['cost'] WHERE id=$1",[alternatives[0].id])
    const user = await authenticateApplicationOAuth(`oat_${authorizationId}_${secret}`, appId)
    expect(user).not.toBeNull()
    return { authentication: { user: user! },appId,alternativeId:alternatives[0]?.id,grantId: ids[0],grantIds:ids,anchorGrantId: anchorId,
      refresh:async ():Promise<ApplicationAuthentication> => {
        const current=await authenticateApplicationOAuth(`oat_${authorizationId}_${secret}`,appId)
        expect(current).not.toBeNull();return {user:current!}
      }}
  }
  async function query(fixture: Fixture, app: Awaited<ReturnType<typeof application>>, input: Partial<ApplicationQuery> = { fields: ['title'] },authentication:ApplicationAuthentication=app.authentication) {
    return dispatcher.query(await resolveApplicationExecutionContext(authentication), 'records', 'query',
      { type: fixture.type, query: input }) as Promise<{ records: ApplicationRecordProjection[] }>
  }
  async function snapshot(source: ScopeSource, userId = memberId) {
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN'); await applyRLSGucs(client, userId)
      expect((await client.query(`SELECT r.rolsuper,r.rolbypassrls,pg_has_role(r.oid,c.relowner,'USAGE') AS owns
        FROM pg_roles r,pg_class c WHERE r.rolname=current_user AND c.oid='public.entity_instances'::regclass`)).rows[0])
        .toEqual({ rolsuper: false, rolbypassrls: false, owns: false })
      return (await client.query('SELECT read_admitted_application_field_snapshot($1,$2,$3) AS value', [workspaceId, source.resourceId, source.version])).rows[0].value
    } finally { await client.query('ROLLBACK'); client.release() }
  }
  async function domain(result: object) {
    const sources = boundScopeSources(result)
    const id = (await owner.query("SELECT id FROM application_field_resources WHERE id=ANY($1::uuid[]) AND selection='query_domain'",
      [sources.map(source => source.resourceId)])).rows[0]?.id
    const source = sources.find(source => source.resourceId === id)
    expect(source).toBeDefined()
    return source!
  }
  const principalCases = ['owner_member','ordinary_member','member_external_profile','external_user','service'] as const
  async function principalCase(kind:typeof principalCases[number]):Promise<PrincipalCase> {
    if (kind==='owner_member') return {kind:'member',userId:ownerId}
    if (kind==='ordinary_member') return {kind:'member',userId:memberId}
    if (kind==='member_external_profile') return {kind:'external_user',userId:memberId}
    const appId=randomUUID()
    if (kind==='service') {
      const userId=(await findOrCreateUser({authProvider:'channel',authProviderId:`app-service:${appId}:${randomUUID()}`,name:'Fictional compound service'})).user.id
      syntheticUsers.push(userId);return {kind:'service',userId,appId}
    }
    const userId=randomUUID();await owner.query("INSERT INTO users(id,auth_provider,auth_provider_id) VALUES($1::uuid,'email',$1::text)",[userId])
    syntheticUsers.push(userId);return {kind:'external_user',userId,appId}
  }
  it.each(principalCases.flatMap(principal => [
    ['ids','self'] as Selection[],['ids','relationship'] as Selection[],['ids','self','relationship'] as Selection[],
  ].flatMap(selectors => selectors.map((_selector,revokedIndex) => ({principal,selectors,revokedIndex})))))
  ('Q01/Q03 intersects compound $selectors for actual $principal credentials and denies revoked parent $revokedIndex',async ({principal,selectors,revokedIndex}) => {
    const actor=await principalCase(principal),fixture=await records(actor.userId),app=await application(fixture,selectors,undefined,undefined,actor)
    const result=await query(fixture,app)
    expect(result.records.map(row => row.ref.id)).toEqual([fixture.row.id])
    expect(result.records[0].values).toMatchObject({title:{kind:'text',value:'Fictional request'}})
    await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1",[app.grantIds[revokedIndex]])
    await expect(query(fixture,app)).rejects.toMatchObject({code:principal==='service' && revokedIndex>0 ? 'access_unavailable' : 'grant_revoked'})
  })
  it.each(principalCases)('Q01/Q02 unions same-candidate fields for actual %s while retaining the independent captured maximum',async principal => {
    const actor=await principalCase(principal),fixture=await records(actor.userId),app=await application(fixture,['ids'],undefined,'overlap',actor)
    const input:Partial<ApplicationQuery>={fields:['title'],filters:[{field:'cost',op:'eq',value:42}]}
    expect((await query(fixture,app,input)).records.map(row => row.ref.id)).toEqual([fixture.row.id])
    if (principal==='service') {
      await expect(owner.query("UPDATE application_credential_grants SET maximum_grant=jsonb_set(maximum_grant,'{grants,0,readFields}','[]') WHERE app_id=$1 AND grant_id=$2",[app.appId,app.alternativeId])).rejects.toMatchObject({code:'22023'})
    } else {
      await expect(owner.query(`UPDATE application_oauth_bindings SET maximum_grants=(SELECT jsonb_agg(CASE WHEN value->'grants'->0->>'id'=$2
        THEN jsonb_set(value,'{grants,0,readFields}','[]') ELSE value END ORDER BY ordinal)
        FROM jsonb_array_elements(maximum_grants) WITH ORDINALITY entries(value,ordinal)) WHERE app_id=$1`,[app.appId,app.alternativeId])).rejects.toMatchObject({code:'22023'})
    }
    expect((await owner.query('SELECT read_fields FROM application_access_grants WHERE id=$1',[app.alternativeId])).rows[0].read_fields).toEqual(['cost'])
    expect((await query(fixture,app,input)).records.map(row => row.ref.id)).toEqual([fixture.row.id])
    // Capture a genuinely narrower issuance maximum, then widen only its live
    // app grant. The canonical triggers derive the snapshot; no maximum is forged.
    const narrow=await application(fixture,['ids'],undefined,'overlap',await principalCase(principal),false)
    expect((await owner.query('SELECT read_fields FROM application_access_grants WHERE id=$1',[narrow.alternativeId])).rows[0].read_fields).toEqual(['cost'])
    const authentication=await narrow.refresh()
    await expect(query(fixture,narrow,input,authentication)).rejects.toMatchObject({code:'access_unavailable'})
    expect((await query(fixture,narrow,{fields:['title']},authentication)).records.map(row => row.ref.id)).toEqual([fixture.row.id])
  })
  it.each(principalCases)('Q01/Q02 refuses a field released only on another candidate for actual %s',async principal => {
    const actor=await principalCase(principal),fixture=await records(actor.userId),app=await application(fixture,['ids'],undefined,'disjoint',actor)
    await expect(query(fixture,app,{fields:['title'],filters:[{field:'cost',op:'eq',value:42}]})).rejects.toMatchObject({code:'access_unavailable'})
  })
  it('Q01/Q03 retains the native member ceiling behind an actual external-profile compound path',async () => {
    const actor=await principalCase('member_external_profile'),fixture=await records(actor.userId),app=await application(fixture,['ids','self','relationship'],undefined,undefined,actor)
    expect((await query(fixture,app)).records.map(row => row.ref.id)).toEqual([fixture.row.id])
    await owner.query("UPDATE entity_instances SET sensitivity='confidential' WHERE id=$1",[fixture.row.id])
    await expect(dispatcher.query(await resolveApplicationExecutionContext(app.authentication),'records','get',{type:fixture.type,id:fixture.row.id}))
      .rejects.toMatchObject({code:'access_unavailable'})
  })
  it('Q01/Q03 retains the actual issuer and executing assistant floors on a compound service path',async () => {
    const actor=await principalCase('service'),fixture=await records(actor.userId),app=await application(fixture,['ids','self','relationship'],undefined,undefined,actor)
    expect((await query(fixture,app)).records.map(row => row.ref.id)).toEqual([fixture.row.id])
    try {
      await owner.query("UPDATE workspace_members SET role='member',clearance='public' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,ownerId])
      await expect((async () => dispatcher.query(await resolveApplicationExecutionContext(app.authentication),'records','get',{type:fixture.type,id:fixture.row.id}))())
        .rejects.toMatchObject({code:'grant_revoked'})
    } finally {await owner.query("UPDATE workspace_members SET role='owner',clearance='confidential' WHERE workspace_id=$1 AND user_id=$2",[workspaceId,ownerId])}
    expect((await query(fixture,app)).records.map(row => row.ref.id)).toEqual([fixture.row.id])
    try {
      await owner.query("UPDATE assistants SET clearance='public' WHERE id=$1",[assistantId])
      await expect((async () => dispatcher.query(await resolveApplicationExecutionContext(app.authentication),'records','get',{type:fixture.type,id:fixture.row.id}))())
        .rejects.toMatchObject({code:'access_unavailable'})
    } finally {await owner.query("UPDATE assistants SET clearance='confidential' WHERE id=$1",[assistantId])}
  })
  const compoundPaths: Selection[][] = [['ids', 'self'], ['self', 'ids'], ['ids', 'relationship'], ['relationship', 'ids'], ['ids', 'self', 'relationship']]
  it.each(compoundPaths.map(selectors => ({ selectors })))(
    'Q01/Q02 refines the finite compound path $selectors for an independently authorized reader', async ({ selectors }) => {
      const fixture = await records(), app = await application(fixture, selectors)
      const result = await query(fixture, app)
      expect(result.records.map(record => record.ref.id)).toEqual([fixture.row.id])
      const source = await domain(result)
      expect(await snapshot(source)).toMatchObject({ held: false })
      await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1", [app.grantId])
      await expect(query(fixture, app)).rejects.toThrow()
      expect(await snapshot(source)).toMatchObject({ held: false })
    })
  it('Q02 preserves absent compound points instead of pretending they were admitted records', async () => {
    const fixture = await records(), app = await application(fixture, ['ids', 'self'], randomUUID())
    const result = await query(fixture, app), source = await domain(result)
    expect(result.records.map(record => record.ref.id)).toEqual([fixture.row.id])
    expect(await snapshot(source)).toMatchObject({ held: true })
    expect(await snapshot(source, ownerId)).toMatchObject({ held: false })
  })
  it('Q02 retains the independently authorized relationship anchor after finite refinement', async () => {
    const fixture = await records(), app = await application(fixture, ['ids', 'relationship'])
    const result = await query(fixture, app), source = await domain(result)
    expect(await snapshot(source)).toMatchObject({ held: false })
    await owner.query("UPDATE entity_instances SET sensitivity='confidential' WHERE id=$1", [fixture.target.id])
    expect(await snapshot(source)).toMatchObject({ held: true })
    expect(await snapshot(source, ownerId)).toMatchObject({ held: false })
  })
  it.each([{ selection: 'self' as const }, { selection: 'relationship' as const }])(
    'Q01 keeps an ID excluded by the compound $selection as an original absence obligation', async ({ selection }) => {
      const fixture = await records(selection === 'self' ? memberId : ownerId, selection !== 'relationship')
      const app = await application(fixture, ['ids', selection]), result = await query(fixture, app)
      expect(result.records).toEqual([])
      const source = await domain(result)
      expect(await snapshot(source)).toMatchObject({ held: true })
      expect(await snapshot(source, ownerId)).toMatchObject({ held: false })
    })
  it('Q01 requires an independent anchor release for a finite relationship path', async () => {
    const fixture = await records(), app = await application(fixture, ['ids', 'relationship'])
    await owner.query("UPDATE application_access_grants SET status='revoked' WHERE id=$1", [app.anchorGrantId])
    await expect(query(fixture, app)).rejects.toThrow()
  })
  it('Q01/Q02 unions field grants on the same candidate within one authorized layer', async () => {
    const fixture = await records(), app = await application(fixture, ['ids'], undefined, 'overlap')
    const result = await query(fixture, app, { fields: ['title'], filters: [{ field: 'cost', op: 'eq', value: 42 }] })
    expect(result.records.map(record => record.ref.id)).toEqual([fixture.row.id])
    expect(result.records[0].values).toEqual({ title: { kind: 'text', value: 'Fictional request' } })
  })
  it('Q01/Q02 refuses a field granted only on another candidate in the same layer', async () => {
    const fixture = await records(), app = await application(fixture, ['ids'], undefined, 'disjoint')
    await expect(query(fixture, app, { fields: ['title'], filters: [{ field: 'cost', op: 'eq', value: 42 }] }))
      .rejects.toMatchObject({ code: 'access_unavailable' })
  })
})
