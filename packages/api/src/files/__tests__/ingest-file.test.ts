import { describe, expect, it, vi } from 'vitest'
import type { FilesApi } from '@use-brian/core'
import { createFileIngestor, FileIngestError, type FileIngestContext } from '../ingest-file.js'

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

describe('[COMP:files/ingest] createFileIngestor', () => {
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
