/**
 * Canonical structured-document format registry.
 *
 * Keep upload admission, channel classification, and parsing on this one
 * table so a newly supported format cannot silently work in only one path.
 * Content detection is delegated to AnyDoc and deliberately loaded lazily:
 * MIME-only channel classification should not load a native parser binding.
 *
 * [COMP:files/document-formats]
 */

export type DocumentFormat =
  | 'csv'
  | 'doc'
  | 'docx'
  | 'epub'
  | 'odp'
  | 'ods'
  | 'odt'
  | 'pdf'
  | 'ppt'
  | 'pptx'
  | 'rtf'
  | 'xlsx'

export type DocumentFamily = 'document' | 'ebook' | 'presentation' | 'spreadsheet'

type FormatRecord = {
  family: DocumentFamily
  extensions: readonly string[]
  mimeTypes: readonly string[]
}

export const DOCUMENT_FORMATS: Readonly<Record<DocumentFormat, FormatRecord>> = {
  csv: {
    family: 'spreadsheet',
    extensions: ['csv'],
    mimeTypes: ['text/csv', 'application/csv'],
  },
  doc: {
    family: 'document',
    extensions: ['doc'],
    mimeTypes: ['application/msword'],
  },
  docx: {
    family: 'document',
    extensions: ['docx', 'docm'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      'application/vnd.ms-word.document.macroenabled.12',
    ],
  },
  epub: {
    family: 'ebook',
    extensions: ['epub'],
    mimeTypes: ['application/epub+zip'],
  },
  odp: {
    family: 'presentation',
    extensions: ['odp'],
    mimeTypes: ['application/vnd.oasis.opendocument.presentation'],
  },
  ods: {
    family: 'spreadsheet',
    extensions: ['ods'],
    mimeTypes: ['application/vnd.oasis.opendocument.spreadsheet'],
  },
  odt: {
    family: 'document',
    extensions: ['odt'],
    mimeTypes: ['application/vnd.oasis.opendocument.text'],
  },
  pdf: {
    family: 'document',
    extensions: ['pdf'],
    mimeTypes: ['application/pdf'],
  },
  ppt: {
    family: 'presentation',
    extensions: ['ppt', 'pps', 'pot'],
    mimeTypes: ['application/vnd.ms-powerpoint'],
  },
  pptx: {
    family: 'presentation',
    extensions: ['pptx', 'pptm', 'ppsx', 'ppsm'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.presentationml.presentation',
      'application/vnd.openxmlformats-officedocument.presentationml.slideshow',
      'application/vnd.ms-powerpoint.presentation.macroenabled.12',
      'application/vnd.ms-powerpoint.slideshow.macroenabled.12',
    ],
  },
  rtf: {
    family: 'document',
    extensions: ['rtf'],
    mimeTypes: ['application/rtf', 'application/x-rtf', 'text/rtf'],
  },
  xlsx: {
    family: 'spreadsheet',
    // AnyDoc normalizes Excel's legacy, macro-enabled, and binary workbook
    // containers to the xlsx output format.
    extensions: ['xlsx', 'xls', 'xlsm', 'xlsb'],
    mimeTypes: [
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'application/vnd.ms-excel',
      'application/vnd.ms-excel.sheet.macroenabled.12',
      'application/vnd.ms-excel.sheet.binary.macroenabled.12',
    ],
  },
}

const FORMATS = Object.entries(DOCUMENT_FORMATS) as [DocumentFormat, FormatRecord][]

export const STRUCTURED_DOCUMENT_MIME_TYPES: ReadonlySet<string> = new Set(
  FORMATS.flatMap(([, record]) => record.mimeTypes),
)

function normalizedMime(mimeType: string): string {
  return mimeType.split(';', 1)[0]!.trim().toLowerCase()
}

export function fileExtension(fileName?: string): string | undefined {
  if (!fileName) return undefined
  const basename = fileName.split(/[\\/]/).at(-1) ?? fileName
  const dot = basename.lastIndexOf('.')
  return dot > -1 ? basename.slice(dot + 1).toLowerCase() : undefined
}

export function documentFormatFromMetadata(
  mimeType: string,
  fileName?: string,
): DocumentFormat | undefined {
  const extension = fileExtension(fileName)
  if (extension) {
    const byExtension = FORMATS.find(([, record]) => record.extensions.includes(extension))
    if (byExtension) return byExtension[0]
  }

  const mime = normalizedMime(mimeType)
  return FORMATS.find(([, record]) => record.mimeTypes.includes(mime))?.[0]
}

/**
 * Detect from bytes first, then fall back to normalized filename/MIME metadata.
 * AnyDoc returns one of its public format strings; values outside Brian's
 * accepted registry are intentionally ignored.
 */
export async function detectDocumentFormat(
  buffer: Buffer,
  mimeType: string,
  fileName?: string,
): Promise<DocumentFormat | undefined> {
  try {
    const { formatFromBytes } = await import('@firecrawl/anydoc')
    const detected = await formatFromBytes(buffer)
    if (typeof detected === 'string' && detected in DOCUMENT_FORMATS) {
      return detected as DocumentFormat
    }
  } catch {
    // An unknown/corrupt stream is normal here. Metadata remains a useful
    // fallback and the chosen parser will produce Brian-owned failure copy.
  }

  return documentFormatFromMetadata(mimeType, fileName)
}

export function isStructuredDocument(mimeType: string, fileName?: string): boolean {
  return documentFormatFromMetadata(mimeType, fileName) !== undefined
}

export function isTabularDocument(mimeType: string, fileName?: string): boolean {
  const format = documentFormatFromMetadata(mimeType, fileName)
  return format !== undefined && DOCUMENT_FORMATS[format].family === 'spreadsheet'
}

export function documentFamily(format: DocumentFormat): DocumentFamily {
  return DOCUMENT_FORMATS[format].family
}

/** Canonical transport MIME for storing a document whose format is known. */
export function documentMimeType(format: DocumentFormat): string {
  return DOCUMENT_FORMATS[format].mimeTypes[0]!
}
