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
import {
  ChatComposer,
  resolveEnterIntent,
  splitHighlightSegments,
} from '../ChatComposer'

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

describe('[COMP:chat-ui/chat-composer] mention-chip mirror', () => {
  it('splits the value into plain and highlighted runs', () => {
    expect(splitHighlightSegments('ask @Blendit now', [{ start: 4, end: 12 }])).toEqual([
      { text: 'ask ', highlighted: false },
      { text: '@Blendit', highlighted: true },
      { text: ' now', highlighted: false },
    ])
  })

  it('never drops or duplicates a character', () => {
    // A stale range from the previous keystroke must not corrupt the mirror:
    // whatever comes out has to re-concatenate to the value exactly, or the
    // chips stop lining up with the glyphs in the textarea.
    const value = '@A and @B'
    const cases = [
      [{ start: 0, end: 2 }, { start: 7, end: 9 }],
      [{ start: 0, end: 2 }, { start: 1, end: 5 }], // overlapping
      [{ start: 7, end: 9 }, { start: 0, end: 2 }], // out of order
      [{ start: -5, end: 2 }, { start: 7, end: 99 }], // out of bounds
      [{ start: 4, end: 4 }], // empty
    ]
    for (const ranges of cases) {
      const segments = splitHighlightSegments(value, ranges)
      expect(segments.map((segment) => segment.text).join('')).toBe(value)
    }
  })

  it('renders the mirror only when the host opts in', () => {
    const plain = renderToString(
      <ChatComposer value="ask @Blendit" onChange={() => {}} onSend={() => {}} />,
    )
    expect(plain).not.toContain('composer-highlight-backdrop')

    const chipped = renderToString(
      <ChatComposer
        value="ask @Blendit"
        onChange={() => {}}
        onSend={() => {}}
        highlightRanges={[{ start: 4, end: 12 }]}
        textareaClassName="text-sm"
      />,
    )
    expect(chipped).toContain('composer-highlight-backdrop')
    expect(chipped).toContain('composer-mention-chip')
    // Both layers must carry the host's typography or they cannot align.
    expect(chipped.match(/text-sm/g)?.length).toBe(2)
    expect(chipped).toContain('composer-highlight-input')
  })
})
