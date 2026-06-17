import { describe, it, expect, vi } from 'vitest'
import type {
  DocPageStore,
  LLMProvider,
  NameOrigin,
  Page,
  SavedViewStore,
  StreamChunk,
} from '@sidanclaw/core'
import { runDocAutoTitle } from '../auto-title.js'

const USER_ID = 'user-1'
const PAGE_ID = 'page-1'

/** A page whose plaintext comfortably clears a low test threshold. */
function bodyPage(text: string): Page {
  return { blocks: [{ kind: 'text', id: 't', text }] as never }
}

function mockProvider(title: string): LLMProvider {
  return {
    createSession() {
      return { thoughtSignature: undefined } as never
    },
    async *stream(): AsyncGenerator<StreamChunk> {
      yield { type: 'text_delta', text: title } as StreamChunk
      yield {
        type: 'message_end',
        stopReason: 'end_turn',
        usage: { inputTokens: 50, outputTokens: 4 },
      } as StreamChunk
    },
  } as unknown as LLMProvider
}

function pageStore(read: {
  nameOrigin: NameOrigin
  text: string
} | null): DocPageStore {
  return {
    getVersionedPage: vi.fn().mockResolvedValue(
      read
        ? { page: bodyPage(read.text), version: 1, title: 'Untitled', nameOrigin: read.nameOrigin }
        : null,
    ),
    applyPatch: vi.fn(),
  } as unknown as DocPageStore
}

function savedStore(committed: { name: string; icon: string | null } | null): {
  store: SavedViewStore
  setAutoTitle: ReturnType<typeof vi.fn>
} {
  const setAutoTitle = vi.fn().mockResolvedValue(committed)
  return { store: { setAutoTitle } as unknown as SavedViewStore, setAutoTitle }
}

const LONG = 'A page about quarterly revenue growth and enterprise renewals.' // > floor

describe('[COMP:api/doc-auto-title] runDocAutoTitle', () => {
  it('generates + commits for a placeholder page over the size floor', async () => {
    const { store, setAutoTitle } = savedStore({
      name: 'Quarterly Revenue Growth',
      icon: null,
    })
    const result = await runDocAutoTitle({
      userId: USER_ID,
      pageId: PAGE_ID,
      provider: mockProvider('Quarterly Revenue Growth'),
      docPageStore: pageStore({ nameOrigin: 'placeholder', text: LONG }),
      savedViewStore: store,
      minChars: 10,
    })
    expect(result).toEqual({
      applied: true,
      title: 'Quarterly Revenue Growth',
      icon: null,
      usage: { inputTokens: 50, outputTokens: 4 },
      model: 'gemini-3.1-flash-lite',
    })
    // No emoji from the model → the icon arg is null.
    expect(setAutoTitle).toHaveBeenCalledWith(USER_ID, PAGE_ID, 'Quarterly Revenue Growth', null)
  })

  it('passes the model-suggested emoji through to the commit and result', async () => {
    const { store, setAutoTitle } = savedStore({
      name: 'Quarterly Revenue Growth',
      icon: '📈',
    })
    const result = await runDocAutoTitle({
      userId: USER_ID,
      pageId: PAGE_ID,
      provider: mockProvider('📈 Quarterly Revenue Growth'),
      docPageStore: pageStore({ nameOrigin: 'placeholder', text: LONG }),
      savedViewStore: store,
      minChars: 10,
    })
    expect(result.applied).toBe(true)
    expect(result.title).toBe('Quarterly Revenue Growth')
    expect(result.icon).toBe('📈')
    expect(setAutoTitle).toHaveBeenCalledWith(
      USER_ID,
      PAGE_ID,
      'Quarterly Revenue Growth',
      '📈',
    )
  })

  it('skips a non-placeholder page without calling the model', async () => {
    const { store, setAutoTitle } = savedStore({ name: 'x', icon: null })
    const provider = mockProvider('Should Not Run')
    const streamSpy = vi.spyOn(provider, 'stream')
    const result = await runDocAutoTitle({
      userId: USER_ID,
      pageId: PAGE_ID,
      provider,
      docPageStore: pageStore({ nameOrigin: 'user', text: LONG }),
      savedViewStore: store,
      minChars: 10,
    })
    expect(result.applied).toBe(false)
    expect(result.title).toBeNull()
    expect(streamSpy).not.toHaveBeenCalled()
    expect(setAutoTitle).not.toHaveBeenCalled()
  })

  it('skips when the body is below the size floor', async () => {
    const { store, setAutoTitle } = savedStore({ name: 'x', icon: null })
    const result = await runDocAutoTitle({
      userId: USER_ID,
      pageId: PAGE_ID,
      provider: mockProvider('Nope'),
      docPageStore: pageStore({ nameOrigin: 'placeholder', text: 'hi' }),
      savedViewStore: store,
      minChars: 500,
    })
    expect(result.applied).toBe(false)
    expect(setAutoTitle).not.toHaveBeenCalled()
  })

  it('skips when the page is missing / RLS-hidden', async () => {
    const { store } = savedStore({ name: 'x', icon: null })
    const result = await runDocAutoTitle({
      userId: USER_ID,
      pageId: PAGE_ID,
      provider: mockProvider('Nope'),
      docPageStore: pageStore(null),
      savedViewStore: store,
      minChars: 10,
    })
    expect(result.applied).toBe(false)
    expect(result.title).toBeNull()
  })

  it('reports applied:false but keeps usage when a concurrent rename won the commit', async () => {
    // setAutoTitle returns null → another writer flipped name_origin first.
    const { store } = savedStore(null)
    const result = await runDocAutoTitle({
      userId: USER_ID,
      pageId: PAGE_ID,
      provider: mockProvider('Quarterly Revenue Growth'),
      docPageStore: pageStore({ nameOrigin: 'placeholder', text: LONG }),
      savedViewStore: store,
      minChars: 10,
    })
    expect(result.applied).toBe(false)
    expect(result.title).toBeNull()
    // The model still ran — usage is returned so the caller can attribute it.
    expect(result.usage).toEqual({ inputTokens: 50, outputTokens: 4 })
  })
})
