import { describe, expect, it, vi } from 'vitest'
import type { ToolContext } from '@use-brian/core'
import { createLiveInteractionTools, type LiveInteractionUtterance } from '../live-interaction-tools.js'

const row = (id: string, text: string, startMs = 0): LiveInteractionUtterance => ({ id, text, startMs, endMs: startMs + 100, source: 'microphone' })
function fixture() {
  const rows = [row('one', 'Budget agreed yesterday')]
  const assertAccess = vi.fn(async () => {})
  const tools = createLiveInteractionTools({ read: async () => rows, assertAccess, scopeId: 'capture-a' })
  const call = async (name: string, input = {}) => (await tools.get(name)!.execute(input, {} as ToolContext)).data as {
    cursor: string; nextCursor: string; revision: number; method: string; degraded: boolean;
    hits: Array<LiveInteractionUtterance & { citation: string }>; missingReferences: string[]
  }
  return { rows, assertAccess, tools, call }
}
describe('[COMP:recordings/live-interaction] retrieval', () => {
  it('reads persisted speech arriving after job start, including late and revised utterances', async () => {
    const f = fixture()
    const first = await f.call('readLiveTranscriptRange')
    f.rows.push(row('two', 'Budget is now approved', 1000), row('late', 'Late budget context', 10))
    const next = await f.call('readLiveTranscriptRange', { afterCursor: first.cursor, limit: 1 })
    expect(next.hits.map(h => h.id)).toEqual(['late'])
    const page = await f.call('readLiveTranscriptRange', { afterCursor: next.nextCursor })
    expect(page.hits.map(h => h.id)).toEqual(['two'])
    expect((await f.call('searchLiveTranscript', { query: 'approved' })).hits[0]?.id).toBe('two')
    f.rows[0]!.text = 'Budget corrected'
    const revised = await f.call('readLiveTranscriptRange', { afterCursor: page.cursor })
    expect(revised.hits[0]?.citation).not.toBe(first.hits[0]?.citation)
    expect((await f.call('readLiveTranscriptRange', { references: [first.hits[0]!.citation] })).missingReferences).toEqual([first.hits[0]!.citation])
    expect(f.assertAccess.mock.calls.length).toBeGreaterThan(6)
  })
  it('keeps citations stable, isolates scopes and rejects guessed IDs/scope inputs', async () => {
    const f = fixture()
    const first = await f.call('readLiveTranscriptRange')
    expect((await f.call('readLiveTranscriptRange')).hits[0]?.citation).toBe(first.hits[0]?.citation)
    expect((await f.call('readLiveTranscriptRange', { references: ['secret-other-capture'] })).hits).toEqual([])
    const other = createLiveInteractionTools({ scopeId: 'capture-b', read: async () => f.rows, assertAccess: async () => {} })
    const result = await other.get('readLiveTranscriptRange')!.execute({}, {} as ToolContext)
    expect(JSON.stringify(result.data)).not.toContain(first.hits[0]!.citation)
    await expect(other.get('readLiveTranscriptRange')!.execute({ afterCursor: first.cursor }, {} as ToolContext)).rejects.toThrow('Foreign')
    await expect(f.call('searchLiveTranscript', { query: 'budget', scopeId: 'other' })).rejects.toThrow()
    f.assertAccess.mockRejectedValue(new Error('revoked'))
    for (const name of f.tools.keys()) await expect(f.call(name, name === 'readLiveTranscriptRange' ? {} : { query: 'budget' })).rejects.toThrow('revoked')
  })
  it('supports time ranges and surrounding context with exact evidence', async () => {
    const f = fixture()
    f.rows.push(row('two', 'second', 1000), row('three', 'third', 2000))
    expect((await f.call('readLiveTranscriptRange', { startMs: 1000, endMs: 1100 })).hits.map(h => h.id)).toEqual(['two'])
    expect((await f.call('readLiveTranscriptRange', { references: ['two'], surroundingContext: 1 })).hits).toHaveLength(3)
  })
  it('labels fallback honestly and refreshes embeddings when text changes', async () => {
    const f = fixture()
    expect(await f.call('findSimilarLiveTranscript', { query: 'budget' })).toMatchObject({ method: 'lexical-fallback', degraded: true })
    const embed = vi.fn(async (texts: string[]) => texts.map(() => [1, 0]))
    const tools = createLiveInteractionTools({ scopeId: 'a', read: async () => f.rows, assertAccess: f.assertAccess, embedder: { embed } })
    const call = () => tools.get('findSimilarLiveTranscript')!.execute({ query: 'budget' }, {} as ToolContext)
    expect((await call()).data).toMatchObject({ method: 'semantic-recent-tail', degraded: false })
    await call()
    expect(embed.mock.calls[1]![0]).toEqual(['budget'])
    f.rows[0]!.text = 'Updated budget'
    await call()
    expect(embed.mock.calls[2]![0]).toContain('Updated budget')
    embed.mockRejectedValueOnce(new Error('offline'))
    expect((await call()).data).toMatchObject({ method: 'lexical-fallback', degraded: true })
  })
})
