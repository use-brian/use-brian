import { createHash } from 'node:crypto'
import type { PdfRect, PdfSnapshot } from '@use-brian/office-model'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfEngineError } from './errors.js'
import { expectedPdfRenderReceipts, type PdfRenderReceipt, type PdfWriterResult } from './writer.js'

export type ValidatedPdfOutput = {
  sha256: string
  pageCount: number
  textByPage: string[]
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function close(left: number, right: number): boolean {
  return Math.abs(left - right) <= 0.05
}

function sameRect(left: PdfRect, right: PdfRect): boolean {
  return close(left.x, right.x)
    && close(left.y, right.y)
    && close(left.width, right.width)
    && close(left.height, right.height)
}

function sameReceipt(actual: PdfRenderReceipt, expected: PdfRenderReceipt): boolean {
  return actual.objectId === expected.objectId
    && actual.kind === expected.kind
    && actual.pageId === expected.pageId
    && actual.visibleText === expected.visibleText
    && sameRect(actual.rect, expected.rect)
}

function assertNoUnsafeMarkers(bytes: Uint8Array): void {
  const source = Buffer.from(bytes).toString('latin1')
  if (/\/Encrypt\b|\/ByteRange\s*\[|\/(?:DocMDP|FieldMDP|XFA|JavaScript|JS|Collection|EmbeddedFiles)\b/.test(source)) {
    throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF contains a forbidden security or active-content feature')
  }
}

/** Reopens writer output through PDF.js and rejects any semantic mismatch. */
export async function validateRenderedPdf(
  snapshot: PdfSnapshot,
  writerResult: PdfWriterResult,
): Promise<ValidatedPdfOutput> {
  const outputHash = sha256(writerResult.bytes)
  if (outputHash !== writerResult.sha256) {
    throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF hash does not match the release receipt')
  }
  assertNoUnsafeMarkers(writerResult.bytes)

  const expectedReceipts = expectedPdfRenderReceipts(snapshot)
  if (writerResult.renders.length !== expectedReceipts.length
    || expectedReceipts.some((expected, index) => !sameReceipt(writerResult.renders[index], expected))) {
    throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF object receipts do not match the canonical snapshot')
  }
  if (writerResult.pages.length !== snapshot.pages.length || snapshot.pages.some((page, index) => {
    const receipt = writerResult.pages[index]
    return !receipt
      || receipt.pageId !== page.id
      || receipt.sourcePageIndex !== page.sourcePageIndex
      || receipt.outputPageIndex !== index
      || receipt.rotation !== page.rotation
      || !close(receipt.width, page.cropBox.width)
      || !close(receipt.height, page.cropBox.height)
  })) {
    throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF page receipts do not match the canonical snapshot')
  }

  const loadingTask = getDocument({ data: new Uint8Array(writerResult.bytes), isEvalSupported: false, useSystemFonts: false })
  try {
    const document = await loadingTask.promise
    if (document.numPages !== snapshot.pages.length) {
      throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF page count does not match the canonical snapshot')
    }
    if (document.isPureXfa) throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF unexpectedly contains XFA')
    const [attachments, javaScript, fields] = await Promise.all([
      document.getAttachments(),
      document.getJSActions(),
      document.getFieldObjects(),
    ])
    if (attachments && Object.keys(attachments).length > 0) throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF contains attachments')
    if (javaScript && Object.keys(javaScript).length > 0) throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF contains JavaScript')
    if (fields && Object.keys(fields).length > 0) throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF contains active form fields')

    const textByPage: string[] = []
    for (const [index, expected] of snapshot.pages.entries()) {
      const page = await document.getPage(index + 1)
      const view = page.view
      if (view.length !== 4
        || !close(view[2] - view[0], expected.cropBox.width)
        || !close(view[3] - view[1], expected.cropBox.height)
        || page.rotate !== expected.rotation) {
        throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF page geometry does not match the canonical snapshot')
      }
      const textContent = await page.getTextContent()
      const text = textContent.items.flatMap((item) => 'str' in item ? [item.str] : []).join(' ')
      textByPage.push(text)
      page.cleanup()
    }

    for (const receipt of expectedReceipts) {
      if (!receipt.visibleText) continue
      const pageIndex = snapshot.pages.findIndex((page) => page.id === receipt.pageId)
      const compactPageText = textByPage[pageIndex]?.replace(/\s+/g, '')
      const compactExpectedText = receipt.visibleText.replace(/\s+/g, '')
      if (pageIndex < 0 || !compactPageText?.includes(compactExpectedText)) {
        throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF is missing expected visible field or overlay text')
      }
    }
    return { sha256: outputHash, pageCount: document.numPages, textByPage }
  } catch (error) {
    if (error instanceof PdfEngineError) throw error
    throw new PdfEngineError('pdf_output_invalid', 'Rendered PDF could not be reopened safely', { cause: error })
  } finally {
    await loadingTask.destroy()
  }
}
