/**
 * Safe, bounded LinkedIn ZIP inspection. Extraction is deterministic and the
 * returned member buffers are the exact bytes later persisted as artifacts.
 *
 * [COMP:brain/linkedin-import]
 */

import { createHash } from 'node:crypto'

import JSZip from 'jszip'

import type { LinkedInArchiveMember } from './types.js'

export const MAX_LINKEDIN_ARCHIVE_BYTES = 50 * 1024 * 1024
export const MAX_LINKEDIN_MEMBER_BYTES = 50 * 1024 * 1024
export const MAX_LINKEDIN_TOTAL_UNCOMPRESSED_BYTES = 250 * 1024 * 1024
export const MAX_LINKEDIN_MEMBERS = 1_000
export const MAX_LINKEDIN_MEMBER_PATH_LENGTH = 768

export class LinkedInArchiveError extends Error {
  constructor(
    readonly kind:
      | 'archive_too_large'
      | 'invalid_zip'
      | 'unsafe_path'
      | 'duplicate_path'
      | 'too_many_members'
      | 'member_too_large'
      | 'expanded_archive_too_large'
      | 'encrypted_or_unsupported',
    message: string,
  ) {
    super(message)
    this.name = 'LinkedInArchiveError'
  }
}

export function sha256(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}

type CentralDirectoryEntry = {
  path: string
  compressedSize: number
  uncompressedSize: number
}

function invalidZip(message: string): never {
  throw new LinkedInArchiveError('invalid_zip', message)
}

/**
 * Read the central directory before JSZip sees it. JSZip exposes files as an
 * object keyed by sanitized name, which can hide duplicate raw names; the
 * central directory is the only place to reject duplicates/encryption and size
 * bombs before extraction.
 */
function readCentralDirectory(bytes: Buffer): CentralDirectoryEntry[] {
  const eocdMin = 22
  const eocdSearchStart = Math.max(0, bytes.length - eocdMin - 0xffff)
  let eocd = -1
  for (let offset = bytes.length - eocdMin; offset >= eocdSearchStart; offset -= 1) {
    if (bytes.readUInt32LE(offset) === 0x06054b50) {
      eocd = offset
      break
    }
  }
  if (eocd < 0) invalidZip('Could not find the ZIP central directory.')
  const disk = bytes.readUInt16LE(eocd + 4)
  const centralDisk = bytes.readUInt16LE(eocd + 6)
  const entriesOnDisk = bytes.readUInt16LE(eocd + 8)
  const entryCount = bytes.readUInt16LE(eocd + 10)
  const centralSize = bytes.readUInt32LE(eocd + 12)
  const centralOffset = bytes.readUInt32LE(eocd + 16)
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount) {
    invalidZip('Multi-disk ZIP archives are not supported.')
  }
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff) {
    invalidZip('ZIP64 archives are not supported by the LinkedIn import boundary.')
  }
  if (centralOffset + centralSize > eocd || centralOffset < 0) {
    invalidZip('ZIP central directory offsets are inconsistent.')
  }

  const entries: CentralDirectoryEntry[] = []
  const seen = new Set<string>()
  let total = 0
  let offset = centralOffset
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > bytes.length || bytes.readUInt32LE(offset) !== 0x02014b50) {
      invalidZip(`Invalid ZIP central-directory entry ${index + 1}.`)
    }
    const flags = bytes.readUInt16LE(offset + 8)
    if ((flags & 0x1) !== 0) {
      throw new LinkedInArchiveError('encrypted_or_unsupported', 'Encrypted ZIP members are not supported.')
    }
    const compressedSize = bytes.readUInt32LE(offset + 20)
    const uncompressedSize = bytes.readUInt32LE(offset + 24)
    const nameLength = bytes.readUInt16LE(offset + 28)
    const extraLength = bytes.readUInt16LE(offset + 30)
    const commentLength = bytes.readUInt16LE(offset + 32)
    const end = offset + 46 + nameLength + extraLength + commentLength
    if (end > bytes.length) invalidZip(`Truncated ZIP central-directory entry ${index + 1}.`)
    const rawNameBytes = bytes.subarray(offset + 46, offset + 46 + nameLength)
    const rawName = rawNameBytes.toString('utf8')
    if (rawName.includes('\ufffd')) invalidZip('ZIP member name is not valid UTF-8.')
    const directory = rawName.endsWith('/')
    const comparableName = directory ? rawName.slice(0, -1) : rawName
    const path = normalizeMemberPath(comparableName)
    if (seen.has(path)) {
      throw new LinkedInArchiveError('duplicate_path', `Duplicate ZIP member path: ${path}`)
    }
    seen.add(path)
    if (!directory) {
      if (uncompressedSize > MAX_LINKEDIN_MEMBER_BYTES) {
        throw new LinkedInArchiveError(
          'member_too_large',
          `ZIP member ${path} expands to ${uncompressedSize} bytes; maximum is ${MAX_LINKEDIN_MEMBER_BYTES}.`,
        )
      }
      total += uncompressedSize
      if (total > MAX_LINKEDIN_TOTAL_UNCOMPRESSED_BYTES) {
        throw new LinkedInArchiveError(
          'expanded_archive_too_large',
          `ZIP expands beyond ${MAX_LINKEDIN_TOTAL_UNCOMPRESSED_BYTES} bytes.`,
        )
      }
      entries.push({ path, compressedSize, uncompressedSize })
    }
    offset = end
  }
  if (entries.length > MAX_LINKEDIN_MEMBERS) {
    throw new LinkedInArchiveError(
      'too_many_members',
      `LinkedIn archive has ${entries.length} files; maximum is ${MAX_LINKEDIN_MEMBERS}.`,
    )
  }
  return entries
}

export function normalizeMemberPath(raw: string): string {
  if (
    raw.length === 0 ||
    raw.length > MAX_LINKEDIN_MEMBER_PATH_LENGTH ||
    raw.includes('\0') ||
    raw.includes('\\') ||
    raw.startsWith('/') ||
    /^[A-Za-z]:/.test(raw)
  ) {
    throw new LinkedInArchiveError('unsafe_path', `Unsafe ZIP member path: ${JSON.stringify(raw)}`)
  }
  const parts = raw.split('/')
  if (parts.some((part) => part === '' || part === '.' || part === '..')) {
    throw new LinkedInArchiveError('unsafe_path', `Unsafe ZIP member path: ${JSON.stringify(raw)}`)
  }
  return parts.join('/')
}

export function mimeForMember(path: string): string {
  const lower = path.toLowerCase()
  if (lower.endsWith('.csv')) return 'text/csv'
  if (lower.endsWith('.json')) return 'application/json'
  if (lower.endsWith('.html') || lower.endsWith('.htm')) return 'text/html'
  if (lower.endsWith('.txt')) return 'text/plain'
  if (lower.endsWith('.xml')) return 'application/xml'
  if (lower.endsWith('.pdf')) return 'application/pdf'
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'image/jpeg'
  if (lower.endsWith('.png')) return 'image/png'
  return 'application/octet-stream'
}

export async function inspectLinkedInArchive(bytes: Buffer): Promise<LinkedInArchiveMember[]> {
  if (bytes.length > MAX_LINKEDIN_ARCHIVE_BYTES) {
    throw new LinkedInArchiveError(
      'archive_too_large',
      `LinkedIn archive is ${bytes.length} bytes; maximum is ${MAX_LINKEDIN_ARCHIVE_BYTES}.`,
    )
  }

  let centralEntries: CentralDirectoryEntry[]
  try {
    centralEntries = readCentralDirectory(bytes)
  } catch (err) {
    if (err instanceof LinkedInArchiveError) throw err
    throw new LinkedInArchiveError('invalid_zip', `Could not read ZIP directory: ${String(err)}`)
  }

  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(bytes, { checkCRC32: true, createFolders: false })
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    const encrypted = /encrypted|password/i.test(message)
    throw new LinkedInArchiveError(
      encrypted ? 'encrypted_or_unsupported' : 'invalid_zip',
      `Could not read LinkedIn ZIP: ${message}`,
    )
  }

  const members: LinkedInArchiveMember[] = []
  let actualTotal = 0
  for (const metadata of centralEntries) {
    const { path } = metadata
    const entry = zip.file(path)
    if (!entry || entry.dir) invalidZip(`ZIP member ${path} is missing after directory validation.`)
    let memberBytes: Buffer
    try {
      memberBytes = await entry.async('nodebuffer')
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      throw new LinkedInArchiveError(
        /encrypted|password/i.test(message) ? 'encrypted_or_unsupported' : 'invalid_zip',
        `Could not extract ${path}: ${message}`,
      )
    }
    if (memberBytes.length > MAX_LINKEDIN_MEMBER_BYTES) {
      throw new LinkedInArchiveError(
        'member_too_large',
        `ZIP member ${path} expands to ${memberBytes.length} bytes; maximum is ${MAX_LINKEDIN_MEMBER_BYTES}.`,
      )
    }
    if (memberBytes.length !== metadata.uncompressedSize) {
      invalidZip(`ZIP member ${path} size differs from its central-directory declaration.`)
    }
    actualTotal += memberBytes.length
    if (actualTotal > MAX_LINKEDIN_TOTAL_UNCOMPRESSED_BYTES) {
      throw new LinkedInArchiveError(
        'expanded_archive_too_large',
        `ZIP expands beyond ${MAX_LINKEDIN_TOTAL_UNCOMPRESSED_BYTES} bytes.`,
      )
    }
    members.push({
      path,
      bytes: memberBytes,
      contentSha256: sha256(memberBytes),
      compressedSize: metadata.compressedSize,
      sizeBytes: memberBytes.length,
      mime: mimeForMember(path),
    })
  }

  return members.sort((a, b) => a.path.localeCompare(b.path))
}
