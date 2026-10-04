import { describe, expect, it, vi } from 'vitest'
import { ACCOUNT_TEARDOWN_RULES, AccountTeardownBlockedError, deleteAccountFootprint } from '../account-teardown.js'

type Row = Record<string, unknown>

/** A scripted client: catalog queries return `fks`, everything else succeeds unless `fail` says otherwise. */
function fakeClient(opts: {
  fks?: Array<{ tbl: string; col: string; nn?: boolean; has_ws?: boolean }>
  fail?: (sql: string, call: number) => Error | null
  user?: { deleted_at: Date | null } | null
}) {
  let call = 0
  const query = vi.fn(async (sql: string) => {
    call++
    if (sql.includes('FOR UPDATE')) {
      const user = opts.user === undefined ? { deleted_at: null } : opts.user
      return { rows: (user ? [user] : []) as Row[], rowCount: user ? 1 : 0 }
    }
    if (sql.includes('FROM pg_constraint')) {
      return {
        rows: (opts.fks ?? []).map((f) => ({
          tbl: f.tbl, col: f.col, nn: f.nn ?? false, has_ws: f.has_ws ?? true, target: 'users', target_key: 'id',
        })) as Row[],
        rowCount: 0,
      }
    }
    const err = opts.fail?.(sql, call)
    if (err) throw err
    return { rows: [] as Row[], rowCount: 0 }
  })
  return { query }
}

const fkError = () => Object.assign(new Error('violates foreign key constraint "x"'), { code: '23503' })

describe('[COMP:api/account-teardown] account teardown rules and fixpoint', () => {
  it('does nothing for an account already deleted or tombstoned (a concurrent second call)', async () => {
    for (const user of [null, { deleted_at: new Date() }]) {
      const client = fakeClient({ user })
      await deleteAccountFootprint(client as never, 'u_1')
      const writes = client.query.mock.calls.map((c) => String(c[0])).filter((q) => /^(DELETE|UPDATE|INSERT)/.test(q.trim()))
      expect(writes).toEqual([])
    }
  })

  it('fails closed on a foreign key to users that has no rule, before touching anything', async () => {
    const client = fakeClient({ fks: [{ tbl: 'brand_new_table', col: 'owner_user_id' }] })
    await expect(deleteAccountFootprint(client as never, 'u_1')).rejects.toMatchObject({
      code: 'account_data_blocked',
      blockers: [{ step: 'brand_new_table.owner_user_id', error: 'no account teardown rule' }],
    })
    const writes = client.query.mock.calls.map((c) => String(c[0])).filter((s) => /^(DELETE|UPDATE)/.test(s.trim()))
    expect(writes).toEqual([])
  })

  it('accepts an edition rule for its own table but never lets it override an open rule', async () => {
    const extra = { 'overlay_table.owner_user_id': { action: 'reassign' as const }, 'entities.user_id': { action: 'keep' as const } }
    const client = fakeClient({ fks: [{ tbl: 'overlay_table', col: 'owner_user_id' }, { tbl: 'entities', col: 'user_id' }] })
    await deleteAccountFootprint(client as never, 'u_1', extra)
    const sql = client.query.mock.calls.map((c) => String(c[0]))
    expect(sql.some((s) => s.startsWith('UPDATE overlay_table t SET "owner_user_id" ='))).toBe(true)
    // The open rule (private rows are deleted) wins over the extra `keep`.
    expect(sql.some((s) => s.startsWith('DELETE FROM entities t WHERE t."user_id" = $1'))).toBe(true)
  })

  it('refuses a reassign rule on a table that has no workspace to take ownership', async () => {
    const client = fakeClient({ fks: [{ tbl: 'saved_views', col: 'created_by', has_ws: false }] })
    await expect(deleteAccountFootprint(client as never, 'u_1')).rejects.toBeInstanceOf(AccountTeardownBlockedError)
  })

  it('retries a step refused for ordering and succeeds on a later pass', async () => {
    let refusals = 0
    const client = fakeClient({
      fail: (sql) => (sql.startsWith('DELETE FROM assistants WHERE workspace_id IS NULL') && refusals++ === 0 ? fkError() : null),
    })
    await expect(deleteAccountFootprint(client as never, 'u_1')).resolves.toBeDefined()
    const assistantDeletes = client.query.mock.calls.filter((c) => String(c[0]).startsWith('DELETE FROM assistants'))
    expect(assistantDeletes).toHaveLength(2)
  })

  it('stops at once on a non-ordering error and names the step, releasing its savepoint', async () => {
    const client = fakeClient({
      fail: (sql) => (sql.startsWith('DELETE FROM assistants WHERE workspace_id IS NULL') ? Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' }) : null),
    })
    await expect(deleteAccountFootprint(client as never, 'u_1')).rejects.toMatchObject({
      blockers: [{ step: 'assistants (solo-owned, no workspace)', error: 'canceling statement due to statement timeout' }],
    })
    const sql = client.query.mock.calls.map((c) => String(c[0]))
    expect(sql.filter((s) => s.startsWith('DELETE FROM assistants'))).toHaveLength(1)
    expect(sql.slice(-2)).toEqual(['ROLLBACK TO SAVEPOINT account_teardown_step', 'RELEASE SAVEPOINT account_teardown_step'])
  })

  it('reports a step that never stops being refused instead of looping', async () => {
    const client = fakeClient({ fail: (sql) => (sql.startsWith('DELETE FROM assistants WHERE workspace_id IS NULL') ? fkError() : null) })
    await expect(deleteAccountFootprint(client as never, 'u_1')).rejects.toMatchObject({ blockers: [{ step: 'assistants (solo-owned, no workspace)' }] })
  })

  it('never hands a private row to the owner: every user_id visibility key is deleted', () => {
    for (const key of ['entities.user_id', 'entity_links.user_id', 'episodes.user_id', 'kb_chunks.user_id', 'tasks.user_id', 'workspace_files.user_id', 'session_messages.user_id']) {
      expect(ACCOUNT_TEARDOWN_RULES[key]?.action).toBe('delete')
    }
    expect(ACCOUNT_TEARDOWN_RULES['saved_views.created_by']?.privateWhere).toBe('t.teamspace_id IS NULL')
    expect(ACCOUNT_TEARDOWN_RULES['office_artifacts.owner_user_id']?.privateWhere).toBe("t.mode = 'session'")
  })

  it('never credits a recorded actor to the workspace owner', () => {
    for (const [key, rule] of Object.entries(ACCOUNT_TEARDOWN_RULES)) {
      if (/(verified_by|retracted_by|approved_by|decided_by|revoked_by|actor|released_by|merged_by|undone_by|changed_by|granted_by)/.test(key)) {
        expect([key, rule.action]).not.toEqual([key, 'reassign'])
      }
    }
    expect(ACCOUNT_TEARDOWN_RULES['workflows.schedule_authoring_user_id']?.action).toBe('keep')
  })

  it('tombstones the row instead of failing when something still names the user', async () => {
    const client = fakeClient({ fail: (sql) => (sql.startsWith('DELETE FROM users') ? fkError() : null) })
    await expect(deleteAccountFootprint(client as never, 'u_1')).resolves.toMatchObject({ mode: 'tombstoned' })
    const sql = client.query.mock.calls.map((c) => String(c[0]))
    const tombstone = sql.find((s) => s.trim().startsWith('UPDATE users'))
    expect(tombstone).toMatch(/email = NULL/)
    expect(tombstone).toMatch(/auth_provider_id = 'deleted:'/)
    expect(tombstone).toMatch(/auth_version = auth_version \+ 1/)
    expect(tombstone).toMatch(/deleted_at = now\(\)/)
  })
})
