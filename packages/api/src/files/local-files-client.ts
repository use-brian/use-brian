/**
 * Local-filesystem implementation of {@link GcsFilesClient}. It is used as the
 * self-hosted application default when `LOCAL_FILES_DIR` is configured, and as
 * the dev/test fallback when `GCS_FILES_BUCKET` is unset. Stores each blob at
 * `<baseDir>/<key>` with a sidecar `<...>.meta.json` carrying the mime + custom
 * metadata, so the workspace-file tools (`fileWrite`, `saveFileToBrain`, …)
 * work end-to-end without GCS — otherwise the whole file primitive is silently
 * disabled locally and the model can't actually save an uploaded file.
 *
 * Signed reads and writes use a short-lived API transfer URL when `apiUrl` and
 * `signingSecret` are configured. That keeps browser recording uploads,
 * connector media streams, public previews, and Range playback working without
 * exposing a `file://` path. Production use requires `LOCAL_FILES_DIR` to point
 * at a durable mounted volume. Without an explicit path, boot only uses the
 * ephemeral `/tmp` fallback off Cloud Run; Cloud Run remains fail-closed.
 */

import { createReadStream, createWriteStream, mkdirSync, promises as fs, writeFileSync } from 'node:fs'
import type { Readable, Writable } from 'node:stream'
import { tmpdir } from 'node:os'
import * as path from 'node:path'
import type { GcsBlob, GcsFilesClient, GcsObjectMetadata } from './gcs-client.js'
import { buildLocalFileTransferUrl } from './local-files-signing.js'

const DEFAULT_META: GcsObjectMetadata = { workspaceId: '', mime: 'application/octet-stream' }

export function resolveLocalFilesBaseDir(configured?: string): string {
  return path.resolve(configured?.trim() || path.join(tmpdir(), 'sidanclaw-files'))
}

export type LocalFilesClient = GcsFilesClient & {
  openReadStream(key: string, range?: { start: number; end: number }): Readable
}

export function createLocalFilesClient(opts: {
  baseDir: string
  apiUrl?: string
  signingSecret?: string
}): LocalFilesClient {
  const baseDir = path.resolve(opts.baseDir)
  const blobPath = (key: string): string => {
    const resolved = path.resolve(baseDir, key)
    if (resolved !== baseDir && !resolved.startsWith(`${baseDir}${path.sep}`)) {
      throw new Error('local files: key escapes storage directory')
    }
    return resolved
  }
  const metaPath = (key: string): string => `${blobPath(key)}.meta.json`
  const transferUrl = (action: 'read' | 'write', key: string, ttlSec: number, mime?: string): string | null => {
    if (!opts.apiUrl || !opts.signingSecret) return null
    return buildLocalFileTransferUrl({
      apiUrl: opts.apiUrl,
      secret: opts.signingSecret,
      grant: {
        action,
        key,
        expires: Math.floor(Date.now() / 1000) + ttlSec,
        ...(mime ? { mime } : {}),
      },
    })
  }

  const client: LocalFilesClient = {
    async writeBlob(key, bytes, metadata) {
      const p = blobPath(key)
      await fs.mkdir(path.dirname(p), { recursive: true })
      await fs.writeFile(p, bytes)
      await fs.writeFile(metaPath(key), JSON.stringify(metadata))
    },

    async appendBlob(key, bytes) {
      const existing = await client.readBlob(key)
      const next = existing ? Buffer.concat([existing.bytes, bytes]) : bytes
      await client.writeBlob(key, next, existing?.metadata ?? DEFAULT_META)
    },

    async readBlob(key): Promise<GcsBlob | null> {
      try {
        const bytes = await fs.readFile(blobPath(key))
        let metadata = DEFAULT_META
        try {
          metadata = JSON.parse(await fs.readFile(metaPath(key), 'utf8')) as GcsObjectMetadata
        } catch {
          // Missing/corrupt sidecar — fall back to the default mime.
        }
        return { bytes, mime: metadata.mime, metadata }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },

    async statBlob(key) {
      try {
        // stat(), not readFile() — the point of statBlob is size WITHOUT
        // pulling the object into memory.
        const st = await fs.stat(blobPath(key))
        let metadata = DEFAULT_META
        try {
          metadata = JSON.parse(await fs.readFile(metaPath(key), 'utf8')) as GcsObjectMetadata
        } catch {
          // Missing/corrupt sidecar — fall back to the default mime.
        }
        return { sizeBytes: st.size, mime: metadata.mime, updatedAt: st.mtime }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null
        throw err
      }
    },

    async deleteBlob(key) {
      await fs.rm(blobPath(key), { force: true })
      await fs.rm(metaPath(key), { force: true })
    },

    async signedReadUrl(key, ttlSec = 3600) {
      return transferUrl('read', key, ttlSec) ?? `file://${blobPath(key)}`
    },

    async signedWriteUrl(key, signedOpts) {
      return transferUrl('write', key, signedOpts?.ttlSec ?? 3600, signedOpts?.contentType) ?? `file://${blobPath(key)}`
    },

    openReadStream(key, range) {
      return createReadStream(blobPath(key), range)
    },

    writeStream(key, opts): Writable {
      const p = blobPath(key)
      // Setup is synchronous so the returned stream is the actual file sink;
      // its `finish` event therefore means bytes have reached the filesystem.
      mkdirSync(path.dirname(p), { recursive: true })
      writeFileSync(metaPath(key), JSON.stringify(opts.metadata ?? { workspaceId: '', mime: opts.mime }))
      return createWriteStream(p)
    },
  }

  return client
}
