import { access, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { completePresentationSnapshot, formattedPresentationSnapshot, resolveFixtureResource } from './fixtures.js'
import { convertPresentationPptxToPdf, exportOfficePresentationPdf, type PresentationPdfPort } from '../pptx/pdf.js'

const pdf = new Uint8Array([37, 80, 68, 70, 45, 49, 46, 55])

describe('[COMP:office/presentation-pdf] Presentation PDF', () => {
  it('converts canonical PPTX and accepts exact slide/page parity', async () => {
    let convertedInput: Uint8Array | undefined
    const convert = vi.fn(async (input: Uint8Array) => { convertedInput = input; return pdf })
    const port: PresentationPdfPort = { convert, pageCount: vi.fn(async () => 2) }
    const result = await exportOfficePresentationPdf(formattedPresentationSnapshot(), resolveFixtureResource, port)
    expect(result).toMatchObject({ bytes: pdf, mime: 'application/pdf', receipt: { expectedPageCount: 2, actualPageCount: 2, renderer: 'libreoffice', issues: [] } })
    expect(Array.from(convertedInput?.slice(0, 2) ?? [])).toEqual([80, 75])
  })

  it.each([
    ['converter_unavailable', { convert: vi.fn(async () => { throw new Error('converter_unavailable') }), pageCount: vi.fn() }],
    ['timeout', { convert: vi.fn(async () => { throw new Error('timeout') }), pageCount: vi.fn() }],
    ['invalid_pdf', { convert: vi.fn(async () => pdf), pageCount: vi.fn(async () => { throw new Error('bad') }) }],
  ] as const)('returns the owned %s code', async (code, port) => {
    const result = await exportOfficePresentationPdf(completePresentationSnapshot(), resolveFixtureResource, port as PresentationPdfPort)
    expect(result.bytes).toBeUndefined()
    expect(result.receipt.issues).toEqual([expect.objectContaining({ code })])
  })

  it('blocks a page-count mismatch', async () => {
    const result = await exportOfficePresentationPdf(completePresentationSnapshot(), resolveFixtureResource, { convert: async () => pdf, pageCount: async () => 1 })
    expect(result.bytes).toBeUndefined()
    expect(result.receipt).toMatchObject({ expectedPageCount: 2, actualPageCount: 1, issues: [{ code: 'page_count_mismatch' }] })
  })

  it('cleans the isolated workspace when conversion fails', async () => {
    let root = ''
    await expect(convertPresentationPptxToPdf(new Uint8Array([1]), async ({ inputPath, outputDirectory }) => {
      root = dirname(dirname(inputPath))
      await writeFile(join(outputDirectory, 'partial.tmp'), new Uint8Array([1]))
      throw new Error('timeout')
    })).rejects.toThrow('timeout')
    await expect(access(root)).rejects.toThrow()
  })

  it('owns a successful converter run that omits its PDF output', async () => {
    let root = ''
    await expect(convertPresentationPptxToPdf(new Uint8Array([1]), async ({ inputPath }) => {
      root = dirname(dirname(inputPath))
    })).rejects.toThrow('invalid_pdf')
    await expect(access(root)).rejects.toThrow()
  })
})
