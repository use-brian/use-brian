import { describe, it, expect, vi } from 'vitest'
import { createFathomTools, type FathomApi } from '../base/fathom.js'

function fakeApi(overrides: Partial<FathomApi> = {}): FathomApi {
  return {
    listMeetings: vi.fn().mockResolvedValue({ items: [] }),
    getMeeting: vi.fn().mockResolvedValue({ id: 'm1', title: 'Test' }),
    getTranscript: vi.fn().mockResolvedValue({ entries: [] }),
    getSummary: vi.fn().mockResolvedValue({ summary: 'ok' }),
    ...overrides,
  }
}

const NULL_CTX = {
  userId: 'test-user',
  assistantId: 'test-assistant',
  sessionId: 'test-session',
  appId: 'test',
  channelType: 'web' as const,
  channelId: 'test-channel',
  abortSignal: new AbortController().signal,
}

describe('[COMP:tools/fathom] Fathom tools', () => {
  it('exposes the four read-only tools in registry order', () => {
    const tools = createFathomTools(fakeApi())
    expect(tools.map((t) => t.name)).toEqual([
      'fathomListMeetings',
      'fathomGetMeeting',
      'fathomGetTranscript',
      'fathomGetSummary',
    ])
    for (const t of tools) {
      expect(t.isReadOnly).toBe(true)
      expect(t.isConcurrencySafe).toBe(true)
      expect(t.requiresConfirmation ?? false).toBe(false)
    }
  })

  it('fathomListMeetings forwards include flags and cursor', async () => {
    const api = fakeApi()
    const tool = createFathomTools(api).find((t) => t.name === 'fathomListMeetings')!

    await tool.execute(
      {
        cursor: 'abc',
        limit: 10,
        includeTranscript: true,
        includeSummary: true,
        includeActionItems: true,
      },
      NULL_CTX,
    )

    expect(api.listMeetings).toHaveBeenCalledWith({
      cursor: 'abc',
      limit: 10,
      recordedAfter: undefined,
      recordedBefore: undefined,
      includeTranscript: true,
      includeSummary: true,
      includeActionItems: true,
      includeCrmMatches: undefined,
    })
  })

  it('returns the API payload as data on success', async () => {
    const api = fakeApi({
      getTranscript: vi.fn().mockResolvedValue({ entries: [{ speaker: 'A', text: 'hi' }] }),
    })
    const tool = createFathomTools(api).find((t) => t.name === 'fathomGetTranscript')!

    const result = await tool.execute({ meetingId: 'm1' }, NULL_CTX)

    expect(result.isError).toBeUndefined()
    expect(result.data).toEqual({ entries: [{ speaker: 'A', text: 'hi' }] })
  })

  it('wraps API errors as isError results without throwing', async () => {
    const api = fakeApi({
      getMeeting: vi.fn().mockRejectedValue(new Error('Fathom token is invalid')),
    })
    const tool = createFathomTools(api).find((t) => t.name === 'fathomGetMeeting')!

    const result = await tool.execute({ meetingId: 'm1' }, NULL_CTX)

    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('Fathom error')
    expect(String(result.data)).toContain('Fathom token is invalid')
  })
})
