import { describe, it, expect, vi } from 'vitest'
vi.mock('@use-brian/core', async () => ({
  ...(await import('../../../../core/src/security/sensitivity.js')),
  ...(await import('../../../../core/src/security/context-scope.js')),
  workspaceFilesCtxFor: (await import('../../../../core/src/workspace-files/tool-helpers.js')).ctxFor,
}))
import { createBrowserFileBridge } from '../browser-files.js'
import { ContextScopeAccumulator } from '../../../../core/src/security/context-scope.js'
import type { FilesApi, FilesContext } from '../../../../core/src/workspace-files/api.js'
import type { ToolContext } from '../../../../core/src/tools/types.js'

function fixture() {
  const file = { id: 'file', path: '/workspace.txt', mime: 'text/plain', sizeBytes: 3,
    sensitivity: 'internal' as const, compartments: ['legal'], projectIds: ['p'], createdByAssistantId: 'a', createdByUserId: 'u' }
  const api = {
    stat: vi.fn(async () => ({ ok: true, value: file })),
    readBytes: vi.fn(async () => ({ ok: true, value: { file, bytes: Buffer.from('abc') } })),
    writeBytes: vi.fn(async (_ctx: FilesContext, params: { path: string }) => ({ ok: true, value: { ...file, path: params.path } })),
  }
  const context: ToolContext = { userId: 'u', workspaceId: 'w', assistantId: 'a', sessionId: 's', appId: 'app', channelType: 'web', channelId: 'c',
    clearance: 'internal', assistantKind: 'app', compartments: ['legal'], mutationCompartments: ['legal'], projectIds: ['p'],
    assistantDefaultCompartments: ['legal'], assistantDefaultProjectIds: ['p'],
    scopeAccumulator: new ContextScopeAccumulator({ sensitivity: 'internal', compartments: ['legal'], projectIds: ['p'] }),
    abortSignal: new AbortController().signal }
  return { api, context, bridge: createBrowserFileBridge(api as unknown as FilesApi, async () => 'confidential') }
}

describe('browser workspace file authority', () => {
  it('preserves the assistant/member ceiling and all scope and write provenance', async () => {
    const f = fixture()
    await f.bridge.readBytes(f.context, 'file')
    expect(f.api.readBytes).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', workspaceId: 'w', assistantId: 'a', assistantKind: 'app',
      clearance: 'internal', compartments: ['legal'], mutationCompartments: ['legal'], projectIds: ['p'], writeCompartments: ['legal'], writeProjectIds: ['p'], writeSensitivity: 'internal' }), 'file')
    const saved = await f.bridge.writeBytes(f.context, { path: '/browser-downloads/key/a.txt', name: 'a.txt', mime: 'text/plain', bytes: Buffer.from('abc') })
    expect(saved.fileId).toBe('file')
    expect(f.api.writeBytes).toHaveBeenCalledWith(expect.objectContaining({ assistantId: 'a', writeSensitivity: 'internal' }), expect.objectContaining({ sensitivity: 'internal', mime: 'text/plain', bytes: Buffer.from('abc') }))
  })
  it('never reads bytes when unauthorized or oversized', async () => {
    const f = fixture()
    f.api.stat.mockResolvedValueOnce({ ok: false } as never)
    await expect(f.bridge.readBytes(f.context, 'secret')).rejects.toThrow(/unauthorized/)
    f.api.stat.mockResolvedValueOnce({ ok: true, value: { sizeBytes: 4 * 1024 * 1024 + 1 } } as never)
    await expect(f.bridge.readBytes(f.context, 'large')).rejects.toThrow(/4 MiB/)
    expect(f.api.readBytes).not.toHaveBeenCalled()
  })
  it('revalidates existing artifacts, rejects collisions and partitions write provenance', async () => {
    const f = fixture()
    const params = { path: '/browser-downloads/key/a.txt', name: 'a.txt', mime: 'text/plain', bytes: Buffer.from('abc') }
    const first = await f.bridge.writeBytes(f.context, params)
    f.context.scopeAccumulator!.note({ sensitivity: 'confidential' })
    const second = await f.bridge.writeBytes(f.context, params)
    expect(second.path).not.toBe(first.path)
    f.api.writeBytes.mockResolvedValue({ ok: false, error: { kind: 'conflict' } } as never)
    f.api.readBytes.mockResolvedValueOnce({ ok: true, value: { file: { id: 'file', path: second.path, sensitivity: 'confidential',
      createdByAssistantId: 'a', createdByUserId: 'u', compartments: ['legal'], projectIds: ['p'] }, bytes: Buffer.from('abc') } } as never)
    expect((await f.bridge.writeBytes(f.context, params)).fileId).toBe('file')
    f.api.readBytes.mockResolvedValueOnce({ ok: false } as never)
    await expect(f.bridge.writeBytes(f.context, params)).rejects.toThrow(/persist/)
    await expect(f.bridge.writeBytes(f.context, { ...params, bytes: Buffer.from('different') })).rejects.toThrow(/persist/)
  })
})
