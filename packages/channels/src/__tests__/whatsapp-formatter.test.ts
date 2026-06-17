import { describe, it, expect } from 'vitest'
import { markdownToWhatsApp } from '../whatsapp/formatter.js'

describe('[COMP:channels/whatsapp] markdownToWhatsApp', () => {
  // ── Bold ──────────────────────────────────────────────────────
  it('converts **bold** to *bold*', () => {
    expect(markdownToWhatsApp('This is **bold** text')).toBe('This is *bold* text')
  })

  it('converts multiple **bold** segments', () => {
    expect(markdownToWhatsApp('**one** and **two**')).toBe('*one* and *two*')
  })

  // ── Bold-italic ───────────────────────────────────────────────
  it('converts ***bold-italic*** to *_bold-italic_*', () => {
    expect(markdownToWhatsApp('***emphasis***')).toBe('*_emphasis_*')
  })

  // ── Strikethrough ─────────────────────────────────────────────
  it('converts ~~strikethrough~~ to ~strikethrough~', () => {
    expect(markdownToWhatsApp('~~removed~~')).toBe('~removed~')
  })

  // ── Inline code ───────────────────────────────────────────────
  it('preserves `inline code` as-is', () => {
    expect(markdownToWhatsApp('Use `console.log()`')).toBe('Use `console.log()`')
  })

  // ── Code blocks ───────────────────────────────────────────────
  it('strips language identifier from fenced code blocks', () => {
    const input = '```typescript\nconst x = 1\n```'
    const expected = '```\nconst x = 1\n```'
    expect(markdownToWhatsApp(input)).toBe(expected)
  })

  it('preserves code blocks without language identifier', () => {
    const input = '```\nconst x = 1\n```'
    expect(markdownToWhatsApp(input)).toBe(input)
  })

  // ── Headers ───────────────────────────────────────────────────
  it('converts # headers to *bold*', () => {
    expect(markdownToWhatsApp('# Title')).toBe('*Title*')
  })

  it('converts ## and ### headers to *bold*', () => {
    expect(markdownToWhatsApp('## Subtitle')).toBe('*Subtitle*')
    expect(markdownToWhatsApp('### Section')).toBe('*Section*')
  })

  it('does not affect # in the middle of text', () => {
    expect(markdownToWhatsApp('Issue #42')).toBe('Issue #42')
  })

  // ── Links ─────────────────────────────────────────────────────
  it('converts [text](url) to text (url)', () => {
    expect(markdownToWhatsApp('Visit [Google](https://google.com)')).toBe(
      'Visit Google (https://google.com)',
    )
  })

  it('converts inline images ![alt](url) to alt (url)', () => {
    expect(markdownToWhatsApp('![logo](https://example.com/img.png)')).toBe(
      'logo (https://example.com/img.png)',
    )
  })

  // ── Lists (native WhatsApp support) ───────────────────────────
  it('preserves bullet lists (- item) as-is', () => {
    const input = '- First\n- Second\n- Third'
    expect(markdownToWhatsApp(input)).toBe(input)
  })

  it('preserves numbered lists as-is', () => {
    const input = '1. First\n2. Second\n3. Third'
    expect(markdownToWhatsApp(input)).toBe(input)
  })

  // ── Blockquotes (native WhatsApp support) ─────────────────────
  it('preserves > blockquotes as-is', () => {
    const input = '> This is a quote'
    expect(markdownToWhatsApp(input)).toBe(input)
  })

  // ── Horizontal rules ─────────────────────────────────────────
  it('removes horizontal rules (---)', () => {
    expect(markdownToWhatsApp('above\n---\nbelow')).toBe('above\n\nbelow')
  })

  it('removes horizontal rules (***)', () => {
    expect(markdownToWhatsApp('above\n***\nbelow')).toBe('above\n\nbelow')
  })

  // ── Combined / realistic output ───────────────────────────────
  it('handles a realistic LLM response', () => {
    const input = [
      '## Weather Update',
      '',
      "Here's the forecast for today:",
      '',
      '- **Morning**: Sunny, 22°C',
      '- **Afternoon**: Partly cloudy, 28°C',
      '- **Evening**: Clear skies, 19°C',
      '',
      '> Note: UV index is ~~high~~ moderate today.',
      '',
      'Check [Weather.com](https://weather.com) for more details.',
    ].join('\n')

    const expected = [
      '*Weather Update*',
      '',
      "Here's the forecast for today:",
      '',
      '- *Morning*: Sunny, 22°C',
      '- *Afternoon*: Partly cloudy, 28°C',
      '- *Evening*: Clear skies, 19°C',
      '',
      '> Note: UV index is ~high~ moderate today.',
      '',
      'Check Weather.com (https://weather.com) for more details.',
    ].join('\n')

    expect(markdownToWhatsApp(input)).toBe(expected)
  })

  it('handles plain text without changes', () => {
    const input = 'Just a normal message with no formatting.'
    expect(markdownToWhatsApp(input)).toBe(input)
  })

  // ── Tables ──────────────────────────────────────────────────────
  it('converts a markdown table to key-value list', () => {
    const input = [
      '| Model | Context | Speed |',
      '|---|---|---|',
      '| Gemini 2.5 | 1M | Fast |',
      '| GPT-4o | 128k | Medium |',
    ].join('\n')

    const expected = [
      '*Model:* Gemini 2.5',
      '*Context:* 1M',
      '*Speed:* Fast',
      '',
      '*Model:* GPT-4o',
      '*Context:* 128k',
      '*Speed:* Medium',
    ].join('\n') + '\n'

    expect(markdownToWhatsApp(input)).toBe(expected)
  })

  it('converts a table with surrounding text', () => {
    const input = [
      'Here is the comparison:',
      '',
      '| Feature | A | B |',
      '| --- | --- | --- |',
      '| Price | $10 | $20 |',
      '',
      'Hope that helps!',
    ].join('\n')

    const result = markdownToWhatsApp(input)
    expect(result).toContain('*Feature:* Price')
    expect(result).toContain('*A:* $10')
    expect(result).toContain('*B:* $20')
    expect(result).toContain('Here is the comparison:')
    expect(result).toContain('Hope that helps!')
  })

  it('handles a single-row table', () => {
    const input = [
      '| Name | Value |',
      '|---|---|',
      '| Timeout | 30s |',
    ].join('\n')

    const expected = '*Name:* Timeout\n*Value:* 30s\n'
    expect(markdownToWhatsApp(input)).toBe(expected)
  })
})
