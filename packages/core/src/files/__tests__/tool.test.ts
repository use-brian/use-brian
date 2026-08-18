import { describe, it, expect } from 'vitest'
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

  it('is read-only and concurrency-safe', () => {
    const tool = createReadFileTool(makeFakeFileStore())
    expect(tool.isReadOnly).toBe(true)
    expect(tool.isConcurrencySafe).toBe(true)
  })
})
