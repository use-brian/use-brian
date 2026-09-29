import { describe, expect, it, vi } from 'vitest'
import type { ResolvedOfficeAccess } from '@use-brian/api/office/access.js'
import { revalidateOfficeConnection, revalidateOfficeRoom, sweepOfficeRooms, type OfficeRoomConnection } from '../office-authority.js'

const access = (canEdit: boolean): ResolvedOfficeAccess => ({
  artifactId: 'artifact', workspaceId: 'workspace', mode: 'artifact', role: canEdit ? 'edit' : 'view',
  workspaceRole: 'member', lifecycleState: 'active', canView: true,
  canComment: canEdit, canEdit, canRestore: false, canDeletePermanently: false,
  canElevate: false, canManageSharing: false,
})

function connection(userId = 'user', readOnly = false): OfficeRoomConnection & { sent: string[]; closed: number } {
  return {
    context: { userId, sessionId: `session-${userId}`, authVersion: 1, office: true },
    readOnly, sent: [], closed: 0,
    sendStateless(message) { this.sent.push(message) },
    close() { this.closed += 1 },
  }
}

describe('[COMP:doc-sync/office-collab] current Office room authority', () => {
  it('downgrades before publication and can restore write authority', async () => {
    const peer = connection()
    let current = access(false)
    const deps = { validateSession: vi.fn(async () => true), resolveAccess: vi.fn(async () => current) }
    await expect(revalidateOfficeConnection({ artifactId: 'artifact', connection: peer, deps })).resolves.toBe('read-only')
    expect(peer.readOnly).toBe(true)
    expect(peer.sent).toEqual(['office-write-denied'])
    current = access(true)
    await expect(revalidateOfficeConnection({ artifactId: 'artifact', connection: peer, deps })).resolves.toBe('read-write')
    expect(peer.sent).toEqual(['office-write-denied', 'office-write-allowed'])
  })

  it.each(['revoked session', 'lost projection', 'resolver failure'])('removes a peer before delivery on %s', async reason => {
    const peer = connection()
    const deps = {
      validateSession: vi.fn(async () => reason !== 'revoked session'),
      resolveAccess: vi.fn(async () => {
        if (reason === 'resolver failure') throw new Error('database unavailable')
        return reason === 'lost projection' ? null : access(true)
      }),
    }
    await expect(revalidateOfficeConnection({ artifactId: 'artifact', connection: peer, deps })).resolves.toBe('denied')
    expect(peer.readOnly).toBe(true)
    expect(peer.sent).toEqual(['office-access-denied'])
    expect(peer.closed).toBe(1)
  })

  it('audits every mixed-authority recipient before a room transaction', async () => {
    const editor = connection('editor')
    const viewer = connection('viewer')
    const revoked = connection('revoked')
    const document = { getConnections: () => [editor, viewer, revoked] }
    const results = await revalidateOfficeRoom({ artifactId: 'artifact', document, deps: {
      validateSession: async () => true,
      resolveAccess: async userId => userId === 'revoked' ? null : access(userId === 'editor'),
    } })
    expect([...results.values()]).toEqual(['read-write', 'read-only', 'denied'])
    expect(revoked.closed).toBe(1)
  })

  it('sweeps only explicit Office namespaces while rooms are idle', async () => {
    const office = connection()
    const page = connection('page')
    const audited = await sweepOfficeRooms({ documents: new Map([
      ['office:artifact', { getConnections: () => [office] }],
      ['page:page-id', { getConnections: () => [page] }],
    ]), deps: { validateSession: async () => true, resolveAccess: async () => null } })
    expect(audited).toBe(1)
    expect(office.closed).toBe(1)
    expect(page.closed).toBe(0)
  })
})
