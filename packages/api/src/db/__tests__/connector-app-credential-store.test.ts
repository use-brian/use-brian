/**
 * Unit tests for the workspace-owned OAuth app-credential store
 * (migration 394). The DB layer is mocked, so these assert SQL shape,
 * parameter threading, encryption handling, and the RLS-vs-system routing.
 *
 * Component tag: [COMP:api/connector-app-credential-store].
 * Spec: docs/architecture/integrations/msgraph.md → "Auth".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import {
  ConnectorAppCredentialAuthError,
  createConnectorAppCredentialStore,
} from '../connector-app-credential-store.js'
import { query, queryWithRLS } from '../client.js'
import { decryptCredentials, encryptCredentials } from '../credential-crypto.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)

const key = randomBytes(32)
const WS = '22222222-2222-2222-2222-222222222222'

function row(over: Record<string, unknown> = {}) {
  return {
    workspace_id: WS,
    provider: 'msgraph',
    client_id: 'entra-client-id',
    tenant_id: null,
    updated_at: new Date(0),
    ...over,
  }
}

/** `role` drives the owner/admin authority gate; null means "not a member". */
function mockRole(role: string | null) {
  mockQuery.mockResolvedValueOnce({ rows: role ? [{ role }] : [] } as never)
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('[COMP:api/connector-app-credential-store] reads', () => {
  it('reads the summary through RLS and never returns the secret', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [row({ tenant_id: 'tid-1' })] } as never)
    const store = createConnectorAppCredentialStore(key)

    const summary = await store.get('u1', WS, 'msgraph')

    expect(summary).toEqual({
      provider: 'msgraph',
      workspaceId: WS,
      clientId: 'entra-client-id',
      tenantId: 'tid-1',
      hasSecret: true,
      updatedAt: new Date(0),
    })
    // No secret anywhere in the DTO — the panel re-collects it to change it.
    expect(JSON.stringify(summary)).not.toContain('secret-value')
    // RLS-gated, with the acting user threaded through.
    const [actingUserId, sql, params] = mockQueryWithRLS.mock.calls[0]!
    expect(actingUserId).toBe('u1')
    expect(sql).not.toContain('client_secret_ciphertext')
    expect(params).toEqual([WS, 'msgraph'])
  })

  it('returns null when the workspace has no registration', async () => {
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [] } as never)
    const store = createConnectorAppCredentialStore(key)
    expect(await store.get('u1', WS, 'msgraph')).toBeNull()
  })

  /**
   * `getSystem` is the ONLY decrypting accessor, and it runs on the owner pool
   * because the exchange must work on paths where the acting user did not
   * author the row. The caller proves workspace access before calling in.
   */
  it('decrypts the pair for the exchange, on the system pool', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [row({
        tenant_id: 'tid-1',
        client_secret_ciphertext: encryptCredentials({ clientSecret: 'secret-value' }, key),
      })],
    } as never)
    const store = createConnectorAppCredentialStore(key)

    expect(await store.getSystem(WS, 'msgraph')).toEqual({
      clientId: 'entra-client-id',
      clientSecret: 'secret-value',
      tenantId: 'tid-1',
    })
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })

  it('refuses to read a secret with no encryption key rather than returning a broken pair', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [row({ client_secret_ciphertext: encryptCredentials({ clientSecret: 's' }, key) })],
    } as never)
    const store = createConnectorAppCredentialStore(null)
    await expect(store.getSystem(WS, 'msgraph')).rejects.toThrow(/CHANNEL_CREDENTIAL_KEY/)
  })
})

describe('[COMP:api/connector-app-credential-store] writes', () => {
  it('encrypts the secret and upserts on (workspace, provider)', async () => {
    mockRole('admin')
    mockQueryWithRLS.mockResolvedValueOnce({ rows: [row()] } as never)
    const store = createConnectorAppCredentialStore(key)

    await store.set({
      actingUserId: 'u1',
      workspaceId: WS,
      provider: 'msgraph',
      clientId: 'entra-client-id',
      clientSecret: 'secret-value',
      tenantId: null,
    })

    const [actingUserId, sql, params] = mockQueryWithRLS.mock.calls[0]!
    expect(actingUserId).toBe('u1')
    expect(sql).toContain('ON CONFLICT (workspace_id, provider) DO UPDATE')
    const ciphertext = (params as unknown[])[3] as Buffer
    expect(Buffer.isBuffer(ciphertext)).toBe(true)
    // The plaintext must not be recoverable from the stored bytes.
    expect(ciphertext.toString('utf8')).not.toContain('secret-value')
    expect(decryptCredentials<{ clientSecret: string }>(ciphertext, key)).toEqual({
      clientSecret: 'secret-value',
    })
  })

  /**
   * The authority boundary, separate from the tenancy boundary RLS enforces:
   * an ordinary member of your own workspace may SEE that an app is
   * configured, but repointing it silently re-aims every future consent in the
   * workspace, so only owner/admin may write.
   */
  it('rejects a non-admin member before touching the table', async () => {
    mockRole('member')
    const store = createConnectorAppCredentialStore(key)

    await expect(store.set({
      actingUserId: 'u2', workspaceId: WS, provider: 'msgraph',
      clientId: 'x', clientSecret: 'y',
    })).rejects.toBeInstanceOf(ConnectorAppCredentialAuthError)

    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })

  it('rejects a non-member distinctly from a non-admin', async () => {
    mockRole(null)
    const store = createConnectorAppCredentialStore(key)
    await expect(store.set({
      actingUserId: 'stranger', workspaceId: WS, provider: 'msgraph',
      clientId: 'x', clientSecret: 'y',
    })).rejects.toMatchObject({ reason: 'not_member' })
  })

  it('refuses to store a plaintext secret when no encryption key is configured', async () => {
    mockRole('owner')
    const store = createConnectorAppCredentialStore(null)
    await expect(store.set({
      actingUserId: 'u1', workspaceId: WS, provider: 'msgraph',
      clientId: 'x', clientSecret: 'y',
    })).rejects.toThrow(/CHANNEL_CREDENTIAL_KEY/)
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })

  it('removes the registration for an admin and reports whether a row went', async () => {
    mockRole('owner')
    mockQueryWithRLS.mockResolvedValueOnce({ rowCount: 1, rows: [] } as never)
    const store = createConnectorAppCredentialStore(key)
    expect(await store.remove('u1', WS, 'msgraph')).toBe(true)

    mockRole('owner')
    mockQueryWithRLS.mockResolvedValueOnce({ rowCount: 0, rows: [] } as never)
    expect(await store.remove('u1', WS, 'msgraph')).toBe(false)
  })

  it('rejects a non-admin remove', async () => {
    mockRole('member')
    const store = createConnectorAppCredentialStore(key)
    await expect(store.remove('u2', WS, 'msgraph')).rejects.toMatchObject({ reason: 'not_admin' })
    expect(mockQueryWithRLS).not.toHaveBeenCalled()
  })
})
