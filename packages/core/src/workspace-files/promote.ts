/**
 * Promote a transient upload (`file_cache`) into the permanent workspace file
 * primitive.
 *
 * Extracted so there is exactly ONE decoder. `saveFileToBrain` is the explicit
 * "keep this file" path; the Shopify product-image seam promotes implicitly so
 * a photo the owner just attached can reach a product without a bookkeeping
 * step they never asked for. Two copies of the data-URL branch would drift, and
 * the failure would be silent: a base64 payload written as UTF-8 is a corrupt
 * image that still uploads.
 */
import type { FilesApi, FilesContext, FilesResult } from './api.js'
import type { WorkspaceFile } from './types.js'
import type { CachedFile } from '../files/types.js'

const DATA_URL_RE = /^data:[^;]+;base64,(.+)$/

/**
 * Binary attachments (image/PDF/audio) are cached as a base64 data URL;
 * text-like files are cached as plain UTF-8. Decode either to raw bytes.
 */
export function cachedFileBytes(cached: CachedFile): Buffer {
  const m = DATA_URL_RE.exec(cached.content)
  return m ? Buffer.from(m[1], 'base64') : Buffer.from(cached.content, 'utf-8')
}

export type PromoteCachedFileOptions = {
  path?: string
  title?: string
  summary?: string
  tags?: string[]
  sensitivity?: FilesWriteSensitivity
}

type FilesWriteSensitivity = NonNullable<Parameters<FilesApi['writeBytes']>[1]['sensitivity']>

/** Persist the cached bytes verbatim at `/uploads/<original name>` by default. */
export function promoteCachedFile(
  api: FilesApi,
  ctx: FilesContext,
  cached: CachedFile,
  opts?: PromoteCachedFileOptions,
): Promise<FilesResult<WorkspaceFile>> {
  return api.writeBytes(ctx, {
    path: opts?.path ?? `/uploads/${cached.fileName}`,
    bytes: cachedFileBytes(cached),
    mime: cached.mimeType,
    title: opts?.title ?? cached.fileName,
    summary: opts?.summary ?? cached.summary ?? null,
    tags: opts?.tags,
    sensitivity: opts?.sensitivity,
  })
}
