/**
 * Unit tests for the workspace tool policy store + its McpSettingsStore
 * adapter (migration 312). Mocks the DB layer and asserts SQL shape / param
 * threading plus the adapter's workspace-keyed policy resolution.
 *
 * Component tag: [COMP:api/workspace-tool-policy-store].
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
}))

import {
  createWorkspaceToolPolicyStore,
  workspacePolicyAsSettingsStore,
  type WorkspaceToolPolicy,
} from '../workspace-tool-policy-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  vi.clearAllMocks()
})

function fakeRow(overrides: Partial<WorkspaceToolPolicy> = {}): WorkspaceToolPolicy {
  return {
    id: 'wtp_1',
    workspaceId: 'ws_1',
    serverName: 'github',
    toolName: 'githubCreateIssue',
    policy: 'block',
    classification: 'write',
    updatedBy: 'u_1',
    updatedAt: new Date('2026-07-09T00:00:00Z'),
    ...overrides,
  }
}

describe('[COMP:api/workspace-tool-policy-store] createWorkspaceToolPolicyStore', () => {
  it('getPolicy keys on (workspace, server, tool)', async () => {
    const store = createWorkspaceToolPolicyStore()
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow()], rowCount: 1 } as never)

    const row = await store.getPolicy('ws_1', 'github', 'githubCreateIssue')

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('WHERE workspace_id = $1 AND server_name = $2 AND tool_name = $3')
    expect(params).toEqual(['ws_1', 'github', 'githubCreateIssue'])
    expect(row?.policy).toBe('block')
  })

  it('getPolicy returns null when unset', async () => {
    const store = createWorkspaceToolPolicyStore()
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await store.getPolicy('ws_1', 'github', 'x')).toBeNull()
  })

  it('setPolicy upserts on the unique key', async () => {
    const store = createWorkspaceToolPolicyStore()
    mockQuery.mockResolvedValueOnce({ rows: [fakeRow({ policy: 'allow' })], rowCount: 1 } as never)

    await store.setPolicy({
      workspaceId: 'ws_1', serverName: 'github', toolName: 'githubCreateIssue',
      policy: 'allow', classification: 'write', updatedBy: 'u_2',
    })

    const [sql, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(sql).toContain('ON CONFLICT (workspace_id, server_name, tool_name) DO UPDATE')
    expect(params).toEqual(['ws_1', 'github', 'githubCreateIssue', 'allow', 'write', 'u_2'])
  })
})

describe('[COMP:api/workspace-tool-policy-store] workspacePolicyAsSettingsStore adapter', () => {
  it('resolves policy from the workspace row, ignoring assistantId/userId', async () => {
    const store = createWorkspaceToolPolicyStore()
    mockQuery.mockResolvedValue({ rows: [fakeRow({ policy: 'block' })], rowCount: 1 } as never)
    const adapter = workspacePolicyAsSettingsStore(store, 'ws_1')

    const setting = await adapter.getPolicy({
      assistantId: 'any-assistant', userId: 'any-user',
      serverName: 'github', toolName: 'githubCreateIssue',
    })

    expect(setting?.policy).toBe('block')
    // The lookup keys on the bound workspace, not the passed user/assistant.
    const [, params] = mockQuery.mock.calls[0] as [string, unknown[]]
    expect(params).toEqual(['ws_1', 'github', 'githubCreateIssue'])
  })

  it('returns null (→ caller fallback) when the workspace has no row', async () => {
    const store = createWorkspaceToolPolicyStore()
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 } as never)
    const adapter = workspacePolicyAsSettingsStore(store, 'ws_1')
    expect(await adapter.getPolicy({ assistantId: 'a', userId: 'u', serverName: 'github', toolName: 'x' })).toBeNull()
  })

  it('is inert for writes + usage (no silent graduation of shared policy)', async () => {
    const store = createWorkspaceToolPolicyStore()
    const adapter = workspacePolicyAsSettingsStore(store, 'ws_1')
    await adapter.setPolicy({ assistantId: 'a', userId: 'u', serverName: 'github', toolName: 'x', policy: 'allow', classification: 'write' })
    await adapter.recordUsage({ assistantId: 'a', userId: 'u', serverName: 'github', toolName: 'x', allowed: true })
    const counts = await adapter.recordUsageAndGetCount({ assistantId: 'a', userId: 'u', serverName: 'github', toolName: 'x', allowed: true })
    expect(counts).toEqual({ timesAllowed: 0, timesDenied: 0 })
    // No DB writes happened through the adapter.
    expect(mockQuery).not.toHaveBeenCalled()
  })
})
