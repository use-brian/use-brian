import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createIngestStoredFileTool } from '../base/ingest-stored-file.js'
import { createReprocessRecordingTool } from '../base/reprocess-recording.js'
import type { ToolContext } from '../types.js'

// The user-reachable ingestion-recovery tools (file-artifacts.md §"Re-ingest",
// transcription.md §"Re-processing"). The invariant under test in both: an
// already-ingested/processed target is NEVER silently re-run — the first call
// asks for a user-approved confirm; only confirm: true enqueues.

const ctx: ToolContext = {
  userId: 'u-1',
  assistantId: 'a-1',
  sessionId: 's-1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'web-1',
  workspaceId: 'ws-1',
  abortSignal: new AbortController().signal,
}

beforeEach(() => vi.clearAllMocks())

describe('[COMP:files/ingest-stored-file-tool] ingestFile', () => {
  const FILE = {
    id: 'f-1',
    name: 'notes.md',
    mime: 'text/markdown',
    sizeBytes: 4096,
    sourceEpisodeId: null as string | null,
  }
  function makeDeps(file: Partial<typeof FILE> | null = {}) {
    return {
      getFile: vi.fn(async () => (file === null ? null : { ...FILE, ...file })),
      enqueue: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' as string | null })),
    }
  }

  it('enqueues a never-ingested file without confirmation', async () => {
    const deps = makeDeps()
    const res = await createIngestStoredFileTool(deps).execute({ fileId: 'f-1' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ fileId: 'f-1', workspaceId: 'ws-1', actingUserId: 'u-1', sourceLabel: 'upload' }),
    )
  })

  it('GUARD: an already-ingested file returns a confirmation request, enqueues nothing', async () => {
    const deps = makeDeps({ sourceEpisodeId: 'ep-9' })
    const res = await createIngestStoredFileTool(deps).execute({ fileId: 'f-1' }, ctx)
    expect(String(res.data)).toContain('CONFIRMATION REQUIRED')
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('GUARD: confirm: true re-ingests, labelled reingest', async () => {
    const deps = makeDeps({ sourceEpisodeId: 'ep-9' })
    const res = await createIngestStoredFileTool(deps).execute({ fileId: 'f-1', confirm: true }, ctx)
    expect(res.isError).toBeFalsy()
    expect(deps.enqueue).toHaveBeenCalledWith(expect.objectContaining({ sourceLabel: 'reingest' }))
  })

  it('an in-flight job reports "already being ingested" without erroring', async () => {
    const deps = makeDeps()
    deps.enqueue.mockResolvedValue({ enqueued: false, jobId: null })
    const res = await createIngestStoredFileTool(deps).execute({ fileId: 'f-1' }, ctx)
    expect(String(res.data)).toContain('already being ingested')
  })

  it('refuses audio/video (recordings own media) and unknown files', async () => {
    const media = makeDeps({ mime: 'video/mp4' })
    const r1 = await createIngestStoredFileTool(media).execute({ fileId: 'f-1' }, ctx)
    expect(r1.isError).toBe(true)
    expect(String(r1.data)).toContain('reprocessRecording')

    const missing = makeDeps(null)
    const r2 = await createIngestStoredFileTool(missing).execute({ fileId: 'nope' }, ctx)
    expect(r2.isError).toBe(true)
  })

  it('errors outside a workspace', async () => {
    const deps = makeDeps()
    const res = await createIngestStoredFileTool(deps).execute(
      { fileId: 'f-1' },
      { ...ctx, workspaceId: null },
    )
    expect(res.isError).toBe(true)
    expect(deps.enqueue).not.toHaveBeenCalled()
  })
})

describe('[COMP:recordings/reprocess-recording-tool] reprocessRecording', () => {
  const REC = {
    id: 'rec-1',
    workspaceId: 'ws-1',
    sourceKind: 'recording',
    sourceRef: { gcsKey: 'k', fileName: 'meeting.mp4' } as Record<string, unknown> | null,
  }
  function makeDeps(rec: Partial<typeof REC> | null = {}, processed = true) {
    return {
      getRecording: vi.fn(async () => (rec === null ? null : { ...REC, ...rec })),
      hasProcessed: vi.fn(async () => processed),
      enqueue: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' as string | null })),
    }
  }

  it('GUARD: an already-processed recording returns a confirmation request, enqueues nothing', async () => {
    const deps = makeDeps({}, true)
    const res = await createReprocessRecordingTool(deps).execute({ recordingId: 'rec-1' }, ctx)
    expect(String(res.data)).toContain('CONFIRMATION REQUIRED')
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('GUARD: confirm: true re-processes an already-processed recording', async () => {
    const deps = makeDeps({}, true)
    const res = await createReprocessRecordingTool(deps).execute(
      { recordingId: 'rec-1', confirm: true },
      ctx,
    )
    expect(res.isError).toBeFalsy()
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ recordingId: 'rec-1', workspaceId: 'ws-1', actingUserId: 'u-1' }),
    )
  })

  it('a never-processed recording (earlier run failed) enqueues without confirmation', async () => {
    const deps = makeDeps({}, false)
    const res = await createReprocessRecordingTool(deps).execute({ recordingId: 'rec-1' }, ctx)
    expect(res.isError).toBeFalsy()
    expect(deps.enqueue).toHaveBeenCalledTimes(1)
  })

  it('refuses a recording from another workspace, a non-recording episode, and missing audio', async () => {
    const cross = makeDeps({ workspaceId: 'ws-OTHER' })
    expect((await createReprocessRecordingTool(cross).execute({ recordingId: 'rec-1' }, ctx)).isError).toBe(true)
    expect(cross.enqueue).not.toHaveBeenCalled()

    const notRec = makeDeps({ sourceKind: 'voice_memo' })
    expect((await createReprocessRecordingTool(notRec).execute({ recordingId: 'rec-1' }, ctx)).isError).toBe(true)

    const noAudio = makeDeps({ sourceRef: { fileName: 'x.mp4' } })
    const res = await createReprocessRecordingTool(noAudio).execute({ recordingId: 'rec-1' }, ctx)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('upload')
  })

  it('an in-flight job reports "already being processed" without erroring', async () => {
    const deps = makeDeps({}, false)
    deps.enqueue.mockResolvedValue({ enqueued: false, jobId: null })
    const res = await createReprocessRecordingTool(deps).execute({ recordingId: 'rec-1' }, ctx)
    expect(String(res.data)).toContain('already being processed')
  })
})
