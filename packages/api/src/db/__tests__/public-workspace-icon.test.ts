/**
 * [COMP:api/workspace-icon] Public pages read the workspace picture URL and
 * landmark seed, and a lookup failure does not fail the page.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../client.js', () => ({ query: vi.fn() }))

import { query } from '../client.js'
import { getPublicWorkspaceIcon } from '../workspace-icon.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  mockQuery.mockReset()
})

describe('[COMP:api/workspace-icon] public page identity', () => {
  it('returns the uploaded picture URL and landmark seed', async () => {
    mockQuery.mockResolvedValue({
      rows: [{ iconUrl: 'https://api.example/api/workspace-icons/ws-1?v=ab', iconSeed: 42 }],
    } as never)
    await expect(getPublicWorkspaceIcon('ws-1')).resolves.toEqual({
      url: 'https://api.example/api/workspace-icons/ws-1?v=ab',
      seed: 42,
    })
  })

  it('uses no picture and seed 0 when the workspace row is missing', async () => {
    mockQuery.mockResolvedValue({ rows: [] } as never)
    await expect(getPublicWorkspaceIcon('missing')).resolves.toEqual({ url: null, seed: 0 })
  })

  it('falls back when the lookup fails so the page can still render', async () => {
    mockQuery.mockRejectedValue(new Error('db down'))
    await expect(getPublicWorkspaceIcon('ws-1')).resolves.toEqual({ url: null, seed: 0 })
  })
})
