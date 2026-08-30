/**
 * [COMP:api/workspace-home-apps] — the Home app-bar config store pair.
 *
 * `workspaces` carries no RLS, so `setWorkspaceHomeApps` is the enforcement
 * point for BOTH halves of the contract: admin/owner membership, and the app
 * vocabulary. This suite pins each, plus the read side's null-safety — the
 * app-bar is navigation on every authenticated surface, so a config read that
 * fails must degrade to the default strip rather than leave the user with no
 * navigation at all.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  queryGated: vi.fn(),
  getPool: vi.fn(),
  getAppPool: vi.fn(),
  rollbackAndRelease: vi.fn(),
}))

import { getWorkspaceHomeApps, setWorkspaceHomeApps } from '../workspace-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
})

/** Membership lookup → UPDATE, the setter's two-query shape. */
function asRole(role: string | undefined) {
  mockQuery.mockResolvedValueOnce({
    rows: role ? [{ role }] : [],
    rowCount: role ? 1 : 0,
  } as never)
}

describe('[COMP:api/workspace-home-apps] getWorkspaceHomeApps', () => {
  it('returns the stored strip', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ home_apps: ['chat', 'page'] }],
      rowCount: 1,
    } as never)
    expect(await getWorkspaceHomeApps('ws-1')).toEqual(['chat', 'page'])
  })

  it("treats '[]' as unset and resolves the built-in default", async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ home_apps: [] }], rowCount: 1 } as never)
    expect(await getWorkspaceHomeApps('ws-1')).toEqual(['page', 'office', 'chat'])
  })

  it('filters an entry this build does not know (additive contract)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ home_apps: ['page', 'live', 'holodeck', 'chat'] }],
      rowCount: 1,
    } as never)
    expect(await getWorkspaceHomeApps('ws-1')).toEqual(['page', 'chat'])
  })

  it('drops a custom app the workspace cannot render (T3 drift → hidden)', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ home_apps: ['page', 'custom:a', 'custom:b'] }],
      rowCount: 1,
    } as never)
    expect(
      await getWorkspaceHomeApps('ws-1', { knownCustomIds: new Set(['a']) }),
    ).toEqual(['page', 'custom:a'])
  })

  it('degrades to the default strip when the read throws', async () => {
    // The app-bar is navigation on every authenticated surface — a config
    // lookup failure must never take the shell down.
    mockQuery.mockRejectedValueOnce(new Error('DB down'))
    expect(await getWorkspaceHomeApps('ws-1')).toEqual(['page', 'office', 'chat'])
  })

  it('handles a missing workspace and a missing id', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await getWorkspaceHomeApps('ws-gone')).toEqual(['page', 'office', 'chat'])
    expect(await getWorkspaceHomeApps(null)).toEqual(['page', 'office', 'chat'])
  })
})

describe('[COMP:api/workspace-home-apps] setWorkspaceHomeApps', () => {
  it('refuses a plain member (workspaces has no RLS — the setter IS the gate)', async () => {
    asRole('member')
    const result = await setWorkspaceHomeApps('u-1', 'ws-1', ['page'])
    expect(result).toMatchObject({ ok: false, reason: 'not_admin' })
    // The UPDATE must not have run.
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('refuses a non-member', async () => {
    asRole(undefined)
    expect(await setWorkspaceHomeApps('u-1', 'ws-1', ['page'])).toMatchObject({
      ok: false,
      reason: 'not_admin',
    })
  })

  it('accepts an owner and an admin', async () => {
    for (const role of ['owner', 'admin']) {
      mockQuery.mockReset()
      asRole(role)
      mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
      expect(await setWorkspaceHomeApps('u-1', 'ws-1', ['page', 'chat'])).toEqual({
        ok: true,
        homeApps: ['page', 'chat'],
      })
    }
  })

  it('accepts custom app entries alongside built-ins', async () => {
    asRole('admin')
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 } as never)
    expect(
      await setWorkspaceHomeApps('u-1', 'ws-1', ['page', 'custom:abc']),
    ).toEqual({ ok: true, homeApps: ['page', 'custom:abc'] })
  })

  it('rejects an unknown key rather than silently dropping it', async () => {
    // Dropping it would show the admin a strip they did not choose.
    asRole('admin')
    const result = await setWorkspaceHomeApps('u-1', 'ws-1', ['page', 'holodeck'])
    expect(result).toMatchObject({ ok: false, reason: 'invalid' })
    expect(mockQuery).toHaveBeenCalledTimes(1)
  })

  it('rejects an empty strip, a duplicate, and more than seven', async () => {
    for (const bad of [
      [],
      ['page', 'page'],
      ['page', 'office', 'tasks', 'crm', 'feed', 'browsers', 'chat', 'custom:x'],
    ]) {
      mockQuery.mockReset()
      asRole('admin')
      expect(await setWorkspaceHomeApps('u-1', 'ws-1', bad)).toMatchObject({
        ok: false,
        reason: 'invalid',
      })
    }
  })

  it('reports a missing workspace instead of claiming success', async () => {
    asRole('admin')
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 } as never)
    expect(await setWorkspaceHomeApps('u-1', 'ws-gone', ['page'])).toMatchObject({
      ok: false,
      reason: 'not_found',
    })
  })
})
