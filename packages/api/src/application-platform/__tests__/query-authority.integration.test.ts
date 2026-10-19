import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { boundScopeSources, type ScopeSource } from '@use-brian/core'
import type { ApplicationAccessGrant, ApplicationGrantMaximum, ApplicationRecordProjection, ApplicationQuery } from '@use-brian/shared'
import { applyRLSGucs, getAppPool, getPool } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { createDbOAuthClientStore } from '../../db/oauth-client-store.js'
import { hashSecret } from '../../db/api-key-store.js'
import { authenticateApplicationOAuth } from '../oauth-auth.js'
import { resolveApplicationExecutionContext } from '../execution-context.js'
import { ApplicationPlatformService } from '../service.js'
import { createCanonicalGenericApplicationModule } from '../generic-adapter.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()

describe('[COMP:api/application-records] compound query authority under real principal ceilings', () => {
  const owner = getPool(), workspaceId = randomUUID(), ownerId = randomUUID(), memberId = randomUUID(), assistantId = randomUUID()
  const clients: string[] = []
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
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])', [[ownerId, memberId]])
    await getAppPool().end(); await owner.end()
  })
  async function records(createdBy = ownerId, linked = true) {
    const targetSchema = await store.createEntityType({ workspaceId, name: `Fictional anchors ${randomUUID()}`, createdBy: ownerId,
      properties: [{ name: 'title', config: { kind: 'text' } }] })
    const target = await store.createEntity({ workspaceId, entityTypeId: targetSchema.id, createdBy: ownerId, lastEditedBy: ownerId,
      sourceApp: 'api', data: { title: { kind: 'text', value: 'Fictional anchor' } } })
    const schema = await store.createEntityType({ workspaceId, name: `Fictional requests ${randomUUID()}`, createdBy: ownerId,
      properties: [{ name: 'title', config: { kind: 'text' } }, { name: 'cost', config: { kind: 'number' } },
        { name: 'parent', config: { kind: 'relation', targetEntityTypeRef: { kind: 'user_defined', entityTypeId: targetSchema.id } } }] })
    const author = createDbDocEntityStore({ actorUserId: createdBy })
    const row = await author.createEntity({ workspaceId, entityTypeId: schema.id, createdBy, lastEditedBy: createdBy,
      sourceApp: 'api', data: { title: { kind: 'text', value: 'Fictional request' }, cost: { kind: 'number', value: 42 }, parent: { kind: 'relation', value: linked ? target.id : null } } })
    const other = await store.createEntity({ workspaceId, entityTypeId: schema.id, createdBy: ownerId, lastEditedBy: ownerId,
      sourceApp: 'api', data: { title: { kind: 'text', value: 'Unreleased fictional request' }, cost: { kind: 'number', value: 43 }, parent: { kind: 'relation', value: target.id } } })
    return { schema, targetSchema, target, row, other, type: `record.${schema.id}`, origin: { kind: 'generic' as const, entityTypeId: schema.id },
      resolver: `relation.${createHash('sha256').update('parent').digest('hex')}` }
  }
  type Fixture = Awaited<ReturnType<typeof records>>
  type Selection = 'ids' | 'self' | 'relationship'
  async function application(fixture: Fixture, selections: Selection[], absent?: string, splitFields?: 'overlap' | 'disjoint') {
    const appId = randomUUID(), ids = selections.map(() => randomUUID()), anchorId = randomUUID()
    await owner.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id)
      VALUES($1,$2,'records','Fictional compound client','external_frontend',$3,$4)`, [appId, workspaceId, assistantId, ownerId])
    const grants: ApplicationAccessGrant[] = selections.map((selection, index) => ({
      id: ids[index], appId, workspaceId, principal: { kind: 'member', userId: ownerId }, origin: fixture.origin, typeKey: fixture.type,
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
      alternatives.push({ ...grants[0], id: randomUUID(), parentGrantId: null, readFields: ['cost'],
        selector: { kind: 'ids', ids: [splitFields === 'overlap' ? fixture.row.id : fixture.other.id] } })
    }
    for (const grant of [anchor, ...alternatives, ...[...grants].reverse()]) await owner.query(`INSERT INTO application_access_grants
      (id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,actions,read_fields,write_fields,
       selector,compartments,project_ids,clearance,parent_grant_id,starts_at)
      VALUES($1,$2,$3,'member',$4,$4,$5,$6,$7,$8,'{}',$9,'{}','{}','confidential',$10,$11)`,
    [grant.id, appId, workspaceId, ownerId, grant.origin, grant.typeKey, grant.actions, grant.readFields, grant.selector, grant.parentGrantId, grant.startsAt])
    const maximum: ApplicationGrantMaximum = { version: 1, grants }
    const oauth = await createDbOAuthClientStore().register({ clientName: 'Fictional compound portal', clientUri: 'https://portal.example',
      redirectUris: ['https://portal.example/callback'], tokenEndpointAuthMethod: 'none' })
    clients.push(oauth.clientId)
    await owner.query('UPDATE application_clients SET oauth_client_id=$2 WHERE id=$1', [appId, oauth.clientId])
    const authorizationId = randomUUID(), secret = randomBytes(32).toString('base64url')
    await owner.query(`INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,audience,application_client_id,access_token_hash,access_token_expires_at)
      VALUES($1,$2,$3,$4,'read_write','application',$5,$6,now()+interval '10 minutes')`,
    [authorizationId, oauth.clientId, ownerId, workspaceId, appId, await hashSecret(secret)])
    await owner.query(`INSERT INTO application_oauth_bindings(authorization_id,app_id,workspace_id,principal_user_id,parent_grant_id,maximum_grants)
      VALUES($1,$2,$3,$4,$5,$6)`, [authorizationId, appId, workspaceId, ownerId, ids[0],
        JSON.stringify([maximum, ...alternatives.map(grant => ({ version: 1, grants: [grant] })), { version: 1, grants: [anchor] }])])
    const user = await authenticateApplicationOAuth(`oat_${authorizationId}_${secret}`, appId)
    expect(user).not.toBeNull()
    return { authentication: { user: user! }, grantId: ids[0], anchorGrantId: anchorId }
  }
  async function query(fixture: Fixture, app: Awaited<ReturnType<typeof application>>, input: Partial<ApplicationQuery> = { fields: ['title'] }) {
    return dispatcher.query(await resolveApplicationExecutionContext(app.authentication), 'records', 'query',
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
