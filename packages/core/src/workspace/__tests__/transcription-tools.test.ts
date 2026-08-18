import { describe, it, expect, vi } from 'vitest'
import { createTranscriptionPrefTools, type WorkspaceTranscriptionPrefsPort } from '../transcription-tools.js'
import type { ToolContext } from '../../tools/types.js'

const context = (workspaceId?: string): ToolContext =>
  ({
    userId: 'user-1',
    assistantId: 'assistant-1',
    sessionId: 'session-1',
    appId: 'Use Brian',
    channelType: 'web',
    channelId: 'chan-1',
    ...(workspaceId ? { workspaceId } : {}),
  }) as ToolContext

function makeStore(overrides: Partial<WorkspaceTranscriptionPrefsPort> = {}): WorkspaceTranscriptionPrefsPort {
  return {
    get: vi.fn(async () => ({})),
    set: vi.fn(async (_u, _w, patch) => ({
      ok: true as const,
      prefs: {
        ...(patch.languageCode ? { languageCode: patch.languageCode } : {}),
        ...(patch.chineseScript ? { chineseScript: patch.chineseScript } : {}),
      },
    })),
    ...overrides,
  }
}

describe('[COMP:workspace/transcription-prefs] configureTranscriptionPreference', () => {
  it('reads the current preference when called with no arguments', async () => {
    const store = makeStore({
      get: vi.fn(async () => ({ chineseScript: 'traditional' as const })),
    })
    const { configureTranscriptionPreference: tool } = createTranscriptionPrefTools(store)
    const res = await tool.execute({}, context('ws-1'))
    expect(res.isError).toBeUndefined()
    expect(res.data).toMatchObject({ prefs: { chineseScript: 'traditional' } })
    expect(store.set).not.toHaveBeenCalled()
  })

  it('writes a script preference and reports the saved prefs', async () => {
    const store = makeStore()
    const { configureTranscriptionPreference: tool } = createTranscriptionPrefTools(store)
    const res = await tool.execute({ chineseScript: 'traditional' }, context('ws-1'))
    expect(store.set).toHaveBeenCalledWith('user-1', 'ws-1', { chineseScript: 'traditional' })
    expect(res.data).toMatchObject({ prefs: { chineseScript: 'traditional' } })
  })

  it("maps 'auto' to a clear (null) on both fields", async () => {
    const store = makeStore()
    const { configureTranscriptionPreference: tool } = createTranscriptionPrefTools(store)
    await tool.execute({ chineseScript: 'auto', languageCode: 'auto' }, context('ws-1'))
    expect(store.set).toHaveBeenCalledWith('user-1', 'ws-1', {
      chineseScript: null,
      languageCode: null,
    })
  })

  it('surfaces a not_admin rejection as a tool error the assistant can relay', async () => {
    const store = makeStore({
      set: vi.fn(async () => ({
        ok: false as const,
        reason: 'not_admin' as const,
        message: 'Only a workspace owner or admin can change transcription preferences.',
      })),
    })
    const { configureTranscriptionPreference: tool } = createTranscriptionPrefTools(store)
    const res = await tool.execute({ languageCode: 'yue' }, context('ws-1'))
    expect(res.isError).toBe(true)
    const data = String(res.data)
    // The store's diagnosis leads; the tool owns the next step + verdict,
    // because only it knows the READ is ungated while the write is not.
    expect(data).toContain('owner or admin')
    expect(data).toContain('Nothing was changed')
    expect(data).toContain('with NO arguments')
    expect(data).toContain('will keep failing')
  })

  it('translates a not_found workspace into a do-not-retry, not a role problem', async () => {
    const store = makeStore({
      set: vi.fn(async () => ({
        ok: false as const,
        reason: 'not_found' as const,
        message: 'Workspace not found.',
      })),
    })
    const { configureTranscriptionPreference: tool } = createTranscriptionPrefTools(store)
    const res = await tool.execute({ chineseScript: 'traditional' }, context('ws-1'))
    expect(res.isError).toBe(true)
    const data = String(res.data)
    expect(data).toContain('no longer exists')
    expect(data).toContain('do NOT retry')
    expect(data).not.toContain('owner or admin')
  })

  it('errors without a workspace binding', async () => {
    const store = makeStore()
    const { configureTranscriptionPreference: tool } = createTranscriptionPrefTools(store)
    const res = await tool.execute({ chineseScript: 'traditional' }, context())
    expect(res.isError).toBe(true)
    const data = String(res.data)
    expect(data).toContain('workspaces.transcription_prefs')
    expect(data).toContain('Studio')
    expect(data).toContain('will keep failing')
    expect(store.set).not.toHaveBeenCalled()
  })
})
