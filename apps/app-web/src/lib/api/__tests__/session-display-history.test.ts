import { beforeEach, describe, expect, it, vi } from 'vitest'
vi.mock('@/lib/auth-fetch', () => ({ authFetch: vi.fn() }))
import { authFetch } from '@/lib/auth-fetch'
import { readPersonalDisplayHistory } from '../sessions'
const fetch = vi.mocked(authFetch)
const session = '00000000-0000-4000-8000-000000000001', workspace = '00000000-0000-4000-8000-000000000002'
const row = { id: '00000000-0000-4000-8000-000000000003', sequence: 2, role: 'assistant', timestamp: '2026-01-01T00:00:00Z', available: true, text: 'Saved reply' }
const page = { sessionId: session, workspaceId: workspace, mode: 'personal_transcript_display', rows: [row], nextSequence: null }
function response(value: unknown) { return new Response(JSON.stringify(value), { status: 200, headers: { 'Content-Type': 'application/json' } }) }
beforeEach(() => { vi.resetAllMocks(); fetch.mockResolvedValue(response(page)) })
describe('[COMP:app-web/chat-display-history] display DTO', () => {
  it('uses the independent bounded no-store display port with cancellation', async () => {
    const controller = new AbortController()
    expect(await readPersonalDisplayHistory(session, workspace, 0, controller.signal)).toEqual(page)
    expect(fetch).toHaveBeenCalledWith(expect.stringContaining(`/api/sessions/${session}/display-history?workspaceId=${workspace}&afterSequence=0&limit=100`), { signal: controller.signal, cache: 'no-store' })
  })
  it.each([
    { ...page, sessionId: workspace }, { ...page, workspaceId: session }, { ...page, mode: 'private_legacy_history' },
    { ...page, rows: [row, row] }, { ...page, rows: [{ ...row, sequence: 0 }] },
    { ...page, rows: [{ ...row, available: false }] }, { ...page, rows: [{ ...row, text: null }] },
    { ...page, rows: [{ ...row, timestamp: 'invalid' }] }, { ...page, nextSequence: 1 },
  ])('rejects mismatched, unordered or contradictory display evidence %#', async value => {
    fetch.mockResolvedValueOnce(response(value))
    await expect(readPersonalDisplayHistory(session, workspace, 0)).rejects.toThrow()
  })
  it('keeps unavailable rows explicit and refuses denied responses', async () => {
    fetch.mockResolvedValueOnce(response({ ...page, rows: [{ ...row, available: false, text: null }] }))
    expect((await readPersonalDisplayHistory(session, workspace, 0)).rows[0]).toEqual({ ...row, available: false, text: null })
    fetch.mockResolvedValueOnce(new Response(null, { status: 403 }))
    await expect(readPersonalDisplayHistory(session, workspace, 0)).rejects.toThrow('personal_display_history_failed: 403')
  })
})
