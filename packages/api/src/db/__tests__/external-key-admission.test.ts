import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), apply: vi.fn() }))
vi.mock('../client.js', () => ({
  getAppPool: () => ({ connect: async () => db }),
  applyRLSGucs: db.apply,
  rollbackAndRelease: db.release,
}))
import { createExternalKey, withExternalKeyActor } from '../external-key-admission.js'
beforeEach(() => { vi.clearAllMocks(); db.query.mockResolvedValue({ rows: [] }) })
describe('external key configuration provenance', () => {
  it('locks workspace before insert, installs only the current authenticated session', async () => {
    await withExternalKeyActor('actor', 'session', () => createExternalKey('actor', { workspaceId: 'workspace' }, 'INSERT key', [], true))
    expect(db.query.mock.calls.map(c => c[0])).toEqual([
      'BEGIN', 'SELECT id FROM workspaces WHERE id=$1 FOR UPDATE',
      "SELECT set_config('app.external_key_session',$1,true)",
      "SELECT set_config('app.external_key_explicit',$1,true)", 'INSERT key', 'COMMIT',
    ])
    expect(db.apply).toHaveBeenCalledWith(db, 'actor')
    expect(db.release).toHaveBeenCalledWith(db)
  })
  it('cannot substitute a historical creator and does not leak across calls', async () => {
    await withExternalKeyActor('other', 'session', () => createExternalKey('actor', { workspaceId: 'workspace' }, 'INSERT key', []))
    await createExternalKey('actor', { workspaceId: 'workspace' }, 'INSERT key', [])
    expect(db.query.mock.calls.some(c => c[0].includes('external_key_session'))).toBe(false)
  })
  it('rolls back/releases failed writes without committing', async () => {
    db.query.mockImplementation(async (sql: string) => { if (sql === 'INSERT key') throw new Error('denied'); return { rows: [] } })
    await expect(createExternalKey('actor', { workspaceId: 'workspace' }, 'INSERT key', [])).rejects.toThrow('denied')
    expect(db.query).not.toHaveBeenCalledWith('COMMIT')
    expect(db.release).toHaveBeenCalledWith(db)
  })
})
