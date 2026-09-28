import { describe, expect, it, vi } from 'vitest'
import { meetingTagsStore } from '../meeting-tags-store.js'
import { emptyTagState, setManualTags } from '../../recordings/meeting-tags.js'
const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('../client.js', () => ({ queryWithRLS: mocks.query }))
describe('[COMP:recordings/meeting-tags] caller-scoped store', () => {
  it('retries a conflicting update against the new version rather than overwriting it', async () => {
    mocks.query.mockReset().mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ data: emptyTagState(), version: 1 }] }).mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ data: { ...emptyTagState(), dismissed: ['keep'] }, version: 2 }] }).mockResolvedValueOnce({ rows: [{ page_id: 'page' }] })
    const result = await meetingTagsStore.change('user', 'page', (state) => setManualTags(state, ['Custom']))
    expect(result.dismissed).toEqual(['keep'])
    expect(mocks.query.mock.calls.every(([user]) => user === 'user')).toBe(true)
    expect(mocks.query.mock.calls[4][2][2]).toBe(2)
  })
  it('restricts learning to visible manual examples with matching source scope', async () => {
    mocks.query.mockReset().mockResolvedValue({ rows: [] })
    await meetingTagsStore.examples('user', 'folder')
    const [user, sql, params] = mocks.query.mock.calls[0]
    expect(user).toBe('user'); expect(params).toEqual(['folder'])
    expect(sql).toContain('p.clearance=f.clearance')
    expect(sql).toContain('p.teamspace_id IS NOT DISTINCT FROM f.teamspace_id')
    expect(sql).toContain('p.project_id IS NOT DISTINCT FROM f.project_id')
    expect(sql).toContain('"source":"manual"')
  })
})
