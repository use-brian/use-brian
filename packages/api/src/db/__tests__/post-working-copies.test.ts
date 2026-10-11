import { beforeEach, describe, expect, it, vi } from 'vitest'
const db = vi.hoisted(() => ({ query: vi.fn(), release: vi.fn(), get: vi.fn() }))
vi.mock('../client.js', () => ({ query: db.get, getPool: () => ({ connect: async () => ({ query: db.query, release: db.release }) }) }))
import { postWorkingCopiesStore, WorkingCopyError, type WorkingCopyInput } from '../post-working-copies.js'
const input: WorkingCopyInput = { revision: 0, mutationId: 'mutation-1', create: { platform: 'threads' },
  content: { title: 'Launch notes', privateBrief: 'A private thought', text: 'Unfinished', postFormat: 'post', threadSegments: ['', ''], article: { sourceUrl: '', title: '', description: '' }, media: [] } }
let previous: unknown
let created: boolean
beforeEach(() => {
  vi.clearAllMocks(); previous = undefined; created = true
  db.query.mockImplementation(async (sql: string) => {
    // Creation admission by anchor (L12) reads the assistant; no policy row = legacy.
    if (sql.includes('FROM assistants WHERE id=$1 FOR SHARE')) return { rows: [{ workspaceId: 'ws-1', clearance: 'internal' }] }
    if (sql.includes("current_setting('app.system_bypass'")) return { rows: [{ value: null }] }
    if (sql.includes('SELECT feed_draft_audience_allowed')) return { rows: [{ allowed: true }] }
    if (sql.startsWith('INSERT INTO sessions')) return { rows: created ? [{ id: 'session-1' }] : [] }
    if (sql.includes('FOR UPDATE')) return { rows: [{ userId: 'user-1', title: '[threads] Launch notes' }] }
    if (sql.includes('SELECT revision')) return { rows: previous ? [previous] : [] }
    return { rows: [] }
  })
})
describe('[COMP:feed/post-working-copies] transactional persistence', () => {
  it('atomically registers a stable session id, seeds the private brief and stores content', async () => {
    const copy = await postWorkingCopiesStore.put('assistant-1', 'session-1', 'user-1', input)
    expect(copy.revision).toBe(1)
    expect(db.query.mock.calls[0][0]).toBe('BEGIN')
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO sessions'), expect.arrayContaining(['session-1', 'draft:session-1']))
    expect(db.query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO session_messages'), expect.arrayContaining([expect.stringContaining('A private thought')]))
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('COMMIT')
    expect(db.release).toHaveBeenCalledOnce()
  })
  it('acknowledges a lost-response retry without reseeding or another write', async () => {
    created = false; previous = { ...input, revision: 1 }
    const copy = await postWorkingCopiesStore.put('assistant-1', 'session-1', 'user-1', input)
    expect(copy.revision).toBe(1)
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO session_messages'))).toBe(false)
    expect(db.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO feed_post_working_copies'))).toBe(false)
  })
  it('rejects a stale revision under the row lock and rolls back', async () => {
    created = false; previous = { ...input, revision: 2, mutationId: 'other-device' }
    await expect(postWorkingCopiesStore.put('assistant-1', 'session-1', 'user-1', input)).rejects.toMatchObject({ status: 409 })
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
  })
  it('does not let a guessed id claim an existing session without a working copy', async () => {
    created = false
    await expect(postWorkingCopiesStore.put('assistant-1', 'session-1', 'user-1', input)).rejects.toBeInstanceOf(WorkingCopyError)
  })
  it('preserves a remote rename made before the first working copy sync', async () => {
    created = false
    const { create: _create, ...edit } = input
    await expect(postWorkingCopiesStore.put('assistant-1', 'session-1', 'user-1', {
      ...edit, baseTitle: '[threads] Earlier title',
    })).rejects.toMatchObject({ status: 409 })
  })
  it('rolls back session creation if the seeded-message write fails', async () => {
    db.query.mockImplementation(async (sql: string) => {
      if (sql.includes('FROM assistants WHERE id=$1 FOR SHARE')) return { rows: [{ workspaceId: 'ws-1', clearance: 'internal' }] }
      if (sql.includes("current_setting('app.system_bypass'")) return { rows: [{ value: null }] }
      if (sql.includes('INSERT INTO sessions')) return { rows: [{ id: 'session-1' }] }
      if (sql.includes('FOR UPDATE')) return { rows: [{ userId: 'user-1', title: '[threads] Launch notes' }] }
      if (sql.includes('INSERT INTO session_messages')) throw new Error('disk full')
      return { rows: [] }
    })
    await expect(postWorkingCopiesStore.put('assistant-1', 'session-1', 'user-1', input)).rejects.toThrow('disk full')
    expect(db.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK')
    expect(db.release).toHaveBeenCalledOnce()
  })
})
