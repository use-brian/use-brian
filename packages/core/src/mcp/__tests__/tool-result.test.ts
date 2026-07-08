import { describe, it, expect } from 'vitest'
import { mcpResultToToolResult } from '../tool-result.js'

describe('[COMP:mcp/tool-result] mcpResultToToolResult', () => {
  it('wraps a plain string result as { data }', () => {
    expect(mcpResultToToolResult('hello')).toEqual({ data: 'hello' })
  })

  it('passes through a non-multimodal object/array as data (fallback)', () => {
    const arr = [{ type: 'resource', uri: 'x://y' }]
    expect(mcpResultToToolResult(arr)).toEqual({ data: arr })
  })

  it('lifts { text, images } onto ToolResult.images', () => {
    const out = mcpResultToToolResult({
      text: 'frames attached',
      images: [
        { mimeType: 'image/jpeg', data: 'a' },
        { mimeType: 'image/png', data: 'b' },
      ],
    })
    expect(out).toEqual({
      data: 'frames attached',
      images: [
        { mimeType: 'image/jpeg', data: 'a' },
        { mimeType: 'image/png', data: 'b' },
      ],
    })
  })

  it('synthesizes placeholder text when images have no accompanying text', () => {
    const out = mcpResultToToolResult({ text: '', images: [{ mimeType: 'image/jpeg', data: 'a' }] })
    expect(out.data).toBe('[returned 1 image(s)]')
    expect(out.images).toHaveLength(1)
  })

  it('drops malformed image entries', () => {
    const out = mcpResultToToolResult({
      text: 't',
      images: [{ mimeType: 'image/jpeg', data: 'a' }, { mimeType: 'image/jpeg' }, null, 'nope'],
    })
    expect(out.images).toEqual([{ mimeType: 'image/jpeg', data: 'a' }])
  })

  it('caps the number of lifted images at 8', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ mimeType: 'image/jpeg', data: String(i) }))
    const out = mcpResultToToolResult({ text: 't', images: many })
    expect(out.images).toHaveLength(8)
  })

  it('keeps the real text and omits images when the images array is all invalid', () => {
    const out = mcpResultToToolResult({ text: 'just text', images: [null, 'x'] })
    expect(out).toEqual({ data: 'just text' })
    expect(out.images).toBeUndefined()
  })
})
