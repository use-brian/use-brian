import { describe, expect, it } from 'vitest'
import { PDF_SESSION_MAX_BYTES, parsePdfSession, validateRenderedPdf, type PdfWriterResult } from '../pdf/index.js'
import {
  createFlatPdfFixture,
  createTooManyPagesPdfFixture,
  malformedPdfFixture,
  withPdfCatalogMarker,
} from './fixtures/pdf/index.js'

const id = (ordinal: number) => `00000000-0000-4000-8000-${ordinal.toString().padStart(12, '0')}`

function input(bytes: Uint8Array) {
  return {
    bytes,
    artifactId: id(1),
    workspaceId: id(2),
    ownerUserId: id(3),
    fileId: id(4),
    originalFileName: 'fictional-security.example.pdf',
    title: 'Fictional security fixture',
  }
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toMatchObject({ code })
}

describe('[COMP:office/pdf-engine] PDF security boundaries', () => {
  it('fails closed for encrypted, active-content, portfolio, attachment, and signed markers', async () => {
    const safe = await createFlatPdfFixture()
    for (const marker of ['/Encrypt 9 0 R', '/XFA 9 0 R', '/JavaScript 9 0 R', '/JS 9 0 R', '/Collection 9 0 R', '/EmbeddedFiles 9 0 R']) {
      await expectCode(parsePdfSession(input(withPdfCatalogMarker(safe, marker))), marker === '/Encrypt 9 0 R' ? 'pdf_encrypted' : 'pdf_unsupported_feature')
    }
    for (const marker of ['/ByteRange [0 10 20 30]', '/DocMDP 9 0 R', '/FieldMDP 9 0 R']) {
      await expectCode(parsePdfSession(input(withPdfCatalogMarker(safe, marker))), 'pdf_existing_digital_signature')
    }
  })

  it('enforces magic, byte, page, parse, and source-hash limits with stable codes', async () => {
    await expectCode(parsePdfSession(input(Buffer.from('not a pdf'))), 'pdf_malformed')
    await expectCode(parsePdfSession(input(malformedPdfFixture())), 'pdf_malformed')
    await expectCode(parsePdfSession(input(new Uint8Array(PDF_SESSION_MAX_BYTES + 1))), 'pdf_too_large')
    await expectCode(parsePdfSession(input(await createTooManyPagesPdfFixture())), 'pdf_too_many_pages')

    const safe = await createFlatPdfFixture()
    await expectCode(parsePdfSession({ ...input(safe), sha256: '0'.repeat(64) }), 'pdf_malformed')
  })

  it('rejects a forged release hash or semantic receipt before offering output', async () => {
    const safe = await createFlatPdfFixture()
    const snapshot = await parsePdfSession(input(safe))
    const forged: PdfWriterResult = {
      bytes: safe,
      sha256: '0'.repeat(64),
      pages: [],
      renders: [],
    }
    await expectCode(validateRenderedPdf(snapshot, forged), 'pdf_output_invalid')
  })
})
