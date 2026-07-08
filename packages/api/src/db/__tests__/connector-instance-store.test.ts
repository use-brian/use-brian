/**
 * Unit tests for the connector-instance store (Stage 1 of the
 * team-connector promotion).
 *
 * These tests mock the DB layer and assert on SQL shape + params.
 * Constraint enforcement (`owner_xor`, RLS policies) is verified at the
 * SQL level by migration 083 — the store interface here is tested for
 * parameter threading, encryption handling, and RLS-vs-system call
 * routing.
 *
 * Component tag: [COMP:api/connector-instance-store].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { randomBytes } from 'node:crypto'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
}))

import {
  createConnectorInstanceStore,
  type ConnectorInstance,
} from '../connector-instance-store.js'
import { query, queryWithRLS } from '../client.js'
import { decryptCredentials, encryptCredentials } from '../channel-integrations.js'

const mockQuery = vi.mocked(query)
const mockQueryWithRLS = vi.mocked(queryWithRLS)

const key = randomBytes(32)

beforeEach(() => {
  vi.clearAllMocks()
})

// ── Helpers ────────────────────────────────────────────────────

function fakeRow(overrides: Partial<ConnectorInstance> = {}): ConnectorInstance {
  return {
    id: 'ci_1',
    scope: 'user',
    userId: 'u_1',
    workspaceId: null,
    provider: 'gcal',
    label: 'Primary Google',
    connectedEmail: 'alice@example.com',
    url: null,
    custom: false,
    config: {},
    sensitivity: 'internal',
    connected: true,
    ingestionEnabled: false,
    ingestWorkspaceId: null,
    credentialsType: 'none',
    healthStatus: 'ok',
    lastError: null,
    lastCheckedAt: null,
    createdBy: 'u_1',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  }
}

// ── Tests ──────────────────────────────────────────────────────

describe('[COMP:api/connector-instance-store] createConnectorInstanceStore', () => {
  describe('listForUser', () => {
    it('scopes in SQL to the caller — own user instances + their workspaces', async () => {
      // RLS is defense-in-depth, not the filter: a privileged DB role
      // bypasses RLS, so a WHERE-less read would leak every tenant's
      // connectors. The query must scope explicitly.
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [fakeRow()],
        rowCount: 1,
      } as never)

      const rows = await store.listForUser('u_1')

      expect(rows).toHaveLength(1)
      expect(mockQueryWithRLS).toHaveBeenCalledTimes(1)
      const [calledUserId, sql, params] = mockQueryWithRLS.mock.calls[0] as [
        string,
        string,
        unknown[],
      ]
      expect(calledUserId).toBe('u_1')
      expect(sql).toContain('FROM connector_instance')
      expect(sql).toContain('WHERE')
      expect(sql).toContain("scope = 'user'")
      expect(sql).toContain("scope = 'workspace'")
      expect(sql).toContain('workspace_members')
      expect(params).toEqual(['u_1'])
    })
  })

  describe('listByUser / listByTeam', () => {
    it('listByUser filters to scope=user and owner', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

      await store.listByUser('u_1', 'u_2')

      const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(sql).toContain("scope = 'user'")
      expect(sql).toContain('user_id = $1')
      expect(params).toEqual(['u_2'])
    })

    it('listByTeam filters to scope=team and workspace_id', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

      await store.listByWorkspace('u_1', 'team_42')

      const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(sql).toContain("scope = 'workspace'")
      expect(sql).toContain('workspace_id = $1')
      expect(params).toEqual(['team_42'])
    })
  })

  describe('createUserInstance', () => {
    it('writes scope=user with workspace_id NULL and user_id set', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [fakeRow()],
        rowCount: 1,
      } as never)

      await store.createUserInstance({
        userId: 'u_1',
        provider: 'gcal',
        label: 'Primary Google',
      })

      const [calledUserId, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(calledUserId).toBe('u_1')
      expect(sql).toContain("VALUES ('user', $1, NULL,")
      // No credentials → credentials_type defaults to 'none' (migration 261).
      expect(params[7]).toBe('none')
      // Sensitivity defaults to 'internal' per spec.
      expect(params[9]).toBe('internal')
      // connected defaults to false.
      expect(params[10]).toBe(false)
    })

    it('encrypts credentials when provided', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [fakeRow()],
        rowCount: 1,
      } as never)

      await store.createUserInstance({
        userId: 'u_1',
        provider: 'github',
        label: 'GitHub',
        credentials: { client_id: 'x', client_secret: 'ghp_secret123' },
      })

      const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      const stored = params[6] as Buffer
      expect(Buffer.isBuffer(stored)).toBe(true)
      // Confirm roundtrip: decrypting yields back the same credentials.
      const decoded = decryptCredentials(stored, key)
      expect(decoded).toEqual({ client_id: 'x', client_secret: 'ghp_secret123' })
      // Legacy oauth-shaped blob (no `type`) → credentials_type 'oauth'.
      expect(params[7]).toBe('oauth')
    })

    it('throws when credentials provided but no encryption key configured', async () => {
      const store = createConnectorInstanceStore(null)

      await expect(
        store.createUserInstance({
          userId: 'u_1',
          provider: 'github',
          label: 'GitHub',
          credentials: { client_id: 'x', client_secret: 'y' },
        }),
      ).rejects.toThrow(/CHANNEL_CREDENTIAL_KEY/)
    })

    it('respects explicit sensitivity override', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [fakeRow({ sensitivity: 'confidential' })],
        rowCount: 1,
      } as never)

      await store.createUserInstance({
        userId: 'u_1',
        provider: 'gmail',
        label: 'Gmail',
        sensitivity: 'confidential',
      })

      const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(params[9]).toBe('confidential')
    })

    it('allows the same (user, provider) to be inserted twice (multi-instance)', async () => {
      // No UNIQUE constraint on (user_id, provider) — the store doesn't
      // guard against duplicates. Two INSERTs should both succeed at the
      // store layer; DB-level enforcement is the RLS CHECK only.
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS
        .mockResolvedValueOnce({ rows: [fakeRow({ id: 'ci_a', label: 'Work Google' })], rowCount: 1 } as never)
        .mockResolvedValueOnce({ rows: [fakeRow({ id: 'ci_b', label: 'Personal Google' })], rowCount: 1 } as never)

      const a = await store.createUserInstance({ userId: 'u_1', provider: 'gcal', label: 'Work Google' })
      const b = await store.createUserInstance({ userId: 'u_1', provider: 'gcal', label: 'Personal Google' })

      expect(a.id).not.toBe(b.id)
      expect(mockQueryWithRLS).toHaveBeenCalledTimes(2)
    })
  })

  describe('createWorkspaceInstance', () => {
    it('writes scope=team with user_id NULL and workspace_id set', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [fakeRow({
          scope: 'workspace',
          userId: null,
          workspaceId: 'team_42',
          provider: 'github',
          label: 'Engineering GitHub',
          createdBy: 'u_admin',
        })],
        rowCount: 1,
      } as never)

      await store.createWorkspaceInstance({
        workspaceId: 'team_42',
        provider: 'github',
        label: 'Engineering GitHub',
        createdBy: 'u_admin',
      })

      const [calledUserId, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      // RLS executes as the authorizing admin so ci_team_member evaluates correctly.
      expect(calledUserId).toBe('u_admin')
      expect(sql).toContain("VALUES ('workspace', NULL, $1,")
      // created_by last positional param.
      expect(params[11]).toBe('u_admin')
    })
  })

  describe('update', () => {
    it('builds a dynamic SET list from provided keys', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [fakeRow({ label: 'Renamed', sensitivity: 'confidential' })],
        rowCount: 1,
      } as never)

      await store.update('u_1', 'ci_1', { label: 'Renamed', sensitivity: 'confidential' })

      const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(sql).toContain('label = $1')
      expect(sql).toContain('sensitivity = $2')
      expect(sql).toContain('WHERE id = $3')
      expect(params).toEqual(['Renamed', 'confidential', 'ci_1'])
    })

    it('returns the current row as no-op when no updates provided', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [fakeRow()],
        rowCount: 1,
      } as never)

      const row = await store.update('u_1', 'ci_1', {})

      const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(sql).toContain('SELECT')
      expect(sql).not.toContain('UPDATE')
      expect(row?.id).toBe('ci_1')
    })

    it('encrypts credentials on update when provided', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [fakeRow()],
        rowCount: 1,
      } as never)

      await store.update('u_1', 'ci_1', {
        credentials: { client_id: 'x', client_secret: 'rotated' },
      })

      const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      const stored = params[0] as Buffer
      expect(Buffer.isBuffer(stored)).toBe(true)
      expect(decryptCredentials(stored, key)).toEqual({
        client_id: 'x',
        client_secret: 'rotated',
      })
      // A credentials write always re-derives the discriminator column.
      expect(sql).toContain('credentials_type = $2')
      expect(params[1]).toBe('oauth')
    })

    it('writes a typed credentials_type for a typed blob', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [fakeRow()], rowCount: 1 } as never)

      await store.update('u_1', 'ci_1', { credentials: { type: 'bearer', token: 't' } })

      const [, , params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(params[1]).toBe('bearer')
    })
  })

  describe('getAuthCredentials / getAuthCredentialsSystem', () => {
    it('reads without the connected filter and normalizes a typed blob (RLS-gated)', async () => {
      const store = createConnectorInstanceStore(key)
      const blob = encryptCredentials({ type: 'bearer', token: 't9' } as never, key)
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [{ credentials: blob }], rowCount: 1 } as never)

      const out = await store.getAuthCredentials('u_1', 'ci_1')

      expect(out).toEqual({ type: 'bearer', token: 't9' })
      // The probe must read credentials of a not-yet-connected row.
      const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(sql).not.toContain('connected = true')
    })

    it('system variant stamps a legacy oauth-shaped blob with type oauth', async () => {
      const store = createConnectorInstanceStore(key)
      const blob = encryptCredentials({ client_id: 'a', client_secret: 'b' } as never, key)
      mockQuery.mockResolvedValueOnce({ rows: [{ credentials: blob }], rowCount: 1 } as never)

      expect(await store.getAuthCredentialsSystem('ci_1')).toEqual({
        type: 'oauth',
        client_id: 'a',
        client_secret: 'b',
      })
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).not.toContain('connected = true')
    })

    it('returns null when the row has no credentials', async () => {
      const store = createConnectorInstanceStore(key)
      mockQuery.mockResolvedValueOnce({ rows: [{ credentials: null }], rowCount: 1 } as never)
      expect(await store.getAuthCredentialsSystem('ci_1')).toBeNull()
    })
  })

  describe('setConfig', () => {
    it('merges keys via jsonb concat', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

      await store.setConfig('u_1', 'ci_1', { connectedEmail: 'new@example.com' })

      const [, sql, params] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(sql).toContain("|| $2::jsonb")
      expect(params[1]).toBe(JSON.stringify({ connectedEmail: 'new@example.com' }))
    })
  })

  describe('getCredentials / getCredentialsSystem', () => {
    it('getCredentials goes through RLS and decrypts', async () => {
      const store = createConnectorInstanceStore(key)
      const { encryptCredentials } = await import('../channel-integrations.js')
      const encrypted = encryptCredentials(
        { client_id: 'x', client_secret: 'secret' } as unknown as import('../channel-integrations.js').ChannelCredentials,
        key,
      )
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [{ credentials: encrypted }],
        rowCount: 1,
      } as never)

      const creds = await store.getCredentials('u_1', 'ci_1')

      expect(creds).toEqual({ client_id: 'x', client_secret: 'secret' })
      const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(sql).toContain('connected = true')
    })

    it('getCredentialsSystem bypasses RLS via query()', async () => {
      const store = createConnectorInstanceStore(key)
      const { encryptCredentials } = await import('../channel-integrations.js')
      const encrypted = encryptCredentials(
        { client_id: 'x', client_secret: 'secret' } as unknown as import('../channel-integrations.js').ChannelCredentials,
        key,
      )
      mockQuery.mockResolvedValueOnce({
        rows: [{ credentials: encrypted }],
        rowCount: 1,
      } as never)

      const creds = await store.getCredentialsSystem('ci_1')

      expect(creds).toEqual({ client_id: 'x', client_secret: 'secret' })
      expect(mockQuery).toHaveBeenCalledTimes(1)
      expect(mockQueryWithRLS).not.toHaveBeenCalled()
    })

    it('returns null when the row has no credentials stored', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [{ credentials: null }],
        rowCount: 1,
      } as never)

      const creds = await store.getCredentials('u_1', 'ci_1')
      expect(creds).toBeNull()
    })

    it('returns null when no encryption key is configured', async () => {
      const store = createConnectorInstanceStore(null)
      mockQueryWithRLS.mockResolvedValueOnce({
        rows: [{ credentials: Buffer.from('fake-but-unreadable-without-key') }],
        rowCount: 1,
      } as never)

      const creds = await store.getCredentials('u_1', 'ci_1')
      expect(creds).toBeNull()
    })
  })

  describe('updateCredentialsSystem', () => {
    it('encrypts and persists the rotated tuple via query() — no RLS', async () => {
      const store = createConnectorInstanceStore(key)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

      await store.updateCredentialsSystem('ci_1', {
        client_id: 'fathom_oauth',
        client_secret: 'rotated-tuple',
      })

      expect(mockQuery).toHaveBeenCalledTimes(1)
      expect(mockQueryWithRLS).not.toHaveBeenCalled()
      const [, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      const stored = params[1] as Buffer
      expect(Buffer.isBuffer(stored)).toBe(true)
      expect(decryptCredentials(stored, key)).toEqual({
        client_id: 'fathom_oauth',
        client_secret: 'rotated-tuple',
      })
    })

    it('throws when no encryption key is configured', async () => {
      const store = createConnectorInstanceStore(null)
      await expect(
        store.updateCredentialsSystem('ci_1', {
          client_id: 'fathom_oauth',
          client_secret: 'rotated-tuple',
        }),
      ).rejects.toThrow(/CHANNEL_CREDENTIAL_KEY/)
    })
  })

  describe('findByWorkspaceProviderSystem', () => {
    it('used by workers (KB sync) — returns first team instance for provider', async () => {
      const store = createConnectorInstanceStore(key)
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow({
          scope: 'workspace',
          userId: null,
          workspaceId: 'team_42',
          provider: 'github',
          label: 'Engineering GitHub',
        })],
        rowCount: 1,
      } as never)

      const inst = await store.findByWorkspaceProviderSystem('team_42', 'github')

      expect(inst?.provider).toBe('github')
      expect(inst?.scope).toBe('workspace')
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain("scope = 'workspace'")
      expect(sql).toContain('workspace_id = $1')
      expect(sql).toContain('provider = $2')
      expect(sql).toContain('LIMIT 1')
      expect(params).toEqual(['team_42', 'github'])
    })

    it('returns null when team has no instance for that provider', async () => {
      const store = createConnectorInstanceStore(key)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      const inst = await store.findByWorkspaceProviderSystem('team_42', 'github')
      expect(inst).toBeNull()
    })
  })

  describe('findByUserProviderSystem', () => {
    it('returns all of a user\'s instances for a provider (multi-instance)', async () => {
      const store = createConnectorInstanceStore(key)
      mockQuery.mockResolvedValueOnce({
        rows: [
          fakeRow({ id: 'ci_a', label: 'Work Google' }),
          fakeRow({ id: 'ci_b', label: 'Personal Google' }),
        ],
        rowCount: 2,
      } as never)

      const rows = await store.findByUserProviderSystem('u_1', 'gcal')
      expect(rows).toHaveLength(2)
      expect(rows.map(r => r.label)).toEqual(['Work Google', 'Personal Google'])
    })
  })

  describe('listByWorkspaceSystem', () => {
    it('returns every team-native instance — used by the connector resolver', async () => {
      const store = createConnectorInstanceStore(key)
      mockQuery.mockResolvedValueOnce({
        rows: [
          fakeRow({ scope: 'workspace', userId: null, workspaceId: 't_1', provider: 'github', label: 'Engineering GitHub' }),
          fakeRow({ scope: 'workspace', userId: null, workspaceId: 't_1', provider: 'notion', label: 'Engineering Notion' }),
        ],
        rowCount: 2,
      } as never)

      const rows = await store.listByWorkspaceSystem('t_1')
      expect(rows).toHaveLength(2)
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain("scope = 'workspace'")
      expect(sql).toContain('workspace_id = $1')
    })
  })

  describe('listByUserSystem', () => {
    it('returns every user-scoped instance', async () => {
      const store = createConnectorInstanceStore(key)
      mockQuery.mockResolvedValueOnce({
        rows: [fakeRow()],
        rowCount: 1,
      } as never)

      await store.listByUserSystem('u_1')

      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain("scope = 'user'")
      expect(sql).toContain('user_id = $1')
      expect(params).toEqual(['u_1'])
    })
  })

  describe('delete', () => {
    it('deletes through RLS and returns true when a row was removed', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

      const ok = await store.delete('u_1', 'ci_1')
      expect(ok).toBe(true)
    })

    it('returns false when no row was removed', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)

      const ok = await store.delete('u_1', 'ci_1')
      expect(ok).toBe(false)
    })
  })

  describe('[COMP:integrations/connector-health] markHealth', () => {
    it('writes health only on a transition and returns whether it changed', async () => {
      const store = createConnectorInstanceStore(key)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

      const changed = await store.markHealth('ci_1', 'auth_failed', '401 Bad credentials')
      expect(changed).toBe(true)
      const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain('UPDATE connector_instance')
      expect(sql).toContain('health_status = $2')
      expect(sql).toContain('IS DISTINCT FROM')
      expect(params).toEqual(['ci_1', 'auth_failed', '401 Bad credentials'])
    })

    it('returns false when no row transitioned (idempotent success path)', async () => {
      const store = createConnectorInstanceStore(key)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
      expect(await store.markHealth('ci_1', 'ok')).toBe(false)
    })
  })

  describe('[COMP:integrations/connector-health] reconnect resets health', () => {
    it('update() with fresh credentials also clears auth_failed', async () => {
      const store = createConnectorInstanceStore(key)
      mockQueryWithRLS.mockResolvedValueOnce({ rows: [fakeRow()], rowCount: 1 } as never)

      await store.update('u_1', 'ci_1', {
        credentials: { type: 'oauth', client_id: '', client_secret: 'pat' },
      })
      const [, sql] = mockQueryWithRLS.mock.calls[0] as [string, string, unknown[]]
      expect(sql).toContain("health_status = 'ok'")
      expect(sql).toContain('last_error = NULL')
    })

    it('updateCredentialsSystem() clears auth_failed', async () => {
      const store = createConnectorInstanceStore(key)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)

      await store.updateCredentialsSystem('ci_1', { type: 'oauth', client_id: '', client_secret: 'pat' })
      const [sql] = mockQuery.mock.calls[0] as [string, unknown[]]
      expect(sql).toContain("health_status = 'ok'")
      expect(sql).toContain('last_error = NULL')
    })
  })
})
