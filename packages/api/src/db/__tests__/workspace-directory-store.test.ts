// [COMP:workspace/tools] — the API-side WorkspaceDirectoryStore that backs
// `listWorkspaceMembers`. Spec: docs/architecture/platform/workspaces.md →
// "Member directory tool".
import { describe, it, expect } from 'vitest'
import { createWorkspaceDirectoryStore, toWorkspaceMemberInfo } from '../workspace-directory-store.js'
import type { WorkspaceMember } from '../workspace-store.js'

const WS = 'ws_1'
function member(over: Partial<WorkspaceMember> & Pick<WorkspaceMember, 'id' | 'userId'>): WorkspaceMember {
  return {
    workspaceId: WS,
    role: 'member',
    canDraft: false,
    clearance: 'internal',
    joinedAt: new Date('2026-01-01T00:00:00Z'),
    ...over,
  } as WorkspaceMember
}

const ROWS: WorkspaceMember[] = [
  member({ id: 'm_owner', userId: 'u_owner', role: 'owner', userName: 'Dana Lee', email: 'dana@acme.example' }),
  // Nameless member — the case a name-match can never resolve.
  member({ id: 'm_jack', userId: 'u_jack', role: 'admin', userName: null, email: 'jack@acme.example' }),
  member({ id: 'm_hinson', userId: 'u_hinson', role: 'admin', userName: 'Hinson Wong', email: 'hinson@acme.example' }),
]

function fakeWorkspaceStore(memberUserIds = new Set(ROWS.map((r) => r.userId))) {
  return {
    async getMembership(userId: string) {
      return memberUserIds.has(userId) ? { role: 'member' as const, canDraft: false } : null
    },
    async listMembers(_userId: string, workspaceId: string) {
      return workspaceId === WS ? ROWS : []
    },
  }
}

describe('[COMP:workspace/tools] WorkspaceDirectoryStore (API adapter)', () => {
  it('listMembers marks exactly the caller\'s row with isCurrentUser: true', async () => {
    const store = createWorkspaceDirectoryStore(fakeWorkspaceStore())
    const rows = await store.listMembers('u_hinson', WS)
    expect(rows.map((r) => r.memberId)).toEqual(['m_owner', 'm_jack', 'm_hinson'])
    expect(rows.filter((r) => r.isCurrentUser).map((r) => r.memberId)).toEqual(['m_hinson'])
    // Other rows carry no key at all (not `false`) — keeps the roster compact.
    expect('isCurrentUser' in rows[0]!).toBe(false)
  })

  it('listMembers marks a nameless caller too — the flag is by user id, not name', async () => {
    const store = createWorkspaceDirectoryStore(fakeWorkspaceStore())
    const rows = await store.listMembers('u_jack', WS)
    const me = rows.find((r) => r.isCurrentUser)
    expect(me).toMatchObject({ memberId: 'm_jack', name: null, email: 'jack@acme.example' })
  })

  it('listMembers returns [] for a caller who is not a member (no roster leak)', async () => {
    const store = createWorkspaceDirectoryStore(fakeWorkspaceStore())
    expect(await store.listMembers('u_stranger', WS)).toEqual([])
  })

  it('get / batchGet never set isCurrentUser (no caller in the loop)', async () => {
    const store = createWorkspaceDirectoryStore(fakeWorkspaceStore())
    const one = await store.get(WS, 'm_hinson')
    expect(one).toMatchObject({ memberId: 'm_hinson', name: 'Hinson Wong' })
    expect(one && 'isCurrentUser' in one).toBe(false)
    const many = await store.batchGet(WS, ['m_jack', 'm_missing'])
    expect([...many.keys()]).toEqual(['m_jack'])
    expect(await store.get(WS, 'm_missing')).toBeNull()
  })

  it('toWorkspaceMemberInfo projects the roster shape and defaults nulls', () => {
    expect(toWorkspaceMemberInfo(ROWS[1]!, null)).toEqual({
      memberId: 'm_jack', name: null, email: 'jack@acme.example', avatarUrl: null, role: 'admin',
    })
    expect(toWorkspaceMemberInfo(ROWS[1]!, 'u_jack')).toMatchObject({ isCurrentUser: true })
  })
})
