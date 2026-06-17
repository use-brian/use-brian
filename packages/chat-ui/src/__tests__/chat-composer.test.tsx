/**
 * [COMP:chat-ui/chat-composer] ChatComposer disable semantics.
 *
 * The load-bearing contract: `disabled` hard-locks the whole composer
 * (textarea + send), while `sendDisabled` blocks submission ONLY — the
 * textarea stays typeable so the user can draft their next message while a
 * reply streams. Hosts (floating-chat et al.) pass `sendDisabled={isStreaming}`
 * and reserve `disabled` for offline / suspended-on-question states.
 *
 * chat-ui's vitest is node-only (no jsdom) — components are rendered via
 * `renderToString` and asserted against the static markup, matching the
 * app-web component tests.
 */

import { describe, expect, it } from 'vitest'
import { renderToString } from 'react-dom/server'
import { ChatComposer } from '../ChatComposer'

function render(props: Partial<Parameters<typeof ChatComposer>[0]>): string {
  return renderToString(
    <ChatComposer value="draft" onChange={() => {}} onSend={() => {}} {...props} />,
  )
}

function textareaTag(html: string): string {
  const match = html.match(/<textarea[^>]*>/)
  if (!match) throw new Error('no textarea in markup')
  return match[0]
}

function sendButtonTag(html: string): string {
  const match = html.match(/<button[^>]*data-testid="chat-composer-send"[^>]*>/)
  if (!match) throw new Error('no send button in markup')
  return match[0]
}

describe('[COMP:chat-ui/chat-composer] ChatComposer disable semantics', () => {
  it('renders both textarea and send enabled at rest', () => {
    const html = render({})
    expect(textareaTag(html)).not.toContain('disabled')
    expect(sendButtonTag(html)).not.toContain('disabled')
  })

  it('disabled hard-locks the textarea and the send button', () => {
    const html = render({ disabled: true })
    expect(textareaTag(html)).toContain('disabled')
    expect(sendButtonTag(html)).toContain('disabled')
  })

  it('sendDisabled blocks the send button but keeps the textarea typeable', () => {
    const html = render({ sendDisabled: true })
    expect(textareaTag(html)).not.toContain('disabled')
    expect(sendButtonTag(html)).toContain('disabled')
  })

  it('sendDisabled overrides allowEmptySend on the send button', () => {
    const html = render({ value: '', sendDisabled: true, allowEmptySend: true })
    expect(textareaTag(html)).not.toContain('disabled')
    expect(sendButtonTag(html)).toContain('disabled')
  })
})
