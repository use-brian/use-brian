import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'

const searchRecording = vi.fn()
const readRecordingRange = vi.fn()
vi.mock('../../db/retrieval-store.js', () => ({
  searchRecording: (...a: unknown[]) => searchRecording(...a),
  readRecordingRange: (...a: unknown[]) => readRecordingRange(...a),
}))

const listRecordings = vi.fn()
vi.mock('../../db/recordings-store.js', () => ({
  listRecordings: (...a: unknown[]) => listRecordings(...a),
  LIST_RECORDINGS_LIMIT_DEFAULT: 20,
  LIST_RECORDINGS_LIMIT_MAX: 100,
}))

import {
  createChatSearchRecordingTool,
  createListRecordingsTool,
} from '../recording-chat-tools.js'

/**
 * The recording surface for chat. Component tag:
 * [COMP:recordings/recording-chat-tools].
 *
 * Two axes, neither redundant: listRecordings is TEMPORAL ("Tuesday's call" —
 * a lookup semantic search structurally cannot do), searchRecording is
 * PRECISION inside one recording (what, who, and WHEN).
 */

/** A real uuid: the schema validates `recordingId`, so 'rec-1' could never
 *  reach execute() in production. */
const REC_ID = '92e52d5a-ef0c-46d7-875e-fce8dc83ec6f'

const CTX = {
  userId: 'u-1',
  assistantId: 'a-1',
  sessionId: 's-1',
  appId: 'app',
  channelType: 'web',
  channelId: 'c-1',
  workspaceId: 'ws-1',
  clearance: 'internal',
  compartments: [],
} as never

/** No workspace bind — retrieval has no defined permission boundary. */
const CTX_NO_WS = { ...(CTX as object), workspaceId: null } as never

beforeEach(() => {
  vi.clearAllMocks()
  listRecordings.mockResolvedValue([])
  searchRecording.mockResolvedValue([])
  readRecordingRange.mockResolvedValue([])
})

describe('[COMP:recordings/recording-chat-tools] searchRecording', () => {
  it('takes recordingId as a MODEL INPUT (unlike the pinned synthesis twin)', async () => {
    const tool = createChatSearchRecordingTool()
    // Choosing the recording IS the job in chat. The synthesis-loop twin binds
    // recordingId in its closure precisely so it CANNOT pivot; that would be
    // exactly wrong here. Assert the schema actually accepts it, rather than
    // reaching into zod internals.
    expect(tool.inputSchema.safeParse({ recordingId: REC_ID, query: 'x' }).success).toBe(true)
    expect(tool.inputSchema.safeParse({ query: 'x' }).success).toBe(false)
    // And it must be a real id — a non-uuid never reaches the store.
    expect(tool.inputSchema.safeParse({ recordingId: 'rec-1', query: 'x' }).success).toBe(false)

    await tool.execute({ recordingId: REC_ID, query: 'pricing' }, CTX)
    expect(searchRecording).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws-1', userId: 'u-1' }),
      expect.objectContaining({ recordingId: REC_ID, query: 'pricing' }),
      undefined,
    )
  })

  it('rebuilds the actor from the ToolContext, so read ceilings hold per call', async () => {
    const tool = createChatSearchRecordingTool()
    await tool.execute({ recordingId: REC_ID, query: 'x' }, CTX)
    const [actor] = searchRecording.mock.calls[0]
    expect(actor).toMatchObject({
      workspaceId: 'ws-1',
      userId: 'u-1',
      assistantId: 'a-1',
      clearance: 'internal',
    })
  })

  it('refuses a session with no workspace rather than searching unscoped', async () => {
    const tool = createChatSearchRecordingTool()
    const res = await tool.execute({ recordingId: REC_ID, query: 'x' }, CTX_NO_WS)
    expect(res.isError).toBe(true)
    expect(searchRecording).not.toHaveBeenCalled()
  })

  it('routes fromIndex to the range read (overview paging, not top-K)', async () => {
    const tool = createChatSearchRecordingTool()
    await tool.execute({ recordingId: REC_ID, query: '', fromIndex: 20 }, CTX)
    expect(readRecordingRange).toHaveBeenCalledWith(
      expect.anything(),
      { recordingId: REC_ID, fromIndex: 20, toIndex: 29 }, // default 10-wide window
    )
    expect(searchRecording).not.toHaveBeenCalled()
  })

  it('returns an error body instead of throwing into the loop', async () => {
    searchRecording.mockRejectedValue(new Error('db down'))
    const tool = createChatSearchRecordingTool()
    const res = await tool.execute({ recordingId: REC_ID, query: 'x' }, CTX)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('db down')
  })

  it('is read-only and concurrency-safe', () => {
    const tool = createChatSearchRecordingTool()
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
    expect(tool.requiresConfirmation).toBe(false)
  })
})

describe('[COMP:recordings/recording-chat-tools] listRecordings', () => {
  it('resolves "Tuesday\'s call" — the temporal lookup', async () => {
    const tool = createListRecordingsTool()
    await tool.execute(
      { kind: 'meeting', since: '2026-07-14T00:00:00Z', until: '2026-07-15T00:00:00Z' },
      CTX,
    )
    expect(listRecordings).toHaveBeenCalledWith(
      'u-1',
      'ws-1',
      expect.objectContaining({
        kind: 'meeting',
        since: new Date('2026-07-14T00:00:00Z'),
        until: new Date('2026-07-15T00:00:00Z'),
      }),
      {},
    )
  })

  it('rejects a malformed date instead of silently listing everything', async () => {
    const tool = createListRecordingsTool()
    const res = await tool.execute({ since: 'last tuesday' }, CTX)
    // Coercing this to Invalid Date and dropping the filter would hand the
    // model a confidently wrong answer.
    expect(res.isError).toBe(true)
    expect(listRecordings).not.toHaveBeenCalled()
  })

  it('returns metadata only — never transcript text', async () => {
    listRecordings.mockResolvedValue([
      {
        id: 'rec-1',
        title: 'Client call',
        fileName: 'call.m4a',
        kind: 'meeting',
        status: 'processed',
        createdAt: new Date('2026-07-14T10:00:00Z'),
        durationMs: 5_735_000,
        truncated: false,
        transcriptFileId: 'wf-1',
        gcsKey: 'ws-1/recordings/secret-key',
        storageUri: 'gs://bucket/ws-1/recordings/secret-key',
      },
    ])
    const tool = createListRecordingsTool()
    const res = await tool.execute({}, CTX)
    const rows = res.data as Array<Record<string, unknown>>
    expect(rows[0]).toEqual({
      recordingId: 'rec-1',
      title: 'Client call',
      kind: 'meeting',
      status: 'processed',
      occurredAt: new Date('2026-07-14T10:00:00Z'),
      durationMs: 5_735_000,
      truncated: false,
      hasTranscript: true,
    })
    // Infrastructure is not something to hand a model.
    expect(rows[0]).not.toHaveProperty('gcsKey')
    expect(rows[0]).not.toHaveProperty('storageUri')
  })

  it('falls back to the file name when no title is set', async () => {
    listRecordings.mockResolvedValue([
      { id: 'r', title: null, fileName: 'raw.m4a', kind: 'memo', status: 'processed', createdAt: new Date(), durationMs: null, truncated: false, transcriptFileId: null },
    ])
    const tool = createListRecordingsTool()
    const rows = (await tool.execute({}, CTX)).data as Array<Record<string, unknown>>
    expect(rows[0].title).toBe('raw.m4a')
    expect(rows[0].hasTranscript).toBe(false)
  })

  it('refuses a session with no workspace', async () => {
    const tool = createListRecordingsTool()
    const res = await tool.execute({}, CTX_NO_WS)
    expect(res.isError).toBe(true)
    expect(listRecordings).not.toHaveBeenCalled()
  })

  it('returns an error body instead of throwing into the loop', async () => {
    listRecordings.mockRejectedValue(new Error('db down'))
    const tool = createListRecordingsTool()
    const res = await tool.execute({}, CTX)
    expect(res.isError).toBe(true)
  })
})

/**
 * REGISTRATION. A tool that exists, works, and is not in the base tools map is
 * invisible — which is exactly what happened to `searchRecording`: it was
 * written, correct, and reachable only from the external brain-MCP surface and
 * the synthesis loop, so chat could never answer "what did we decide on
 * Tuesday's call?" no matter how good the tool was.
 *
 * boot.ts cannot be imported here (it is the composition root and pulls in the
 * world), so this reads the source. Coarse, but it fails loudly if someone drops
 * the registration — which is the whole regression worth catching.
 */
describe('[COMP:recordings/recording-chat-tools] registration in the base tool map', () => {
  const boot = readFileSync(
    new URL('../../boot.ts', import.meta.url),
    'utf8',
  )

  it('registers searchRecording and listRecordings', () => {
    expect(boot).toMatch(/tools\.set\(\s*'searchRecording'/)
    expect(boot).toMatch(/tools\.set\('listRecordings'/)
  })

  it('registers them at the SAME seam as searchFileContent (the base map)', () => {
    // The base `tools` map — not a chat-only map — is what makes chat, the
    // callee executor, and workflows carry them by construction. Anchoring on
    // searchFileContent pins the seam: if someone moves the recording tools to
    // a chat-only map later, this fails.
    const fileSeam = boot.indexOf("tools.set(\n      'searchFileContent'")
    const recSeam = boot.indexOf("tools.set(\n      'searchRecording'")
    expect(fileSeam).toBeGreaterThan(-1)
    expect(recSeam).toBeGreaterThan(fileSeam)
  })
})
