/**
 * Validate-on-connect for bring-your-own S3-compatible storage — the sibling
 * of `gcs-byo-validate.ts`.
 *
 * Before a workspace's BYO binding is marked `connected`, prove the supplied
 * access-key/secret-key pair can actually write/read/delete in the named
 * bucket. Bad keys, a wrong bucket, a wrong endpoint, or a missing policy fail
 * HERE — at setup — not at the user's first file upload. See
 * docs/plans/byo-s3-storage.md §4.
 *
 * The probe round-trips a small object under the reserved `.sidanclaw/`
 * prefix and deletes it. The credential object is passed straight through to
 * the S3 client and is never referenced by field name or logged.
 */

import { createS3FilesClient, type S3Credentials } from './s3-client.js'
import type { GcsFilesClient } from './gcs-client.js'

/** Stable key for the connect-time probe object. */
export const S3_BYO_HEALTHCHECK_KEY = '.sidanclaw/healthcheck'

export type S3ByoValidateFailureCode =
  | 'invalid_key' // access key / secret rejected (signature / auth)
  | 'permission_denied' // 401/403 — the key lacks the policy on the bucket
  | 'bucket_unreachable' // 404 / DNS — bucket missing, wrong region, or wrong endpoint
  | 'unknown'

export type S3ByoValidateResult =
  | { ok: true }
  | { ok: false; code: S3ByoValidateFailureCode; message: string }

export type ValidateS3ByoParams = {
  credentials: S3Credentials
  bucket: string
  region?: string
  endpoint?: string
  forcePathStyle?: boolean
}

export type ValidateS3ByoDeps = {
  /** Client factory — overridable in tests with an in-memory fake. */
  createClient?: (opts: {
    bucket: string
    region?: string
    endpoint?: string
    forcePathStyle?: boolean
    credentials: S3Credentials
  }) => GcsFilesClient
}

function classifyError(err: unknown): { code: S3ByoValidateFailureCode; message: string } {
  const e = (err && typeof err === 'object' ? (err as Record<string, unknown>) : {})
  const name = typeof e.name === 'string' ? e.name : ''
  const s3Code = typeof e.Code === 'string' ? e.Code : ''
  const http =
    e.$metadata && typeof e.$metadata === 'object'
      ? (e.$metadata as { httpStatusCode?: number }).httpStatusCode
      : undefined
  const nodeCode = typeof e.code === 'string' ? e.code : ''
  const raw = err instanceof Error ? err.message : String(err)
  // Strip anything that could echo key material into a stored/logged message.
  const message = raw.slice(0, 200)

  // Bad-key checks run FIRST: AWS returns HTTP 403 for both a rejected key
  // (SignatureDoesNotMatch / InvalidAccessKeyId) and a valid-but-unauthorized
  // key (AccessDenied), so the specific bad-key codes must be caught before the
  // generic 403 → permission_denied fallback.
  if (
    name === 'SignatureDoesNotMatch' ||
    s3Code === 'SignatureDoesNotMatch' ||
    name === 'InvalidAccessKeyId' ||
    s3Code === 'InvalidAccessKeyId' ||
    name === 'TokenRefreshRequired' ||
    /signature does not match|invalid.?access.?key/i.test(raw)
  ) {
    return { code: 'invalid_key', message }
  }
  if (http === 401 || http === 403 || name === 'AccessDenied' || s3Code === 'AccessDenied') {
    return { code: 'permission_denied', message }
  }
  if (
    http === 404 ||
    name === 'NoSuchBucket' ||
    s3Code === 'NoSuchBucket' ||
    name === 'NotFound' ||
    nodeCode === 'ENOTFOUND' ||
    nodeCode === 'EAI_AGAIN' ||
    nodeCode === 'ECONNREFUSED'
  ) {
    return { code: 'bucket_unreachable', message }
  }
  return { code: 'unknown', message }
}

/**
 * Round-trip write → read → delete a probe object against the customer
 * bucket with the supplied credentials. Returns a typed result; never throws.
 */
export async function validateS3ByoBinding(
  params: ValidateS3ByoParams,
  deps: ValidateS3ByoDeps = {},
): Promise<S3ByoValidateResult> {
  const make = deps.createClient ?? createS3FilesClient
  let client: GcsFilesClient
  try {
    client = make({
      bucket: params.bucket,
      region: params.region,
      endpoint: params.endpoint,
      forcePathStyle: params.forcePathStyle,
      credentials: params.credentials,
    })
  } catch (err) {
    const { code, message } = classifyError(err)
    return { ok: false, code: code === 'unknown' ? 'invalid_key' : code, message }
  }

  const probe = Buffer.from('sidanclaw byo s3 storage healthcheck')
  try {
    await client.writeBlob(S3_BYO_HEALTHCHECK_KEY, probe, { workspaceId: 'healthcheck', mime: 'text/plain' })
    const read = await client.readBlob(S3_BYO_HEALTHCHECK_KEY)
    if (!read) {
      return { ok: false, code: 'unknown', message: 'healthcheck object not readable after write' }
    }
    await client.deleteBlob(S3_BYO_HEALTHCHECK_KEY)
    return { ok: true }
  } catch (err) {
    // Best-effort cleanup; ignore failures (the write may not have landed).
    try {
      await client.deleteBlob(S3_BYO_HEALTHCHECK_KEY)
    } catch {
      /* ignore */
    }
    return { ok: false, ...classifyError(err) }
  }
}
