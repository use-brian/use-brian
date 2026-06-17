/**
 * Unit tests for the Google Docs tools.
 * Component tag: [COMP:tools/google-docs].
 *
 * Verifies createGoogleDocsTools: the four-tool surface + flags, the
 * read tool's data passthrough + `Docs error:` mapping, the write tools'
 * authorized-file confirmation bypass (resolveConfirmation → false only
 * when the doc id is in authorizedFiles), the always-prompt create, and
 * appendText's "Text appended successfully." fallback.
 */

import { describe, it, expect, vi } from 'vitest'
import { createGoogleDocsTools, type GoogleDocsApi } from '../google-docs.js'
import type { AuthorizedFile } from '../google-drive.js'
import type { Tool, ToolContext } from '../../types.js'

const ctx: ToolContext = {
  userId: 'u-1',
  assistantId: 'a-1',
  sessionId: 's-1',
  appId: 'sidanclaw',
  channelType: 'web',
  channelId: 'c-1',
  abortSignal: new AbortController().signal,
}

function stubApi(over: Partial<GoogleDocsApi> = {}): GoogleDocsApi {
  return {
    getContent: vi.fn().mockResolvedValue({ title: 'Doc', body: 'hello' }),
    appendText: vi.fn().mockResolvedValue(undefined),
    replaceText: vi.fn().mockResolvedValue({ replaced: 2 }),
    create: vi.fn().mockResolvedValue({ documentId: 'd-new', title: 'New', url: 'http://x' }),
    ...over,
  }
}

function byName(tools: Tool[], name: string): Tool {
  const t = tools.find((x) => x.name === name)
  if (!t) throw new Error(`tool ${name} not found`)
  return t
}

const authFile: AuthorizedFile = {
  id: 'd-ok',
  name: 'Picked',
  mimeType: 'application/vnd.google-apps.document',
  addedAt: '2026-05-16T00:00:00Z',
}

describe('[COMP:tools/google-docs] createGoogleDocsTools', () => {
  it('exposes the four docs tools with read/write flags', () => {
    const tools = createGoogleDocsTools(stubApi())
    expect(tools.map((t) => t.name)).toEqual([
      'googleDocsGetContent',
      'googleDocsAppendText',
      'googleDocsReplaceText',
      'googleDocsCreate',
    ])
    const get = byName(tools, 'googleDocsGetContent')
    expect(get.isReadOnly).toBe(true)
    expect(get.isConcurrencySafe).toBe(true)
    expect(get.requiresConfirmation).toBe(false)
    for (const w of ['googleDocsAppendText', 'googleDocsReplaceText', 'googleDocsCreate']) {
      const tool = byName(tools, w)
      expect(tool.isReadOnly).toBe(false)
      expect(tool.requiresConfirmation).toBe(true)
    }
  })

  it('getContent forwards the document id and returns the api payload', async () => {
    const api = stubApi()
    const tools = createGoogleDocsTools(api)
    const res = await byName(tools, 'googleDocsGetContent').execute({ documentId: 'd-1' }, ctx)
    expect(api.getContent).toHaveBeenCalledWith('d-1')
    expect(res.data).toEqual({ title: 'Doc', body: 'hello' })
    expect(res.isError).toBeFalsy()
  })

  it('getContent maps a thrown error to an isError result with the Docs prefix', async () => {
    const api = stubApi({ getContent: vi.fn().mockRejectedValue(new Error('not found')) })
    const tools = createGoogleDocsTools(api)
    const res = await byName(tools, 'googleDocsGetContent').execute({ documentId: 'd-x' }, ctx)
    expect(res.isError).toBe(true)
    expect(res.data).toBe('Docs error: not found')
  })

  it('appendText prompts for an un-authorized doc and skips for an authorized one', async () => {
    const tools = createGoogleDocsTools(stubApi(), [authFile])
    const append = byName(tools, 'googleDocsAppendText')
    expect(await append.resolveConfirmation?.(ctx, { documentId: 'd-other' })).toBe(true)
    expect(await append.resolveConfirmation?.(ctx, { documentId: 'd-ok' })).toBe(false)
  })

  it('appendText returns a fallback confirmation when the api yields nothing', async () => {
    const tools = createGoogleDocsTools(stubApi())
    const res = await byName(tools, 'googleDocsAppendText').execute(
      { documentId: 'd-1', text: 'more' },
      ctx,
    )
    expect(res.data).toBe('Text appended successfully.')
  })

  it('replaceText forwards the find/replace pair to the api', async () => {
    const api = stubApi()
    const tools = createGoogleDocsTools(api)
    await byName(tools, 'googleDocsReplaceText').execute(
      { documentId: 'd-1', findText: 'old', replaceText: 'new' },
      ctx,
    )
    expect(api.replaceText).toHaveBeenCalledWith('d-1', 'old', 'new')
  })

  it('create always prompts — even with a fully-authorized file list', async () => {
    const tools = createGoogleDocsTools(stubApi(), [authFile])
    expect(await byName(tools, 'googleDocsCreate').resolveConfirmation?.(ctx, { title: 'X' })).toBe(
      true,
    )
  })
})
