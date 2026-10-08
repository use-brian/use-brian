import { randomUUID } from 'node:crypto'
import type { Request } from 'express'
import { authenticateBrainRequest, getAuthenticatedBrainCredentialCurrent } from '../auth.js'
import { createDbOAuthAuthorizationStore } from '../../db/oauth-authorization-store.js'
import { hashSecret } from '../../db/api-key-store.js'
import { afterAll, describe, expect, it } from 'vitest'
import { makeBrainContextResolver } from '../tools.js'
import { getPool, getAppPool } from '../../db/client.js'
import { getEntityById } from '../../db/entities-store.js'

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
})
