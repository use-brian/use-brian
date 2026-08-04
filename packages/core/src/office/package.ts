import { createHash } from 'node:crypto'
import JSZip from 'jszip'
import {
  assertOfficeArtifactSnapshot,
  type OfficeArtifactSnapshot,
  type OfficeFamily,
  type OfficePreflightDiagnostic,
  type OfficeResourceRef,
} from '@use-brian/office-model'

export const OFFICE_CANONICAL_PART = 'customXml/brian-office.json'
export const OFFICE_CANONICAL_CONTENT_TYPE = 'application/vnd.use-brian.office+json'

const MAX_PACKAGE_BYTES = 100 * 1024 * 1024
const MAX_PACKAGE_ENTRIES = 2_000
const MAX_UNCOMPRESSED_BYTES = 400 * 1024 * 1024

const ACTIVE_PART_PATTERNS = [
  /(^|\/)vbaProject\.bin$/i,
  /(^|\/)activeX\//i,
  /(^|\/)customUI\//i,
  /(^|\/)signatures?\//i,
  /(^|\/)digital-signature/i,
  /encryptedpackage/i,
]

const XML_REJECTIONS: Array<{ pattern: RegExp; capabilityId: string; message: string }> = [
  { pattern: /<(?:w:)?(?:ins|del|moveFrom|moveTo)\b/i, capabilityId: 'trackedChanges', message: 'Accept or reject tracked changes before import' },
  { pattern: /<(?:w:)?(?:altChunk|customXml|dataBinding|mailMerge|documentProtection)\b/i, capabilityId: 'externalRelationship', message: 'Bound, protected, or externally populated Word content is not supported' },
  { pattern: /<(?:p:)?(?:timing|transition)\b/i, capabilityId: 'animation', message: 'Remove slide animations and transitions before import' },
  { pattern: /<(?:p:)?(?:oleObj|control)\b/i, capabilityId: 'embeddedWorksheet', message: 'Embedded packages and controls are not supported' },
  { pattern: /<(?:a:)?audioFile\b/i, capabilityId: 'audio', message: 'Audio is outside the v1 media contract' },
]

type ZipEntryWithSize = JSZip.JSZipObject & { _data?: { uncompressedSize?: number } }

export type OfficePackagePreflight = {
  ok: boolean
  family: OfficeFamily
  diagnostics: OfficePreflightDiagnostic[]
  zip?: JSZip
}

export type OfficeImportContext = {
  artifactId: string
  workspaceId: string
  templateVersionId: string
  locale: string
  defaultLanguage: string
  title: string
}

export type OfficeResourcePayload = {
  bytes: Uint8Array
  mime: string
  widthPx?: number
  heightPx?: number
}

export type OfficeResourceResolver = (resourceId: string) => Promise<OfficeResourcePayload | null>

export type ExtractedOfficeResource = {
  ref: OfficeResourceRef
  bytes: Uint8Array
  sourcePart: string
}

export type OfficeImportResult = {
  snapshot?: OfficeArtifactSnapshot
  resources: ExtractedOfficeResource[]
  diagnostics: OfficePreflightDiagnostic[]
  ok: boolean
}

function error(code: string, path: string, message: string, capabilityId?: string): OfficePreflightDiagnostic {
  return { severity: 'error', code, path, message, capabilityId }
}

function relationshipAttributes(tag: string): Record<string, string> {
  return Object.fromEntries(
    [...tag.matchAll(/([A-Za-z:]+)="([^"]*)"/g)].map((match) => [match[1], match[2]]),
  )
}

export async function preflightOfficePackage(
  bytes: Uint8Array,
  family: OfficeFamily,
): Promise<OfficePackagePreflight> {
  const diagnostics: OfficePreflightDiagnostic[] = []
  if (bytes.byteLength > MAX_PACKAGE_BYTES) {
    return { ok: false, family, diagnostics: [error('package.too_large', '', `Office package exceeds ${MAX_PACKAGE_BYTES} bytes`)] }
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true })
  } catch (cause) {
    return { ok: false, family, diagnostics: [error('package.invalid_zip', '', cause instanceof Error ? cause.message : 'Invalid OOXML ZIP package')] }
  }

  const entries = Object.values(zip.files)
  if (entries.length > MAX_PACKAGE_ENTRIES) diagnostics.push(error('package.too_many_parts', '', `Office package contains more than ${MAX_PACKAGE_ENTRIES} parts`))
  let uncompressedBytes = 0
  for (const entry of entries) {
    const safePath = entry.name.replaceAll('\\', '/')
    if (safePath.startsWith('/') || safePath.split('/').includes('..')) diagnostics.push(error('package.unsafe_path', entry.name, 'OOXML part path escapes the package root'))
    if (ACTIVE_PART_PATTERNS.some((pattern) => pattern.test(safePath))) diagnostics.push(error('package.active_content', entry.name, 'Executable, embedded, signed, or encrypted Office content is rejected', 'macro'))
    if (/(^|\/)embeddings\//i.test(safePath) && !entry.dir && !/^ppt\/embeddings\/Microsoft_Excel_Worksheet\d+\.xlsx$/i.test(safePath)) diagnostics.push(error('package.embedded_package', entry.name, 'Only the inert workbook backing a supported native chart may be embedded', 'embeddedWorksheet'))
    const size = (entry as ZipEntryWithSize)._data?.uncompressedSize ?? 0
    uncompressedBytes += size
  }
  if (uncompressedBytes > MAX_UNCOMPRESSED_BYTES) diagnostics.push(error('package.decompression_limit', '', `Expanded Office package exceeds ${MAX_UNCOMPRESSED_BYTES} bytes`))

  const contentTypes = await zip.file('[Content_Types].xml')?.async('string')
  if (!contentTypes) diagnostics.push(error('package.missing_content_types', '[Content_Types].xml', 'OOXML content types are missing'))
  const mainPart = family === 'document' ? 'word/document.xml' : 'ppt/presentation.xml'
  if (!zip.file(mainPart)) diagnostics.push(error('package.missing_main_part', mainPart, `Missing ${family} main part`))

  for (const entry of entries) {
    if (entry.dir || !entry.name.endsWith('.xml') && !entry.name.endsWith('.rels')) continue
    const size = (entry as ZipEntryWithSize)._data?.uncompressedSize ?? 0
    if (size > 20 * 1024 * 1024) {
      diagnostics.push(error('package.xml_part_too_large', entry.name, 'An XML part exceeds the safe parsing limit'))
      continue
    }
    const xml = await entry.async('string')
    if (/<!DOCTYPE|<!ENTITY/i.test(xml)) diagnostics.push(error('package.xml_entity', entry.name, 'DOCTYPE and entity declarations are rejected'))
    if (entry.name.endsWith('.rels')) {
      for (const match of xml.matchAll(/<Relationship\b[^>]*\/?\s*>/g)) {
        const attrs = relationshipAttributes(match[0])
        if (attrs.TargetMode !== 'External') continue
        const hyperlink = attrs.Type?.endsWith('/hyperlink') && /^(https:|mailto:)/.test(attrs.Target ?? '')
        if (!hyperlink) diagnostics.push(error('package.external_relationship', entry.name, 'External templates, data, media, and unknown relationships are rejected', 'externalRelationship'))
      }
    }
    for (const rejected of XML_REJECTIONS) {
      if (rejected.pattern.test(xml)) diagnostics.push(error('package.unsupported_construct', entry.name, rejected.message, rejected.capabilityId))
    }
  }

  return { ok: diagnostics.length === 0, family, diagnostics, zip }
}

export function canonicalOfficeJson(snapshot: OfficeArtifactSnapshot): string {
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize)
    if (value && typeof value === 'object') {
      return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => [key, normalize(child)]))
    }
    return value
  }
  return JSON.stringify(normalize(snapshot))
}

export function officeSemanticHash(snapshot: OfficeArtifactSnapshot): string {
  return createHash('sha256').update(canonicalOfficeJson(snapshot)).digest('hex')
}

export function stableOfficeUuid(seed: string): string {
  const hex = createHash('sha256').update(seed).digest('hex').slice(0, 32).split('')
  hex[12] = '4'
  hex[16] = ['8', '9', 'a', 'b'][Number.parseInt(hex[16], 16) % 4]
  return `${hex.slice(0, 8).join('')}-${hex.slice(8, 12).join('')}-${hex.slice(12, 16).join('')}-${hex.slice(16, 20).join('')}-${hex.slice(20).join('')}`
}

export async function attachCanonicalOfficePart(bytes: Uint8Array, snapshot: OfficeArtifactSnapshot): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes)
  zip.file(OFFICE_CANONICAL_PART, canonicalOfficeJson(snapshot))
  const contentTypes = await zip.file('[Content_Types].xml')?.async('string')
  if (!contentTypes) throw new Error('Generated OOXML package has no [Content_Types].xml')
  if (!contentTypes.includes(OFFICE_CANONICAL_CONTENT_TYPE)) {
    zip.file('[Content_Types].xml', contentTypes.replace('</Types>', `<Override PartName="/${OFFICE_CANONICAL_PART}" ContentType="${OFFICE_CANONICAL_CONTENT_TYPE}"/></Types>`))
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } })
}

export async function readCanonicalOfficePart(zip: JSZip, family: OfficeFamily): Promise<OfficeArtifactSnapshot | null> {
  const file = zip.file(OFFICE_CANONICAL_PART)
  if (!file) return null
  const snapshot = assertOfficeArtifactSnapshot(JSON.parse(await file.async('string')))
  if (snapshot.family !== family) throw new Error(`Canonical Office part is ${snapshot.family}, expected ${family}`)
  return snapshot
}

export function decodeXmlText(value: string): string {
  return value
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&apos;', "'")
    .replaceAll('&amp;', '&')
}
