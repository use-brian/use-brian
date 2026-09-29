import { createHash } from 'node:crypto'
import {
  PdfSnapshotSchema,
  type PdfField,
  type PdfFieldValue,
  type PdfPage,
  type PdfRect,
  type PdfSnapshot,
  type PdfWidget,
} from '@use-brian/office-model'
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs'
import { PdfEngineError } from './errors.js'

export const PDF_SESSION_MAX_BYTES = 15 * 1024 * 1024
export const PDF_SESSION_MAX_PAGES = 100

export type ParsePdfSessionInput = {
  bytes: Uint8Array
  artifactId: string
  workspaceId: string
  ownerUserId: string
  fileId: string
  sha256?: string
  originalFileName: string
  title: string
  locale?: string
  defaultLanguage?: string
  signal?: AbortSignal
}

type PdfJsField = Record<string, unknown>

function stableUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ((Number.parseInt(hex[16], 16) & 0x3) | 0x8).toString(16)
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

function bytesSha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex')
}

function assertNotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw signal.reason ?? new DOMException('The PDF operation was aborted', 'AbortError')
}

function rejectUnsafeCatalogMarkers(bytes: Uint8Array): void {
  const source = Buffer.from(bytes).toString('latin1')
  if (/\/Encrypt\b/.test(source)) {
    throw new PdfEngineError('pdf_encrypted', 'Encrypted or password-protected PDFs cannot be edited')
  }
  if (/\/ByteRange\s*\[/.test(source)) {
    throw new PdfEngineError('pdf_existing_digital_signature', 'PDFs with an existing digital signature cannot be edited')
  }
  if (/\/(?:DocMDP|FieldMDP)\b/.test(source)) {
    throw new PdfEngineError('pdf_existing_digital_signature', 'PDFs with certification or field-lock signatures cannot be edited')
  }
  if (/\/(?:XFA|JavaScript|JS|Collection|EmbeddedFiles)\b/.test(source)) {
    throw new PdfEngineError('pdf_unsupported_feature', 'PDF contains active or embedded content that cannot be edited safely')
  }
}

function finiteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function normalizeRect(raw: unknown): PdfRect | null {
  if (!Array.isArray(raw) || raw.length !== 4) return null
  const values = raw.map(finiteNumber)
  if (values.some((value) => value === null)) return null
  const [x1, y1, x2, y2] = values as [number, number, number, number]
  if (x2 <= x1 || y2 <= y1) return null
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 }
}

function normalizePageRect(raw: unknown): PdfRect | null {
  const rect = normalizeRect(raw)
  return rect ? { x: 0, y: 0, width: rect.width, height: rect.height } : null
}

function strings(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (!Array.isArray(value)) return []
  return value.filter((item): item is string => typeof item === 'string')
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function choiceOptions(entries: PdfJsField[]): string[] {
  const itemValues = entries.flatMap((entry) => {
    if (!Array.isArray(entry.items)) return []
    return entry.items.flatMap((item) => {
      if (!item || typeof item !== 'object') return []
      const candidate = (item as Record<string, unknown>).exportValue ?? (item as Record<string, unknown>).displayValue
      return typeof candidate === 'string' ? [candidate] : []
    })
  })
  const exportValues = entries.flatMap((entry) => strings(entry.exportValues))
  return unique([...itemValues, ...exportValues])
}

function fieldKind(type: unknown): PdfField['kind'] | null {
  if (type === 'text') return 'text'
  if (type === 'checkbox') return 'checkbox'
  if (type === 'radiobutton') return 'radio'
  if (type === 'combobox') return 'dropdown'
  if (type === 'listbox') return 'option-list'
  if (type === 'signature') return 'signature'
  return null
}

function fieldValue(kind: PdfField['kind'], raw: unknown): PdfFieldValue {
  if (kind === 'text') return typeof raw === 'string' ? raw : null
  if (kind === 'checkbox') return raw === true || typeof raw === 'string' && raw !== '' && raw !== 'Off'
  if (kind === 'radio' || kind === 'dropdown') return typeof raw === 'string' && raw !== 'Off' ? raw : null
  if (kind === 'option-list') {
    const values = strings(raw)
    return values.length ? unique(values) : null
  }
  return null
}

function labelFor(originalName: string): string {
  const label = originalName.replace(/[._-]+/g, ' ').replace(/\s+/g, ' ').trim()
  return (label || 'PDF field').slice(0, 1_000)
}

function hasActions(entry: PdfJsField): boolean {
  const actions = entry.actions ?? entry.action
  if (Array.isArray(actions)) return actions.length > 0
  return Boolean(actions && typeof actions === 'object' && Object.keys(actions).length > 0)
}

function normalizeRotation(value: unknown): 0 | 90 | 180 | 270 {
  const normalized = typeof value === 'number' ? ((value % 360) + 360) % 360 : 0
  if (normalized === 90 || normalized === 180 || normalized === 270) return normalized
  return 0
}

function errorFromParse(error: unknown): PdfEngineError {
  if (error instanceof PdfEngineError) return error
  const message = error instanceof Error ? error.message : String(error)
  if (/password|encrypted/i.test(message)) {
    return new PdfEngineError('pdf_encrypted', 'Encrypted or password-protected PDFs cannot be edited', { cause: error })
  }
  return new PdfEngineError('pdf_malformed', 'The PDF could not be parsed safely', { cause: error })
}

export async function parsePdfSession(input: ParsePdfSessionInput): Promise<PdfSnapshot> {
  assertNotAborted(input.signal)
  if (input.bytes.byteLength > PDF_SESSION_MAX_BYTES) {
    throw new PdfEngineError('pdf_too_large', 'PDF exceeds the 15 MiB editing limit')
  }
  if (input.bytes.byteLength < 5 || Buffer.from(input.bytes.subarray(0, 5)).toString('ascii') !== '%PDF-') {
    throw new PdfEngineError('pdf_malformed', 'The source is not a PDF')
  }
  rejectUnsafeCatalogMarkers(input.bytes)

  const sha256 = input.sha256 ?? bytesSha256(input.bytes)
  if (sha256 !== bytesSha256(input.bytes)) throw new PdfEngineError('pdf_malformed', 'The PDF source hash does not match its bytes')

  const loadingTask = getDocument({
    data: new Uint8Array(input.bytes),
    isEvalSupported: false,
    useSystemFonts: false,
  })
  const abort = () => void loadingTask.destroy()
  input.signal?.addEventListener('abort', abort, { once: true })

  try {
    const document = await loadingTask.promise
    assertNotAborted(input.signal)
    if (document.numPages > PDF_SESSION_MAX_PAGES) {
      throw new PdfEngineError('pdf_too_many_pages', 'PDF exceeds the 100-page editing limit')
    }
    if (document.isPureXfa) throw new PdfEngineError('pdf_unsupported_feature', 'XFA PDFs cannot be edited')
    const [attachments, javaScript, fieldObjects] = await Promise.all([
      document.getAttachments(),
      document.getJSActions(),
      document.getFieldObjects(),
    ])
    if (attachments && Object.keys(attachments).length > 0) {
      throw new PdfEngineError('pdf_unsupported_feature', 'PDF attachments and portfolios are not supported')
    }
    if (javaScript && Object.keys(javaScript).length > 0) {
      throw new PdfEngineError('pdf_unsupported_feature', 'PDF JavaScript is not supported')
    }

    const normalizedFieldObjects: Record<string, PdfJsField[]> = Object.fromEntries(
      Object.entries(fieldObjects ?? {}).map(([name, entries]) => [name, Array.isArray(entries) ? entries as PdfJsField[] : []]),
    )
    const pages: PdfPage[] = []
    for (let pageIndex = 0; pageIndex < document.numPages; pageIndex += 1) {
      const page = await document.getPage(pageIndex + 1)
      const cropBox = normalizePageRect(page.view)
      const mediaBox = normalizePageRect((page as unknown as { _pageInfo?: { view?: unknown } })._pageInfo?.view ?? page.view)
      if (!cropBox || !mediaBox || cropBox.width > 20_000 || cropBox.height > 20_000) {
        throw new PdfEngineError('pdf_malformed', 'PDF contains an invalid page box')
      }
      pages.push({
        id: stableUuid(`${sha256}:page:${pageIndex}`),
        sourcePageIndex: pageIndex,
        mediaBox,
        cropBox,
        rotation: normalizeRotation(page.rotate),
        fields: [],
        overlays: [],
        placementTargets: [],
      })
      const annotations = await page.getAnnotations({ intent: 'any' })
      for (const annotation of annotations) {
        if (annotation.fieldType !== 'Sig' || typeof annotation.fieldName !== 'string') continue
        const entries = normalizedFieldObjects[annotation.fieldName] ?? []
        if (!entries.some((entry) => entry.id === annotation.id && entry.rect)) {
          entries.push({
            ...annotation,
            type: 'signature',
            page: pageIndex,
            value: annotation.fieldValue,
          } as PdfJsField)
          normalizedFieldObjects[annotation.fieldName] = entries
        }
      }
      page.cleanup()
    }

    for (const [fieldIndex, [originalName, rawEntries]] of Object.entries(normalizedFieldObjects).entries()) {
      const entries = (Array.isArray(rawEntries) ? rawEntries : []).filter(
        (entry): entry is PdfJsField => Boolean(entry && typeof entry === 'object'),
      )
      if (entries.length === 0) continue
      if (entries.some(hasActions)) {
        throw new PdfEngineError('pdf_unsupported_feature', 'PDF form actions are not supported')
      }
      const typed = entries.find((entry) => fieldKind(entry.type))
      const kind = fieldKind(typed?.type)
      if (!kind) continue
      if (entries.some((entry) => entry.password === true)) {
        throw new PdfEngineError('pdf_unsupported_feature', 'Password-style form fields cannot be edited')
      }

      const widgets: PdfWidget[] = []
      for (const [widgetIndex, entry] of entries.entries()) {
        const pageIndex = finiteNumber(entry.page)
        const rect = normalizeRect(entry.rect)
        if (pageIndex === null || !Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pages.length || !rect) continue
        const exportValue = strings(entry.exportValues)[0]
        widgets.push({
          id: stableUuid(`${sha256}:field:${originalName}:widget:${entry.id ?? widgetIndex}`),
          pageId: pages[pageIndex].id,
          rect,
          ...(exportValue ? { exportValue } : {}),
        })
      }
      if (widgets.length === 0) continue

      const rawValue = typed?.value ?? entries.find((entry) => entry.value !== undefined)?.value
      const value = fieldValue(kind, rawValue)
      if (kind === 'signature' && value !== null) {
        throw new PdfEngineError('pdf_existing_digital_signature', 'PDFs with an existing digital signature cannot be edited')
      }
      const options = kind === 'radio' || kind === 'dropdown' || kind === 'option-list' ? choiceOptions(entries) : undefined
      if (options && options.length === 0) {
        throw new PdfEngineError('pdf_unsupported_feature', 'A PDF choice field has no enumerable options')
      }
      if (options && typeof value === 'string' && !options.includes(value)) options.push(value)
      if (options && Array.isArray(value)) for (const selected of value) if (!options.includes(selected)) options.push(selected)

      const field: PdfField = {
        id: stableUuid(`${sha256}:field:${originalName}:${fieldIndex}`),
        originalName: originalName.slice(0, 1_000),
        label: labelFor(originalName),
        kind,
        readOnly: entries.every((entry) => entry.editable === false || entry.readOnly === true),
        required: entries.some((entry) => entry.required === true),
        value,
        ...(options ? { allowedOptions: options } : {}),
        widgets,
      }
      const firstPage = pages.find((page) => page.id === widgets[0].pageId)
      if (!firstPage) throw new PdfEngineError('pdf_malformed', 'PDF field widget references an invalid page')
      firstPage.fields.push(field)
      if (kind === 'signature') {
        for (const widget of widgets) {
          const page = pages.find((candidate) => candidate.id === widget.pageId)
          page?.placementTargets.push({
            id: stableUuid(`${sha256}:signature-target:${widget.id}`),
            purpose: 'signature',
            pageId: widget.pageId,
            rect: widget.rect,
            creatorUserId: input.ownerUserId,
            creationVersion: 0,
          })
        }
      }
    }

    return PdfSnapshotSchema.parse({
      schemaVersion: 1,
      capabilityVersion: 1,
      artifactId: input.artifactId,
      workspaceId: input.workspaceId,
      locale: input.locale ?? 'en-US',
      defaultLanguage: input.defaultLanguage ?? input.locale ?? 'en-US',
      templateVersionId: null,
      rootId: stableUuid(`${sha256}:root`),
      title: input.title,
      resources: [],
      accessibility: { title: input.title },
      family: 'pdf',
      source: {
        fileId: input.fileId,
        sha256,
        byteLength: input.bytes.byteLength,
        originalFileName: input.originalFileName,
        pageCount: pages.length,
      },
      pages,
    })
  } catch (error) {
    throw errorFromParse(error)
  } finally {
    input.signal?.removeEventListener('abort', abort)
    await loadingTask.destroy()
  }
}
