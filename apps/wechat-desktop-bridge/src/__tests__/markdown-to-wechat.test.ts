/**
 * [COMP:app/wechat-desktop-bridge] markdown flatten + chunking for the desktop client.
 */
import { describe, expect, it } from 'vitest'
import { chunkText, markdownToWechat } from '../markdown-to-wechat.js'

describe('[COMP:app/wechat-desktop-bridge] markdownToWechat', () => {
  it('strips bold, italics, headings and inline code', () => {
    expect(markdownToWechat('# Title\n\n**bold** and __also__ and *it* and _it_ and `code`')).toBe(
      'Title\n\nbold and also and it and it and code',
    )
  })

  it('keeps list bullets and ordered lists', () => {
    expect(markdownToWechat('- one\n* two\n+ three\n1. four')).toBe('- one\n- two\n- three\n1. four')
  })

  it('renders links as text (url) and images as alt text', () => {
    expect(markdownToWechat('see [the docs](https://example.com/d) and ![diagram](https://example.com/i.png)')).toBe(
      'see the docs (https://example.com/d) and diagram',
    )
    expect(markdownToWechat('[https://example.com](https://example.com)')).toBe('https://example.com')
  })

  it('drops code fences but keeps the body', () => {
    expect(markdownToWechat('```ts\nconst a = 1\n```')).toBe('const a = 1')
  })

  it('leaves CJK text and punctuation alone', () => {
    expect(markdownToWechat('**你好**，世界。')).toBe('你好，世界。')
  })
})

describe('[COMP:app/wechat-desktop-bridge] chunkText', () => {
  it('returns the text as-is under the limit and nothing for empty', () => {
    expect(chunkText('hi', 10)).toEqual(['hi'])
    expect(chunkText('', 10)).toEqual([])
  })

  it('splits on paragraph / line boundaries and never exceeds max', () => {
    const text = Array.from({ length: 50 }, (_, i) => `paragraph ${i}`).join('\n\n')
    const chunks = chunkText(text, 60)
    expect(chunks.length).toBeGreaterThan(1)
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(60)
    expect(chunks.join('\n\n')).toBe(text)
  })

  it('hard-splits a single long token', () => {
    const chunks = chunkText('x'.repeat(25), 10)
    expect(chunks).toEqual(['xxxxxxxxxx', 'xxxxxxxxxx', 'xxxxx'])
  })
})
