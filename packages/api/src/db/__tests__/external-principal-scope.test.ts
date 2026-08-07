/**
 * [COMP:consolidation/external-principal-isolation] — the always-on half.
 *
 * `external-principal-consolidation.integration.test.ts` proves the actual
 * merge/prune behavior, but it needs a live Postgres and self-skips without
 * one. This suite has no DB dependency, so it runs on every `pnpm test` and
 * every CI box: it stubs the pool and asserts that each of the three system
 * readers the consolidation worker reaches through still emits the
 * external-principal exclusion, against the right auth namespaces, on the
 * memories table's own `user_id`.
 *
 * The failure it exists to catch is deletion, not drift: the clause carries
 * no bind params (the prefixes are compile-time constants), so nothing else
 * in the query breaks if someone removes it — the leak just comes back
 * silently. See `docs/architecture/context-engine/memory-consolidation.md`
 * → "External principals".
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const captured: Array<{ sql: string; params: unknown[] }> = []

vi.mock('../client.js', () => ({
  query: vi.fn(async (sql: string, params: unknown[] = []) => {
    captured.push({ sql, params })
    return { rows: [], rowCount: 0 }
  }),
  getPool: vi.fn(() => {
    throw new Error('getPool must not be reached by these readers')
  }),
}))

const memories = await import('../memories.js')

/** Collapse whitespace so the assertions read against one flat string. */
function flat(sql: string): string {
  return sql.replace(/\s+/g, ' ')
}

function lastSql(): string {
  return flat(captured[captured.length - 1].sql)
}

beforeEach(() => {
  captured.length = 0
})

describe('[COMP:consolidation/external-principal-isolation] external-principal exclusion SQL', () => {
  it('getWorkspaceMemoryIndexSystem excludes api: and chatlink: authors', async () => {
    await memories.getWorkspaceMemoryIndexSystem('a-1', 'ws-1')
    const sql = lastSql()
    expect(sql).toContain('NOT EXISTS')
    expect(sql).toContain("ep_u.auth_provider = 'channel'")
    expect(sql).toContain("ep_u.auth_provider_id LIKE 'api:%'")
    expect(sql).toContain("ep_u.auth_provider_id LIKE 'chatlink:%'")
    expect(sql).toContain('ep_u.id = memories.user_id')
  })

  it('listWorkspaceMemoriesWithMetrics excludes them before the keyset page clause', async () => {
    await memories.listWorkspaceMemoriesWithMetrics('a-1', 'ws-1', { limit: 50 })
    const sql = lastSql()
    expect(sql).toContain('ep_u.id = memories.user_id')
    // ORDER BY / LIMIT are appended by `metricsPageSql`; the predicate has to
    // land in the WHERE clause, ahead of them, or Postgres rejects the query.
    expect(sql.indexOf('NOT EXISTS')).toBeLessThan(sql.indexOf('ORDER BY'))
  })

  it('listMemoryUsers excludes them on the aliased inner scan', async () => {
    await memories.listMemoryUsers()
    const sql = lastSql()
    expect(sql).toContain('ep_u.id = m.user_id')
    expect(sql).toContain("ep_u.auth_provider_id LIKE 'api:%'")
    expect(sql).toContain("ep_u.auth_provider_id LIKE 'chatlink:%'")
  })

  it('leaves the per-user system readers alone — they are already user-scoped', async () => {
    // `getMemoryIndexSystem` is keyed on one (assistant, user) pair, so it can
    // never compare two principals against each other. Excluding external
    // authors here would instead break the live read path for a client's own
    // memory, which stays fully functional (D7 turns off only the background
    // personal pass, never the client's own `saveMemory` / `getMemory`).
    await memories.getMemoryIndexSystem('a-1', 'u-1')
    expect(lastSql()).not.toContain('NOT EXISTS')
  })

  it('binds no extra parameters — the prefixes are compile-time constants', async () => {
    await memories.getWorkspaceMemoryIndexSystem('a-1', 'ws-1')
    expect(captured[captured.length - 1].params).toEqual(['a-1', 'ws-1'])
  })
})
