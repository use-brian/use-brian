import { describe, expect, it, vi } from 'vitest'
import { createRenderPdfTool } from '../render-pdf.js'
import type { FilesApi } from '../api.js'

/**
 * M4 step 5: the default PDF converter (doc/convert/to-pdf.ts -> .docx ->
 * LibreOffice) loads on the first render, not when the file tools are built. A
 * converter that cannot load is an honest refusal with no file written.
 * Spec: docs/architecture/platform/deployment.md -> "Lazy tool implementations".
 */
vi.mock('../../doc/convert/to-pdf.js', () => { throw Object.assign(new Error('fixture: converter module missing'), { code: 'ERR_MODULE_NOT_FOUND' }) })

describe('[COMP:files/render-pdf] renderPdf converter loads on first use', () => {
  it('refuses honestly and writes nothing when the converter cannot load', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const writeBytes = vi.fn()
    const tool = createRenderPdfTool({ writeBytes } as unknown as FilesApi)
    const result = await tool.execute({ path: 'reports/q3', markdown: '# Q3' }, {
      userId: 'u-1', assistantId: 'a-1', sessionId: 's-1', appId: 'Use Brian', channelType: 'web', channelId: 'c-1',
      workspaceId: 'ws-1', abortSignal: new AbortController().signal,
    } as never)
    expect(result.isError).toBe(true)
    expect(String(result.data)).toContain('the PDF converter could not be loaded on this server, so no file was written')
    expect(writeBytes).not.toHaveBeenCalled()
  })
})
