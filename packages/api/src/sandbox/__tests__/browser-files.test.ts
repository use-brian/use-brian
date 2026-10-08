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
  const prepare = vi.fn(async () => ({ taskId: 'task', assertCurrent: async () => {}, writeBytes: vi.fn(async () => ({ fileId: 'file', path: '/protected' })) }))
  return { api, context, prepare, bridge: createBrowserFileBridge(api as unknown as FilesApi, async () => 'confidential', prepare) }
}

describe('browser workspace file authority', () => {
  it('preserves the assistant/member ceiling and all scope and write provenance', async () => {
    const f = fixture()
    await f.bridge.readBytes(f.context, 'file')
    expect(f.api.readBytes).toHaveBeenCalledWith(expect.objectContaining({ userId: 'u', workspaceId: 'w', assistantId: 'a', assistantKind: 'app',
      clearance: 'internal', compartments: ['legal'], mutationCompartments: ['legal'], projectIds: ['p'], writeCompartments: ['legal'], writeProjectIds: ['p'], writeSensitivity: 'internal' }), 'file')
    await f.bridge.prepareWrite(f.context, { backend: 'local', profileId: 'profile' })
    expect(f.prepare).toHaveBeenCalledWith(f.context, { backend: 'local', profileId: 'profile' })
    expect(f.api.writeBytes).not.toHaveBeenCalled()
  })
  it('never reads bytes when unauthorized or oversized', async () => {
    const f = fixture()
    f.api.stat.mockResolvedValueOnce({ ok: false } as never)
    await expect(f.bridge.readBytes(f.context, 'secret')).rejects.toThrow(/unauthorized/)
    f.api.stat.mockResolvedValueOnce({ ok: true, value: { sizeBytes: 4 * 1024 * 1024 + 1 } } as never)
    await expect(f.bridge.readBytes(f.context, 'large')).rejects.toThrow(/4 MiB/)
    expect(f.api.readBytes).not.toHaveBeenCalled()
  })
})
