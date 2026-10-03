import type { S3ClientOptions } from './s3-client.js'

/** Deployment defaults only; workspace connectors always supply their own keys. */
export type S3Env = {
  S3_FILES_BUCKET?: string
  S3_REGION?: string
  S3_ENDPOINT?: string
  S3_FORCE_PATH_STYLE?: string
  S3_ACCESS_KEY_ID?: string
  S3_SECRET_ACCESS_KEY?: string
  S3_SESSION_TOKEN?: string
}

export function s3OptionsFromEnv(env: S3Env): S3ClientOptions | null {
  const bucket = env.S3_FILES_BUCKET?.trim()
  const configured = [env.S3_REGION, env.S3_ENDPOINT, env.S3_FORCE_PATH_STYLE,
    env.S3_ACCESS_KEY_ID, env.S3_SECRET_ACCESS_KEY, env.S3_SESSION_TOKEN].some(value => value?.trim())
  if (!bucket) {
    if (configured) throw new Error('[files] S3_FILES_BUCKET is required when S3 storage options are set')
    return null
  }
  // Accept conventional S3-compatible bucket names, never paths or URLs.
  if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) {
    throw new Error('[files] S3_FILES_BUCKET must be a valid bucket name')
  }
  const endpoint = env.S3_ENDPOINT?.trim() || undefined
  if (endpoint) {
    let url: URL
    try { url = new URL(endpoint) } catch { throw new Error('[files] S3_ENDPOINT must be an HTTP(S) URL') }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw new Error('[files] S3_ENDPOINT must be an HTTP(S) URL without credentials, query, or fragment')
    }
  }
  const pathStyle = env.S3_FORCE_PATH_STYLE?.trim()
  if (pathStyle && pathStyle !== 'true' && pathStyle !== 'false') {
    throw new Error('[files] S3_FORCE_PATH_STYLE must be true or false')
  }
  const accessKeyId = env.S3_ACCESS_KEY_ID?.trim()
  const secretAccessKey = env.S3_SECRET_ACCESS_KEY?.trim()
  const sessionToken = env.S3_SESSION_TOKEN?.trim()
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey) || (sessionToken && !accessKeyId)) {
    throw new Error('[files] S3_ACCESS_KEY_ID and S3_SECRET_ACCESS_KEY must be set together; S3_SESSION_TOKEN requires both')
  }
  return {
    bucket,
    region: env.S3_REGION?.trim() || undefined,
    endpoint,
    forcePathStyle: pathStyle ? pathStyle === 'true' : undefined,
    ...(accessKeyId && secretAccessKey ? {
      credentials: { accessKeyId, secretAccessKey, ...(sessionToken ? { sessionToken } : {}) },
    } : {}),
  }
}
