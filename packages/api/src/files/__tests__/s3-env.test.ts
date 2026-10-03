import { describe, expect, it } from 'vitest'
import { s3OptionsFromEnv, type S3Env } from '../s3-env.js'

describe('deployment S3 configuration', () => {
  it('is disabled unless configured', () => {
    expect(s3OptionsFromEnv({})).toBeNull()
    expect(s3OptionsFromEnv({ S3_FILES_BUCKET: ' ' })).toBeNull()
  })
  it('supports AWS default credentials and region', () => {
    expect(s3OptionsFromEnv({ S3_FILES_BUCKET: ' brian-files ' })).toEqual({
      bucket: 'brian-files', region: undefined, endpoint: undefined, forcePathStyle: undefined,
    })
  })
  it('supports R2 with explicit keys and a false path-style override', () => {
    expect(s3OptionsFromEnv({ S3_FILES_BUCKET: 'brian-files', S3_REGION: 'auto',
      S3_ENDPOINT: 'https://account.r2.cloudflarestorage.com', S3_FORCE_PATH_STYLE: 'false',
      S3_ACCESS_KEY_ID: 'synthetic-id', S3_SECRET_ACCESS_KEY: 'synthetic-secret',
    })).toEqual({ bucket: 'brian-files', region: 'auto', endpoint: 'https://account.r2.cloudflarestorage.com',
      forcePathStyle: false, credentials: { accessKeyId: 'synthetic-id', secretAccessKey: 'synthetic-secret' },
    })
  })
  it('allows HTTP endpoints for self-hosted MinIO', () => {
    expect(s3OptionsFromEnv({ S3_FILES_BUCKET: 'brian-files', S3_ENDPOINT: 'http://localhost:9000' })?.endpoint)
      .toBe('http://localhost:9000')
  })
  it.each<S3Env>([
    { S3_ENDPOINT: 'https://storage.example.com' },
    { S3_ACCESS_KEY_ID: 'synthetic-id' },
    { S3_SECRET_ACCESS_KEY: 'synthetic-secret' },
    { S3_SESSION_TOKEN: 'synthetic-token' },
    { S3_FORCE_PATH_STYLE: 'false' },
  ])('rejects incomplete config instead of falling back to local disk: %j', env => {
    expect(() => s3OptionsFromEnv(env)).toThrow('S3_FILES_BUCKET')
  })
  it.each<S3Env>([
    { S3_ACCESS_KEY_ID: 'synthetic-id' }, { S3_SECRET_ACCESS_KEY: 'synthetic-secret' },
    { S3_SESSION_TOKEN: 'synthetic-token' },
  ])('rejects partial credentials: %j', env => {
    expect(() => s3OptionsFromEnv({ S3_FILES_BUCKET: 'brian-files', ...env })).toThrow('must be set together')
  })
  it.each(['s3://bucket', 'not a URL', 'https://user:secret@example.com', 'https://example.com?secret=value', 'https://example.com#fragment'])('rejects unsafe endpoints without echoing them', endpoint => {
    expect(() => s3OptionsFromEnv({ S3_FILES_BUCKET: 'brian-files', S3_ENDPOINT: endpoint })).toThrow(/S3_ENDPOINT must be/)
    try { s3OptionsFromEnv({ S3_FILES_BUCKET: 'brian-files', S3_ENDPOINT: endpoint }) } catch (error) {
      expect((error as Error).message).not.toContain(endpoint)
    }
  })
  it.each(['s3://bucket', 'bucket/path', 'ab', 'bad..bucket', 'BadBucket'])('rejects invalid buckets', bucket => {
    expect(() => s3OptionsFromEnv({ S3_FILES_BUCKET: bucket })).toThrow('valid bucket name')
  })
  it('rejects misspelled booleans', () => {
    expect(() => s3OptionsFromEnv({ S3_FILES_BUCKET: 'brian-files', S3_FORCE_PATH_STYLE: 'yes' })).toThrow('true or false')
  })
})
