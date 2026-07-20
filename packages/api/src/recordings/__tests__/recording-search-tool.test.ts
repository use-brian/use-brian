import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { RetrievalActor, ToolContext } from '@use-brian/core'

// Mock the retrieval store so the tool's routing + closure-binding can be
// asserted with no DB. vi.hoisted keeps the mock fns referenceable from the
// hoisted vi.mock factory.
const { searchRecordingMock, readRecordingRangeMock } = vi.hoisted(() => ({
  searchRecordingMock: vi.fn(),
  readRecordingRangeMock: vi.fn(),
}))

vi.mock('../../db/retrieval-store.js', () => ({
  searchRecording: searchRecordingMock,
  readRecordingRange: readRecordingRangeMock,
}))

import { createSearchRecordingTool } from '../recording-search-tool.js'

const ACTOR: RetrievalActor = {
  workspaceId: 'ws-1',
  userId: 'u-1',
  assistantId: 'a-1',
  assistantKind: 'standard',
  clearance: 'internal',
}
const RID = 'rec-123'
const CTX = {} as ToolContext

const make = () => createSearchRecordingTool({ recordingId: RID, actor: ACTOR })

describe('[COMP:recordings/recording-search-tool] searchRecording in-process tool', () => {
  beforeEach(() => {
    searchRecordingMock.mockReset().mockResolvedValue([])
    readRecordingRangeMock.mockReset().mockResolvedValue([])
  })

  it('binds recordingId in the closure — the schema has no recordingId input', () => {
    const parsed = make().inputSchema.parse({ recordingId: 'attacker-rec', query: 'hi' }) as Record<
      string,
      unknown
    >
    expect(parsed.recordingId).toBeUndefined() // unknown key stripped
    expect(parsed.query).toBe('hi')
  })

  it('searches with the closure recordingId (an input recordingId cannot override it)', async () => {
    await make().execute({ query: 'pricing', topK: 5 }, CTX)
    expect(searchRecordingMock).toHaveBeenCalledTimes(1)
    const [actor, input] = searchRecordingMock.mock.calls[0]
    expect(actor).toBe(ACTOR)
    expect(input).toMatchObject({ recordingId: RID, query: 'pricing', topK: 5 })
    expect(readRecordingRangeMock).not.toHaveBeenCalled()
  })

  it('routes to readRecordingRange when fromIndex is present (default 10-segment window)', async () => {
    await make().execute({ query: '', fromIndex: 4 }, CTX)
    expect(readRecordingRangeMock).toHaveBeenCalledTimes(1)
    const [, input] = readRecordingRangeMock.mock.calls[0]
    expect(input).toMatchObject({ recordingId: RID, fromIndex: 4, toIndex: 13 })
    expect(searchRecordingMock).not.toHaveBeenCalled()
  })

  it('honours an explicit toIndex', async () => {
    await make().execute({ query: '', fromIndex: 2, toIndex: 5 }, CTX)
    const [, input] = readRecordingRangeMock.mock.calls[0]
    expect(input).toMatchObject({ fromIndex: 2, toIndex: 5 })
  })

  it('clamps topK at the schema (max 20)', () => {
    const schema = make().inputSchema
    expect(schema.safeParse({ topK: 51 }).success).toBe(false)
    expect(schema.safeParse({ topK: 20 }).success).toBe(true)
  })

  it('returns isError when the store throws, never crashing the loop', async () => {
    searchRecordingMock.mockRejectedValueOnce(new Error('db down'))
    const res = await make().execute({ query: 'x' }, CTX)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('db down')
  })

  it('is read-only, concurrency-safe, and never prompts for confirmation', () => {
    const tool = make()
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
    expect(tool.requiresConfirmation).toBe(false)
  })
})
