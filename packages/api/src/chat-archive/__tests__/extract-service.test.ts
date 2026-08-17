/**
 * [COMP:integrations/chat-message-store] Document-modality dispatch.
 *
 * The store treats `unsupported` as terminal — such assets are excluded from
 * the extraction claim query forever — so the boundary between "no reader
 * exists" and "nobody looked" is worth pinning down. These cases exist because
 * the previous MIME allowlist got that boundary wrong: it rejected formats the
 * parser could already read, and read `application/octet-stream` as proof of
 * unreadability when it is really just an unhelpful provider.
 */

import { describe, expect, it, vi } from 'vitest'
import { createExtractService, type ExtractServiceDeps } from '../extract-service.js'

function service(deps: ExtractServiceDeps = {}) {
  return createExtractService(deps)
}

function doc(buffer: Buffer, mime: string, filename?: string) {
  return { modality: 'document' as const, mime, filename, buffer }
}

describe('document extraction dispatch', () => {
  it('reads a text file that declares a text MIME', async () => {
    const result = await service().extract(
      doc(Buffer.from('quarterly numbers are up'), 'text/plain', 'notes.txt'),
    )
    expect(result.unsupported).toBeFalsy()
    expect(result.texts[0]?.text).toContain('quarterly numbers are up')
  })

  it('reads a text file a provider labelled application/octet-stream', async () => {
    // WeChat labels every document this way. The old gate rejected it outright.
    const result = await service().extract(
      doc(Buffer.from('the door code is 4471'), 'application/octet-stream', 'notes.txt'),
    )
    expect(result.unsupported).toBeFalsy()
    expect(result.texts[0]?.text).toContain('the door code is 4471')
  })

  it('identifies a registry format by extension when the MIME is generic', async () => {
    const result = await service().extract(
      doc(Buffer.from('region,revenue\nAPAC,120\n'), 'application/octet-stream', 'report.csv'),
    )
    expect(result.unsupported).toBeFalsy()
    expect(result.texts[0]?.text).toContain('APAC')
  })

  it('routes a PDF to the distiller rather than the text parser', async () => {
    // parseFileContent hands PDFs back as base64 for page rendering, which is
    // not indexable text — so the vision distiller has to own this branch.
    const distill = vi.fn().mockResolvedValue('page one text')
    const result = await service({ distill }).extract(
      doc(Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n', 'binary'), 'application/pdf', 'a.pdf'),
    )
    expect(distill).toHaveBeenCalledOnce()
    expect(result.texts[0]?.text).toBe('page one text')
  })

  it('reports a genuinely unreadable binary as unsupported', async () => {
    // Modelled on iWork: a ZIP container no parser in the stack can read. It
    // must stay terminal so the store does not retry it forever.
    const zipish = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(64, 0)])
    const result = await service().extract(doc(zipish, 'application/octet-stream', 'deck.pages'))
    expect(result.unsupported).toBe(true)
    expect(result.texts).toEqual([])
  })

  it('does not call unsupported when a readable file simply has no text', async () => {
    // An empty document is a successful extraction that found nothing. Marking
    // it unsupported would park it permanently on a verdict about its format.
    const result = await service().extract(doc(Buffer.from('   \n  '), 'text/plain', 'empty.txt'))
    expect(result.unsupported).toBeFalsy()
    expect(result.texts).toEqual([])
  })

  it('rejects an unknown modality rather than guessing', async () => {
    const result = await service().extract({
      modality: 'nonsense' as never,
      mime: 'text/plain',
      buffer: Buffer.from('x'),
    })
    expect(result.unsupported).toBe(true)
  })
})
