import { randomUUID } from 'node:crypto'
import { afterAll,beforeAll,describe,expect,it } from 'vitest'
import type { PoolClient } from 'pg'
import { getAppPool,getPool,applyRLSGucs } from '../../db/client.js'
import { createDbDocEntityStore } from '../../db/doc-entity-store.js'
import { defineNativeApplicationFieldPolicy,decideNativeApplicationFields,type NativeApplicationFieldFacts } from '@use-brian/core'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs',import.meta.url).href)
await assertLocalFixture()

// The fixture deploys a metadata-only module port. The reader and role/scope
// decisions are production SQL under a separate login with no owner/RLS bypass.
describe('[COMP:security/native-field-policy] current canonical native field masks', () => {
  const owner = getPool(),workspaceId = randomUUID(),otherWorkspaceId = randomUUID()
  const ownerId = randomUUID(),memberId = randomUUID(),otherId = randomUUID()
  const store = createDbDocEntityStore({ actorUserId: ownerId })
  beforeAll(async () => {
    for (const id of [ownerId,memberId,otherId]) await owner.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)',[id])
    for (const id of [workspaceId,otherWorkspaceId]) {
      await owner.query("INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional field policy workspace',$2,false)",[id,ownerId])
      for (const [user,role] of [[ownerId,'owner'],[memberId,'member'],[otherId,'member']]) await owner.query(
        'INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,$3,$4)',[id,user,role,role === 'owner' ? 'confidential' : 'internal'])
    }
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
    await owner.query('DELETE FROM users WHERE id=ANY($1::uuid[])',[[ownerId,memberId,otherId]])
    await getAppPool().end();await owner.end()
  })
  function fields() {
    return [
      { key: 'title',read: [],write: [],releaseReadTo: ['external_user','service'],releaseWriteTo: ['service'] },
      { key: 'cost',read: [['finance']],write: [['finance'],['approver']],releaseReadTo: [],releaseWriteTo: [] },
    ]
  }
  async function record() {
    const schema = await store.createEntityType({ workspaceId,name: `Fictional purchases ${randomUUID()}`,createdBy: ownerId,
      properties: [{ name: 'title',config: { kind: 'text' } },{ name: 'cost',config: { kind: 'number',format: 'decimal' } }] })
    const row = await store.createEntity({ workspaceId,entityTypeId: schema.id,createdBy: ownerId,lastEditedBy: ownerId,sourceApp: 'api',
      data: { title: { kind: 'text',value: 'Fictional request' },cost: { kind: 'number',value: 42 } } })
    const recordVersion = row.recordVersion
    if (!recordVersion) throw new Error('The canonical fixture requires its persisted record version.')
    const origin = { kind: 'generic',entityTypeId: schema.id },type = `record.${schema.id}`
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
        expect((await maskOn(client,fixture))?.readFields).toEqual(['title'])
      } finally { await client.query('DROP TABLE pg_temp.application_native_role_assignments') }
    })
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
