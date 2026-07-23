import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ingestChannelMedia,
  classifyMedia,
  type ChannelMediaRef,
  type ChannelMediaIntakeDeps,
} from '../channel-media-intake.js'

const baseRef: ChannelMediaRef = {
  channel: 'whatsapp',
  gcsKey: 'ws-1/channel-media/abc',
  mime: 'video/mp4',
  fileName: 'clip.mp4',
  sizeBytes: 1_000_000,
  sender: { id: '15551234567', name: 'Client A' },
  workspaceId: 'ws-1',
  assistantId: 'a-1',
  actingUserId: 'owner-1',
}

function makeDeps(overrides: Partial<ChannelMediaIntakeDeps> = {}): ChannelMediaIntakeDeps {
  return {
    createEpisode: vi.fn(async () => ({ id: 'rec-1' }) as never),
    createRecording: vi.fn(async () => ({ id: 'rec-1' }) as never),
    enqueueRecordingJob: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' })),
    ...overrides,
  }
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:brain/channel-media-intake] classifyMedia', () => {
  it('routes AV, documents, and rejects the rest', () => {
    expect(classifyMedia('video/mp4')).toBe('audio_video')
    expect(classifyMedia('audio/ogg')).toBe('audio_video')
    expect(classifyMedia('application/pdf')).toBe('document')
    expect(classifyMedia('text/plain')).toBe('document')
    expect(classifyMedia('application/vnd.openxmlformats-officedocument.wordprocessingml.document')).toBe('document')
    expect(classifyMedia('image/png')).toBe('unsupported')
    expect(classifyMedia('application/zip')).toBe('unsupported')
  })
})

describe('[COMP:brain/channel-media-intake] ingestChannelMedia', () => {
  it('AV → creates a recording Episode (sender provenance) and enqueues', async () => {
    const deps = makeDeps()
    const res = await ingestChannelMedia(baseRef, deps)
    expect(res).toEqual({ status: 'queued', kind: 'audio_video', recordingId: 'rec-1', jobId: 'job-1' })

    const epArg = (deps.createEpisode as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(epArg[0]).toBe('owner-1') // created as the acting user
    expect(epArg[1]).toMatchObject({
      sourceKind: 'recording',
      assistantId: 'a-1',
      userId: null,
      createdByUserId: 'owner-1',
    })
    expect(epArg[1].sourceRef).toMatchObject({
      gcsKey: 'ws-1/channel-media/abc',
      source: { channel: 'whatsapp', sender: { id: '15551234567', name: 'Client A' } },
    })
    expect(deps.enqueueRecordingJob).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: 'rec-1', workspaceId: 'ws-1', actingUserId: 'owner-1' }),
    )
    expect(deps.createRecording).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rec-1',
      gcsKey: 'ws-1/channel-media/abc',
      status: 'queued',
    }))
    // With no resolver wired, the job carries no blueprint (ingest-only).
    expect(deps.enqueueRecordingJob).toHaveBeenCalledWith(
      expect.objectContaining({ blueprintSlug: null }),
    )
  })

  it('AV → stamps sourceRef.storageUri when the ref is BYO (and omits it otherwise)', async () => {
    const byoDeps = makeDeps()
    await ingestChannelMedia({ ...baseRef, storageUri: 'gs://byo-bucket/ws-1/channel-media/abc' }, byoDeps)
    expect((byoDeps.createEpisode as ReturnType<typeof vi.fn>).mock.calls[0][1].sourceRef).toMatchObject({
      gcsKey: 'ws-1/channel-media/abc',
      storageUri: 'gs://byo-bucket/ws-1/channel-media/abc',
    })

    const platformDeps = makeDeps()
    await ingestChannelMedia(baseRef, platformDeps) // no storageUri
    expect((platformDeps.createEpisode as ReturnType<typeof vi.fn>).mock.calls[0][1].sourceRef.storageUri).toBeUndefined()
  })

  it('AV → resolves the workspace default blueprint at the enqueue edge and stores it on the job', async () => {
    const resolveWorkspaceDefaultBlueprint = vi.fn(async () => 'tpl-default')
    const deps = makeDeps({ resolveWorkspaceDefaultBlueprint })
    await ingestChannelMedia(baseRef, deps)

    expect(resolveWorkspaceDefaultBlueprint).toHaveBeenCalledWith('ws-1')
    expect(deps.enqueueRecordingJob).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: 'rec-1', blueprintSlug: 'tpl-default' }),
    )
  })

  it('AV → a null workspace default enqueues ingest-only (blueprintSlug null)', async () => {
    const resolveWorkspaceDefaultBlueprint = vi.fn(async () => null)
    const deps = makeDeps({ resolveWorkspaceDefaultBlueprint })
    await ingestChannelMedia(baseRef, deps)

    expect(resolveWorkspaceDefaultBlueprint).toHaveBeenCalledWith('ws-1')
    expect(deps.enqueueRecordingJob).toHaveBeenCalledWith(
      expect.objectContaining({ blueprintSlug: null }),
    )
  })

  it('document → calls the document ingestor, never the recording path', async () => {
    const ingestDocument = vi.fn(async () => ({ status: 'accepted' as const, episodeId: 'doc-ep-1' }))
    const deps = makeDeps({ ingestDocument })
    const res = await ingestChannelMedia({ ...baseRef, mime: 'application/pdf', fileName: 'spec.pdf' }, deps)
    expect(res).toEqual({ status: 'ingested', kind: 'document', episodeId: 'doc-ep-1', fileName: 'spec.pdf' })
    expect(ingestDocument).toHaveBeenCalledOnce()
    expect(deps.enqueueRecordingJob).not.toHaveBeenCalled()
  })

  it('document with no handler wired → rejected', async () => {
    const res = await ingestChannelMedia({ ...baseRef, mime: 'application/pdf' }, makeDeps())
    expect(res).toEqual({ status: 'rejected', reason: 'no_document_handler' })
  })

  it('document over the parse cap → doc_too_large with MB numbers for the handoff copy', async () => {
    const ingestDocument = vi.fn(async () => ({
      status: 'too_large' as const,
      sizeBytes: 30 * 1024 * 1024,
      limitBytes: 25 * 1024 * 1024,
    }))
    const deps = makeDeps({ ingestDocument })
    const res = await ingestChannelMedia({ ...baseRef, mime: 'application/pdf', fileName: 'big.pdf' }, deps)
    expect(res).toEqual({ status: 'rejected', reason: 'doc_too_large', sizeMb: 30, limitMb: 25 })
  })

  it('document accepted on the artifact path carries fileId + path for the route reply', async () => {
    const ingestDocument = vi.fn(async () => ({
      status: 'accepted' as const,
      episodeId: null,
      fileId: 'wf-77',
      path: '/uploads/channel/x-brief.pdf',
    }))
    const deps = makeDeps({ ingestDocument })
    const res = await ingestChannelMedia({ ...baseRef, mime: 'application/pdf', fileName: 'brief.pdf' }, deps)
    expect(res).toEqual({
      status: 'ingested',
      kind: 'document',
      episodeId: null,
      fileName: 'brief.pdf',
      fileId: 'wf-77',
      path: '/uploads/channel/x-brief.pdf',
    })
  })

  it('document storage-quota failure → doc_storage_quota rejection', async () => {
    const ingestDocument = vi.fn(async () => ({ status: 'storage_quota' as const }))
    const deps = makeDeps({ ingestDocument })
    const res = await ingestChannelMedia({ ...baseRef, mime: 'text/plain' }, deps)
    expect(res).toEqual({ status: 'rejected', reason: 'doc_storage_quota' })
  })

  it('document with no assistant / empty parse → skipped arms (routes stay quiet)', async () => {
    const noAssistant = vi.fn(async () => ({ status: 'skipped_no_assistant' as const }))
    const resA = await ingestChannelMedia(
      { ...baseRef, mime: 'text/plain' },
      makeDeps({ ingestDocument: noAssistant }),
    )
    expect(resA).toEqual({ status: 'skipped', kind: 'document', reason: 'no_assistant' })

    const empty = vi.fn(async () => ({ status: 'empty' as const }))
    const resB = await ingestChannelMedia({ ...baseRef, mime: 'text/plain' }, makeDeps({ ingestDocument: empty }))
    expect(resB).toEqual({ status: 'skipped', kind: 'document', reason: 'empty' })
  })

  it('unsupported mime → rejected, nothing created', async () => {
    const deps = makeDeps()
    const res = await ingestChannelMedia({ ...baseRef, mime: 'image/png' }, deps)
    expect(res).toEqual({ status: 'rejected', reason: 'unsupported' })
    expect(deps.createEpisode).not.toHaveBeenCalled()
  })

  it('over the byte ceiling → rejected before any work', async () => {
    const deps = makeDeps({ maxBytes: 100 })
    const res = await ingestChannelMedia({ ...baseRef, sizeBytes: 1000 }, deps)
    expect(res).toEqual({ status: 'rejected', reason: 'too_large' })
    expect(deps.createEpisode).not.toHaveBeenCalled()
  })

  it('quota denial → rejected', async () => {
    const deps = makeDeps({ checkQuota: vi.fn(async () => ({ ok: false, reason: 'rate' })) })
    const res = await ingestChannelMedia(baseRef, deps)
    expect(res).toEqual({ status: 'rejected', reason: 'quota' })
    expect(deps.enqueueRecordingJob).not.toHaveBeenCalled()
  })
})

// ── Pre-flight confirm (channel-recording-preflight-confirm §5) ──

function makePreflight(overrides: Partial<NonNullable<ChannelMediaIntakeDeps['preflightConfirm']>> = {}) {
  return {
    signedReadUrl: vi.fn(async ({ gcsKey }: { gcsKey: string; workspaceId: string; storageUri?: string | null }) => `https://signed/${gcsKey}`),
    probeDurationMs: vi.fn(async () => 600_000), // 10 min
    surchargeCredits: vi.fn((s: number) => (s > 180 ? 1 : 0)),
    storePending: vi.fn(async () => ({ inserted: true })),
    buildAsk: vi.fn(() => 'CONFIRM_ASK'),
    ...overrides,
  }
}

describe('[COMP:brain/channel-media-intake] pre-flight confirm', () => {
  const refWithConversation: ChannelMediaRef = { ...baseRef, conversationId: 'chat-1' }

  it('BIG recording (surcharge>0) → stores pending, does NOT enqueue, returns the ask', async () => {
    const preflightConfirm = makePreflight()
    const deps = makeDeps({
      preflightConfirm,
      resolveWorkspaceDefaultBlueprint: vi.fn(async () => 'tpl-default'),
    })
    const res = await ingestChannelMedia(refWithConversation, deps)

    expect(res).toEqual({
      status: 'pending_confirmation',
      kind: 'audio_video',
      recordingId: 'rec-1',
      durationSeconds: 600,
      surchargeCredits: 1,
      message: 'CONFIRM_ASK',
    })
    expect(preflightConfirm.storePending).toHaveBeenCalledWith(
      expect.objectContaining({
        recordingId: 'rec-1',
        channelSessionKey: 'whatsapp:chat-1:owner-1',
        durationSeconds: 600,
        surchargeCredits: 1,
        defaultBlueprintSlug: 'tpl-default',
        fileLabel: 'clip.mp4',
      }),
    )
    expect(deps.enqueueRecordingJob).not.toHaveBeenCalled()
  })

  it('SMALL recording (surcharge==0) → enqueues immediately, no pending row', async () => {
    const preflightConfirm = makePreflight({ probeDurationMs: vi.fn(async () => 60_000) }) // 1 min
    const deps = makeDeps({ preflightConfirm })
    const res = await ingestChannelMedia(refWithConversation, deps)

    expect(res).toEqual({ status: 'queued', kind: 'audio_video', recordingId: 'rec-1', jobId: 'job-1' })
    expect(preflightConfirm.storePending).not.toHaveBeenCalled()
    expect(deps.enqueueRecordingJob).toHaveBeenCalledOnce()
  })

  it('no conversationId → cannot correlate, enqueues (today\'s behavior)', async () => {
    const preflightConfirm = makePreflight()
    const deps = makeDeps({ preflightConfirm })
    const res = await ingestChannelMedia(baseRef, deps) // baseRef has no conversationId
    expect(res.status).toBe('queued')
    expect(preflightConfirm.probeDurationMs).not.toHaveBeenCalled()
    expect(deps.enqueueRecordingJob).toHaveBeenCalledOnce()
  })

  it('ffprobe failure → falls back to enqueue, never crashes', async () => {
    const preflightConfirm = makePreflight({
      probeDurationMs: vi.fn(async () => {
        throw new Error('ffprobe boom')
      }),
    })
    const deps = makeDeps({ preflightConfirm })
    const res = await ingestChannelMedia(refWithConversation, deps)
    expect(res.status).toBe('queued')
    expect(deps.enqueueRecordingJob).toHaveBeenCalledOnce()
  })
})
