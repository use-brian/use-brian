import { describe, it, expect, vi, beforeEach } from 'vitest'
import { createIngestStoredFileTool } from '../base/ingest-stored-file.js'
import { createReprocessRecordingTool } from '../base/reprocess-recording.js'
import type { ToolContext } from '../types.js'

// The user-reachable ingestion-recovery tools (file-artifacts.md §"Re-ingest",
// transcription.md §"Re-processing"). The invariant under test in both: an
// staged or already-ingested/processed target is NEVER silently run — the first
// call asks for a user-approved confirm; only confirm: true enqueues.

const ctx: ToolContext = {
  userId: 'u-1',
  assistantId: 'a-1',
  sessionId: 's-1',
  appId: 'Use Brian',
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

  it('GUARD: a staged never-ingested file requires confirmation', async () => {
    const deps = makeDeps()
    const res = await createIngestStoredFileTool(deps).execute({ fileId: 'f-1' }, ctx)
    expect(String(res.data)).toContain('CONFIRMATION REQUIRED')
    expect(String(res.data)).toContain('has not been ingested')
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('confirm: true ingests a staged file', async () => {
    const deps = makeDeps()
    const res = await createIngestStoredFileTool(deps).execute(
      { fileId: 'f-1', confirm: true },
      ctx,
    )
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
    const res = await createIngestStoredFileTool(deps).execute({ fileId: 'f-1', confirm: true }, ctx)
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

  it('errors outside a workspace with the same sentence the retrieval gate uses', async () => {
    const deps = makeDeps()
    const res = await createIngestStoredFileTool(deps).execute(
      { fileId: 'f-1' },
      { ...ctx, workspaceId: null },
    )
    expect(res.isError).toBe(true)
    expect(deps.enqueue).not.toHaveBeenCalled()
    const data = String(res.data)
    expect(data).toContain('This chat is not bound to a workspace')
    expect(data).toContain('brain rows are workspace-scoped')
    expect(data).toMatch(/No argument change or retry will help/i)
    expect(data).toMatch(/workspace chat/i)
  })

  it('an enqueue failure says ingestion did NOT start and not to re-ask for consent', async () => {
    const deps = makeDeps()
    deps.enqueue.mockRejectedValueOnce(new Error('file_ingest_jobs insert rejected'))
    const res = await createIngestStoredFileTool(deps).execute(
      { fileId: 'f-1', confirm: true },
      ctx,
    )
    expect(res.isError).toBe(true)
    const data = String(res.data)
    expect(data).toContain('file_ingest_jobs insert rejected')
    expect(data).toContain('notes.md')
    expect(data).toMatch(/did NOT start/)
    expect(data).toMatch(/do not ask them again/i)
  })

  it('a lookup failure is not reported as a missing file', async () => {
    const deps = makeDeps()
    deps.getFile.mockRejectedValueOnce(new Error('ECONNRESET'))
    const res = await createIngestStoredFileTool(deps).execute({ fileId: 'f-1' }, ctx)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('stored-file lookup')
    expect(String(res.data)).toMatch(/retry once/i)
    expect(deps.enqueue).not.toHaveBeenCalled()
  })
})

describe('[COMP:recordings/reprocess-recording-tool] reprocessRecording', () => {
  const REC = {
    id: 'rec-1',
    workspaceId: 'ws-1',
    sourceKind: 'recording',
    sourceRef: { gcsKey: 'k', fileName: 'meeting.mp4' } as Record<string, unknown> | null,
    durationMs: 20 * 60 * 1000,
  }
  function makeDeps(rec: Partial<typeof REC> | null = {}, processed = true) {
    return {
      getRecording: vi.fn(async () => (rec === null ? null : { ...REC, ...rec })),
      hasProcessed: vi.fn(async () => processed),
      enqueue: vi.fn(async () => ({ enqueued: true, jobId: 'job-1' as string | null })),
      surchargeCredits: vi.fn(() => 2),
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

  it('GUARD: a staged never-processed recording requires purpose + cost confirmation', async () => {
    const deps = makeDeps({}, false)
    const res = await createReprocessRecordingTool(deps).execute(
      { recordingId: 'rec-1', blueprintSlug: 'meeting-notes' },
      ctx,
    )
    expect(String(res.data)).toContain('CONFIRMATION REQUIRED')
    expect(String(res.data)).toContain('20 minutes')
    expect(String(res.data)).toContain('2 credits')
    expect(String(res.data)).toContain('meeting-notes')
    expect(deps.enqueue).not.toHaveBeenCalled()
  })

  it('confirm: true processes a staged recording with the chosen blueprint', async () => {
    const deps = makeDeps({}, false)
    const res = await createReprocessRecordingTool(deps).execute(
      { recordingId: 'rec-1', blueprintSlug: 'meeting-notes', confirm: true },
      ctx,
    )
    expect(res.isError).toBeFalsy()
    expect(deps.enqueue).toHaveBeenCalledWith(
      expect.objectContaining({ blueprintSlug: 'meeting-notes' }),
    )
  })

  it('separates "no such recording" from "that id is not a recording"', async () => {
    const missing = makeDeps(null)
    const r1 = await createReprocessRecordingTool(missing).execute({ recordingId: 'rec-x' }, ctx)
    expect(r1.isError).toBe(true)
    const d1 = String(r1.data)
    expect(d1).toContain('rec-x')
    expect(d1).toContain('fileSearch')            // discovery pointer
    expect(d1).toMatch(/Do NOT retry this exact id/i)
    expect(d1).not.toMatch(/ingestFile/)          // wrong remedy for a missing id

    const wrongKind = makeDeps({ sourceKind: 'document' })
    const r2 = await createReprocessRecordingTool(wrongKind).execute({ recordingId: 'rec-1' }, ctx)
    expect(r2.isError).toBe(true)
    const d2 = String(r2.data)
    expect(d2).toContain('"document"')            // names the actual kind
    expect(d2).toContain('ingestFile')            // names what DOES accept it
    expect(d2).toMatch(/fail the same way/i)
    expect(d1).not.toBe(d2)
  })

  it('an enqueue failure says processing did NOT start and preserves the consent already given', async () => {
    const deps = makeDeps({}, false)
    deps.enqueue.mockRejectedValueOnce(new Error('recording_jobs insert rejected'))
    const res = await createReprocessRecordingTool(deps).execute(
      { recordingId: 'rec-1', confirm: true },
      ctx,
    )
    expect(res.isError).toBe(true)
    const data = String(res.data)
    expect(data).toContain('recording_jobs insert rejected')
    expect(data).toMatch(/did NOT start/)
    expect(data).toMatch(/do not ask them again/i)
  })

  it('a previous-run check failure does not become a silent re-transcription', async () => {
    const deps = makeDeps({}, false)
    deps.hasProcessed.mockRejectedValueOnce(new Error('ETIMEDOUT'))
    const res = await createReprocessRecordingTool(deps).execute({ recordingId: 'rec-1' }, ctx)
    expect(res.isError).toBe(true)
    expect(String(res.data)).toContain('previous-run check')
    expect(String(res.data)).toMatch(/do not skip it by passing confirm: true/i)
    expect(deps.enqueue).not.toHaveBeenCalled()
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
    const res = await createReprocessRecordingTool(deps).execute(
      { recordingId: 'rec-1', confirm: true },
      ctx,
    )
    expect(String(res.data)).toContain('already being processed')
  })
})
