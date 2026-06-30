/**
 * Local-filesystem stand-in for {@link GcsFilesClient}, used in dev / test when
 * `GCS_FILES_BUCKET` is unset (no bucket to provision). Stores each blob at
 * `<baseDir>/<key>` with a sidecar `<...>.meta.json` carrying the mime + custom
 * metadata, so the workspace-file tools (`fileWrite`, `saveFileToBrain`, …)
 * work end-to-end without GCS — otherwise the whole file primitive is silently
 * disabled locally and the model can't actually save an uploaded file.
 *
 * **Not for production.** Cloud Run always sets `GCS_FILES_BUCKET`; the boot
 * wiring only reaches for this off Cloud Run (no `K_SERVICE`), so a
 * misconfigured prod fails safe instead of writing to ephemeral disk.
 */

import { promises as fs, createWriteStream } from 'node:fs'
import { PassThrough, type Writable } from 'node:stream'
import * as path from 'node:path'
import type { GcsBlob, GcsFilesClient, GcsObjectMetadata } from './gcs-client.js'

const DEFAULT_META: GcsObjectMetadata = { workspaceId: '', mime: 'application/octet-stream' }

export function createLocalFilesClient(opts: { baseDir: string }): GcsFilesClient {
  const { baseDir } = opts
  const blobPath = (key: string): string => path.join(baseDir, key)
  const metaPath = (key: string): string => `${path.join(baseDir, key)}.meta.json`

  const client: GcsFilesClient = {
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

    async deleteBlob(key) {
      await fs.rm(blobPath(key), { force: true })
      await fs.rm(metaPath(key), { force: true })
    },

    async signedReadUrl(key) {
      // No signing locally. The workspace-file tools never call this (they read
      // via readBlob); it exists only to satisfy the interface for the
      // doc-block preview path, which is GCS-only anyway.
      return `file://${blobPath(key)}`
    },

    async signedWriteUrl(key) {
      // No signed PUT locally — the recording upload flow is GCS-only. Returned
      // for interface parity; a local caller should writeBlob directly instead.
      return `file://${blobPath(key)}`
    },

    writeStream(key, opts): Writable {
      // A PassThrough the caller pipes into; we set up the real file sink (and
      // meta sidecar) asynchronously and forward into it. Dev/test only.
      const p = blobPath(key)
      const pass = new PassThrough()
      void (async () => {
        await fs.mkdir(path.dirname(p), { recursive: true })
        await fs.writeFile(metaPath(key), JSON.stringify(opts.metadata ?? { workspaceId: '', mime: opts.mime }))
        const out = createWriteStream(p)
        out.on('error', (e) => pass.destroy(e))
        pass.pipe(out)
      })().catch((e) => pass.destroy(e))
      return pass
    },
  }

  return client
}
