import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({ queryWithRLS: vi.fn() }))

import { queryWithRLS } from '../client.js'
import { readWorkspacePageDirectory } from '../page-directory.js'

const query = vi.mocked(queryWithRLS)
const userId = '00000000-0000-4000-8000-000000000001'
const workspaceId = '00000000-0000-4000-8000-000000000010'
const pages = [{ id: '00000000-0000-4000-8000-000000000100', title: 'Current plan' }]

describe('[COMP:api/page-directory] coherent publication', () => {
  beforeEach(() => vi.clearAllMocks())

  it('publishes only an identical second membership and RLS-bound snapshot', async () => {
    query.mockResolvedValueOnce({ rows: [{ pages, validForMs: 12_000 }] } as never)
      .mockResolvedValueOnce({ rows: [{ pages, validForMs: 11_900 }] } as never)
    const reply = await readWorkspacePageDirectory(userId, workspaceId)
    expect(reply.status).toBe(200)
    expect(reply.status === 200 && reply.body).toMatchObject({ workspaceId, viewerId: userId, pages })
    expect(query).toHaveBeenCalledTimes(2)
    expect(query.mock.calls[0]?.[0]).toBe(userId)
    expect(query.mock.calls[0]?.[1]).toContain('FROM saved_views')
    expect(query.mock.calls[0]?.[1]).toContain('workspace_members')
  })

  it('returns the same unavailable shape when the caller membership is absent', async () => {
    query.mockResolvedValueOnce({ rows: [] } as never)
    await expect(readWorkspacePageDirectory(userId, workspaceId)).resolves.toEqual({
      status: 404,
      body: { error: 'page_directory_unavailable' },
    })
  })

  it('refuses when the visible page set or title changes between snapshots', async () => {
    query.mockResolvedValueOnce({ rows: [{ pages, validForMs: 12_000 }] } as never)
      .mockResolvedValueOnce({ rows: [{ pages: [{ ...pages[0]!, title: 'Renamed' }], validForMs: 11_900 }] } as never)
    await expect(readWorkspacePageDirectory(userId, workspaceId)).resolves.toEqual({
      status: 409,
      body: { error: 'page_directory_changed' },
    })
  })

  it('refuses an exhausted department-derived lifetime', async () => {
    query.mockResolvedValue({ rows: [{ pages, validForMs: 0 }] } as never)
    await expect(readWorkspacePageDirectory(userId, workspaceId)).resolves.toEqual({
      status: 404,
      body: { error: 'page_directory_unavailable' },
    })
  })
})
