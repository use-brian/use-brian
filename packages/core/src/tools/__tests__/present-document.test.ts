import { describe, expect, it } from 'vitest'
import {
  createPresentDocumentTool,
  MAX_PRESENTED_DOCUMENT_CHARS,
  parsePresentedDocumentInput,
} from '../base/present-document.js'
import type { ToolContext } from '../types.js'

const ctx: ToolContext = {
  userId: 'user-1',
  assistantId: 'assistant-1',
  sessionId: 'session-1',
  appId: 'Use Brian',
  channelType: 'web',
  channelId: 'channel-1',
  workspaceId: 'workspace-1',
  abortSignal: new AbortController().signal,
}

describe('[COMP:app-web/chat-document-viewer] presentDocument tool', () => {
  it('defaults extracted sources to plain text and preserves the body verbatim', () => {
    expect(
      parsePresentedDocumentInput({
        title: ' Source.docx ',
        content: 'Line one\n\n**not rewritten**',
      }),
    ).toEqual({
      title: 'Source.docx',
      content: 'Line one\n\n**not rewritten**',
      format: 'text',
    })
  })

  it('rejects empty and over-limit bodies at the shared boundary', () => {
    expect(parsePresentedDocumentInput({ title: 'Empty', content: '' })).toBeNull()
    expect(
      parsePresentedDocumentInput({
        title: 'Too large',
        content: 'x'.repeat(MAX_PRESENTED_DOCUMENT_CHARS + 1),
      }),
    ).toBeNull()
  })

  it('returns a compact acknowledgement rather than duplicating document content', async () => {
    const tool = createPresentDocumentTool()
    const result = await tool.execute(
      {
        title: 'Board memo',
        content: 'confidential source body',
        format: 'text',
        sourceName: 'Email attachment',
      },
      ctx,
    )
    expect(result.data).toEqual({
      kind: 'document_presented',
      title: 'Board memo',
      format: 'text',
      sourceName: 'Email attachment',
    })
    expect(JSON.stringify(result.data)).not.toContain('confidential source body')
  })
})
