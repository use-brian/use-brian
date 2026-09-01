import { describe, it, expect, vi } from 'vitest'
import { resolveRecordingForFile, isMediaMime } from '../recording-for-file.js'
import type { WorkspaceFile } from '@use-brian/core'

const WS = 'ws-1'

function mediaFile(overrides: Partial<WorkspaceFile> = {}): WorkspaceFile {
  return {
    id: 'f-1',
    workspaceId: WS,
    path: '/recordings/2026-09-01-memo.opus',
    parentPath: '/recordings',
    name: 'memo.opus',
    title: 'Memo',
    summary: null,
    mime: 'audio/ogg',
    sizeBytes: 1_533_659,
    tags: [],
    relatedIds: [],
    storageUri: `gs://bucket/${WS}/recordings/media-uuid`,
    sensitivity: 'internal',
    compartments: [],
    projectIds: [],
    metadata: {},
    userId: null,
    assistantId: 'a-1',
    source: 'user',
    sourceEpisodeId: null,
    verifiedByUserId: null,
    verifiedAt: null,
    validFrom: new Date(),
    validTo: null,
    supersededBy: null,
    retractedAt: null,
    retractedReason: null,
    retractedBy: null,
    createdByUserId: 'u-1',
    createdByAssistantId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as WorkspaceFile
}

function deps(over: Record<string, unknown> = {}) {
  return {
    getEpisode: vi.fn().mockResolvedValue(null),
    getRecording: vi.fn().mockResolvedValue(null),
    getRecordingByMediaFile: vi.fn().mockResolvedValue(null),
    createEpisode: vi.fn().mockResolvedValue({ id: 'rec-new' }),
    createRecording: vi.fn().mockResolvedValue({ id: 'rec-new' }),
    updateRecording: vi.fn().mockResolvedValue(null),
    ...over,
  } as never
}

describe('[COMP:recordings/recording-for-file] resolveRecordingForFile', () => {
  it('follows the media row back-edge to the recording that already owns it', async () => {
    const d = deps({
      getEpisode: vi.fn().mockResolvedValue({ id: 'rec-1', sourceKind: 'recording', workspaceId: WS }),
      getRecording: vi.fn().mockResolvedValue({ id: 'rec-1', status: 'awaiting_upload' }),
    })
    const out = await resolveRecordingForFile(mediaFile({ sourceEpisodeId: 'rec-1' }), 'u-1', d)
    expect(out).toEqual({ status: 'ok', recordingId: 'rec-1', adopted: false, alreadyProcessed: false })
    expect((d as never as { createEpisode: ReturnType<typeof vi.fn> }).createEpisode).not.toHaveBeenCalled()
  })

  // The back-edge can point at an Episode from some other boundary. Trusting it
  // blindly would hand the caller a non-recording id, which /estimate then 400s
  // on with no way for the user to tell what went wrong.
  it('ignores a back-edge that is not a recording Episode and adopts instead', async () => {
    const d = deps({
      getEpisode: vi.fn().mockResolvedValue({ id: 'ep-9', sourceKind: 'file_ingest', workspaceId: WS }),
    })
    const out = await resolveRecordingForFile(mediaFile({ sourceEpisodeId: 'ep-9' }), 'u-1', d)
    expect(out).toEqual({ status: 'ok', recordingId: 'rec-new', adopted: true, alreadyProcessed: false })
  })

  // Without this step a second click adopts a SECOND recording for the same
  // audio, and the user pays the duration surcharge twice.
  it('finds a recording that already carries the file as its media, unstamped back-edge', async () => {
    const d = deps({
      getRecordingByMediaFile: vi.fn().mockResolvedValue({ id: 'rec-owner', status: 'processed' }),
    })
    const out = await resolveRecordingForFile(mediaFile(), 'u-1', d)
    // A resolved recording that already ran is exactly the case the caller's
    // confirmation must warn about; inventing `false` here would hide it.
    expect(out).toEqual({ status: 'ok', recordingId: 'rec-owner', adopted: false, alreadyProcessed: true })
    expect((d as never as { createEpisode: ReturnType<typeof vi.fn> }).createEpisode).not.toHaveBeenCalled()
  })

  it('adopts over the bytes where they already are, and closes the back-edge', async () => {
    const d = deps()
    const out = await resolveRecordingForFile(mediaFile(), 'u-1', d)
    expect(out).toEqual({ status: 'ok', recordingId: 'rec-new', adopted: true, alreadyProcessed: false })

    const calls = d as never as {
      createEpisode: ReturnType<typeof vi.fn>
      createRecording: ReturnType<typeof vi.fn>
      updateRecording: ReturnType<typeof vi.fn>
    }
    // The key comes out of storage_uri. Re-deriving `<workspace>/<row id>` is
    // the bug this whole change exists to stop: it points at nothing.
    expect(calls.createEpisode).toHaveBeenCalledWith('u-1', expect.objectContaining({
      sourceKind: 'recording',
      sourceRef: expect.objectContaining({ gcsKey: `${WS}/recordings/media-uuid` }),
    }))
    expect(calls.createRecording).toHaveBeenCalledWith(expect.objectContaining({
      id: 'rec-new',
      gcsKey: `${WS}/recordings/media-uuid`,
      storageUri: `gs://bucket/${WS}/recordings/media-uuid`,
    }))
    expect(calls.updateRecording).toHaveBeenCalledWith('rec-new', { mediaFileId: 'f-1' })
  })

  it('maps a confidential file onto the private Episode tier, never a wider one', async () => {
    const d = deps()
    await resolveRecordingForFile(mediaFile({ sensitivity: 'confidential', compartments: [] }), 'u-1', d)
    expect((d as never as { createEpisode: ReturnType<typeof vi.fn> }).createEpisode).toHaveBeenCalledWith(
      'u-1',
      expect.objectContaining({ sensitivity: 'private' }),
    )
  })

  // recordings carries no compartments column, so adopting a compartmented file
  // would file its transcript workspace-wide.
  it('refuses to adopt a compartmented file', async () => {
    const d = deps()
    const out = await resolveRecordingForFile(mediaFile({ compartments: ['legal'] }), 'u-1', d)
    expect(out).toEqual({ status: 'refused', reason: 'compartmented' })
    expect((d as never as { createEpisode: ReturnType<typeof vi.fn> }).createEpisode).not.toHaveBeenCalled()
  })

  it('still returns an EXISTING recording for a compartmented file', async () => {
    const d = deps({ getRecordingByMediaFile: vi.fn().mockResolvedValue({ id: 'rec-owner', status: 'queued' }) })
    const out = await resolveRecordingForFile(mediaFile({ compartments: ['legal'] }), 'u-1', d)
    expect(out).toEqual({ status: 'ok', recordingId: 'rec-owner', adopted: false, alreadyProcessed: false })
  })

  it('classifies audio and video as media, and nothing else', () => {
    expect(isMediaMime('audio/ogg')).toBe(true)
    expect(isMediaMime('video/quicktime')).toBe(true)
    expect(isMediaMime('application/pdf')).toBe(false)
    expect(isMediaMime('text/markdown')).toBe(false)
  })
})
