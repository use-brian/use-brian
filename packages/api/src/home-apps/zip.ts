/**
 * Zip import/export for custom Home apps — the §7 distribution format.
 *
 * A zip is the GitHub path without the repo: the same bundle, the same
 * validator, the same consent gate, moved as one file. Two codecs live here
 * and nothing else — extraction feeds the SAME `writeHomeAppBundle` seam the
 * assistant path uses (one write path, per its own contract), and export reads
 * back exactly what the bundle route would serve.
 *
 * Extraction rules, in order:
 *
 *   1. **Archive junk is dropped first** (`__MACOSX/`, `.DS_Store`, `._*`,
 *      `Thumbs.db`) — a zip made by right-clicking a folder on macOS carries
 *      all of it, and failing the import over resource forks would be absurd.
 *   2. **A single top-level folder is stripped.** Zipping a folder (rather
 *      than its contents) is the most common way to make this archive, and
 *      `MyApp/brian-app.json` should import identically to `brian-app.json`.
 *   3. **Repo furniture is filtered with `isBundleAsset`** — the zip path
 *      mirrors the GitHub path (an archive of a repo checkout is expected),
 *      not the assistant path.
 *   4. **The v1 caps are enforced DURING extraction**, not just at
 *      validation: a zip is attacker-supplied compressed input, and the caps
 *      must bound memory before a decompression bomb inflates, not after.
 *
 * Binary assets (png, woff, …) ride as bytes and are stored byte-preserving
 * via `filesApi.writeBytes` — the one fidelity the text-only GitHub fetch
 * does not have.
 *
 * Spec: docs/architecture/features/home-apps.md → "Zip import/export".
 * [COMP:api/home-app-zip]
 */

import JSZip from 'jszip'
import {
  BUNDLE_MAX_FILES,
  BUNDLE_MAX_FILE_BYTES,
  BUNDLE_MAX_TOTAL_BYTES,
  contentTypeFor,
  isSafeBundlePath,
} from '@use-brian/brian-app'
import { isBundleAsset } from './sync.js'
import type { BundleWriteFile } from './tools.js'

export type FilesFromZipResult =
  | { ok: true; files: BundleWriteFile[] }
  | { ok: false; message: string }

/** Archive junk a folder-zip always carries. Never an error, always skipped. */
function isArchiveJunk(path: string): boolean {
  const segments = path.split('/')
  if (segments[0] === '__MACOSX') return true
  const base = segments[segments.length - 1] ?? ''
  return base === '.DS_Store' || base === 'Thumbs.db' || base.startsWith('._')
}

/** Text vs bytes, decided by the SAME pinned table the serving route uses. */
function isTextType(path: string): boolean {
  const type = contentTypeFor(path) ?? ''
  return (
    type.startsWith('text/') ||
    type.startsWith('application/json') ||
    type === 'image/svg+xml'
  )
}

/**
 * Extract a zip into bundle files, ready for `writeHomeAppBundle`.
 *
 * Returns a message rather than throwing: everything that can go wrong here is
 * the uploader's input, and the message is the user-facing explanation.
 */
export async function filesFromZipBuffer(buf: Uint8Array): Promise<FilesFromZipResult> {
  let zip: JSZip
  try {
    zip = await JSZip.loadAsync(buf)
  } catch {
    return { ok: false, message: 'That file is not a readable zip archive.' }
  }

  const entries = Object.values(zip.files).filter((e) => !e.dir && !isArchiveJunk(e.name))
  if (entries.length === 0) {
    return { ok: false, message: 'The zip archive is empty.' }
  }

  // Strip a single shared top-level folder ("MyApp/…"), the shape a
  // zip-the-folder archive always has. Only when EVERY entry shares it.
  const tops = new Set(entries.map((e) => e.name.split('/')[0]))
  const hasNestedOnly = entries.every((e) => e.name.includes('/'))
  const strip = tops.size === 1 && hasNestedOnly ? `${[...tops][0]}/` : ''

  const files: BundleWriteFile[] = []
  let total = 0
  for (const entry of entries) {
    const path = entry.name.slice(strip.length)
    if (!isSafeBundlePath(path)) continue
    // The GitHub rule: a checkout CONTAINS a bundle, it is not one. README,
    // LICENSE, CI config all skip silently rather than failing the import.
    if (!isBundleAsset(path)) continue

    if (files.length >= BUNDLE_MAX_FILES) {
      return { ok: false, message: `The bundle has more than ${BUNDLE_MAX_FILES} files.` }
    }
    const bytes = Buffer.from(await entry.async('uint8array'))
    if (bytes.byteLength > BUNDLE_MAX_FILE_BYTES) {
      return {
        ok: false,
        message: `${path} is larger than ${Math.floor(BUNDLE_MAX_FILE_BYTES / 1024 / 1024)} MB.`,
      }
    }
    total += bytes.byteLength
    if (total > BUNDLE_MAX_TOTAL_BYTES) {
      return {
        ok: false,
        message: `The bundle is larger than ${Math.floor(BUNDLE_MAX_TOTAL_BYTES / 1024 / 1024)} MB.`,
      }
    }
    files.push(
      isTextType(path)
        ? { path, content: bytes.toString('utf8') }
        : { path, bytes },
    )
  }

  return { ok: true, files }
}

/** Pack stored bundle files into a zip, the byte-mirror of extraction. */
export async function buildBundleZip(
  files: Array<{ path: string; bytes: Uint8Array }>,
): Promise<Buffer> {
  const zip = new JSZip()
  for (const file of files) {
    zip.file(file.path, file.bytes)
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' })
}
