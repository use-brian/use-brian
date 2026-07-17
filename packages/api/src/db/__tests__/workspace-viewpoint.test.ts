import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({ query: vi.fn() }))

import { resolveWorkspaceViewpoint } from '../workspace-viewpoint.js'
import { query } from '../client.js'

/**
 * A member's read viewpoint on a workspace. Component tag:
 * [COMP:brain/workspace-viewpoint].
 *
 * This is a SECURITY predicate. It was a private helper in `routes/brain.ts`
 * until the recordings transcript route needed the same answer; it was extracted
 * verbatim rather than reimplemented, because a security predicate that gets
 * retyped is one that drifts. These tests pin the properties that make it safe —
 * above all the incident-2026-06-01 rule: the clearance ceiling is
 * ASSISTANT-derived, and must be bounded by the acting MEMBER's own clearance,
 * or a low-clearance member browsing a workspace with a high-clearance assistant
 * reads above their tier.
 */

const mockQuery = vi.mocked(query)

/** membership row, then (optionally) the assistant pick. */
function stub(member: Record<string, unknown> | null, assistant?: Record<string, unknown>) {
  mockQuery.mockReset()
  mockQuery.mockResolvedValueOnce({ rows: member ? [member] : [] } as never)
  if (assistant !== undefined) {
    mockQuery.mockResolvedValueOnce({ rows: [assistant] } as never)
  }
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:brain/workspace-viewpoint] membership gate', () => {
  it('returns null for a non-member — membership is the access gate', async () => {
    stub(null)
    await expect(resolveWorkspaceViewpoint('u-1', 'ws-1')).resolves.toBeNull()
  })
})

describe('[COMP:brain/workspace-viewpoint] clearance ceiling', () => {
  it('bounds the assistant ceiling by the MEMBER clearance (incident 2026-06-01)', async () => {
    // A workspace whose highest assistant is `restricted`, browsed by a member
    // cleared only to `internal`. Before the incident fix the assistant's
    // ceiling won and the member read above their tier.
    stub(
      { role: 'member', clearance: 'internal', compartments: null },
      { id: 'a-hi', clearance: 'restricted' },
    )
    const ctx = await resolveWorkspaceViewpoint('u-1', 'ws-1')
    expect(ctx!.clearance).toBe('internal')
  })

  it('falls back to the workspace-wide highest-clearance assistant', async () => {
    stub({ role: 'owner', clearance: 'restricted', compartments: null }, { id: 'a-hi', clearance: 'confidential' })
    const ctx = await resolveWorkspaceViewpoint('u-1', 'ws-1')
    // The member out-clears the assistant, so the assistant is the binding cap.
    expect(ctx!.clearance).toBe('confidential')
    expect(ctx!.assistantId).toBe('a-hi')
  })

  it('honors an explicit in-workspace selection (the floating-pill picker)', async () => {
    stub({ role: 'owner', clearance: 'restricted', compartments: null }, { id: 'a-pub', clearance: 'public' })
    const ctx = await resolveWorkspaceViewpoint('u-1', 'ws-1', 'a-pub')
    // Picking a `public` assistant caps the surface at public.
    expect(ctx!.clearance).toBe('public')
    expect(ctx!.assistantId).toBe('a-pub')
  })

  it('treats a stale cross-workspace selection as absent, not an error', async () => {
    // The selected assistant is not in this workspace → the lookup misses, and
    // the resolver falls back to the workspace ceiling. Workspace switches must
    // not 500 while localStorage catches up.
    mockQuery.mockReset()
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'owner', clearance: 'restricted', compartments: null }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never) // stale selection: no match
      .mockResolvedValueOnce({ rows: [{ id: 'a-hi', clearance: 'internal' }] } as never)
    const ctx = await resolveWorkspaceViewpoint('u-1', 'ws-1', 'a-from-another-workspace')
    expect(ctx!.clearance).toBe('internal')
    expect(ctx!.assistantId).toBe('a-hi')
  })

  it('defaults to internal when the workspace has no assistant at all', async () => {
    stub({ role: 'owner', clearance: 'restricted', compartments: null }, undefined)
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    const ctx = await resolveWorkspaceViewpoint('u-1', 'ws-1')
    expect(ctx!.clearance).toBe('internal')
  })
})

describe('[COMP:brain/workspace-viewpoint] reflector branch', () => {
  it('is a primary reflector so the assistant_id partition is dropped', async () => {
    stub({ role: 'owner', clearance: 'restricted', compartments: null }, { id: 'a-hi', clearance: 'internal' })
    const ctx = await resolveWorkspaceViewpoint('u-1', 'ws-1')
    // The view must span EVERY assistant's rows in the workspace, bounded by the
    // ceiling — not just the viewpoint assistant's own rows.
    expect(ctx!.assistantKind).toBe('primary')
  })

  it('bounds a compartment-restricted member to their own compartments', async () => {
    stub({ role: 'member', clearance: 'internal', compartments: ['legal'] }, { id: 'a', clearance: 'internal' })
    const ctx = await resolveWorkspaceViewpoint('u-1', 'ws-1')
    expect(ctx!.compartments).toEqual(['legal'])
  })
})
