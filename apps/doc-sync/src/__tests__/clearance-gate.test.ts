import { describe, it, expect } from 'vitest'
import { assertPageAccess, PageAccessDenied, type RlsQuery } from '../clearance-gate.js'

// OSS single-player stub (oss-local-brain-wedge.md §12.3 #3): assertPageAccess
// makes ONLY the membership/clearance read now — the group/grant layer is
// dropped, so the role is always the workspace-member baseline `edit` for the
// single human connection. The injected query only needs to answer PAGE_ACCESS_SQL.
function makeQuery(
  access: { workspaceId: string; pageClearance: string | null; memberClearance: string | null } | null,
): RlsQuery {
  return async () => (access ? [access] : []) as never[]
}

describe('[COMP:doc-sync/clearance-gate] assertPageAccess', () => {
  it('denies when the user is not a workspace member (no row visible)', async () => {
    await expect(
      assertPageAccess({ userId: 'u', pageId: 'p', query: makeQuery(null) }),
    ).rejects.toBeInstanceOf(PageAccessDenied)
  })

  it('allows a member at/above clearance — always-grant role edit', async () => {
    const query = makeQuery({ workspaceId: 'w', pageClearance: 'internal', memberClearance: 'confidential' })
    await expect(assertPageAccess({ userId: 'u', pageId: 'p', query })).resolves.toEqual({
      workspaceId: 'w',
      clearance: 'internal',
      role: 'edit',
    })
  })

  it('denies a member whose clearance is below the page clearance', async () => {
    const query = makeQuery({ workspaceId: 'w', pageClearance: 'confidential', memberClearance: 'public' })
    await expect(
      assertPageAccess({ userId: 'u', pageId: 'p', query }),
    ).rejects.toMatchObject({ reason: 'insufficient_clearance' })
  })

  it('grants are dropped — a member always joins with role edit (no read-only downgrade)', async () => {
    const query = makeQuery({ workspaceId: 'w', pageClearance: 'public', memberClearance: 'confidential' })
    await expect(assertPageAccess({ userId: 'u', pageId: 'p', query })).resolves.toMatchObject({
      role: 'edit',
    })
  })
})
