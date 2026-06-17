import { describe, it, expect, vi } from 'vitest'
import type { DocPageStore, Page, Tool, ToolContext } from '@sidanclaw/core'
import { placeReplyOnEmptyPage, placeReplyAtAnchor } from '../reply-fallback.js'

const USER_ID = 'user-1'
const PAGE_ID = 'page-1'

const ctx = {
  userId: USER_ID,
  assistantId: 'asst-1',
  sessionId: 'sess-1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'web-1',
  workspaceId: 'ws-1',
  assistantKind: 'app',
  abortSignal: new AbortController().signal,
} as unknown as ToolContext

/** A `DocPageStore` whose `getVersionedPage` returns the given page (or null). */
function pageStore(page: Page | null): DocPageStore {
  return {
    getVersionedPage: vi
      .fn()
      .mockResolvedValue(
        page
          ? { page, version: 3, title: 'New draft', nameOrigin: 'placeholder', icon: null }
          : null,
      ),
    applyPatch: vi.fn(),
  } as unknown as DocPageStore
}

/** A fake `patchPage` tool whose `execute` returns success unless `isError`. */
function patchTool(isError = false): { tool: Tool; execute: ReturnType<typeof vi.fn> } {
  const execute = vi
    .fn()
    .mockResolvedValue(isError ? { data: 'boom', isError: true } : { data: { kind: 'doc_patch' } })
  return { tool: { name: 'patchPage', execute } as unknown as Tool, execute }
}

const EMPTY: Page = { blocks: [] }
const NON_EMPTY: Page = { blocks: [{ kind: 'text', id: 't1', text: 'hi' }] as never }

describe('[COMP:api/doc-reply-fallback] placeReplyOnEmptyPage', () => {
  it('writes the reply as an add op when the page is empty', async () => {
    const { tool, execute } = patchTool()
    const res = await placeReplyOnEmptyPage({
      pageId: PAGE_ID,
      replyText: 'I could not find any threads posts in this workspace.',
      docPageStore: pageStore(EMPTY),
      patchPageTool: tool,
      context: ctx,
    })

    expect(res).toEqual({ placed: true, pageId: PAGE_ID })
    expect(execute).toHaveBeenCalledTimes(1)
    const [input, passedCtx] = execute.mock.calls[0]
    expect(input.pageId).toBe(PAGE_ID)
    // expectedVersion is read off the live page (version 3 in the mock).
    expect(input.expectedVersion).toBe(3)
    expect(input.ops).toHaveLength(1)
    expect(input.ops[0]).toMatchObject({
      op: 'add',
      block: { kind: 'text', text: 'I could not find any threads posts in this workspace.' },
    })
    // The synthetic patch runs under the caller's tool context (RLS / gate).
    expect(passedCtx.userId).toBe(USER_ID)
  })

  it('no-ops on a non-empty page (never clobbers existing content)', async () => {
    const { tool, execute } = patchTool()
    const res = await placeReplyOnEmptyPage({
      pageId: PAGE_ID,
      replyText: 'some answer',
      docPageStore: pageStore(NON_EMPTY),
      patchPageTool: tool,
      context: ctx,
    })

    expect(res).toEqual({ placed: false, reason: 'page-not-empty' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('no-ops when the reply text is blank (never reads the page)', async () => {
    const store = pageStore(EMPTY)
    const { tool, execute } = patchTool()
    const res = await placeReplyOnEmptyPage({
      pageId: PAGE_ID,
      replyText: '   \n  ',
      docPageStore: store,
      patchPageTool: tool,
      context: ctx,
    })

    expect(res).toEqual({ placed: false, reason: 'no-text' })
    expect(store.getVersionedPage).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports page-not-found when the page is missing / not visible', async () => {
    const { tool, execute } = patchTool()
    const res = await placeReplyOnEmptyPage({
      pageId: PAGE_ID,
      replyText: 'answer',
      docPageStore: pageStore(null),
      patchPageTool: tool,
      context: ctx,
    })

    expect(res).toEqual({ placed: false, reason: 'page-not-found' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports patch-failed when the underlying patchPage errors', async () => {
    const { tool } = patchTool(true)
    const res = await placeReplyOnEmptyPage({
      pageId: PAGE_ID,
      replyText: 'answer',
      docPageStore: pageStore(EMPTY),
      patchPageTool: tool,
      context: ctx,
    })

    expect(res).toEqual({ placed: false, reason: 'patch-failed' })
  })
})

describe('[COMP:api/doc-reply-fallback] placeReplyAtAnchor', () => {
  it('writes the reply AFTER the anchor block on a populated page', async () => {
    const { tool, execute } = patchTool()
    const res = await placeReplyAtAnchor({
      pageId: PAGE_ID,
      anchorBlockId: 't1', // exists in NON_EMPTY
      replyText: 'Here is the section you asked for.',
      docPageStore: pageStore(NON_EMPTY),
      patchPageTool: tool,
      context: ctx,
    })

    expect(res).toEqual({ placed: true, pageId: PAGE_ID })
    expect(execute).toHaveBeenCalledTimes(1)
    const [input] = execute.mock.calls[0]
    expect(input.pageId).toBe(PAGE_ID)
    expect(input.expectedVersion).toBe(3)
    expect(input.ops).toHaveLength(1)
    // The reply lands as an `add` op anchored AFTER the user's cursor block —
    // NOT appended at the page end and NOT gated on emptiness.
    expect(input.ops[0]).toMatchObject({
      op: 'add',
      after: 't1',
      block: { kind: 'text', text: 'Here is the section you asked for.' },
    })
  })

  it('reports anchor-missing when the anchor block is no longer on the page', async () => {
    const { tool, execute } = patchTool()
    const res = await placeReplyAtAnchor({
      pageId: PAGE_ID,
      anchorBlockId: 'gone', // not in NON_EMPTY
      replyText: 'answer',
      docPageStore: pageStore(NON_EMPTY),
      patchPageTool: tool,
      context: ctx,
    })

    // The caller falls through to placeReplyOnEmptyPage on this signal.
    expect(res).toEqual({ placed: false, reason: 'anchor-missing' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('no-ops when the reply text is blank (never reads the page)', async () => {
    const store = pageStore(NON_EMPTY)
    const { tool, execute } = patchTool()
    const res = await placeReplyAtAnchor({
      pageId: PAGE_ID,
      anchorBlockId: 't1',
      replyText: '   \n  ',
      docPageStore: store,
      patchPageTool: tool,
      context: ctx,
    })

    expect(res).toEqual({ placed: false, reason: 'no-text' })
    expect(store.getVersionedPage).not.toHaveBeenCalled()
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports page-not-found when the page is missing / not visible', async () => {
    const { tool, execute } = patchTool()
    const res = await placeReplyAtAnchor({
      pageId: PAGE_ID,
      anchorBlockId: 't1',
      replyText: 'answer',
      docPageStore: pageStore(null),
      patchPageTool: tool,
      context: ctx,
    })

    expect(res).toEqual({ placed: false, reason: 'page-not-found' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('reports patch-failed when the underlying patchPage errors', async () => {
    const { tool } = patchTool(true)
    const res = await placeReplyAtAnchor({
      pageId: PAGE_ID,
      anchorBlockId: 't1',
      replyText: 'answer',
      docPageStore: pageStore(NON_EMPTY),
      patchPageTool: tool,
      context: ctx,
    })

    expect(res).toEqual({ placed: false, reason: 'patch-failed' })
  })
})
