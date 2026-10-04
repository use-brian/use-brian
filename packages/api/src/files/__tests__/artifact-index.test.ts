import { describe, it, expect, vi, beforeEach } from 'vitest'

const query = vi.fn()
const insertFileSegments = vi.fn()
const captureRecordingIntakeParent = vi.fn()

vi.mock('../../db/client.js', () => ({ getPool: () => ({ query }) }))
vi.mock('../../db/file-segments-store.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/file-segments-store.js')>()),
  insertFileSegments,
}))
vi.mock('../../db/recording-intake-admission.js', () => ({ captureRecordingIntakeParent }))

const { indexFileArtifact } = await import('../artifact-index.js')

describe('[COMP:files/artifact-index] indexFileArtifact segment provenance', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    query.mockResolvedValueOnce({ rows: [{
      path: '/uploads/deck.pptx', user_id: null, assistant_id: null, sensitivity: 'internal',
      compartments: [], tags: null, source: 'upload', metadata: null,
    }] }).mockResolvedValue({ rows: [] })
    insertFileSegments.mockResolvedValue(1)
  })

  // Regression: an upload with no provenance failed every non-media file with
  // `recording_intake_provenance_required` once segment publication required it.
  it('captures the canonical parent as the acting user and hands it to the segment store', async () => {
    const parent = { resourceKind: 'workspace_file', resourceId: 'file-1', workspaceId: 'ws-1', version: '3' }
    captureRecordingIntakeParent.mockResolvedValue(parent)

    await indexFileArtifact({ fileId: 'file-1', workspaceId: 'ws-1', text: '# Deck\n\nSlide one body.', actingUserId: 'user-1' })

    expect(captureRecordingIntakeParent).toHaveBeenCalledWith({ actorUserId: 'user-1' }, 'ws-1', 'file-1')
    const [params, provenance] = insertFileSegments.mock.calls[0]
    expect(params).toMatchObject({ fileId: 'file-1', workspaceId: 'ws-1', createdByUserId: 'user-1' })
    expect(provenance).toEqual({ actorUserId: 'user-1', parent })
  })

  it('does not write segments when the acting user cannot read the parent', async () => {
    captureRecordingIntakeParent.mockRejectedValue(new Error('recording_intake_source_unavailable'))

    await expect(indexFileArtifact({ fileId: 'file-1', workspaceId: 'ws-1', text: 'body', actingUserId: 'user-2' }))
      .rejects.toThrow('recording_intake_source_unavailable')
    expect(insertFileSegments).not.toHaveBeenCalled()
  })
})
