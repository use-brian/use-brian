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

  it('persists and links the transcript before brain ingest, then runs requested synthesis', async () => {
    const order: string[] = []
    const persistTranscript = vi.fn(async () => {
      order.push('persist')
      return { fileId: 'transcript-1', path: '/recordings/call.md', bytes: 42 }
    })
    const linkTranscriptFile = vi.fn(async () => {
      order.push('link')
    })
    const brainIngestor = vi.fn(async () => {
      order.push('brain')
      return {} as never
    })
    const synthesize = vi.fn(async () => {
      order.push('synthesize')
      return { pageId: 'page-brief' }
    })

    await processOpenRecording(
      {
        recordingId: 'rec-1',
        actingUserId: 'owner-1',
        blueprintSlug: '  sales-call  ',
        parentPageId: 'page-parent',
      },
      {
        filesResolver: { forUri: vi.fn(), forWorkspace: vi.fn() },
        fallbackStorage: { signedReadUrl: vi.fn(async () => 'https://signed.example/media') } as never,
        transcriber: {
          name: 'test',
          transcribe: vi.fn(async () => ({
            utterances: [{ startMs: 0, endMs: 1000, speaker: 'A', text: 'hello brain' }],
            usages: [], windows: 1, truncated: false, degenerateWindows: 0,
          })),
        },
        brainIngestor,
        getEpisode: vi.fn(async () => ({
          id: 'rec-1', workspaceId: 'ws-1', userId: null, assistantId: 'assistant-1',
          sensitivity: 'confidential', sourceRef: { gcsKey: 'ws-1/recordings/id' },
        }) as never),
        getRecording: vi.fn(async () => ({ title: 'Sales call', fileName: 'call.m4a' }) as never),
        probe: vi.fn(async () => 1000),
        extract: vi.fn(async () => ({ buffer: Buffer.from('aac'), mime: 'audio/aac' })),
        insertSegments: vi.fn(async () => {
          order.push('segments')
          return 1
        }),
        persistTranscript,
        linkTranscriptFile,
        synthesize,
      },
    )

    expect(order).toEqual(['segments', 'persist', 'link', 'brain', 'synthesize'])
    expect(persistTranscript).toHaveBeenCalledWith(expect.objectContaining({
      recordingId: 'rec-1',
      sensitivity: 'confidential',
      title: 'Sales call',
    }))
    expect(linkTranscriptFile).toHaveBeenCalledWith('rec-1', 'transcript-1')
    expect(synthesize).toHaveBeenCalledWith(expect.objectContaining({
      blueprintSlug: 'sales-call',
      parentPageId: 'page-parent',
      sensitivity: 'confidential',
    }))
  })

  it('keeps artifact and brain ingestion but skips synthesis for a truncated transcript', async () => {
    const persistTranscript = vi.fn(async () => ({
      fileId: 'transcript-1', path: '/recordings/call.md', bytes: 42,
    }))
    const synthesize = vi.fn(async () => ({ pageId: 'page-brief' }))
    const brainIngestor = vi.fn(async () => ({}) as never)

    await processOpenRecording(
      { recordingId: 'rec-1', actingUserId: 'owner-1', blueprintSlug: 'sales-call' },
      {
        filesResolver: { forUri: vi.fn(), forWorkspace: vi.fn() },
        fallbackStorage: { signedReadUrl: vi.fn(async () => 'https://signed.example/media') } as never,
        transcriber: {
          name: 'test',
          transcribe: vi.fn(async () => ({
            utterances: [{ startMs: 0, endMs: 1000, speaker: null, text: 'partial' }],
            usages: [], windows: 1, truncated: true, degenerateWindows: 0,
          })),
        },
        brainIngestor,
        getEpisode: vi.fn(async () => ({
          id: 'rec-1', workspaceId: 'ws-1', userId: null, assistantId: 'assistant-1',
          sensitivity: 'internal', sourceRef: { gcsKey: 'ws-1/recordings/id' },
        }) as never),
        getRecording: vi.fn(async () => null),
        probe: vi.fn(async () => 1000),
        extract: vi.fn(async () => ({ buffer: Buffer.from('aac'), mime: 'audio/aac' })),
        insertSegments: vi.fn(async () => 1),
        persistTranscript,
        linkTranscriptFile: vi.fn(async () => {}),
        synthesize,
      },
    )

    expect(persistTranscript).toHaveBeenCalled()
    expect(brainIngestor).toHaveBeenCalled()
    expect(synthesize).not.toHaveBeenCalled()
  })

  it('runs frame analysis for a video mime, merges visual segments, and interleaves the ingest text', async () => {
    const storage = { signedReadUrl: vi.fn(async () => 'https://signed.example/video') }
    const brainIngestor = vi.fn(async () => ({}) as never)
    const insertSegments = vi.fn(async () => 2)
    const analyzeFrames = vi.fn(async () => ({
      moments: [{ tsMs: 0, description: 'Title slide.' }],
      usages: [{ model: 'vision', usage: null }],
    }))
    await processOpenRecording(
      { recordingId: 'rec-v', actingUserId: 'owner-1' },
      {
        filesResolver: { forUri: vi.fn(), forWorkspace: vi.fn() },
        fallbackStorage: storage as never,
        transcriber: {
          name: 'test',
          transcribe: vi.fn(async () => ({
            utterances: [{ startMs: 500, endMs: 1000, speaker: 'A', text: 'welcome' }],
            usages: [], windows: 1, truncated: false, degenerateWindows: 0,
          })),
        },
        brainIngestor,
        getEpisode: vi.fn(async () => ({
          id: 'rec-v', workspaceId: 'ws-1', userId: null, assistantId: 'assistant-1',
          sensitivity: 'internal', sourceRef: { gcsKey: 'ws-1/recordings/v' },
        }) as never),
        getRecording: vi.fn(async () => ({ mime: 'video/webm', title: 'demo', kind: 'meeting' }) as never),
        probe: vi.fn(async () => 1000),
        extract: vi.fn(async () => ({ buffer: Buffer.from('aac'), mime: 'audio/aac' })),
        insertSegments,
        analyzeFrames,
      },
    )
    expect(analyzeFrames).toHaveBeenCalledWith({ sourceUrl: 'https://signed.example/video', durationMs: 1000 })
    const insertArg = (insertSegments.mock.calls as unknown as [[{ segments: Array<{ kind?: string }> }]])[0][0]
    expect(insertArg.segments.map((seg) => seg.kind ?? 'speech')).toEqual(['visual', 'speech'])
    const ingestArg = (brainIngestor.mock.calls as unknown as [[{ content: string }]])[0][0]
    expect(ingestArg.content).toBe('Screen: Title slide.\nA: welcome')
  })

  it('a frame-analysis failure never fails the video recording', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const storage = { signedReadUrl: vi.fn(async () => 'https://signed.example/video') }
    const brainIngestor = vi.fn(async () => ({}) as never)
    const result = await processOpenRecording(
      { recordingId: 'rec-v2', actingUserId: 'owner-1' },
      {
        filesResolver: { forUri: vi.fn(), forWorkspace: vi.fn() },
        fallbackStorage: storage as never,
        transcriber: {
          name: 'test',
          transcribe: vi.fn(async () => ({
            utterances: [{ startMs: 0, endMs: 1000, speaker: null, text: 'audio only' }],
            usages: [], windows: 1, truncated: false, degenerateWindows: 0,
          })),
        },
        brainIngestor,
        getEpisode: vi.fn(async () => ({
          id: 'rec-v2', workspaceId: 'ws-1', userId: null, assistantId: 'assistant-1',
          sensitivity: 'internal', sourceRef: { gcsKey: 'ws-1/recordings/v2', mime: 'video/mp4' },
        }) as never),
        getRecording: vi.fn(async () => null),
        probe: vi.fn(async () => 1000),
        extract: vi.fn(async () => ({ buffer: Buffer.from('aac'), mime: 'audio/aac' })),
        insertSegments: vi.fn(async () => 1),
        analyzeFrames: vi.fn(async () => {
          throw new Error('vision down')
        }),
      },
    )
    expect(result.segmentsInserted).toBe(1)
    expect(brainIngestor).toHaveBeenCalled()
  })
})
