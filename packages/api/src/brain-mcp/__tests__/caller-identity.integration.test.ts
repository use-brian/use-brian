import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import { authenticateBrainRequest, getAuthenticatedBrainCredentialCurrent, getAuthenticatedCrmCredentialParent } from '../auth.js'
import { assertCrmCredentialParent } from '../../crm-operations/integration-department-authority.js'
import { createDbOAuthAuthorizationStore } from '../../db/oauth-authorization-store.js'
import { hashSecret } from '../../db/api-key-store.js'
import { afterAll, describe, expect, it } from 'vitest'
import { makeBrainContextResolver } from '../tools.js'
import { getPool, getAppPool } from '../../db/client.js'
import { getEntityById } from '../../db/entities-store.js'
import { createDbBrainKeyStore } from '../../db/brain-keys-store.js'
import { createTask } from '../../db/tasks.js'
import { runWithAgentAccess } from '../../db/agent-access-context.js'

const { assertLocalFixture } = await import(new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href)
await assertLocalFixture()
const pool = getPool()

describe('[COMP:api/brain-mcp] Actual user-linked caller identity', () => {
  afterAll(async () => { await Promise.all([pool.end(), getAppPool().end()]) })
  it.each(['oauth_token', 'home_app'] as const)('keeps %s caller scope separate from owner attribution', async kind => {
    const workspaceId = randomUUID(), owner = randomUUID(), viewer = randomUUID(), assistantId = randomUUID()
    for (const id of [owner, viewer]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional caller workspace',$2)", [workspaceId, owner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'member','internal')", [workspaceId, owner, viewer])
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional primary','primary','internal')", [assistantId, workspaceId])
    const privateRows = new Map<string, string>()
    for (const actor of [owner, viewer]) {
      const id = randomUUID(); privateRows.set(actor, id)
      await pool.query("INSERT INTO entities(id,workspace_id,kind,display_name,source,user_id,created_by_user_id) VALUES($1,$2,'person','Fictional private contact','manual',$3,$3)", [id, workspaceId, actor])
    }
    const credentialId = randomUUID()
    let current = true
    let proof = async () => current
    const clientId = randomUUID()
    if (kind === 'oauth_token') {
      const secret = 'fictional-oauth-secret'
      await pool.query("INSERT INTO oauth_clients(client_id,redirect_uris) VALUES($1,ARRAY['https://client.example/callback'])", [clientId])
      await pool.query("INSERT INTO oauth_authorizations(id,client_id,user_id,workspace_id,scope,access_token_hash,access_token_expires_at) VALUES($1,$2,$3,$4,'read_write',$5,now()+interval '10 minutes')", [credentialId, clientId, viewer, workspaceId, await hashSecret(secret)])
      const auth = await authenticateBrainRequest({ headers: { authorization: `Bearer oat_${credentialId}_${secret}` } } as Request,
        { brainKeyStore: {} as never, authorizationStore: createDbOAuthAuthorizationStore() })
      expect(auth?.actingUserId).toBe(viewer)
      proof = getAuthenticatedBrainCredentialCurrent(auth!)!
      expect(await proof()).toBe(true)
    }
    const context = await makeBrainContextResolver(workspaceId, credentialId, 'internal', 'programmatic', { kind, credentialId, userId: viewer }, proof)()
    if ('error' in context) throw new Error(context.error)
    expect(context.userId).toBe(viewer)
    expect(context.executionContext?.security.access.userId).toBe(viewer)
    const access = context.executionContext!.security.access
    expect(await getEntityById(access, privateRows.get(owner)!)).toBeNull()
    expect(await getEntityById(access, privateRows.get(viewer)!)).toMatchObject({ id: privateRows.get(viewer) })
    await context.authority!.assertCurrent()
    current = false
    if (kind === 'oauth_token') {
      await pool.query('UPDATE oauth_clients SET revoked_at=clock_timestamp() WHERE client_id=$1', [clientId])
      expect(await createDbOAuthAuthorizationStore().getByIdSystem(credentialId)).toBeNull()
      expect(await proof()).toBe(false)
    }
    await expect(context.authority!.assertCurrent()).rejects.toMatchObject({ reason: 'authority_changed' })
    expect(await makeBrainContextResolver(workspaceId, credentialId, 'internal', 'programmatic', { kind, credentialId, userId: viewer }, proof)())
      .toEqual({ error: 'Credential unavailable' })
    expect(await makeBrainContextResolver(workspaceId, credentialId, 'internal', 'programmatic', { kind, credentialId })())
      .toEqual({ error: 'Authenticated credential user required' })
  })

  it('runs a department-bound brain key as its issuer, so a task write reaches the bound department', async () => {
    const workspaceId = randomUUID(), owner = randomUUID(), issuer = randomUUID(), assistantId = randomUUID(), department = randomUUID()
    for (const id of [owner, issuer]) await pool.query('INSERT INTO users(id,auth_provider_id) VALUES($1::uuid,$1::text)', [id])
    await pool.query("INSERT INTO workspaces(id,name,owner_user_id) VALUES($1,'Fictional bound-key workspace',$2)", [workspaceId, owner])
    await pool.query("INSERT INTO workspace_members(workspace_id,user_id,role,clearance) VALUES($1,$2,'owner','confidential'),($1,$3,'admin','confidential')", [workspaceId, owner, issuer])
    await pool.query("INSERT INTO assistants(id,workspace_id,name,kind,clearance) VALUES($1,$2,'Fictional primary','primary','confidential')", [assistantId, workspaceId])
    await pool.query(`INSERT INTO workspace_groups(id,workspace_id,kind,name,created_by,compartment_key,key)
      VALUES($1::uuid,$2,'team','Fictional office',$3,$4,$1::text)`, [department, workspaceId, issuer, `team:${department}`])
    await pool.query("INSERT INTO workspace_compartments(workspace_id,key,label,managed_by,managed_ref_id) VALUES($1,$2,'Fictional office','team',$3)", [workspaceId, `team:${department}`, department])
    // The issuer and the primary assistant hold the department; the workspace owner does not.
    await pool.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,user_id,clearance,origin)
      VALUES($1,$2,'user',$3,'confidential','store') ON CONFLICT DO NOTHING`, [workspaceId, department, issuer])
    await pool.query(`INSERT INTO department_edges(workspace_id,department_id,principal_kind,assistant_id,clearance,origin)
      VALUES($1,$2,'assistant',$3,'confidential','store') ON CONFLICT DO NOTHING`, [workspaceId, department, assistantId])
    const keyId = randomUUID(), secret = 'fictional-bound-key'
    await pool.query(`INSERT INTO brain_keys(id,workspace_id,name,key_prefix,key_hash,scope,status,created_by,context_group_id)
      VALUES($1,$2,'Fictional bound key','sk_brain_fixture',$3,'read_write','active',$4,$5)`, [keyId, workspaceId, await hashSecret(secret), issuer, department])

    const auth = await authenticateBrainRequest({ headers: { authorization: `Bearer sk_brain_${keyId}_${secret}` } } as Request,
      { brainKeyStore: createDbBrainKeyStore() })
    expect(auth?.actingUserId).toBe(issuer)
    const proof = getAuthenticatedBrainCredentialCurrent(auth!)!
    const context = await makeBrainContextResolver(workspaceId, keyId, null, 'programmatic',
      { kind: 'brain_key', credentialId: keyId, userId: auth!.actingUserId }, proof)()
    if ('error' in context) throw new Error(context.error)
    expect(context.userId).toBe(issuer)
    expect(context.activeGroupId).toBe(department)
    const access = context.executionContext!.security.access
    const params = { workspaceId, title: 'Fictional follow-up', compartments: [`team:${department}`], createdByAssistantId: assistantId }
    const task = await runWithAgentAccess(access, () => createTask(context.userId!, { ...params, access }))
    expect(task.compartments).toContain(`team:${department}`)
    // The pre-fix principal: the owner holds no edge to the department, so the floor refuses the same row.
    await expect(createTask(owner, params)).rejects.toThrow(/row-level security/)

    // CRM parent evidence names the same acting user, and verifies through app-role admission.
    const parent = getAuthenticatedCrmCredentialParent(auth!)!
    expect(parent.userId).toBe(issuer)
    const connection = await getAppPool().connect()
    try {
      await assertCrmCredentialParent(connection, parent, workspaceId, issuer)
      await expect(assertCrmCredentialParent(connection, { ...parent, userId: owner }, workspaceId, owner))
        .rejects.toMatchObject({ code: 'not_authorized' })
      await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [workspaceId, issuer])
      await expect(assertCrmCredentialParent(connection, parent, workspaceId, issuer))
        .rejects.toMatchObject({ code: 'not_authorized' })
    } finally {
      connection.release()
    }
    expect(await proof()).toBe(false)
    expect(await authenticateBrainRequest({ headers: { authorization: `Bearer sk_brain_${keyId}_${secret}` } } as Request,
      { brainKeyStore: createDbBrainKeyStore() })).toBeNull()
  })
})
