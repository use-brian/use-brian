import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterAll, describe, expect, it } from 'vitest'
import { createCrmIntegrationStore } from '../crm-integration-store.js'

const fixtureScript = new URL('../../../../../scripts/crm/local-fixture.mjs', import.meta.url).href
const { assertLocalFixture } = await import(fixtureScript)
await assertLocalFixture()
const owner = new pg.Pool({ connectionString: process.env.DATABASE_URL })
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL_APP })
const store = createCrmIntegrationStore(owner, app)

async function workspace() {
  const workspaceId = randomUUID()
  const userId = randomUUID()
  const memberId = randomUUID()
  await owner.query(`INSERT INTO users (id,auth_provider_id) VALUES ($1::uuid,$1::text),($2::uuid,$2::text)`, [userId, memberId])
  await owner.query(`INSERT INTO workspaces (id,name,owner_user_id) VALUES ($1,'Integration fixture',$2)`, [workspaceId, userId])
  await owner.query(`INSERT INTO workspace_members (workspace_id,user_id,role) VALUES ($1,$2,'owner'),($1,$3,'member')`, [workspaceId, userId, memberId])
  return { workspaceId, userId, memberId }
}
const input = { label: 'Fixture key', expiresAt: '2099-01-01T00:00:00Z',
  grants: [{ operation: 'crm.records.read' as const, selectors: {} }] }

describe('[COMP:api/crm-integration-auth] Real credential lifecycle', () => {
  afterAll(async () => { await Promise.all([owner.end(), app.end()]) })
  it('shows a secret once, authenticates its ceiling, and immediately revokes it', async () => {
    const f = await workspace()
    const created = await store.create(f.workspaceId, f.userId, input)
    expect(created.oneTimeSecret).toMatch(/^sk_crm_/)
    expect(created).not.toHaveProperty('secretHash')
    expect(await store.authenticate(created.oneTimeSecret)).toEqual({ workspaceId: f.workspaceId, credentialId: created.id, grants: input.grants,
      departmentRead: { workspaceId: f.workspaceId, userId: f.userId, assistantId: null, base: 'internal', departments: {}, contextDepartment: null, binding: [], cap: 'internal' } })
    const rows = await store.listForMember(f.workspaceId, f.userId)
    expect(rows.credentials).toHaveLength(1)
    expect(rows.credentials[0]).not.toHaveProperty('oneTimeSecret')
    expect(rows.credentials[0]).not.toHaveProperty('secretHash')
    const persisted = (await owner.query('SELECT secret_hash FROM crm_integration_credentials WHERE id=$1', [created.id])).rows[0]
    expect(persisted.secret_hash).toMatch(/^scrypt\$/)
    expect(persisted.secret_hash).not.toContain(created.oneTimeSecret)
    expect(await store.revoke(f.workspaceId, f.userId, created.id)).toBe(true)
    expect(await store.revoke(f.workspaceId, f.userId, created.id)).toBe(false)
    expect(await store.authenticate(created.oneTimeSecret)).toBeNull()
    expect((await owner.query(`SELECT 1 FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='crm.integration_credential_revoked'`, [f.workspaceId])).rowCount).toBe(1)
  })

  it('serializes issuance retries and preserves one-time secret and rotation effects', async () => {
    const f = await workspace(), requestId = randomUUID()
    const old = await store.create(f.workspaceId, f.userId, input)
    const request = { ...input, requestId, revokeCredentialId: old.id }
    const results = await Promise.allSettled([store.create(f.workspaceId, f.userId, request), store.create(f.workspaceId, f.userId, request)])
    const accepted = results.find(row => row.status === 'fulfilled')!
    expect(accepted.status).toBe('fulfilled')
    if (accepted.status !== 'fulfilled') throw new Error('Expected one issuance')
    expect(results.filter(row => row.status === 'fulfilled')).toHaveLength(1)
    const rejected = results.find(row => row.status === 'rejected')!
    if (rejected.status !== 'rejected') throw new Error('Expected replay conflict')
    expect(rejected.reason).toMatchObject({ code: 'conflict', details: { reason: 'credential_already_issued', credentialId: accepted.value.id } })
    expect(JSON.stringify(rejected.reason)).not.toContain(accepted.value.oneTimeSecret)
    await expect(store.create(f.workspaceId, f.userId, { ...request, label: 'Changed request' })).rejects.toMatchObject({ code: 'conflict', details: {} })
    await owner.query("UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [f.workspaceId, f.memberId])
    await expect(store.create(f.workspaceId, f.memberId, request)).rejects.toMatchObject({ code: 'conflict', details: {} })
    expect((await store.listForMember(f.workspaceId, f.userId)).credentials).toHaveLength(2)
    expect(await store.authenticate(old.oneTimeSecret)).toBeNull()
    expect((await owner.query("SELECT id FROM workspace_audit_log WHERE workspace_id=$1 AND event_type='crm.integration_credential_created'", [f.workspaceId])).rowCount).toBe(2)
    await expect(owner.query('UPDATE crm_integration_credentials SET request_id=NULL,request_fingerprint=NULL WHERE id=$1', [accepted.value.id])).rejects.toThrow(/immutable/)
    await store.revoke(f.workspaceId, f.userId, accepted.value.id)
    await expect(store.create(f.workspaceId, f.userId, request)).rejects.toMatchObject({ details: { credentialId: accepted.value.id } })
    expect((await store.listForMember(f.workspaceId, f.userId)).credentials).toHaveLength(2)
  })

  it('requires owner/admin lifecycle and confines selected resources to the key workspace', async () => {
    const f = await workspace()
    const other = await workspace()
    await expect(store.create(f.workspaceId, f.memberId, input)).rejects.toMatchObject({ code: 'not_authorized' })
    await expect(store.listForMember(f.workspaceId, other.userId)).rejects.toMatchObject({ code: 'not_authorized' })
    const planId = randomUUID()
    await owner.query(`INSERT INTO association_membership_plans (id,workspace_id,plan_key,name,currency,fee_minor,billing_period)
      VALUES ($1,$2,'annual','Annual','USD',0,'annual')`, [planId, other.workspaceId])
    await expect(store.create(f.workspaceId, f.userId, { ...input, grants: [
      { operation: 'crm.entitlements.read', selectors: { planIds: [planId] } },
    ] })).rejects.toMatchObject({ code: 'invalid_input' })
    await owner.query(`UPDATE workspace_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2`, [f.workspaceId, f.memberId])
    expect((await store.create(f.workspaceId, f.memberId, input)).workspaceId).toBe(f.workspaceId)
  })

  it('rotates atomically and does not revoke the old key on a failed replacement', async () => {
    const f = await workspace()
    const first = await store.create(f.workspaceId, f.userId, input)
    await expect(store.create(f.workspaceId, f.userId, { ...input, revokeCredentialId: randomUUID() })).rejects.toMatchObject({ code: 'not_found' })
    expect(await store.authenticate(first.oneTimeSecret)).not.toBeNull()
    expect((await store.listForMember(f.workspaceId, f.userId)).credentials).toHaveLength(1)
    const next = await store.create(f.workspaceId, f.userId, { ...input, revokeCredentialId: first.id })
    expect(await store.authenticate(first.oneTimeSecret)).toBeNull()
    expect(await store.authenticate(next.oneTimeSecret)).not.toBeNull()
  })

  it('rejects wrong secrets, expired credentials and unknown persisted selectors', async () => {
    const f = await workspace()
    await expect(store.create(f.workspaceId, f.userId, { ...input, expiresAt: '2000-01-01T00:00:00Z' })).rejects.toMatchObject({ code: 'invalid_input' })
    const created = await store.create(f.workspaceId, f.userId, input)
    expect(await store.authenticate(created.oneTimeSecret.slice(0, -1) + '!')).toBeNull()
    const validWrong = created.oneTimeSecret.slice(0, -1) + (created.oneTimeSecret.endsWith('A') ? 'B' : 'A')
    expect(await store.authenticate(validWrong)).toBeNull()
    await owner.query(`UPDATE crm_integration_credentials SET created_at=now()-interval '2 days',expires_at=now()-interval '1 day' WHERE id=$1`, [created.id])
    expect(await store.authenticate(created.oneTimeSecret)).toBeNull()
    const invalid = await store.create(f.workspaceId, f.userId, input)
    // A malformed grant from a restore/manual DB edit must fail closed at auth.
    await owner.query(`DELETE FROM crm_integration_credential_grants WHERE credential_id=$1`, [invalid.id])
    await owner.query(`INSERT INTO crm_integration_credential_grants (workspace_id,credential_id,operation,selectors)
      VALUES ($1,$2,'crm.catalog.read','{"unexpected":"all"}')`, [f.workspaceId, invalid.id])
    expect(await store.authenticate(invalid.oneTimeSecret)).toBeNull()
  })

  it('uses actual app-role RLS and immutable operation grants', async () => {
    const f = await workspace()
    const other = await workspace()
    const created = await store.create(f.workspaceId, f.userId, input)
    await store.create(other.workspaceId, other.userId, input)
    const client = await app.connect()
    try {
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_user_id',$1,true)`, [f.memberId])
      expect((await client.query('SELECT id FROM crm_integration_credentials')).rows).toEqual([])
      expect((await client.query('SELECT credential_id FROM crm_integration_credential_grants')).rows).toEqual([])
      await client.query('ROLLBACK')
      await client.query('BEGIN')
      await client.query(`SELECT set_config('app.current_user_id',$1,true)`, [f.userId])
      expect((await client.query('SELECT id FROM crm_integration_credentials')).rows).toEqual([{ id: created.id }])
      await expect(client.query(`UPDATE crm_integration_credential_grants SET operation='crm.records.write' WHERE credential_id=$1`, [created.id])).rejects.toThrow(/immutable/)
    } finally { await client.query('ROLLBACK'); client.release() }
  })
})
