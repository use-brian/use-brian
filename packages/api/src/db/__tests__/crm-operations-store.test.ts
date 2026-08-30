import { describe, expect, it, vi } from 'vitest'
import { createDbCrmOperationsStore } from '../crm-operations-store.js'

const WORKSPACE_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const context = {
  workspaceId: WORKSPACE_ID,
  actor: { kind: 'user' as const, userId: USER_ID },
  authority: { role: 'owner' as const, canWrite: true, canConfigure: true, trustedIdentitySources: [] },
}

function fakePool() {
  const query = vi.fn().mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT id FROM entities')) return { rows: [{ id: 'contact-1' }], rowCount: 1 }
    return { rows: [], rowCount: 0 }
  })
  const release = vi.fn()
  const connect = vi.fn().mockResolvedValue({ query, release })
  return { pool: { connect } as never, query, release }
}

describe('[COMP:crm/operations-store] CRM operations PostgreSQL transaction store', () => {
  it('sets system bypass locally, workspace-qualifies reads, and commits once', async () => {
    const { pool, query, release } = fakePool()
    const store = createDbCrmOperationsStore(pool)
    const found = await store.transaction(context, (tx) => tx.findContactByEmail('Ari@Example.com'))

    expect(found).toBe('contact-1')
    expect(query.mock.calls[0]![0]).toBe('BEGIN')
    expect(query.mock.calls[1]![0]).toContain("set_config('app.system_bypass', 'true', true)")
    const scoped = query.mock.calls.find((call) => String(call[0]).includes('SELECT id FROM entities'))!
    expect(scoped[0]).toContain('workspace_id = $1')
    expect(scoped[1]).toEqual([WORKSPACE_ID, 'ari@example.com'])
    expect(query.mock.calls.at(-1)![0]).toBe('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })

  it('rolls back and never commits when any transaction step fails', async () => {
    const { pool, query, release } = fakePool()
    const store = createDbCrmOperationsStore(pool)
    await expect(store.transaction(context, async () => {
      throw new Error('atomic step failed')
    })).rejects.toThrow('atomic step failed')

    expect(query.mock.calls.map((call) => call[0])).toEqual([
      'BEGIN',
      expect.stringContaining("set_config('app.system_bypass', 'true', true)"),
      'ROLLBACK',
    ])
    expect(query).not.toHaveBeenCalledWith('COMMIT')
    expect(release).toHaveBeenCalledOnce()
  })
})
