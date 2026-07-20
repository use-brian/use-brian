/**
 * Validate-on-connect for bring-your-own GCS storage.
 *
 * Before a workspace's BYO binding is marked `connected`, prove the supplied
 * service-account key can actually write/read/delete in the named bucket. A
 * bad key, a wrong bucket, or a missing IAM role fails HERE — at setup — not
 * at the user's first file upload. See docs/plans/byo-google-storage.md §4.
 *
 * The probe round-trips a small object under the reserved `.usebrian/`
 * prefix and deletes it. The credential object is passed straight through to
 * the GCS client and is never referenced by field name or logged.
 */

import { createGcsFilesClient, type GcsServiceAccountCredentials, type GcsFilesClient } from './gcs-client.js'

/** Stable key for the connect-time probe object. */
export const BYO_HEALTHCHECK_KEY = '.usebrian/healthcheck'

export type GcsByoValidateFailureCode =
  | 'invalid_key' // key won't parse / sign (bad PEM, malformed JSON)
  | 'permission_denied' // 401/403 — SA lacks the role on the bucket
  | 'bucket_unreachable' // 404 / DNS — bucket missing or wrong project
  | 'unknown'

export type GcsByoValidateResult =
  | { ok: true }
  | { ok: false; code: GcsByoValidateFailureCode; message: string }

export type ValidateGcsByoParams = {
  credentials: GcsServiceAccountCredentials
  bucket: string
  projectId?: string
}

export type ValidateGcsByoDeps = {
  /** Client factory — overridable in tests with an in-memory fake. */
  createClient?: (opts: { bucket: string; projectId?: string; credentials: GcsServiceAccountCredentials }) => GcsFilesClient
}

function classifyError(err: unknown): { code: GcsByoValidateFailureCode; message: string } {
  const code = (err && typeof err === 'object' && 'code' in err ? (err as { code: unknown }).code : undefined)
  const raw = err instanceof Error ? err.message : String(err)
  // Strip anything that could echo key material into a stored/logged message.
  const message = raw.slice(0, 200)
  if (code === 401 || code === 403) return { code: 'permission_denied', message }
  if (code === 404) return { code: 'bucket_unreachable', message }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code: 'bucket_unreachable', message }
  if (/DECODER|PEM|private key|invalid_grant|JWT|signature/i.test(raw)) {
    return { code: 'invalid_key', message }
  }
  return { code: 'unknown', message }
}

/**
 * Round-trip write → read → delete a probe object against the customer
 * bucket with the supplied credentials. Returns a typed result; never throws.
 */
export async function validateGcsByoBinding(
  params: ValidateGcsByoParams,
  deps: ValidateGcsByoDeps = {},
): Promise<GcsByoValidateResult> {
  const make = deps.createClient ?? createGcsFilesClient
  let client: GcsFilesClient
  try {
    client = make({ bucket: params.bucket, projectId: params.projectId, credentials: params.credentials })
  } catch (err) {
    const { code, message } = classifyError(err)
    return { ok: false, code: code === 'unknown' ? 'invalid_key' : code, message }
  }

  const probe = Buffer.from('Use Brian byo storage healthcheck')
  try {
    await client.writeBlob(BYO_HEALTHCHECK_KEY, probe, { workspaceId: 'healthcheck', mime: 'text/plain' })
    const read = await client.readBlob(BYO_HEALTHCHECK_KEY)
    if (!read) {
      return { ok: false, code: 'unknown', message: 'healthcheck object not readable after write' }
    }
    await client.deleteBlob(BYO_HEALTHCHECK_KEY)
    return { ok: true }
  } catch (err) {
    // Best-effort cleanup; ignore failures (the write may not have landed).
    try {
      await client.deleteBlob(BYO_HEALTHCHECK_KEY)
    } catch {
      /* ignore */
    }
    return { ok: false, ...classifyError(err) }
  }
}
