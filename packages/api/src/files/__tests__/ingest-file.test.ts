import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { FilesApi } from '@use-brian/core'
import { createFileIngestor, FileIngestError, type FileIngestContext } from '../ingest-file.js'
import { indexFileArtifact } from '../artifact-index.js'

// Chunking talks to the pool; the contract under test here is what the
// ingestor DOES with the chunker's answer, which used to be nothing at all.
vi.mock('../artifact-index.js', () => ({
  indexFileArtifact: vi.fn(async () => ({
    segmentsInserted: 3,
    segmentCount: 3,
    truncated: false,
    truncatedAtChar: null,
  })),
}))

const indexMock = vi.mocked(indexFileArtifact)

function fakeWriteBytes(over?: { fail?: 'quota' | 'conflict' }) {
  const calls: Array<{ path: string; mime: string; bytes: Buffer }> = []
  const writeBytes = vi.fn(async (_ctx, params: { path: string; mime: string; bytes: Uint8Array }) => {
    calls.push({ path: params.path, mime: params.mime, bytes: Buffer.from(params.bytes) })
    if (over?.fail) return { ok: false as const, error: { kind: over.fail } as never }
    return {
      ok: true as const,
      value: { id: 'file_1', path: params.path, sizeBytes: params.bytes.length } as never,
    }
  })
  return { writeBytes, calls }
}

function fakeIngest(counts: { entities: number; edges: number; memories: number; tasks: number }) {
  const calls: Array<{ content: string; sourceLabel?: string; sourceKind?: string; sourceRef?: unknown }> = []
  const ingest = vi.fn(async (input: { content: string; sourceLabel?: string; sourceKind?: string; sourceRef?: unknown }) => {
    calls.push(input)
    return {
      extracted: true,
      entitiesWritten: Array(counts.entities).fill({}),
      edgesWritten: Array(counts.edges).fill({}),
      memoriesWritten: Array(counts.memories).fill({}),
      tasksWritten: Array(counts.tasks).fill({}),
    } as never
  })
  return { ingest, calls }
}

const ctx: FileIngestContext = {
  workspaceId: 'ws_1',
  userId: 'user_1',
  assistantId: 'asst_1',
  assistantKind: 'primary',
  clearance: 'internal',
  compartments: null,
}

beforeEach(() => {
  indexMock.mockClear()
  indexMock.mockResolvedValue({
    segmentsInserted: 3,
    segmentCount: 3,
    truncated: false,
    truncatedAtChar: null,
  })
})

describe('[COMP:files/ingest] createFileIngestor', () => {
  it('stores staged bytes without parsing, distilling, indexing, or decomposing', async () => {
    const fw = fakeWriteBytes()
    const ing = fakeIngest({ entities: 0, edges: 0, memories: 0, tasks: 0 })
    const distill = vi.fn(async () => 'SHOULD NOT BE CALLED')
    const parse = vi.fn(async () => ({ text: 'SHOULD NOT BE CALLED', summary: '' }))
    const ingestFile = createFileIngestor({
      filesApi: { writeBytes: fw.writeBytes } as unknown as FilesApi,
      ingest: ing.ingest as never,
      distill,
      parse: parse as never,
    })

    const result = await ingestFile(
      {
        fileName: 'extension-request.pdf',
        mime: 'application/pdf',
        bytes: Buffer.from('%PDF'),
        process: false,
      },
      ctx,
    )

    expect(fw.calls).toHaveLength(1)
    expect(parse).not.toHaveBeenCalled()
    expect(distill).not.toHaveBeenCalled()
    expect(ing.ingest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      fileId: 'file_1',
      distilled: false,
      decomposed: false,
      counts: { entities: 0, edges: 0, memories: 0, tasks: 0 },
    })
  })

  it('stores raw bytes and decomposes text through the open brain ingestor', async () => {
    const fw = fakeWriteBytes()
    const ing = fakeIngest({ entities: 2, edges: 1, memories: 3, tasks: 0 })
    const distill = vi.fn(async () => 'SHOULD NOT BE CALLED')
    const parse = vi.fn(async () => ({ text: 'parsed markdown', summary: 's' }))
    const ingestFile = createFileIngestor({
      filesApi: { writeBytes: fw.writeBytes } as unknown as FilesApi,
      ingest: ing.ingest as never,
      distill,
      parse: parse as never,
    })

    const result = await ingestFile(
      { fileName: 'notes.md', mime: 'text/markdown', bytes: Buffer.from('# hi') },
      ctx,
    )

    expect(distill).not.toHaveBeenCalled()
    expect(parse).toHaveBeenCalledOnce()
    expect(fw.calls[0]).toMatchObject({ path: '/uploads/notes.md', mime: 'text/markdown' })
    expect(ing.calls[0]).toMatchObject({
      content: 'parsed markdown',
      sourceLabel: 'notes.md',
      sourceKind: 'file_upload',
      sourceRef: { source_kind: 'file_upload', file_id: 'file_1' },
    })
    expect(result).toMatchObject({
      distilled: false,
      decomposed: true,
      counts: { entities: 2, edges: 1, memories: 3, tasks: 0 },
    })
  })

  it('distills a PDF then decomposes the distilled text', async () => {
    const fw = fakeWriteBytes()
    const ing = fakeIngest({ entities: 1, edges: 0, memories: 0, tasks: 0 })
    const distill = vi.fn(async () => 'distilled markdown')
    const parse = vi.fn(async () => ({ text: 'SHOULD NOT BE CALLED', summary: '' }))
    const ingestFile = createFileIngestor({
      filesApi: { writeBytes: fw.writeBytes } as unknown as FilesApi,
      ingest: ing.ingest as never,
      distill,
      parse: parse as never,
    })

    const result = await ingestFile(
      { fileName: 'doc.pdf', mime: 'application/pdf', bytes: Buffer.from('%PDF') },
      ctx,
    )

    expect(parse).not.toHaveBeenCalled()
    expect(distill).toHaveBeenCalledOnce()
    expect(ing.calls[0].content).toBe('distilled markdown')
    expect(result.distilled).toBe(true)
    expect(result.decomposed).toBe(true)
  })

  it('stores a blank PDF without decomposing it', async () => {
    const fw = fakeWriteBytes()
    const ing = fakeIngest({ entities: 0, edges: 0, memories: 0, tasks: 0 })
    const ingestFile = createFileIngestor({
      filesApi: { writeBytes: fw.writeBytes } as unknown as FilesApi,
      ingest: ing.ingest as never,
      distill: vi.fn(async () => '   '),
    })

    const result = await ingestFile(
      { fileName: 'blank.png', mime: 'image/png', bytes: Buffer.from('x') },
      ctx,
    )

    expect(fw.calls).toHaveLength(1)
    expect(ing.ingest).not.toHaveBeenCalled()
    expect(result).toMatchObject({
      distilled: true,
      decomposed: false,
      counts: { entities: 0, edges: 0, memories: 0, tasks: 0 },
    })
  })

  it('throws FileIngestError when the byte write hits quota', async () => {
    const fw = fakeWriteBytes({ fail: 'quota' })
    const ing = fakeIngest({ entities: 0, edges: 0, memories: 0, tasks: 0 })
    const ingestFile = createFileIngestor({
      filesApi: { writeBytes: fw.writeBytes } as unknown as FilesApi,
      ingest: ing.ingest as never,
      distill: vi.fn(async () => ''),
    })

    await expect(
      ingestFile({ fileName: 'big.pdf', mime: 'application/pdf', bytes: Buffer.from('x') }, ctx),
    ).rejects.toBeInstanceOf(FileIngestError)
    expect(ing.ingest).not.toHaveBeenCalled()
  })
})

/**
 * Every one of these used to return `ok: true` with no way for a caller to
 * learn that the brain got less than the whole file — the drop-block rendered
 * "Stored" or "N added to brain" either way.
 */
describe('[COMP:files/ingest] createFileIngestor reports what the brain did not get', () => {
  function ingestorWith(parse: () => Promise<unknown>) {
    const fw = fakeWriteBytes()
    const ing = fakeIngest({ entities: 0, edges: 0, memories: 0, tasks: 0 })
    const ingestFile = createFileIngestor({
      filesApi: { writeBytes: fw.writeBytes } as unknown as FilesApi,
      ingest: ing.ingest as never,
      distill: vi.fn(async () => 'SHOULD NOT BE CALLED'),
      parse: parse as never,
    })
    return { ingestFile, ing, fw }
  }

  it('never chunks or decomposes a parser placeholder', async () => {
    const { ingestFile, ing, fw } = ingestorWith(async () => ({
      text: '[Document: old.doc. The legacy .doc format is not supported; re-save as .docx to extract its text.]',
      summary: 'Document: old.doc',
      placeholder: true as const,
    }))

    const result = await ingestFile(
      { fileName: 'old.doc', mime: 'application/msword', bytes: Buffer.from('x') },
      ctx,
    )

    // The bytes are durable; nothing else ran.
    expect(fw.calls).toHaveLength(1)
    expect(indexMock).not.toHaveBeenCalled()
    expect(ing.ingest).not.toHaveBeenCalled()
    expect(result).toMatchObject({ decomposed: false, skipped: 'unsupported_type' })
  })

  it('reports an empty parse as empty rather than as a silent success', async () => {
    const { ingestFile, ing } = ingestorWith(async () => ({ text: '   ', summary: '' }))

    const result = await ingestFile(
      { fileName: 'blank.txt', mime: 'text/plain', bytes: Buffer.from(' ') },
      ctx,
    )

    expect(ing.ingest).not.toHaveBeenCalled()
    expect(result).toMatchObject({ decomposed: false, skipped: 'empty' })
  })

  it('reports storage-only staging as not_requested', async () => {
    const { ingestFile } = ingestorWith(async () => ({ text: 'x', summary: '' }))

    const result = await ingestFile(
      { fileName: 'pin.md', mime: 'text/markdown', bytes: Buffer.from('x'), process: false },
      ctx,
    )

    expect(result).toMatchObject({ decomposed: false, skipped: 'not_requested' })
  })

  it('carries the segment count up on a complete index', async () => {
    const { ingestFile } = ingestorWith(async () => ({ text: 'real content', summary: '' }))

    const result = await ingestFile(
      { fileName: 'notes.md', mime: 'text/markdown', bytes: Buffer.from('x') },
      ctx,
    )

    expect(result.segments).toBe(3)
    expect(result.truncated).toBeUndefined()
    expect(result.skipped).toBeUndefined()
  })

  it('carries truncation up, so a partial index cannot present as a whole one', async () => {
    indexMock.mockResolvedValue({
      segmentsInserted: 2000,
      segmentCount: 2000,
      truncated: true,
      truncatedAtChar: 2_948_500,
    })
    const { ingestFile } = ingestorWith(async () => ({ text: 'a very long document', summary: '' }))

    const result = await ingestFile(
      { fileName: 'report.html', mime: 'text/html', bytes: Buffer.from('x') },
      ctx,
    )

    expect(result).toMatchObject({
      decomposed: true,
      segments: 2000,
      truncated: true,
      truncatedAtChar: 2_948_500,
    })
  })

  it('names the recording pipeline for audio instead of calling it empty', async () => {
    const { ingestFile, ing } = ingestorWith(async () => ({ text: '', summary: '' }))

    const result = await ingestFile(
      { fileName: 'note.m4a', mime: 'audio/mp4', bytes: Buffer.from('x') },
      ctx,
    )

    expect(indexMock).not.toHaveBeenCalled()
    expect(ing.ingest).not.toHaveBeenCalled()
    expect(result.skipped).toBe('media_owned_by_recordings')
  })

  it('still decomposes when segment indexing itself fails', async () => {
    indexMock.mockRejectedValue(new Error('pool down'))
    const { ingestFile, ing } = ingestorWith(async () => ({ text: 'real content', summary: '' }))

    const result = await ingestFile(
      { fileName: 'notes.md', mime: 'text/markdown', bytes: Buffer.from('x') },
      ctx,
    )

    expect(ing.ingest).toHaveBeenCalledOnce()
    expect(result.decomposed).toBe(true)
    expect(result.segments).toBeUndefined()
  })
})
