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
import { ChatComposer, resolveEnterIntent } from '../ChatComposer'

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

describe('[COMP:chat-ui/chat-composer] Enter intent', () => {
  const base = {
    shiftKey: false,
    metaKey: false,
    ctrlKey: false,
    isComposing: false,
    disabled: false,
    sendDisabled: false,
    hasText: true,
    allowEmptySend: false,
    canSteer: false,
  }

  it('plain Enter sends', () => {
    expect(resolveEnterIntent(base)).toBe('send')
  })

  it('Shift+Enter is a newline, never a submit', () => {
    expect(resolveEnterIntent({ ...base, shiftKey: true })).toBe('newline')
  })

  it('an IME composition Enter commits a candidate, it does not send', () => {
    expect(resolveEnterIntent({ ...base, isComposing: true })).toBe('newline')
  })

  it('Cmd/Ctrl+Enter steers where the host wired one', () => {
    expect(resolveEnterIntent({ ...base, metaKey: true, canSteer: true })).toBe('steer')
    expect(resolveEnterIntent({ ...base, ctrlKey: true, canSteer: true })).toBe('steer')
  })

  it('Cmd+Enter falls back to an ordinary send where steering is unsupported', () => {
    expect(resolveEnterIntent({ ...base, metaKey: true })).toBe('send')
  })

  it('respects the disable gates for both modes', () => {
    expect(resolveEnterIntent({ ...base, sendDisabled: true })).toBe('blocked')
    expect(resolveEnterIntent({ ...base, metaKey: true, canSteer: true, disabled: true })).toBe('blocked')
  })

  it('blocks an empty draft unless the host allows one', () => {
    expect(resolveEnterIntent({ ...base, hasText: false })).toBe('blocked')
    expect(resolveEnterIntent({ ...base, hasText: false, allowEmptySend: true })).toBe('send')
  })
})
