/**
 * Ledger runtime — process-wide payload-store resolution.
 *
 * Boot injects the exact files client it already constructed
 * (`initLedgerRuntime`), so the ledger rides the same storage decision as
 * workspace files (GCS, Azure, S3, or local disk, per
 * `bootOpenApi`'s selection). Lanes that run without bootOpenApi (the
 * workers service) fall back to the same env-derived selection lazily.
 *
 * When no storage backend resolves at all, `put` throws — the recorder's
 * serialized chain catches it and logs ONCE ("recording degraded"), and
 * the turn proceeds. Honest failure, never a silent no-op at the call
 * site (that would hollow out `invariants/turn-ledger-lane-coverage`).
 *
 * Spec: docs/architecture/engine/turn-ledger.md
 * [COMP:api/turn-ledger-recorder]
 */

import { createGcsFilesClient, type GcsFilesClient } from '../files/gcs-client.js'
import { createLocalFilesClient, resolveLocalFilesBaseDir } from '../files/local-files-client.js'
import { azureBlobOptionsFromEnv, createAzureBlobFilesClient } from '../files/azure-blob-client.js'
import { createS3FilesClient } from '../files/s3-client.js'
import { s3OptionsFromEnv } from '../files/s3-env.js'
import { createLedgerPayloadStore, type LedgerPayloadStore } from './payload-store.js'

let injected: LedgerPayloadStore | null = null
let lazy: LedgerPayloadStore | null = null

/** Called from boot with the files client the app already selected. */
export function initLedgerRuntime(files: GcsFilesClient): void {
  injected = createLedgerPayloadStore(files)
}

function resolveFromEnv(): LedgerPayloadStore {
  const bucket = process.env.GCS_FILES_BUCKET?.trim()
  if ([bucket, process.env.AZURE_BLOB_CONTAINER?.trim(), process.env.S3_FILES_BUCKET?.trim()].filter(Boolean).length > 1) {
    throw new Error('[files] GCS_FILES_BUCKET, AZURE_BLOB_CONTAINER, and S3_FILES_BUCKET are mutually exclusive — pick one app-default blob store')
  }
  const azure = azureBlobOptionsFromEnv(process.env)
  const s3 = s3OptionsFromEnv(process.env)
  if (bucket) {
    return createLedgerPayloadStore(
      createGcsFilesClient({ bucket, projectId: process.env.GOOGLE_CLOUD_PROJECT }),
    )
  }
  if (azure) return createLedgerPayloadStore(createAzureBlobFilesClient(azure))
  if (s3) return createLedgerPayloadStore(createS3FilesClient(s3))
  const configuredLocalDir = process.env.LOCAL_FILES_DIR?.trim()
  // Mirror bootOpenApi: on Cloud Run (K_SERVICE) without an explicit local
  // dir there is no usable disk — recording degrades honestly via throw.
  if (process.env.K_SERVICE && !configuredLocalDir) {
    return {
      put: async () => {
        throw new Error('no ledger storage backend (no cloud default or LOCAL_FILES_DIR configured on Cloud Run)')
      },
      get: async () => null,
      erase: async () => 0,
    }
  }
  const secret = process.env.JWT_SECRET ?? 'ledger-local'
  return createLedgerPayloadStore(
    createLocalFilesClient({
      baseDir: resolveLocalFilesBaseDir(configuredLocalDir),
      apiUrl: process.env.LOCAL_FILES_PUBLIC_URL?.trim() || process.env.API_URL || 'http://localhost:3001',
      signingSecret: secret,
    }),
  )
}

export function getLedgerPayloadStore(): LedgerPayloadStore {
  if (injected) return injected
  if (!lazy) lazy = resolveFromEnv()
  return lazy
}

/** Test seam. */
export function resetLedgerRuntimeForTests(): void {
  injected = null
  lazy = null
}
