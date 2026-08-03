// @vitest-environment jsdom

import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { I18nProvider } from '@/lib/i18n/client'
import { en } from '@/lib/i18n/dictionaries/en'
import type { Dictionary } from '@/lib/i18n/dictionaries'
import {
  ChatDocumentCard,
  ChatDocumentViewer,
} from '../chat-document-viewer'

const dict = en as unknown as Dictionary

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  )
}

describe('[COMP:app-web/chat-document-viewer] raw document viewer', () => {
  const textDocument = {
    id: 'doc-1',
    title: 'Design objective.docx',
    sourceName: 'Email attachment',
    content: 'First line\n\n**literal asterisks**',
    format: 'text' as const,
  }

  it('renders plain text without interpreting source markup', () => {
    const html = wrap(
      <ChatDocumentViewer document={textDocument} onClose={() => {}} />,
    )
    expect(html).toContain('aria-label="Raw document"')
    expect(html).toContain('data-document-format="text"')
    expect(html).toContain('**literal asterisks**')
    expect(html).not.toContain('<strong>literal asterisks</strong>')
    expect(html).toContain('Close document viewer')
  })

  it('uses the safe chat markdown renderer only for markdown sources', () => {
    const html = wrap(
      <ChatDocumentViewer
        document={{ ...textDocument, format: 'markdown' }}
        onClose={() => {}}
      />,
    )
    expect(html).toContain('data-document-format="markdown"')
    expect(html).toContain('<strong>literal asterisks</strong>')
  })

  it('renders an accessible transcript card that can reopen the source', () => {
    const html = wrap(
      <ChatDocumentCard document={textDocument} onOpen={() => {}} />,
    )
    expect(html).toContain('aria-label="Open Design objective.docx"')
    expect(html).toContain('Email attachment')
  })
})
