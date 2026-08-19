import { describe, it, expect, vi } from 'vitest'

// The store's DB-touching paths need a live pool; this file pins the pure
// link-binding rule that Slack (`resolveSlackSender`) and Telegram BYO
// (`telegramLinkBindsHere` alias) share. Mock the client so importing the
// store never opens a connection.
vi.mock('../client.js', () => ({ query: vi.fn(), getPool: vi.fn() }))
vi.mock('../users.js', () => ({ findUserByEmail: vi.fn(), findOrCreateUser: vi.fn() }))
vi.mock('../linked-accounts.js', () => ({ mergeShadowUser: vi.fn() }))
vi.mock('../workspace-store.js', () => ({ getWorkspaceRoleSystem: vi.fn(async () => null) }))

import { channelLinkBindsHere, ensureAssistantMember } from '../channel-user-store.js'
import { query } from '../client.js'

describe('[COMP:api/channel-user-store] channelLinkBindsHere', () => {
  const link = (userId: string, assistantId: string | null) => ({ userId, assistantId })

  it('rejects a missing link', async () => {
    expect(await channelLinkBindsHere(null, 'a1', 'owner', 'ws1', async () => 'admin')).toBe(false)
    expect(await channelLinkBindsHere(undefined, 'a1', 'owner', 'ws1', async () => 'admin')).toBe(false)
  })

  it('binds when the link routes to this exact assistant', async () => {
    const roleLookup = vi.fn(async () => null)
    expect(await channelLinkBindsHere(link('u', 'a1'), 'a1', 'owner', 'ws1', roleLookup)).toBe(true)
    expect(roleLookup).not.toHaveBeenCalled()
  })

  it('binds when the linked user is the billing-party owner', async () => {
    expect(await channelLinkBindsHere(link('owner', 'other'), 'a1', 'owner', 'ws1', async () => null)).toBe(true)
  })

  it('binds when the linked user is a member of this assistant\'s workspace (the Slack 2026-08-18 shape)', async () => {
    const roleLookup = vi.fn(async () => 'admin' as const)
    expect(await channelLinkBindsHere(link('u_gmail', null), 'a1', 'owner', 'ws1', roleLookup)).toBe(true)
    expect(roleLookup).toHaveBeenCalledWith('u_gmail', 'ws1')
  })

  it('does NOT bind a stranger linked to another tenant', async () => {
    expect(await channelLinkBindsHere(link('u_other', 'a_other'), 'a1', 'owner', 'ws1', async () => null)).toBe(false)
  })

  it('does NOT bind by membership when the assistant has no workspace', async () => {
    const roleLookup = vi.fn(async () => 'member' as const)
    expect(await channelLinkBindsHere(link('u', 'a_other'), 'a1', 'owner', null, roleLookup)).toBe(false)
    expect(roleLookup).not.toHaveBeenCalled()
  })
})

describe('[COMP:api/channel-user-store] ensureAssistantMember', () => {
  it('upserts the assistant_members row idempotently', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    await ensureAssistantMember('a1', 'u1')
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (assistant_id, user_id) DO NOTHING'),
      ['a1', 'u1'],
    )
  })
})
