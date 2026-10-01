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

const provenance = {
  actorUserId: input.actingUserId, recordingId: input.recordingId, recordingVersion: '3', episodeVersion: '2',
  parent: { resourceKind: 'workspace_file' as const, resourceId: 'media-1', version: '1', workspaceId: input.workspaceId,
    userId: input.actingUserId, assistantId: input.assistantId, sensitivity: 'confidential' as const,
    compartments: [], projectIds: [], storageUri: 'gs://fixture/media', name: 'media.wav', mime: 'audio/wav', sizeBytes: 3 },
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

    await expect(persist(input, provenance)).resolves.toMatchObject({ fileId: 'file-1' })
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
    expect(api.writeBytes).toHaveBeenCalledWith(expect.objectContaining({ derivation: { producer: 'recording-transcript', sources: [
      expect.objectContaining({ resourceKind: 'workspace_file', userId: 'user-1', version: '1' }),
      expect.objectContaining({ resourceKind: 'recording', resourceId: 'rec-1', version: '3', userId: 'user-1' }),
      expect.objectContaining({ resourceKind: 'episode', resourceId: 'rec-1', version: '2', userId: 'user-1' }),
    ] } }), expect.anything())
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
    await expect(persist(input, provenance)).resolves.toBeNull()
  })
})

it('never falls back to an authored/shared write without per-call evidence', async () => {
  const api = filesApi()
  await expect(createTranscriptArtifactWriter({ filesApi: api as never })(input)).resolves.toBeNull()
  expect(api.writeBytes).not.toHaveBeenCalled()
})
