import { bindScopeSource } from '../../security/source-evidence.js'
import { describe, it, expect, vi } from 'vitest'
import { createReadFileTool } from '../tool.js'
import type { FileStore, CachedFile } from '../types.js'

function makeFakeFileStore(files: CachedFile[] = []): FileStore {
  return {
    async cache(params) {
      const file: CachedFile = {
        id: `file_${files.length + 1}`,
        sessionId: params.sessionId,
        fileName: params.fileName,
        mimeType: params.mimeType,
        content: params.content,
        summary: params.summary ?? null,
        sizeBytes: params.sizeBytes,
      }
      files.push(file)
      return file
    },
    async get(id) {
      return files.find((f) => f.id === id) ?? null
    },
    async getBySession(sessionId) {
      return files.filter((f) => f.sessionId === sessionId)
    },
  }
}

const ctx = {
  workspaceId: 'w1',
  assistantId: 'a1',
  userId: 'u1',
  sessionId: 's1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'c_1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:files/tool] readFileContent', () => {
  it('returns the full cached file content', async () => {
    const file: CachedFile = {
      id: 'file_abc',
      sessionId: 's1',
      fileName: 'doc.pdf',
      mimeType: 'application/pdf',
      content: 'Full document text here',
      summary: 'A short doc',
      sizeBytes: 23,
    }
    const store = makeFakeFileStore([file])
    const tool = createReadFileTool(store)
    const result = await tool.execute({ fileId: 'file_abc' }, ctx)
    expect(result.isError).toBeFalsy()
    expect(result.data).toMatchObject({
      fileName: 'doc.pdf',
      mimeType: 'application/pdf',
      content: 'Full document text here',
      sizeBytes: 23,
    })
  })

  it('returns an error when the file id is not found', async () => {
    const tool = createReadFileTool(makeFakeFileStore())
    const result = await tool.execute({ fileId: 'file_missing' }, ctx)
    expect(result.isError).toBe(true)
    const data = String(result.data)
    // Names the id, explains why a valid-looking id can miss (expiry), names
    // where a valid id comes from (there is no listing tool over the upload
    // cache), and forbids the blind retry.
    expect(data).toContain('file_missing')
    expect(data).toContain('expired')
    expect(data).toContain('<attached_file id="…">')
    expect(data).toContain('no tool that lists cached uploads')
    expect(data).toContain('Do NOT retry this exact id')
  })

  it('passes the caller ceiling and retains canonical source evidence', async () => {
    const source = { resourceKind: 'workspace_file' as const, resourceId: 'f1', version: '2', workspaceId: 'w1',
      userId: null, assistantId: null, sensitivity: 'internal' as const, compartments: [], projectIds: [] }
    const file = bindScopeSource({ id: 'cache1', sessionId: 's1', fileName: 'report.txt', mimeType: 'text/plain',
      content: 'Fictional report', summary: null, sizeBytes: 16 }, source)
    const store = makeFakeFileStore([file]); store.get = vi.fn(store.get)
    const result = await createReadFileTool(store).execute({ fileId: 'cache1' }, { ...ctx, clearance: 'internal', compartments: [], projectIds: [] })
    expect(store.get).toHaveBeenCalledWith('cache1', expect.objectContaining({ workspaceId: 'w1', userId: 'u1', clearance: 'internal', compartments: [], projectIds: [] }))
    expect(result.scopeEvidence?.sources).toEqual([source])
    expect((await createReadFileTool(store).execute({ fileId: 'cache1' }, { ...ctx, workspaceId: undefined })).isError).toBe(true)
    expect(store.get).toHaveBeenCalledTimes(1)
  })

  it('is read-only and concurrency-safe', () => {
    const tool = createReadFileTool(makeFakeFileStore())
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
  })
})
