import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SandboxTaskRecord, SessionBundle } from '@use-brian/core'

vi.mock('../client.js', () => ({ query: vi.fn() }))

import { query } from '../client.js'
import { createBrowserCredentialStore } from '../browser-credential-store.js'
import { createBrowserProfileStore } from '../browser-profile-store.js'
import { createBrowserSessionVault } from '../browser-session-vault.js'
import { createBrowserSkillGrantStore } from '../browser-skill-grant-store.js'
import { createSandboxTaskStore } from '../sandbox-task-store.js'

const mockQuery = vi.mocked(query)
const NOW = new Date('2026-08-10T00:00:00.000Z')
const LATER = new Date('2026-08-10T01:00:00.000Z')
const KEY = Buffer.alloc(32, 4)

function rows<T>(values: T[]) {
  return { rows: values, rowCount: values.length } as never
}

beforeEach(() => {
  vi.clearAllMocks()
  mockQuery.mockResolvedValue(rows([]))
})

describe('[COMP:sandbox/profiles] DB browser profile store', () => {
  const row = {
    id: 'profile-1',
    workspace_id: 'ws-1',
    owner_user_id: 'user-1',
    name: 'Work',
    scope: 'workspace' as const,
    clearance: 'internal' as const,
    enabled_assistant_ids: ['assistant-1'],
    assistant_routing_notes: { 'assistant-1': 'Use the company account.' },
    default_backend: 'local' as const,
    local_control_mode: 'full_browser' as const,
    proxy_url: 'http://proxy.example',
    created_at: NOW,
    updated_at: LATER,
  }

  it('maps all current profile fields', async () => {
    mockQuery.mockResolvedValueOnce(rows([row]))
    const profile = await createBrowserProfileStore().get('profile-1')

    expect(profile).toEqual({
      id: 'profile-1',
      workspaceId: 'ws-1',
      ownerUserId: 'user-1',
      name: 'Work',
      scope: 'workspace',
      clearance: 'internal',
      enabledAssistantIds: ['assistant-1'],
      assistantRoutingNotes: { 'assistant-1': 'Use the company account.' },
      defaultBackend: 'local',
      localControlMode: 'full_browser',
      proxyUrl: 'http://proxy.example',
      createdAt: NOW.toISOString(),
      updatedAt: LATER.toISOString(),
    })
  })

  it('writes every profile field on create and update', async () => {
    mockQuery.mockResolvedValueOnce(rows([row])).mockResolvedValueOnce(rows([row]))
    const store = createBrowserProfileStore()
    await store.create({
      workspaceId: 'ws-1',
      ownerUserId: 'user-1',
      name: 'Work',
      scope: 'workspace',
      clearance: 'internal',
      enabledAssistantIds: ['assistant-1'],
      assistantRoutingNotes: { 'assistant-1': 'Use the company account.' },
      defaultBackend: 'local',
      localControlMode: 'full_browser',
      proxyUrl: 'http://proxy.example',
    })

    const [createSql, createParams] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(createSql).toMatch(/scope,[\s\S]*clearance,[\s\S]*enabled_assistant_ids,[\s\S]*assistant_routing_notes,[\s\S]*local_control_mode/)
    // Column count must match placeholder count: the closed sibling store
    // shipped 10 columns against 9 placeholders, silently dropping proxy_url.
    const columnCount = createSql.match(/\(([^)]*)\)\s*VALUES/)![1].split(',').length
    const placeholderCount = createSql.match(/VALUES \(([^)]*)\)/)![1].split(',').length
    expect(placeholderCount).toBe(columnCount)
    expect(createParams).toEqual([
      'ws-1',
      'user-1',
      'Work',
      'workspace',
      'internal',
      ['assistant-1'],
      { 'assistant-1': 'Use the company account.' },
      'local',
      'full_browser',
      'http://proxy.example',
    ])

    await store.update('profile-1', {
      name: 'Renamed',
      scope: 'owner',
      clearance: 'public',
      enabledAssistantIds: [],
      assistantRoutingNotes: {},
      defaultBackend: 'cloud',
      localControlMode: 'task_tabs',
      proxyUrl: null,
    })
    const [updateSql, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]]
    for (const column of [
      'name',
      'scope',
      'clearance',
      'default_backend',
      'local_control_mode',
      'proxy_url',
      'enabled_assistant_ids',
      'assistant_routing_notes',
      'updated_at',
    ]) {
      expect(updateSql).toContain(column)
    }
    expect(updateParams).toEqual([
      'profile-1',
      'Renamed',
      'owner',
      'public',
      'cloud',
      'task_tabs',
      null,
      [],
      {},
    ])
  })
})

describe('[COMP:sandbox/session-vault] DB browser session vault', () => {
  const bundle: SessionBundle = {
    site: 'example.com',
    cookies: [{ name: 'sid', value: 'cookie-secret', domain: 'example.com' }],
    capturedAt: NOW.toISOString(),
  }

  it('requires an exact AES-256 key and round-trips encrypted bundles', async () => {
    expect(() => createBrowserSessionVault({ encryptionKey: Buffer.alloc(31) })).toThrow(/32 bytes/)
    const vault = createBrowserSessionVault({ encryptionKey: KEY })
    await vault.put({ profileId: 'profile-1', site: 'example.com', bundle })

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('FROM browser_profiles bp WHERE bp.id = $1')
    expect(sql).toContain('ON CONFLICT (profile_id, site)')
    const blob = params[2] as Buffer
    expect(blob.toString('latin1')).not.toContain('cookie-secret')

    mockQuery.mockResolvedValueOnce(rows([{ encrypted_bundle: blob }]))
    await expect(vault.get({ profileId: 'profile-1', site: 'example.com' })).resolves.toEqual(bundle)
  })

  it('lists metadata without selecting encrypted bundles', async () => {
    mockQuery.mockResolvedValueOnce(rows([{
      site: 'example.com',
      captured_at: NOW,
      last_used_at: LATER,
      status: 'dead',
    }]))
    const sessions = await createBrowserSessionVault({ encryptionKey: KEY }).list({ profileId: 'profile-1' })
    const [sql] = mockQuery.mock.calls[0] as [string]
    expect(sql).not.toContain('encrypted_bundle')
    expect(sessions).toEqual([{
      site: 'example.com',
      capturedAt: NOW.toISOString(),
      lastUsedAt: LATER.toISOString(),
      status: 'dead',
    }])
  })
})

describe('[COMP:sandbox/lifecycle] DB sandbox task store', () => {
  const task: SandboxTaskRecord = {
    taskId: 'task-1',
    sandboxId: 'sandbox-1',
    userId: 'user-1',
    workspaceId: 'ws-1',
    sessionId: 'session-1',
    status: 'running',
    profileId: 'profile-1',
    injectedSite: 'example.com',
    browserStartedAt: NOW.getTime(),
    authorizedBudgetUsd: 2.5,
    createdAt: NOW.getTime(),
    lastActivityAt: LATER.getTime(),
  }

  it('maps browser activity and filters workspace discovery to browser tasks', async () => {
    mockQuery.mockResolvedValueOnce(rows([{
      task_id: task.taskId,
      sandbox_id: task.sandboxId,
      user_id: task.userId,
      workspace_id: task.workspaceId,
      session_id: task.sessionId,
      status: task.status,
      profile_id: task.profileId,
      injected_site: task.injectedSite,
      browser_started_at: NOW,
      authorized_budget_usd: '2.5000',
      created_at: NOW,
      last_activity_at: LATER,
    }]))
    const result = await createSandboxTaskStore().listActiveByWorkspace('ws-1')
    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('browser_started_at IS NOT NULL')
    expect(params).toEqual(['ws-1'])
    expect(result).toEqual([task])
  })

  it('writes all task fields and updates browser_started_at as a timestamp', async () => {
    const store = createSandboxTaskStore()
    await store.create(task)
    const [createSql, createParams] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(createSql).toMatch(/profile_id, injected_site, browser_started_at, authorized_budget_usd/)
    expect(createParams).toEqual([
      task.taskId,
      task.sandboxId,
      task.userId,
      task.workspaceId,
      task.sessionId,
      task.status,
      task.profileId,
      task.injectedSite,
      task.browserStartedAt,
      task.authorizedBudgetUsd,
      task.createdAt,
      task.lastActivityAt,
    ])

    await store.update('task-1', { browserStartedAt: LATER.getTime(), status: 'paused' })
    const [updateSql, updateParams] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(updateSql).toContain('browser_started_at = to_timestamp($3::double precision / 1000.0)')
    expect(updateParams).toEqual(['task-1', 'paused', LATER.getTime()])
  })
})

describe('[COMP:sandbox/approval-grants] DB browser skill grant store', () => {
  it('maps numeric and timestamp fields and writes the complete grant', async () => {
    const row = {
      id: 'grant-1',
      workspace_id: 'ws-1',
      skill_id: 'skill-1',
      profile_id: 'profile-1',
      granted_by: 'user-1',
      budget_usd: '4.25',
      rate_per_hour: 3,
      spent_usd: '1.50',
      window_started_at: null,
      window_use_count: 0,
      expires_at: LATER,
      status: 'active' as const,
      created_at: NOW,
      last_used_at: null,
    }
    mockQuery.mockResolvedValueOnce(rows([])).mockResolvedValueOnce(rows([row]))
    const grant = await createBrowserSkillGrantStore().create({
      workspaceId: 'ws-1',
      skillId: 'skill-1',
      profileId: 'profile-1',
      grantedBy: 'user-1',
      budgetUsd: 4.25,
      ratePerHour: 3,
      expiresAt: LATER.toISOString(),
    })

    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(sql).toContain('(workspace_id, skill_id, profile_id, granted_by, budget_usd, rate_per_hour, expires_at)')
    expect(params).toEqual(['ws-1', 'skill-1', 'profile-1', 'user-1', 4.25, 3, LATER.toISOString()])
    expect(grant).toMatchObject({ budgetUsd: 4.25, spentUsd: 1.5, expiresAt: LATER.toISOString() })
  })
})

describe('[COMP:sandbox/browser-credentials] DB browser credential store', () => {
  const secret = { username: 'member@example.com', password: 'plain-password-must-not-leak' }
  const row = {
    id: 'cred-1',
    workspace_id: 'ws-1',
    profile_id: 'profile-1',
    site: 'example.com',
    login_url: 'https://accounts.example.com/login',
    account_label: 'Primary',
    status: 'active' as const,
    last_used_at: null,
    last_failure_code: null,
    created_at: NOW,
    updated_at: NOW,
  }

  it('requires an exact key and upserts one encrypted credential per profile/site', async () => {
    expect(() => createBrowserCredentialStore({ encryptionKey: Buffer.alloc(33) })).toThrow(
      /BROWSER_CREDENTIAL_ENCRYPTION_KEY.*32 bytes/,
    )
    mockQuery.mockResolvedValueOnce(rows([row]))
    const metadata = await createBrowserCredentialStore({ encryptionKey: KEY }).upsert({
      workspaceId: 'ws-1',
      profileId: 'profile-1',
      ownerUserId: 'user-1',
      site: 'example.com',
      loginUrl: row.login_url,
      accountLabel: '  Primary  ',
      secret,
    })

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('(workspace_id, profile_id, owner_user_id, site, login_url, account_label, encrypted_secret)')
    expect(sql).toContain('bp.id = $2')
    expect(sql).toContain('bp.workspace_id = $1')
    expect(sql).toContain('bp.owner_user_id = $3')
    expect(sql).toContain('ON CONFLICT (profile_id, site)')
    expect(params.slice(0, 6)).toEqual([
      'ws-1',
      'profile-1',
      'user-1',
      'example.com',
      row.login_url,
      'Primary',
    ])
    const ciphertext = params[6] as Buffer
    expect(ciphertext.toString('latin1')).not.toContain(secret.username)
    expect(ciphertext.toString('latin1')).not.toContain(secret.password)
    expect(metadata).not.toHaveProperty('secret')
    expect(JSON.stringify(metadata)).not.toContain(secret.username)
    expect(JSON.stringify(metadata)).not.toContain(secret.password)
  })

  it('keeps admin list metadata-only', async () => {
    mockQuery.mockResolvedValueOnce(rows([row]))
    const metadata = await createBrowserCredentialStore({ encryptionKey: KEY }).list({ profileId: 'profile-1' })
    const [sql] = mockQuery.mock.calls[0] as [string]
    expect(sql).not.toContain('encrypted_secret')
    expect(metadata[0]).toEqual({
      id: 'cred-1',
      workspaceId: 'ws-1',
      profileId: 'profile-1',
      site: 'example.com',
      loginUrl: row.login_url,
      accountLabel: 'Primary',
      status: 'active',
      lastUsedAt: null,
      lastFailureCode: null,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    })
  })

  it('decrypts only through the ownership-scoped resolver, including optional id', async () => {
    mockQuery.mockResolvedValueOnce(rows([row]))
    const store = createBrowserCredentialStore({ encryptionKey: KEY })
    await store.upsert({
      workspaceId: 'ws-1',
      profileId: 'profile-1',
      ownerUserId: 'user-1',
      site: 'example.com',
      loginUrl: row.login_url,
      secret,
    })
    const encrypted = (mockQuery.mock.calls[0] as [string, unknown[]])[1][6] as Buffer
    mockQuery.mockResolvedValueOnce(rows([{ ...row, encrypted_secret: encrypted }]))

    const resolved = await store.resolve({
      userId: 'user-1',
      workspaceId: 'ws-1',
      profileId: 'profile-1',
      site: 'example.com',
      credentialId: 'cred-1',
    })
    const [sql, params] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(sql).toMatch(
      /profile_id = \$1[\s\S]*site = \$2[\s\S]*owner_user_id = \$3[\s\S]*workspace_id = \$4[\s\S]*status = 'active'[\s\S]*id = \$5/,
    )
    expect(params).toEqual(['profile-1', 'example.com', 'user-1', 'ws-1', 'cred-1'])
    expect(resolved?.secret).toEqual(secret)
  })

  it('records typed success and failure fields', async () => {
    const store = createBrowserCredentialStore({ encryptionKey: KEY })
    await store.recordResult({ credentialId: 'cred-1', result: 'success' })
    await store.recordResult({ credentialId: 'cred-1', result: 'failure', failureCode: 'mfa_required' })

    const [successSql, successParams] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(successSql).toMatch(/status = 'active'.*last_used_at = now\(\).*last_failure_code = NULL/s)
    expect(successParams).toEqual(['cred-1'])
    const [failureSql, failureParams] = mockQuery.mock.calls[1] as [string, unknown[]]
    expect(failureSql).toMatch(/status = 'invalid'.*last_failure_code = \$2/s)
    expect(failureParams).toEqual(['cred-1', 'mfa_required'])
  })
})
