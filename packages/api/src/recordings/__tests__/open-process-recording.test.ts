import { describe, expect, it, vi } from 'vitest'
import { processOpenRecording } from '../process-recording.js'

describe('[COMP:recordings/open-process-recording] OSS recording processing', () => {
  it('resolves storageUri through FilesClientResolver and ingests the transcript', async () => {
    const storage = { signedReadUrl: vi.fn(async () => 'https://signed.example/media') }
    const forUri = vi.fn(async () => storage)
    const brainIngestor = vi.fn(async () => ({}) as never)
    const result = await processOpenRecording(
      { recordingId: 'rec-1', actingUserId: 'owner-1' },
      {
        filesResolver: { forUri: forUri as never, forWorkspace: vi.fn() },
        fallbackStorage: storage as never,
        transcriber: {
          name: 'test',
          transcribe: vi.fn(async () => ({
            utterances: [{ startMs: 0, endMs: 1000, speaker: null, text: 'hello brain' }],
            usages: [], windows: 1, truncated: false, degenerateWindows: 0,
          })),
        },
        brainIngestor,
        getEpisode: vi.fn(async () => ({
          id: 'rec-1', workspaceId: 'ws-1', userId: null, assistantId: 'assistant-1',
          sensitivity: 'internal', sourceRef: {
            gcsKey: 'ws-1/channel-media/id',
            storageUri: 's3://bucket/ws-1/channel-media/id',
          },
        }) as never),
        getRecording: vi.fn(async () => null),
        probe: vi.fn(async () => 1000),
        extract: vi.fn(async () => ({ buffer: Buffer.from('aac'), mime: 'audio/aac' })),
        insertSegments: vi.fn(async () => 1),
      },
    )

    expect(forUri).toHaveBeenCalledWith('ws-1', 's3://bucket/ws-1/channel-media/id')
    expect(brainIngestor).toHaveBeenCalledWith(expect.objectContaining({ parentEpisodeId: 'rec-1' }))
    expect(result).toEqual({ truncated: false, segmentsInserted: 1, durationMs: 1000 })
  })

  it('fails clearly when no transcriber is configured', async () => {
    await expect(processOpenRecording(
      { recordingId: 'rec-1', actingUserId: 'owner-1' },
      { filesResolver: {} as never, fallbackStorage: {} as never },
    )).rejects.toThrow('recording transcriber prerequisite missing')
  })

  it('stages extracted M4A for a local URL-submit provider and deletes it afterward', async () => {
    const storage = {
      signedReadUrl: vi.fn(async (key: string) => `https://files.example/${key}`),
      writeBlob: vi.fn(async () => undefined),
      deleteBlob: vi.fn(async () => undefined),
    }
    const transcribe = vi.fn(async () => ({
      utterances: [{ startMs: 0, endMs: 1000, speaker: null, text: 'local audio' }],
      usages: [], windows: 1, truncated: false, degenerateWindows: 0,
    }))

    await processOpenRecording(
      { recordingId: 'rec-local', actingUserId: 'owner-1' },
      {
        filesResolver: { forUri: vi.fn(async () => storage), forWorkspace: vi.fn() } as never,
        fallbackStorage: storage as never,
        transcriber: { name: 'dashscope:qwen3-asr-flash-filetrans', transcribe },
        brainIngestor: vi.fn(async () => ({}) as never),
        getEpisode: vi.fn(async () => ({
          id: 'rec-local', workspaceId: 'ws-1', userId: null, assistantId: 'assistant-1',
          sensitivity: 'internal', sourceRef: {
            gcsKey: 'ws-1/recordings/video-id',
            storageUri: 'file:///data/files/ws-1/recordings/video-id',
          },
        }) as never),
        getRecording: vi.fn(async () => null),
        probe: vi.fn(async () => 1000),
        extract: vi.fn(async () => ({ buffer: Buffer.from('m4a-bytes'), mime: 'audio/mp4' })),
        insertSegments: vi.fn(async () => 1),
      },
    )

    const stagedKey = 'ws-1/recordings/video-id.transcription.m4a'
    expect(storage.writeBlob).toHaveBeenCalledWith(stagedKey, Buffer.from('m4a-bytes'), expect.objectContaining({
      workspaceId: 'ws-1',
      mime: 'audio/mp4',
    }))
    expect(transcribe).toHaveBeenCalledWith(expect.objectContaining({
      sourceUrl: `https://files.example/${stagedKey}`,
      mime: 'audio/mp4',
    }))
    expect(storage.deleteBlob).toHaveBeenCalledWith(stagedKey)
  })
})
