import { describe, it, expect } from 'vitest'
import { createWorkspaceTools } from '../tools.js'
import type { WorkspaceDirectoryStore, WorkspaceMemberInfo } from '../types.js'

function makeFakeStore(byWorkspace: Record<string, WorkspaceMemberInfo[]>): WorkspaceDirectoryStore {
  return {
    async listMembers(_userId, workspaceId) {
      return byWorkspace[workspaceId] ?? []
    },
    async get(workspaceId, memberId) {
      const members = byWorkspace[workspaceId] ?? []
      return members.find((m) => m.memberId === memberId) ?? null
    },
    async batchGet(workspaceId, memberIds) {
      const members = byWorkspace[workspaceId] ?? []
      const requested = new Set(memberIds)
      const out = new Map<string, WorkspaceMemberInfo>()
      for (const m of members) {
        if (requested.has(m.memberId)) out.set(m.memberId, m)
      }
      return out
    },
  }
}

const ctx = {
  assistantId: 'assistant_1',
  userId: 'user_1',
  sessionId: 'session_1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c_1',
  workspaceId: 'workspace_1',
  abortSignal: new AbortController().signal,
}

const ROSTER: WorkspaceMemberInfo[] = [
  { memberId: '11111111-1111-1111-1111-111111111111', name: 'Dana Lee', email: 'dana@acme.dev', role: 'owner' },
  { memberId: '22222222-2222-2222-2222-222222222222', name: 'Sam Park', email: 'sam@acme.dev', role: 'member' },
]

describe('[COMP:workspace/tools] listWorkspaceMembers', () => {
  it('returns the roster for the current workspace', async () => {
    const { listWorkspaceMembers } = createWorkspaceTools(makeFakeStore({ workspace_1: ROSTER }))
    const result = await listWorkspaceMembers.execute({}, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual(ROSTER)
  })

  it('exposes member ids so the model can resolve assignee_id', async () => {
    const { listWorkspaceMembers } = createWorkspaceTools(makeFakeStore({ workspace_1: ROSTER }))
    const result = await listWorkspaceMembers.execute({}, ctx)
    const rows = result.data as WorkspaceMemberInfo[]
    expect(rows.map((r) => r.memberId)).toContain('22222222-2222-2222-2222-222222222222')
  })

  it('errors when the assistant is not bound to a workspace', async () => {
    const { listWorkspaceMembers } = createWorkspaceTools(makeFakeStore({}))
    const result = await listWorkspaceMembers.execute({}, { ...ctx, workspaceId: null })
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('not bound to a workspace')
  })

  it('returns an empty roster for a non-member caller (store guard)', async () => {
    // The API adapter returns [] when getMembership is null — verify the
    // tool surfaces that without throwing.
    const { listWorkspaceMembers } = createWorkspaceTools(makeFakeStore({ other_ws: ROSTER }))
    const result = await listWorkspaceMembers.execute({}, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toEqual([])
  })

  it('is read-only and concurrency-safe', () => {
    const { listWorkspaceMembers } = createWorkspaceTools(makeFakeStore({}))
    expect(listWorkspaceMembers.isReadOnly).toBe(true)
    expect(listWorkspaceMembers.isConcurrencySafe).toBe(true)
  })
})

describe('[COMP:workspace/directory-batch] get + batchGet', () => {
  it('get returns a member by id when present in workspace', async () => {
    const store = makeFakeStore({ workspace_1: ROSTER })
    const m = await store.get('workspace_1', '11111111-1111-1111-1111-111111111111')
    expect(m?.name).toBe('Dana Lee')
  })

  it('get returns null for an unknown memberId', async () => {
    const store = makeFakeStore({ workspace_1: ROSTER })
    const m = await store.get('workspace_1', '99999999-9999-9999-9999-999999999999')
    expect(m).toBeNull()
  })

  it('get returns null for a workspace with no roster', async () => {
    const store = makeFakeStore({})
    const m = await store.get('workspace_1', '11111111-1111-1111-1111-111111111111')
    expect(m).toBeNull()
  })

  it('batchGet returns a Map keyed by memberId', async () => {
    const store = makeFakeStore({ workspace_1: ROSTER })
    const map = await store.batchGet('workspace_1', [
      '11111111-1111-1111-1111-111111111111',
      '22222222-2222-2222-2222-222222222222',
    ])
    expect(map.size).toBe(2)
    expect(map.get('11111111-1111-1111-1111-111111111111')?.name).toBe('Dana Lee')
    expect(map.get('22222222-2222-2222-2222-222222222222')?.name).toBe('Sam Park')
  })

  it('batchGet omits ids that are not in this workspace', async () => {
    const store = makeFakeStore({ workspace_1: ROSTER })
    const map = await store.batchGet('workspace_1', [
      '11111111-1111-1111-1111-111111111111',
      '99999999-9999-9999-9999-999999999999',
    ])
    expect(map.size).toBe(1)
    expect(map.has('99999999-9999-9999-9999-999999999999')).toBe(false)
  })

  it('batchGet on an empty input returns an empty Map', async () => {
    const store = makeFakeStore({ workspace_1: ROSTER })
    const map = await store.batchGet('workspace_1', [])
    expect(map.size).toBe(0)
  })
})
