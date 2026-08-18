import { describe, it, expect, vi } from 'vitest'
import type { LLMProvider, StreamChunk, ToolContext } from '@use-brian/core'

import { createRefineActiveThemeTool } from '../theme-tools.js'
import type { DocThemeStore, StoredDocTheme } from '../../db/doc-themes-store.js'

function mockProvider(response: string): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: response } as StreamChunk
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 40 },
      } as StreamChunk
    },
  } as unknown as LLMProvider
}

const THEME: StoredDocTheme = {
  id: 'theme-1',
  workspaceId: 'ws-1',
  createdBy: 'u-1',
  name: 'Deep Focus',
  description: 'Calm.',
  prompt: 'calm ocean',
  seed: {
    name: 'Deep Focus',
    description: 'Calm.',
    primary: '#0EA5E9',
    accent: '#14B8A6',
    neutral: '#0F2A3A',
    mood: 'muted',
  },
  tokens: { light: {} as never, dark: {} as never },
  createdAt: new Date(0),
  updatedAt: new Date(0),
}

const ADJUSTED =
  '{"name":"Whatever","primary":"#F97316","accent":"#FACC15","neutral":"#2A1D1A","mood":"vivid"}'

function storeWith(theme: StoredDocTheme | null): DocThemeStore {
  return {
    list: vi.fn(),
    getById: vi.fn(async () => theme),
    create: vi.fn(),
    rename: vi.fn(),
    updateGenerated: vi.fn(async (_u, id, fields) => ({ ...THEME, id, ...fields })),
    remove: vi.fn(),
  } as unknown as DocThemeStore
}

const ctx = { userId: 'u-1', sessionId: 's-1', workspaceId: 'ws-1' } as ToolContext

describe('[COMP:doc-themes/refine-tool] refineActiveTheme', () => {
  it('refines the active theme in place and fires onRefined', async () => {
    const store = storeWith(THEME)
    const onRefined = vi.fn()
    const tool = createRefineActiveThemeTool({
      themeId: 'theme-1',
      provider: mockProvider(ADJUSTED),
      store,
      onRefined,
    })

    const result = await tool.execute({ instruction: 'make it warmer' }, ctx)

    expect(result.isError).toBeFalsy()
    expect(store.updateGenerated).toHaveBeenCalledOnce()
    // Name held stable; tokens rebuilt (non-empty) from the adjusted seed.
    const [, , fields] = (store.updateGenerated as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(fields.seed.name).toBe('Deep Focus')
    expect(fields.seed.primary).toBe('#F97316')
    expect(Object.keys(fields.tokens.light).length).toBeGreaterThan(0)
    // Third arg is the refined theme's appearance (mood 'vivid', no explicit
    // appearance on either seed → derives 'light').
    expect(onRefined).toHaveBeenCalledWith(
      'theme-1',
      expect.objectContaining({ light: expect.any(Object) }),
      'light',
    )
  })

  // Failure copy (docs/architecture/engine/tool-executor.md → "Failure copy"):
  // the applied-theme id is client state, not an argument the model passed, so
  // a miss must say the theme is gone, that no tool can list or pick one, and
  // that the remedy is the user's Theme menu — never a bare "not found".
  it('names the missing theme id, the user-side remedy, and forbids the retry', async () => {
    const tool = createRefineActiveThemeTool({
      themeId: 'theme-1',
      provider: mockProvider(ADJUSTED),
      store: storeWith(null),
    })
    const result = await tool.execute({ instruction: 'warmer' }, ctx)
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toContain('theme-1')
    expect(data).toMatch(/was not changed/i)
    expect(data).toMatch(/no longer exists/i)
    expect(data).toMatch(/no tool that can list or pick a theme/i)
    expect(data).toMatch(/Theme menu/)
    expect(data).toMatch(/will fail the same way/i)
  })

  it('names the theme, the rejected instruction, and the retry verdict when the model output is unusable', async () => {
    const store = storeWith(THEME)
    const tool = createRefineActiveThemeTool({
      themeId: 'theme-1',
      provider: mockProvider('sorry no'),
      store,
    })
    const result = await tool.execute({ instruction: 'warmer' }, ctx)
    expect(result.isError).toBe(true)
    expect(store.updateGenerated).not.toHaveBeenCalled()
    const data = String(result.data)
    // WHAT: the theme and the exact instruction that was rejected.
    expect(data).toContain(THEME.name)
    expect(data).toContain('"warmer"')
    // NEXT STEP + verdict: rephrase concretely, do not resend the same words.
    expect(data).toMatch(/Nothing was saved/i)
    expect(data).toMatch(/more contrast|swap the accent/i)
    expect(data).toMatch(/same instruction again will fail the same way/i)
  })

  it('reports a theme deleted mid-refine as unsaved, not as applied', async () => {
    const store = storeWith(THEME)
    // Generation succeeds; the row vanishes before the write lands.
    store.updateGenerated = vi.fn().mockResolvedValue(null)
    const tool = createRefineActiveThemeTool({
      themeId: 'theme-1',
      provider: mockProvider(ADJUSTED),
      store,
    })
    const result = await tool.execute({ instruction: 'warmer' }, ctx)
    expect(result.isError).toBe(true)
    const data = String(result.data)
    expect(data).toContain('theme-1')
    expect(data).toMatch(/was not changed/i)
    expect(data).toMatch(/deleted while this ran/i)
    expect(data).toMatch(/Nothing was saved/i)
    expect(data).toMatch(/will fail the same way/i)
  })
})
