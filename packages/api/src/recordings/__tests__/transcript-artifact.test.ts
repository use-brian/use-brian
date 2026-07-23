import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTranscriptArtifactWriter } from '../transcript-artifact.js'

const input = {
  recordingId: 'rec-1',
  workspaceId: 'ws-1',
  actingUserId: 'user-1',
  assistantId: 'assistant-1',
  sensitivity: 'confidential',
  title: 'Weekly call.m4a',
  utterances: [
    { startMs: 0, speaker: 'Ken', text: 'kicking off' },
    { startMs: 2_841_000, speaker: 'Priya', text: 'pushed back on pricing' },
  ],
}

function filesApi(overrides: Record<string, unknown> = {}) {
  return {
    writeBytes: vi.fn(async () => ({
      ok: true as const,
      value: { id: 'file-1', path: '/recordings/2026-07-16T12-00-00-Weekly-call.md' },
    })),
    setMeta: vi.fn(async () => ({ ok: true as const, value: {} })),
    ...overrides,
  }
}

beforeEach(() => {
  vi.restoreAllMocks()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

describe('[COMP:recordings/transcript-artifact] OSS transcript artifact', () => {
  it('writes the shared timestamp format and marks duplicate indexing skipped', async () => {
    const api = filesApi()
    const persist = createTranscriptArtifactWriter({
      filesApi: api as never,
      now: () => new Date('2026-07-16T12:00:00Z'),
    })

    await expect(persist(input)).resolves.toMatchObject({ fileId: 'file-1' })
    const [, params] = (api.writeBytes.mock.calls as unknown as Array<[
      unknown,
      { bytes: Buffer; mime: string; sensitivity: string; path: string },
    ]>)[0]!
    expect(params.bytes.toString('utf8')).toBe(
      '[0:00:00] Ken: kicking off\n[0:47:21] Priya: pushed back on pricing',
    )
    expect(params).toMatchObject({
      mime: 'text/markdown',
      sensitivity: 'confidential',
      path: '/recordings/2026-07-16T12-00-00-Weekly-call.md',
    })
    expect(api.setMeta).toHaveBeenCalledWith(
      expect.anything(),
      'file-1',
      expect.objectContaining({
        metadata: {
          recording_id: 'rec-1',
          indexing: { status: 'skipped', reason: 'transcript_segments' },
        },
      }),
    )
  })

  it('returns null instead of failing recording processing on a storage error', async () => {
    const api = filesApi({
      writeBytes: vi.fn(async () => {
        throw new Error('storage unavailable')
      }),
    })
    const persist = createTranscriptArtifactWriter({ filesApi: api as never })
    await expect(persist(input)).resolves.toBeNull()
  })
})
