import { randomBytes, randomUUID } from 'node:crypto'
import { afterAll, describe, expect, it } from 'vitest'
import { applyRLSGucs, getAppPool, getPool } from '../client.js'
import { reassignDepartingAssignments } from '../account-departure.js'
import { DELETED_USER_NAME, deleteAccountFootprint } from '../account-teardown.js'
import { createTask } from '../tasks.js'
import { findOrCreateUser } from '../users.js'
import { createConnectorInstanceStore } from '../connector-instance-store.js'
import { createDbWorkflowStore } from '../workflow-store.js'
import { captureAuthoringAuthoritySystem } from '../../context-scope/workflow-authority.js'
import { loadApplicationCredentialStateSystem } from '../../application-platform/auth-store.js'
import { mintApplicationCredentialSecret } from '../../application-platform/credentials.js'
import { prepareSourceServiceBinding } from '../../application-platform/source-service-binding.js'

// A departed member (user decision 2026-11-17): the authority they issued is
// revoked, their assigned work moves to the workspace owner through the
// canonical task writer, a binding is re-established by the owner through
// the normal binding channel, and their own data follows the unchanged
// erasure rules. Committed data on a disposable fixture: the departure phase
// runs on the application pool, the teardown on the ordinary owner.
const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

const one = async <T extends Record<string, unknown>>(sql: string, values: unknown[] = []) => (await pool.query<T>(sql, values)).rows[0]

// Fictional identities only; every row is committed to the disposable fixture.
async function departureFixture() {
  const workspace = randomUUID(), owner = randomUUID(), leaver = randomUUID(), assistant = randomUUID(), department = randomUUID(), app = randomUUID()
  for (const [id, name] of [[owner, 'Fictional owner'], [leaver, 'Fictional leaver']])
    await pool.query(`INSERT INTO users(id,auth_provider,auth_provider_id,email,name) VALUES($1::uuid,'email',$1::text,$2,$3)`, [id, `${name.split(' ')[1]}-${id}@example.com`, name])
  await pool.query(`INSERT INTO workspaces(id,name,owner_user_id,department_read_v2) VALUES($1,'Fictional departure workspace',$2,true)`, [workspace, owner])
  await pool.query(`INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'admin','confidential')`, [workspace, owner, leaver])
  await pool.query(`INSERT INTO assistants(id,name,workspace_id,owner_user_id,kind,clearance,compartments) VALUES($1,'Fictional departure assistant',$2,$3,'primary','confidential',NULL)`, [assistant, workspace, owner])
  await pool.query(`INSERT INTO workspace_groups(id,workspace_id,name,created_by,kind,key,compartment_key) VALUES($1::uuid,$2,'Fictional team',$3,'team',$1::text,$4)`, [department, workspace, owner, 'team:' + department])
  await pool.query(`INSERT INTO workspace_compartments(workspace_id,key,label,created_by,managed_by,managed_ref_id) VALUES($1,$2,'Fictional team',$3,'team',$4)`, [workspace, 'team:' + department, owner, department])
  await pool.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin) VALUES($1,$2,'assistant',$3,'confidential','store') ON CONFLICT DO NOTHING`, [workspace, department, assistant])
  for (const id of [owner, leaver]) await pool.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin) VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING`, [workspace, department, id])
  const service = (await findOrCreateUser({ authProvider: 'channel', authProviderId: `app-service:${app}:${randomUUID()}`, name: 'Fictional named service' })).user.id
  await pool.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id) VALUES($1,$2,'native','Fictional departure app','api_client',$3,$4)`, [app, workspace, assistant, owner])
  const instances = createConnectorInstanceStore(randomBytes(32))
  const instance = await instances.createWorkspaceInstance({ workspaceId: workspace, createdBy: owner, provider: randomUUID(), label: 'Fictional source', custom: true, connected: true,
    compartments: ['team:' + department], projectIds: [], sensitivity: 'confidential', credentials: { type: 'bearer', token: randomBytes(24).toString('base64url') } })
  await instances.update(owner, instance.id, { url: 'https://source.example/mcp' })
  const profile = (await pool.query<{ id: string }>(`INSERT INTO connector_source_profiles(workspace_id,connector_instance_id,tenant,issuer,audience,source_base_url,mcp_url,http_read_path,status,created_by_user_id)
    VALUES($1,$2,'fixture-tenant',$3,'https://service-source.example','https://source.example','https://source.example/mcp','/http/read','qualified',$4) RETURNING id`,
  [workspace, instance.id, `https://${randomUUID()}.brain.example`, owner])).rows[0]!.id
  const grant = (id: string, parentGrantId: string | null) => ({ id, appId: app, workspaceId: workspace, principal: { kind: 'service', userId: service },
    origin: { kind: 'external', connectorInstanceId: instance.id, sourceTenant: 'fixture-tenant' }, typeKey: 'purchase', actions: ['read'], readFields: ['description'], writeFields: [],
    selector: { kind: 'ids', ids: ['order-1'] }, version: 1, status: 'active', startsAt: '2026-01-01T00:00:00.000Z', expiresAt: null, parentGrantId,
    compartments: ['team:' + department], projectIds: [], clearance: 'confidential' })
  const insertGrant = (g: ReturnType<typeof grant>, issuer: string) => pool.query(`INSERT INTO application_access_grants(id,app_id,workspace_id,principal_kind,principal_user_id,issued_by_user_id,resource_origin,resource_type,actions,read_fields,write_fields,selector,parent_grant_id,compartments,project_ids,clearance,starts_at)
    VALUES($1,$2,$3,'service',$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}','confidential',$14)`,
  [g.id, app, workspace, service, issuer, g.origin, g.typeKey, g.actions, g.readFields, g.writeFields, g.selector, g.parentGrantId, g.compartments, g.startsAt])
  const parent = grant(randomUUID(), null)
  await insertGrant(parent, owner)
  // A leaf grant and a service credential per issuer, both under the owner's parent.
  const issue = async (issuer: string) => {
    const leaf = grant(randomUUID(), parent.id)
    await insertGrant(leaf, issuer)
    const material = await mintApplicationCredentialSecret()
    await pool.query(`INSERT INTO application_api_credentials(id,app_id,workspace_id,issued_by_user_id,subject_user_id,name,credential_kind,secret_hash,parent_grant_id,expires_at)
      VALUES($1,$2,$3,$4,$5,'Fictional service credential','service',$6,$7,now()+interval '1 hour')`, [material.id, app, workspace, issuer, service, material.secretHash, leaf.id])
    await pool.query(`INSERT INTO application_credential_grants(credential_id,app_id,workspace_id,grant_id,maximum_grant) VALUES($1,$2,$3,$4,$5)`,
      [material.id, app, workspace, leaf.id, { version: 1, grants: [leaf, parent] }])
    return { grant: leaf.id, credential: material.id }
  }
  const workflow = async (author: string) => (await createDbWorkflowStore().create({ userId: author, workspaceId: workspace, name: 'Fictional source workflow',
    authoringAuthority: await captureAuthoringAuthoritySystem({ userId: author, workspaceId: workspace, assistantId: assistant }),
    definition: { startStepId: 'read', steps: [{ id: 'read', type: 'tool_call', toolName: 'readRecord', arguments: { id: 'order-1', fields: ['description'] } }] } })).id
  // The normal binding channel: source.binding.review prepares as the configurer.
  const bind = async (actor: string, credential: string, workflowId: string) => {
    const client = await getAppPool().connect()
    try {
      await client.query('BEGIN')
      await applyRLSGucs(client, actor)
      await client.query(`SELECT set_config('app.application_assistant_id',$1,true),set_config('app.v2_assistant_id',$1,true)`, [assistant])
      const id = (await prepareSourceServiceBinding(client, actor, workspace, { profileId: profile, appId: app, credentialId: credential, workflowId,
        expiresAt: new Date(Date.now() + 30 * 60e3).toISOString() })).reviewId
      await client.query('COMMIT')
      return id
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }
  }
  return { workspace, owner, leaver, assistant, app, service, issue, workflow, bind }
}

describe.sequential('[COMP:api/account-teardown] departed member revocation and reassignment', () => {
  afterAll(async () => {
    await getAppPool().end()
    await pool.end()
  })

  it('revokes issued credentials, grants, activations and bindings, reassigns assigned tasks canonically, and keeps erasure rules', async () => {
    const f = await departureFixture()
    const membership = async (user: string) =>
      (await one<{ id: string }>(`SELECT id FROM workspace_members WHERE workspace_id = $1 AND user_id = $2`, [f.workspace, user]))!.id
    const leaverMembership = await membership(f.leaver), ownerMembership = await membership(f.owner)

    // Authority each admin issued, and a scoped activation and a binding the
    // leaver set up through the normal channel.
    const owned = await f.issue(f.owner), left = await f.issue(f.leaver)
    // The scoped activation is on a second app: an activated app admits only
    // scoped credentials, which this binding fixture does not issue.
    const scopedApp = randomUUID()
    await pool.query(`INSERT INTO application_clients(id,workspace_id,module_key,name,client_mode,executing_assistant_id,created_by_user_id) VALUES($1,$2,'native','Fictional scoped app','api_client',$3,$4)`,
      [scopedApp, f.workspace, f.assistant, f.owner])
    const revision = (await one<{ r: string }>(`SELECT grant_revision::text AS r FROM application_clients WHERE id = $1`, [scopedApp]))!.r
    await pool.query(`INSERT INTO application_scoped_activations(app_id,workspace_id,profile,app_revision,assistant_id,activated_by,status)
      VALUES($1,$2,'canonical_service_v1',$3,$4,$5,'active')`, [scopedApp, f.workspace, revision, f.assistant, f.leaver])
    const workflowId = await f.workflow(f.owner)
    const leaverBinding = await f.bind(f.leaver, left.credential, workflowId)
    expect(await one(`SELECT configured_by_user_id, status FROM source_service_bindings WHERE id = $1`, [leaverBinding]))
      .toEqual({ configured_by_user_id: f.leaver, status: 'pending' })
    for (const id of [owned.credential, left.credential]) expect(await loadApplicationCredentialStateSystem(id)).toMatchObject({ id })

    // Work: a shared task the owner assigned to the leaver, and a shared task
    // the leaver authored. Their own data: a private entity.
    const assigned = await createTask(f.owner, { workspaceId: f.workspace, title: 'Fictional handover task', assigneeId: leaverMembership })
    const authored = await createTask(f.leaver, { workspaceId: f.workspace, title: 'Fictional authored task' })
    const privateEntity = (await one<{ id: string }>(
      `INSERT INTO entities (kind, display_name, workspace_id, created_by_user_id, source, user_id)
       VALUES ('person', 'Fictional private subject', $1, $2, 'manual', $2) RETURNING id`, [f.workspace, f.leaver]))!.id

    expect(await reassignDepartingAssignments(f.leaver)).toEqual({ reassigned: 1, unassigned: 0 })
    const client = await pool.connect()
    let mode: string
    try {
      await client.query('BEGIN')
      mode = (await deleteAccountFootprint(client, f.leaver)).mode
      await client.query('COMMIT')
    } catch (err) {
      await client.query('ROLLBACK')
      throw err
    } finally {
      client.release()
    }

    // Credentials refuse; grants, activations and bindings are revoked, with
    // the canonical authority events; the owner's own authority is untouched.
    expect(mode).toBe('tombstoned')
    expect(await loadApplicationCredentialStateSystem(left.credential)).toBeNull()
    expect(await one(`SELECT status FROM application_api_credentials WHERE id = $1`, [left.credential])).toEqual({ status: 'revoked' })
    expect(await one(`SELECT status FROM application_access_grants WHERE id = $1`, [left.grant])).toEqual({ status: 'revoked' })
    expect((await pool.query(`SELECT action, resource_id FROM application_authority_events WHERE workspace_id = $1 AND actor_user_id = $2 ORDER BY action`,
      [f.workspace, f.leaver])).rows).toEqual([{ action: 'credential_revoked', resource_id: left.credential }, { action: 'grant_revoked', resource_id: left.grant }])
    expect(await one(`SELECT status FROM application_scoped_activations WHERE app_id = $1`, [scopedApp])).toEqual({ status: 'revoked' })
    expect(await one(`SELECT status, configured_by_user_id FROM source_service_bindings WHERE id = $1`, [leaverBinding]))
      .toEqual({ status: 'revoked', configured_by_user_id: f.leaver })
    expect(await one(`SELECT status FROM application_access_grants WHERE id = $1`, [owned.grant])).toEqual({ status: 'active' })
    expect(await loadApplicationCredentialStateSystem(owned.credential)).toMatchObject({ id: owned.credential })

    // A revoked binding stays revoked; the owner binds again through the
    // normal channel and becomes the configurer of every live binding.
    await expect(pool.query(`UPDATE source_service_bindings SET status = 'pending' WHERE id = $1`, [leaverBinding])).rejects.toThrow('source_service_binding_immutable')
    const rebound = await f.bind(f.owner, owned.credential, workflowId)
    expect(await one(`SELECT configured_by_user_id FROM source_service_bindings WHERE id = $1`, [rebound])).toEqual({ configured_by_user_id: f.owner })
    expect((await pool.query(`SELECT DISTINCT configured_by_user_id FROM source_service_bindings WHERE workspace_id = $1 AND status <> 'revoked'`,
      [f.workspace])).rows).toEqual([{ configured_by_user_id: f.owner }])

    // The assignment moved by canonical supersession: the live version is the
    // owner's, authored by the departed member; the original is history.
    expect(await one(`SELECT assignee_id, created_by_user_id FROM tasks WHERE workspace_id = $1 AND logical_id = $2 AND valid_to IS NULL`,
      [f.workspace, assigned.id])).toEqual({ assignee_id: ownerMembership, created_by_user_id: f.leaver })
    expect(await one(`SELECT valid_to IS NOT NULL AS closed FROM tasks WHERE id = $1`, [assigned.id])).toEqual({ closed: true })
    expect(await one(`SELECT created_by_user_id FROM tasks WHERE id = $1 AND valid_to IS NULL`, [authored.id])).toEqual({ created_by_user_id: f.leaver })

    // Erasure rules unchanged: private rows gone, account tombstoned and
    // unusable, no membership left.
    expect(await one(`SELECT count(*)::int AS n FROM entities WHERE id = $1`, [privateEntity])).toEqual({ n: 0 })
    expect(await one(`SELECT email, name, auth_provider, deleted_at IS NOT NULL AS deleted FROM users WHERE id = $1`, [f.leaver]))
      .toEqual({ email: null, name: DELETED_USER_NAME, auth_provider: 'deleted', deleted: true })
    expect(await one(`SELECT count(*)::int AS n FROM workspace_members WHERE user_id = $1`, [f.leaver])).toEqual({ n: 0 })
    expect(await one(`SELECT count(*)::int AS n FROM account_erasures`)).toEqual({ n: 0 })
  })
})
