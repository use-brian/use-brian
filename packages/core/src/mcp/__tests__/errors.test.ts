import { describe, it, expect } from 'vitest'
import { z } from 'zod'
import { describeMcpToolError } from '../errors.js'

describe('[COMP:mcp/errors] describeMcpToolError', () => {
  it('names the server, the tool, the upstream words, and the retry rule', () => {
    const text = describeMcpToolError('notion', 'create_page', new Error('parent.page_id should be a valid uuid'))
    expect(text).toContain('"notion" MCP server')
    expect(text).toContain('"create_page"')
    expect(text).toContain('parent.page_id should be a valid uuid')
    expect(text).toContain("third-party server's own error")
    expect(text).toMatch(/retry ONCE|repeating the identical call will fail identically/)
  })

  it('collapses a thrown ZodError to path: message lines, never the issues JSON', () => {
    let zerr: unknown
    try {
      z.object({ status: z.enum(['todo', 'done']) }).parse({ status: 'urgent' })
    } catch (err) {
      zerr = err
    }
    const text = describeMcpToolError('linear', 'update_issue', zerr)
    expect(text).toContain('status:')
    expect(text).not.toContain('"code":')
    expect(text).not.toContain('unionErrors')
  })

  it('bounds a huge upstream message', () => {
    const text = describeMcpToolError('big', 'tool', new Error('x'.repeat(5000)))
    expect(text.length).toBeLessThan(1200)
    expect(text).toContain('…')
  })
})
