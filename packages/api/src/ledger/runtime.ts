/**
 * Ledger runtime — process-wide payload-store resolution.
 *
 * Boot injects the exact files client it already constructed
 * (`initLedgerRuntime`), so the ledger rides the same storage decision as
 * workspace files (GCS on hosted, local disk on self-host, per
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
import { createLedgerPayloadStore, type LedgerPayloadStore } from './payload-store.js'

let injected: LedgerPayloadStore | null = null
let lazy: LedgerPayloadStore | null = null

/** Called from boot with the files client the app already selected. */
export function initLedgerRuntime(files: GcsFilesClient): void {
  injected = createLedgerPayloadStore(files)
}

function resolveFromEnv(): LedgerPayloadStore {
  const bucket = process.env.GCS_FILES_BUCKET?.trim()
  if (bucket) {
    return createLedgerPayloadStore(
      createGcsFilesClient({ bucket, projectId: process.env.GOOGLE_CLOUD_PROJECT }),
    )
  }
  const configuredLocalDir = process.env.LOCAL_FILES_DIR?.trim()
  // Mirror bootOpenApi: on Cloud Run (K_SERVICE) without an explicit local
  // dir there is no usable disk — recording degrades honestly via throw.
  if (process.env.K_SERVICE && !configuredLocalDir) {
    return {
      put: async () => {
        throw new Error('no ledger storage backend (GCS_FILES_BUCKET unset on Cloud Run)')
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
