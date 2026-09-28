import { createHash } from 'node:crypto'
import {
  PDFDocument,
  PDFSignature,
  degrees,
  rgb,
  type PDFImage,
  type PDFPage,
} from '@cantoo/pdf-lib'
import type {
  PdfField,
  PdfOverlay,
  PdfRect,
  PdfSnapshot,
} from '@use-brian/office-model'
import { PdfEngineError } from './errors.js'
import { resolvePdfFontRuns } from './fonts.js'

export type PdfWriterResource = {
  bytes: Uint8Array
  mime: 'image/png' | 'image/jpeg'
  sha256?: string
}

export type PdfWriterResourceResolver = (resourceId: string) => Promise<PdfWriterResource | null>

export type PdfRenderReceipt = {
  objectId: string
  kind: 'field' | 'overlay'
  pageId: string
  rect: PdfRect
  visibleText: string | null
}

export type PdfPageReceipt = {
  pageId: string
  sourcePageIndex: number
  outputPageIndex: number
  width: number
  height: number
  rotation: 0 | 90 | 180 | 270
}

export type PdfWriterResult = {
  bytes: Uint8Array
  sha256: string
  pages: PdfPageReceipt[]
  renders: PdfRenderReceipt[]
}

export interface PdfWriterPort {
  render(sourceBytes: Uint8Array, snapshot: PdfSnapshot): Promise<PdfWriterResult>
}

function contentSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function color(value: string) {
  const hex = value.slice(1, 7)
  return rgb(
    Number.parseInt(hex.slice(0, 2), 16) / 255,
    Number.parseInt(hex.slice(2, 4), 16) / 255,
    Number.parseInt(hex.slice(4, 6), 16) / 255,
  )
}

function fieldText(field: PdfField, widgetExportValue?: string): string | null {
  if (field.kind === 'signature' || field.value === null) return null
  if (field.kind === 'checkbox') return field.value === true ? 'X' : null
  if (field.kind === 'radio') return widgetExportValue === field.value ? 'X' : null
  if (Array.isArray(field.value)) return field.value.join(', ')
  return String(field.value)
}

async function drawTextInRect(
  document: PDFDocument,
  page: PDFPage,
  text: string,
  rect: PdfRect,
  locale: string,
  preferredSize: number,
  textColor: string,
  alignment: 'start' | 'center' | 'end' = 'start',
  rotation = 0,
): Promise<void> {
  const runs = await resolvePdfFontRuns(document, text, locale)
  let size = Math.max(4, Math.min(preferredSize, rect.height * 0.72))
  const availableWidth = Math.max(1, rect.width - 4)
  const widthAt = (fontSize: number) => runs.reduce((sum, run) => sum + run.font.widthOfTextAtSize(run.text, fontSize), 0)
  while (size > 4 && widthAt(size) > availableWidth) size -= 0.5
  const textWidth = widthAt(size)
  let x = rect.x + 2
  if (alignment === 'center') x = rect.x + Math.max(2, (rect.width - textWidth) / 2)
  if (alignment === 'end') x = rect.x + Math.max(2, rect.width - textWidth - 2)
  const y = rect.y + Math.max(1, (rect.height - size) / 2)
  for (const run of runs) {
    page.drawText(run.text, {
      x,
      y,
      size,
      font: run.font,
      color: color(textColor),
      rotate: degrees(rotation),
    })
    x += run.font.widthOfTextAtSize(run.text, size)
  }
}

async function embedImage(document: PDFDocument, resource: PdfWriterResource): Promise<PDFImage> {
  return resource.mime === 'image/png' ? document.embedPng(resource.bytes) : document.embedJpg(resource.bytes)
}

function snapshotFields(snapshot: PdfSnapshot): PdfField[] {
  return snapshot.pages.flatMap((page) => page.fields)
}

async function flattenSource(document: PDFDocument): Promise<void> {
  const form = document.getForm()
  for (const field of form.getFields()) {
    if (field instanceof PDFSignature) form.removeField(field)
  }
  if (form.getFields().length > 0) form.flatten({ updateFieldAppearances: false })
}

export function createPdfWriterPort(options: { resolveResource?: PdfWriterResourceResolver } = {}): PdfWriterPort {
  return {
    async render(sourceBytes, snapshot) {
      const sourceHash = contentSha256(sourceBytes)
      if (sourceHash !== snapshot.source.sha256) {
        throw new PdfEngineError('pdf_malformed', 'The immutable PDF source no longer matches the canonical snapshot')
      }

      let source: PDFDocument
      try {
        source = await PDFDocument.load(sourceBytes, {
          ignoreEncryption: false,
          throwOnInvalidObject: true,
          updateMetadata: false,
        })
        await flattenSource(source)
      } catch (error) {
        throw new PdfEngineError('pdf_malformed', 'The PDF source could not be prepared for output', { cause: error })
      }

      const output = await PDFDocument.create()
      output.setTitle(snapshot.title)
      output.setLanguage(snapshot.defaultLanguage)
      output.setCreator('Use Brian PDF editor')
      const copied = await output.copyPages(source, snapshot.pages.map((page) => page.sourcePageIndex))
      copied.forEach((page) => output.addPage(page))

      const pages = new Map(snapshot.pages.map((page, index) => [page.id, { model: page, pdf: output.getPage(index), index }]))
      const receipts: PdfRenderReceipt[] = []
      for (const { model, pdf } of pages.values()) {
        pdf.setRotation(degrees(model.rotation))
      }

      for (const field of snapshotFields(snapshot)) {
        for (const widget of field.widgets) {
          const page = pages.get(widget.pageId)
          if (!page) throw new PdfEngineError('pdf_output_invalid', 'A field widget references a missing output page')
          const visibleText = fieldText(field, widget.exportValue)
          if (field.kind !== 'signature') {
            page.pdf.drawRectangle({
              x: widget.rect.x,
              y: widget.rect.y,
              width: widget.rect.width,
              height: widget.rect.height,
              color: rgb(1, 1, 1),
              borderColor: rgb(0.45, 0.45, 0.45),
              borderWidth: 0.5,
            })
            if (visibleText) {
              await drawTextInRect(output, page.pdf, visibleText, widget.rect, snapshot.locale, 10, '#111111')
            }
            receipts.push({
              objectId: `${field.id}:${widget.id}`,
              kind: 'field',
              pageId: widget.pageId,
              rect: widget.rect,
              visibleText,
            })
          }
        }
      }

      const embeddedImages = new Map<string, PDFImage>()
      for (const modelPage of snapshot.pages) {
        const page = pages.get(modelPage.id)
        if (!page) continue
        for (const overlay of [...modelPage.overlays].sort((left, right) => left.zOrder - right.zOrder)) {
          let visibleText: string | null = null
          if (overlay.kind === 'text' || overlay.kind === 'date') {
            visibleText = overlay.kind === 'text' ? overlay.text : overlay.date
            if (overlay.appearance.backgroundColor) {
              page.pdf.drawRectangle({
                x: overlay.rect.x,
                y: overlay.rect.y,
                width: overlay.rect.width,
                height: overlay.rect.height,
                color: color(overlay.appearance.backgroundColor),
              })
            }
            await drawTextInRect(
              output,
              page.pdf,
              visibleText,
              overlay.rect,
              snapshot.locale,
              overlay.appearance.fontSizePt,
              overlay.appearance.color,
              overlay.appearance.alignment,
              overlay.rotation,
            )
          } else if (overlay.kind === 'checkmark') {
            const inset = Math.max(1, overlay.strokeWidthPt)
            const stroke = color(overlay.color)
            if (overlay.mark === 'x') {
              page.pdf.drawLine({ start: { x: overlay.rect.x + inset, y: overlay.rect.y + inset }, end: { x: overlay.rect.x + overlay.rect.width - inset, y: overlay.rect.y + overlay.rect.height - inset }, thickness: overlay.strokeWidthPt, color: stroke })
              page.pdf.drawLine({ start: { x: overlay.rect.x + inset, y: overlay.rect.y + overlay.rect.height - inset }, end: { x: overlay.rect.x + overlay.rect.width - inset, y: overlay.rect.y + inset }, thickness: overlay.strokeWidthPt, color: stroke })
            } else {
              page.pdf.drawLine({ start: { x: overlay.rect.x + inset, y: overlay.rect.y + overlay.rect.height * 0.45 }, end: { x: overlay.rect.x + overlay.rect.width * 0.4, y: overlay.rect.y + inset }, thickness: overlay.strokeWidthPt, color: stroke })
              page.pdf.drawLine({ start: { x: overlay.rect.x + overlay.rect.width * 0.4, y: overlay.rect.y + inset }, end: { x: overlay.rect.x + overlay.rect.width - inset, y: overlay.rect.y + overlay.rect.height - inset }, thickness: overlay.strokeWidthPt, color: stroke })
            }
          } else {
            const declared = snapshot.resources.find((resource) => resource.id === overlay.resourceId)
            const resource = await options.resolveResource?.(overlay.resourceId)
            if (!declared || declared.kind !== 'image' || !resource) {
              throw new PdfEngineError('pdf_resource_unavailable', 'A PDF image resource is unavailable')
            }
            const resourceHash = contentSha256(resource.bytes)
            if (resourceHash !== declared.hash || resource.sha256 && resource.sha256 !== resourceHash || resource.mime !== declared.mime) {
              throw new PdfEngineError('pdf_resource_unavailable', 'A PDF image resource failed integrity validation')
            }
            let image = embeddedImages.get(overlay.resourceId)
            if (!image) {
              image = await embedImage(output, resource)
              embeddedImages.set(overlay.resourceId, image)
            }
            page.pdf.drawImage(image, {
              x: overlay.rect.x,
              y: overlay.rect.y,
              width: overlay.rect.width,
              height: overlay.rect.height,
              rotate: degrees(overlay.rotation),
            })
          }
          receipts.push({ objectId: overlay.id, kind: 'overlay', pageId: overlay.pageId, rect: overlay.rect, visibleText })
        }
      }

      const bytes = await output.save({ addDefaultPage: false, useObjectStreams: true, updateFieldAppearances: false })
      return {
        bytes,
        sha256: contentSha256(bytes),
        pages: snapshot.pages.map((page, outputPageIndex) => ({
          pageId: page.id,
          sourcePageIndex: page.sourcePageIndex,
          outputPageIndex,
          width: page.cropBox.width,
          height: page.cropBox.height,
          rotation: page.rotation,
        })),
        renders: receipts,
      }
    },
  }
}

export function expectedPdfRenderReceipts(snapshot: PdfSnapshot): PdfRenderReceipt[] {
  const fieldReceipts = snapshotFields(snapshot).flatMap((field) => field.widgets.flatMap((widget) => field.kind === 'signature' ? [] : [{
    objectId: `${field.id}:${widget.id}`,
    kind: 'field' as const,
    pageId: widget.pageId,
    rect: widget.rect,
    visibleText: fieldText(field, widget.exportValue),
  }]))
  const overlayReceipts = snapshot.pages.flatMap((page) => page.overlays.map((overlay: PdfOverlay) => ({
    objectId: overlay.id,
    kind: 'overlay' as const,
    pageId: overlay.pageId,
    rect: overlay.rect,
    visibleText: overlay.kind === 'text' ? overlay.text : overlay.kind === 'date' ? overlay.date : null,
  })))
  return [...fieldReceipts, ...overlayReceipts]
}
