import { describe, it, expect } from 'vitest'
import {
  assertPageAccess,
  resolveEffectiveRole,
  isReadOnlyRole,
  PageAccessDenied,
  PAGE_ACCESS_SQL,
  PAGE_ROLE_SQL,
  type RlsQuery,
  type GrantRole,
} from '../clearance-gate.js'

// assertPageAccess makes TWO RLS reads: PAGE_ACCESS_SQL (workspace + clearance
// gate) then PAGE_ROLE_SQL (the effective page_grants role). The mock routes by
// which SQL is asked so a test can supply a member row and, independently, the
// grant the resolver should find. `access: null` → not a member (empty first
// read); `grantRole: null` → no grant (empty second read → the `edit` baseline).
function makeQuery(opts: {
  access: {
    workspaceId: string
    pageClearance: string | null
    memberClearance: string | null
    /** Migration 313 — the page's teamspace tier; null/omitted = a private page / no container. */
    teamspaceSensitivity?: string | null
  } | null
  grantRole?: GrantRole | null
}): RlsQuery {
  return (async (_userId: string, sql: string) => {
    if (sql === PAGE_ACCESS_SQL) return (opts.access ? [opts.access] : []) as never[]
    if (sql === PAGE_ROLE_SQL) return (opts.grantRole ? [{ role: opts.grantRole }] : []) as never[]
    throw new Error(`unexpected sql: ${sql}`)
  }) as RlsQuery
}

describe('[COMP:doc-sync/clearance-gate] assertPageAccess', () => {
  it('denies when the user is not a workspace member (no row visible)', async () => {
    await expect(
      assertPageAccess({ userId: 'u', pageId: 'p', query: makeQuery({ access: null }) }),
    ).rejects.toBeInstanceOf(PageAccessDenied)
  })

  it('denies a member whose clearance is below the page clearance', async () => {
    const query = makeQuery({
      access: { workspaceId: 'w', pageClearance: 'confidential', memberClearance: 'public' },
    })
    await expect(
      assertPageAccess({ userId: 'u', pageId: 'p', query }),
    ).rejects.toMatchObject({ reason: 'insufficient_clearance' })
  })

  it('an ungranted member at/above clearance keeps the edit baseline (read-write)', async () => {
    const query = makeQuery({
      access: { workspaceId: 'w', pageClearance: 'internal', memberClearance: 'confidential' },
      grantRole: null,
    })
    await expect(assertPageAccess({ userId: 'u', pageId: 'p', query })).resolves.toEqual({
      workspaceId: 'w',
      clearance: 'internal',
      role: 'edit',
    })
  })

  it('a member granted `view` joins read-only — the write-authz downgrade', async () => {
    const query = makeQuery({
      access: { workspaceId: 'w', pageClearance: 'public', memberClearance: 'confidential' },
      grantRole: 'view',
    })
    const access = await assertPageAccess({ userId: 'u', pageId: 'p', query })
    expect(access.role).toBe('view')
    expect(isReadOnlyRole(access.role)).toBe(true)
  })

  it('a member granted `comment` joins read-only', async () => {
    const query = makeQuery({
      access: { workspaceId: 'w', pageClearance: 'public', memberClearance: 'internal' },
      grantRole: 'comment',
    })
    const access = await assertPageAccess({ userId: 'u', pageId: 'p', query })
    expect(access.role).toBe('comment')
    expect(isReadOnlyRole(access.role)).toBe(true)
  })

  it('a member granted `edit` stays read-write', async () => {
    const query = makeQuery({
      access: { workspaceId: 'w', pageClearance: 'public', memberClearance: 'internal' },
      grantRole: 'edit',
    })
    const access = await assertPageAccess({ userId: 'u', pageId: 'p', query })
    expect(access.role).toBe('edit')
    expect(isReadOnlyRole(access.role)).toBe(false)
  })

  it('a member granted `full` stays read-write', async () => {
    const query = makeQuery({
      access: { workspaceId: 'w', pageClearance: 'public', memberClearance: 'internal' },
      grantRole: 'full',
    })
    const access = await assertPageAccess({ userId: 'u', pageId: 'p', query })
    expect(access.role).toBe('full')
    expect(isReadOnlyRole(access.role)).toBe(false)
  })

  it('denies a member whose clearance is below the TEAMSPACE sensitivity (migration 313)', async () => {
    // The demotion edge: filed into the container while cleared, tier raised
    // (or clearance dropped) later — the page-open gate is the backstop.
    const query = makeQuery({
      access: {
        workspaceId: 'w',
        pageClearance: 'public',
        memberClearance: 'internal',
        teamspaceSensitivity: 'confidential',
      },
    })
    await expect(
      assertPageAccess({ userId: 'u', pageId: 'p', query }),
    ).rejects.toMatchObject({ reason: 'insufficient_teamspace_clearance' })
  })

  it('a null teamspace sensitivity (private page) adds no container gate', async () => {
    const query = makeQuery({
      access: {
        workspaceId: 'w',
        pageClearance: 'internal',
        memberClearance: 'internal',
        teamspaceSensitivity: null,
      },
      grantRole: null,
    })
    await expect(assertPageAccess({ userId: 'u', pageId: 'p', query })).resolves.toMatchObject({
      workspaceId: 'w',
      role: 'edit',
    })
  })

  it('a member clearing both the page and the teamspace tier joins normally', async () => {
    const query = makeQuery({
      access: {
        workspaceId: 'w',
        pageClearance: 'internal',
        memberClearance: 'confidential',
        teamspaceSensitivity: 'confidential',
      },
      grantRole: null,
    })
    await expect(assertPageAccess({ userId: 'u', pageId: 'p', query })).resolves.toMatchObject({
      workspaceId: 'w',
      role: 'edit',
    })
  })

  it('the clearance gate runs BEFORE the role read — a below-clearance member never reaches the grant', async () => {
    // If the role query were consulted, this mock would throw `unexpected sql`
    // only for a third SQL; here it must reject on clearance without asking for
    // the role at all. We assert the rejection reason is clearance, not a role
    // lookup artifact.
    let roleQueried = false
    const query = (async (_u: string, sql: string) => {
      if (sql === PAGE_ACCESS_SQL)
        return [{ workspaceId: 'w', pageClearance: 'confidential', memberClearance: 'public' }] as never[]
      if (sql === PAGE_ROLE_SQL) {
        roleQueried = true
        return [] as never[]
      }
      throw new Error(`unexpected sql: ${sql}`)
    }) as RlsQuery
    await expect(assertPageAccess({ userId: 'u', pageId: 'p', query })).rejects.toMatchObject({
      reason: 'insufficient_clearance',
    })
    expect(roleQueried).toBe(false)
  })
})

describe('[COMP:doc-sync/clearance-gate] resolveEffectiveRole', () => {
  it('returns the edit baseline when the page carries no grant for the viewer', async () => {
    const query = makeQuery({ access: null, grantRole: null })
    await expect(resolveEffectiveRole({ userId: 'u', pageId: 'p', query })).resolves.toBe('edit')
  })

  it('returns the grant role when one applies', async () => {
    const query = makeQuery({ access: null, grantRole: 'comment' })
    await expect(resolveEffectiveRole({ userId: 'u', pageId: 'p', query })).resolves.toBe('comment')
  })

  it('a malformed role value fails safe to `view`, never up to `edit`', async () => {
    // Defensive: the CHECK constraint makes this unreachable in prod, but a
    // corrupt/unknown role must not silently become read-write.
    const query = (async (_u: string, sql: string) => {
      if (sql === PAGE_ROLE_SQL) return [{ role: 'owner' }] as never[]
      return [] as never[]
    }) as RlsQuery
    await expect(resolveEffectiveRole({ userId: 'u', pageId: 'p', query })).resolves.toBe('view')
  })

  it('passes the pageId and userId through to both reads', async () => {
    const seen: { sql: string; params: unknown[] }[] = []
    const query = (async (_u: string, sql: string, params: unknown[]) => {
      seen.push({ sql, params })
      if (sql === PAGE_ACCESS_SQL)
        return [{ workspaceId: 'w', pageClearance: 'public', memberClearance: 'internal' }] as never[]
      return [{ role: 'view' }] as never[]
    }) as RlsQuery
    await assertPageAccess({ userId: 'user-1', pageId: 'page-1', query })
    // Second read is the role resolver, keyed by (pageId, userId).
    const roleRead = seen.find((s) => s.sql === PAGE_ROLE_SQL)
    expect(roleRead?.params).toEqual(['page-1', 'user-1'])
  })
})

describe('[COMP:doc-sync/clearance-gate] isReadOnlyRole', () => {
  it('view and comment are read-only; edit and full are read-write', () => {
    expect(isReadOnlyRole('view')).toBe(true)
    expect(isReadOnlyRole('comment')).toBe(true)
    expect(isReadOnlyRole('edit')).toBe(false)
    expect(isReadOnlyRole('full')).toBe(false)
  })
})
