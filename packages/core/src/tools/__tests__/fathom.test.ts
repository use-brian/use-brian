import { describe, it, expect, vi } from 'vitest'
import { createFathomTools, type FathomApi } from '../base/fathom.js'
import { ConnectorApiError } from '../base/_connector-result.js'

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

  it('surfaces an integer recording_id (and created_at) so per-recording calls work', async () => {
    // Fathom's GET /meetings returns recording_id as an INTEGER and the
    // timestamp as `created_at`; the share-URL slug is NOT the recording_id.
    // If the projector drops the integer id, the model is forced to scrape
    // the slug out of `url` and every fathomGetSummary(slug) then 404s.
    const api = fakeApi({
      listMeetings: vi.fn().mockResolvedValue({
        items: [
          {
            recording_id: 716959348,
            title: '6 pm PT - Draper Dragon',
            created_at: '2026-06-19T01:00:00Z',
            url: 'https://fathom.video/calls/abc123',
            default_summary: null,
          },
        ],
      }),
    })
    const tool = createFathomTools(api).find((t) => t.name === 'fathomListMeetings')!

    const result = await tool.execute({}, NULL_CTX)
    const item = (result.data as { items: Array<Record<string, unknown>> }).items[0]

    expect(item.recording_id).toBe('716959348')
    expect(item.recorded_at).toBe('2026-06-19T01:00:00Z')
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
    expect(String(result.data)).toContain('Fathom `fathomGetMeeting` on recording `m1` failed')
    expect(String(result.data)).toContain('Fathom token is invalid')
  })

  it('renders a 404 on the summary endpoint as "still processing" with the list-with-summary pointer', async () => {
    const api = fakeApi({
      getSummary: vi.fn().mockRejectedValue(new ConnectorApiError({ provider: 'Fathom', status: 404, message: 'Not Found' })),
    })
    const tool = createFathomTools(api).find((t) => t.name === 'fathomGetSummary')!
    const result = await tool.execute({ meetingId: 'm1' }, NULL_CTX)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('STILL PROCESSING')
    expect(String(result.data)).toContain('fathomListMeetings')
    expect(String(result.data)).toContain('includeSummary: true')
  })

  it('renders a dead token with (401) + "invalid or expired" + reconnect', async () => {
    const api = fakeApi({
      getMeeting: vi.fn().mockRejectedValue(
        new ConnectorApiError({ provider: 'Fathom', status: 401, kind: 'auth', message: 'the Fathom token is invalid or expired. Reconnect Fathom in Studio → Connectors.' }),
      ),
    })
    const tool = createFathomTools(api).find((t) => t.name === 'fathomGetMeeting')!
    const result = await tool.execute({ meetingId: 'm1' }, NULL_CTX)
    expect(String(result.data)).toContain('(401)')
    expect(String(result.data)).toContain('invalid or expired')
    expect(String(result.data)).toContain('Reconnect Fathom (Studio → Connectors)')
  })
})
