/**
 * Resource preflight for Office ZIP containers handled by Brian's ExcelJS and
 * explicit-slide PPTX lanes. AnyDoc enforces equivalent native-parser budgets
 * for its own formats.
 *
 * [COMP:files/document-formats]
 */
import JSZip from 'jszip'

export const MAX_OFFICE_ARCHIVE_ENTRIES = 100_000
export const MAX_OFFICE_ARCHIVE_ENTRY_BYTES = 128 * 1024 * 1024
export const MAX_OFFICE_ARCHIVE_TOTAL_BYTES = 512 * 1024 * 1024

export type OfficeArchiveEntry = {
  name: string
  uncompressedSize: number
}

export class OfficeArchiveLimitError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OfficeArchiveLimitError'
  }
}

/** Pure budget check kept separate so oversized declarations need no allocation in tests. */
export function assertOfficeArchiveBudget(entries: readonly OfficeArchiveEntry[]): void {
  if (entries.length > MAX_OFFICE_ARCHIVE_ENTRIES) {
    throw new OfficeArchiveLimitError('office archive contains too many entries')
  }

  let total = 0
  for (const entry of entries) {
    if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0) {
      throw new OfficeArchiveLimitError('office archive has an invalid entry size')
    }
    if (entry.uncompressedSize > MAX_OFFICE_ARCHIVE_ENTRY_BYTES) {
      throw new OfficeArchiveLimitError('office archive entry exceeds the size limit')
    }
    total += entry.uncompressedSize
    if (total > MAX_OFFICE_ARCHIVE_TOTAL_BYTES) {
      throw new OfficeArchiveLimitError('office archive exceeds the expanded size limit')
    }
  }
}

type ZipObjectWithSize = JSZip.JSZipObject & {
  _data?: { uncompressedSize?: number }
}

export async function assertSafeOfficeArchive(buffer: Buffer): Promise<void> {
  const archive = await JSZip.loadAsync(buffer)
  const entries = Object.values(archive.files)
    .filter((entry) => !entry.dir)
    .map((entry) => {
      const sized = entry as ZipObjectWithSize
      return {
        name: entry.name,
        uncompressedSize: sized._data?.uncompressedSize ?? Number.NaN,
      }
    })

  assertOfficeArchiveBudget(entries)
}
