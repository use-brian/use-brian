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

describe('canonical file adoption', () => {
  const parent = { workspaceId: WS, resourceKind: 'workspace_file' as const, resourceId: 'f-1', version: '1',
    userId: 'u-1', assistantId: null, sensitivity: 'confidential' as const, compartments: ['team:legal'], projectIds: [],
    mime: 'audio/ogg', storageUri: 'gs://bucket/key', name: 'memo.opus', sizeBytes: 10 }
  it('uses the input only as locator and passes actor/evidence separately to the atomic store', async () => {
    const captureParent = vi.fn().mockResolvedValue(parent)
    const createRecording = vi.fn().mockImplementation(async input => ({ id: input.id, status: 'awaiting_upload' }))
    const out = await resolveRecordingForFile(mediaFile({ sourceEpisodeId: 'untrusted', compartments: ['team:legal'] }), 'u-1', { captureParent, createRecording })
    expect(out).toMatchObject({ status: 'ok', adopted: true })
    expect(captureParent).toHaveBeenCalledWith({ actorUserId: 'u-1' }, WS, 'f-1')
    expect(createRecording).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, createdByUserId: 'u-1' }), { actorUserId: 'u-1', parent })
  })
  it('uses the canonical store retry result rather than sourceEpisodeId', async () => {
    const out = await resolveRecordingForFile(mediaFile({ sourceEpisodeId: 'untrusted' }), 'u-1', {
      captureParent: vi.fn().mockResolvedValue(parent), createRecording: vi.fn().mockResolvedValue({ id: 'existing', status: 'processed' }),
    })
    expect(out).toEqual({ status: 'ok', recordingId: 'existing', adopted: false, alreadyProcessed: true })
  })
  it.each(['memo', 'meeting', undefined] as const)('passes optional kind %s into atomic creation', async kind => {
    const createRecording = vi.fn().mockResolvedValue({ id: 'existing', status: 'processed' })
    await resolveRecordingForFile(mediaFile(), 'u-1', {
      captureParent: vi.fn().mockResolvedValue(parent), createRecording,
    }, { kind })
    expect(createRecording).toHaveBeenCalledWith(expect.objectContaining({ kind }), { actorUserId: 'u-1', parent })
  })
  it('propagates an atomic kind conflict without adopting', async () => {
    await expect(resolveRecordingForFile(mediaFile(), 'u-1', {
      captureParent: vi.fn().mockResolvedValue(parent),
      createRecording: vi.fn().mockRejectedValue(new Error('recording_kind_conflict')),
    }, { kind: 'meeting' })).rejects.toThrow('recording_kind_conflict')
  })
  it('classifies media', () => {
    expect(isMediaMime('audio/ogg')).toBe(true)
    expect(isMediaMime('video/mp4')).toBe(true)
    expect(isMediaMime('text/plain')).toBe(false)
  })
})
