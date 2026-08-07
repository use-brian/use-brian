import { describe, it, expect, vi, beforeEach } from 'vitest'
import {
  ingestChannelMedia,
  classifyMedia,
  summarizeAlbumIntake,
  buildAlbumFiledReply,
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
    expect(classifyMedia('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')).toBe('document')
    expect(classifyMedia('application/octet-stream', 'forecast.PPTX')).toBe('document')
    expect(classifyMedia('application/octet-stream', 'brief.odt')).toBe('document')
    expect(classifyMedia('image/png')).toBe('unsupported')
    expect(classifyMedia('application/zip')).toBe('unsupported')
    expect(classifyMedia('application/octet-stream', 'archive.zip')).toBe('unsupported')
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

// ── Album folding ──────────────────────────────────────────────
//
// Cover for the 2026-08-07 album drop: four documents produced four separate
// replies on the happy path, and a member that threw produced none at all, so
// a partially-filed album was indistinguishable from a whole one.

describe('[COMP:brain/channel-media-intake] summarizeAlbumIntake', () => {
  const filed = (fileName: string) =>
    ({ status: 'ingested', kind: 'document', episodeId: 'e1', fileName }) as const

  it('folds an all-filed album into one tally with names', () => {
    const s = summarizeAlbumIntake([filed('a.md'), filed('b.md'), filed('c.md'), filed('d.md')])
    expect(s.filed).toBe(4)
    expect(s.filedNames).toEqual(['a.md', 'b.md', 'c.md', 'd.md'])
    expect(s.failed).toBe(0)
  })

  it('counts a thrown member as failed, never as quiet', () => {
    const s = summarizeAlbumIntake([filed('a.md'), null, filed('c.md')])
    expect(s.filed).toBe(2)
    expect(s.failed).toBe(1)
    expect(s.quiet).toBe(0)
  })

  it('keeps deliberately-silent arms out of the failure count', () => {
    const s = summarizeAlbumIntake([
      { status: 'skipped', kind: 'document', reason: 'empty' },
      { status: 'queued', kind: 'audio_video', recordingId: 'r1', jobId: null },
    ])
    expect(s.quiet).toBe(2)
    expect(s.failed).toBe(0)
    expect(s.filed).toBe(0)
  })

  it('routes an oversized document to the handoff list rather than the failure count', () => {
    const s = summarizeAlbumIntake([
      { status: 'rejected', reason: 'doc_too_large', sizeMb: 40, limitMb: 25 },
      { status: 'rejected', reason: 'quota' },
    ])
    expect(s.oversize).toEqual([{ sizeMb: 40, limitMb: 25 }])
    expect(s.failed).toBe(1)
  })

  it('collects each pending confirmation verbatim', () => {
    const s = summarizeAlbumIntake([
      { status: 'pending_confirmation', kind: 'audio_video', recordingId: 'r1', durationSeconds: 6000, surchargeCredits: 12, message: 'Transcribe this 100-minute recording?' },
    ])
    expect(s.confirmations).toEqual(['Transcribe this 100-minute recording?'])
  })

  it('counts a filed member whose name is unknown', () => {
    const s = summarizeAlbumIntake([
      { status: 'ingested', kind: 'document', episodeId: 'e1', fileName: null },
    ])
    expect(s.filed).toBe(1)
    expect(s.filedNames).toEqual([])
  })
})

describe('[COMP:brain/channel-media-intake] buildAlbumFiledReply', () => {
  it('names every file in a fully-filed album', () => {
    const reply = buildAlbumFiledReply(4, ['a.md', 'b.md', 'c.md', 'd.md'], 0)
    expect(reply).toContain('Saved 4 files')
    expect(reply).toContain('a.md, b.md, c.md, d.md')
    expect(reply).not.toContain("didn't go through")
  })

  it('reports a partial album instead of rounding it up to a whole one', () => {
    const reply = buildAlbumFiledReply(3, ['a.md', 'b.md', 'c.md'], 1)
    expect(reply).toContain('Saved 3 files')
    expect(reply).toContain('1 other file')
    expect(reply).toContain("didn't go through")
  })

  it('says nothing landed when every member failed', () => {
    expect(buildAlbumFiledReply(0, [], 4)).toBe(
      `I couldn't save those 4 files. Please try sending them again.`,
    )
    expect(buildAlbumFiledReply(0, [], 1)).toBe(
      `I couldn't save that file. Please try sending it again.`,
    )
  })

  it('uses singular phrasing for a one-file album', () => {
    const reply = buildAlbumFiledReply(1, ['a.md'], 0)
    expect(reply).toContain('Saved 1 file')
    expect(reply).toContain('ask me anything about it')
  })

  it('never uses an em dash in user-facing copy', () => {
    expect(buildAlbumFiledReply(3, ['a.md'], 2)).not.toContain('—')
    expect(buildAlbumFiledReply(0, [], 2)).not.toContain('—')
  })
})
