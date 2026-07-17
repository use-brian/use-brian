import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../client.js', () => ({
  query: vi.fn(),
  queryWithRLS: vi.fn(),
  getPool: vi.fn(),
}))

import {
  getWorkspaceTranscriptionPrefs,
  setWorkspaceTranscriptionPrefs,
} from '../workspace-store.js'
import { query } from '../client.js'

const mockQuery = vi.mocked(query)

beforeEach(() => {
  vi.clearAllMocks()
})

const WS = 'ws-1'
const USER = 'user-1'

describe('[COMP:workspace/transcription-prefs] getWorkspaceTranscriptionPrefs', () => {
  it('returns the stored prefs', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ transcription_prefs: { chineseScript: 'traditional' } }],
    } as never)
    await expect(getWorkspaceTranscriptionPrefs(WS)).resolves.toEqual({
      chineseScript: 'traditional',
    })
  })

  it('degrades malformed JSONB to {} instead of throwing', async () => {
    mockQuery.mockResolvedValueOnce({
      rows: [{ transcription_prefs: { chineseScript: 'kanji', languageCode: 42 } }],
    } as never)
    await expect(getWorkspaceTranscriptionPrefs(WS)).resolves.toEqual({})
  })

  it('degrades a lookup failure to {} — a prefs error must never block a recording', async () => {
    mockQuery.mockRejectedValueOnce(new Error('connection refused'))
    await expect(getWorkspaceTranscriptionPrefs(WS)).resolves.toEqual({})
  })

  it('returns {} for a missing workspaceId without querying', async () => {
    await expect(getWorkspaceTranscriptionPrefs(null)).resolves.toEqual({})
    expect(mockQuery).not.toHaveBeenCalled()
  })
})

describe('[COMP:workspace/transcription-prefs] setWorkspaceTranscriptionPrefs', () => {
  it('rejects a plain member with a distinguishable not_admin outcome', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ role: 'member' }] } as never)
    const res = await setWorkspaceTranscriptionPrefs(USER, WS, { chineseScript: 'traditional' })
    expect(res).toMatchObject({ ok: false, reason: 'not_admin' })
    expect(mockQuery).toHaveBeenCalledTimes(1) // never reaches the read/write
  })

  it('rejects a non-member the same way', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] } as never)
    const res = await setWorkspaceTranscriptionPrefs(USER, WS, { chineseScript: 'traditional' })
    expect(res).toMatchObject({ ok: false, reason: 'not_admin' })
  })

  it('merges the patch into existing prefs and writes the validated value', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'admin' }] } as never)
      .mockResolvedValueOnce({ rows: [{ transcription_prefs: { languageCode: 'en' } }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
    const res = await setWorkspaceTranscriptionPrefs(USER, WS, { chineseScript: 'traditional' })
    expect(res).toEqual({ ok: true, prefs: { languageCode: 'en', chineseScript: 'traditional' } })
    const [sql, params] = mockQuery.mock.calls[2]
    expect(sql).toContain('UPDATE workspaces SET transcription_prefs')
    expect(JSON.parse((params as string[])[1])).toEqual({
      languageCode: 'en',
      chineseScript: 'traditional',
    })
  })

  it('clears a key when the patch value is null', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as never)
      .mockResolvedValueOnce({
        rows: [{ transcription_prefs: { languageCode: 'yue', chineseScript: 'traditional' } }],
      } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
    const res = await setWorkspaceTranscriptionPrefs(USER, WS, { languageCode: null })
    expect(res).toEqual({ ok: true, prefs: { chineseScript: 'traditional' } })
  })

  it('returns not_found when the workspace row is gone', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ role: 'owner' }] } as never)
      .mockResolvedValueOnce({ rows: [] } as never)
    const res = await setWorkspaceTranscriptionPrefs(USER, WS, { chineseScript: 'simplified' })
    expect(res).toMatchObject({ ok: false, reason: 'not_found' })
  })
})
