import { describe, expect, it } from 'vitest'
import { createS3FilesClient } from '../s3-client.js'
import { s3OptionsFromEnv } from '../s3-env.js'
import { createSingletonFilesClientResolver } from '../files-api.js'
import { createCachedByoFilesResolver } from '../byo-files-resolver.js'

// Composition coverage without storage IO: SDK clients stay lazy throughout.
describe('deployment-default S3 resolver', () => {
  it('preserves the default bucket and s3 scheme through the workspace resolver', async () => {
    const options = s3OptionsFromEnv({ S3_FILES_BUCKET: 'deployment-files' })!
    const client = createS3FilesClient(options)
    const fallback = createSingletonFilesClientResolver(client, options.bucket, 's3')
    const resolver = createCachedByoFilesResolver({ lookup: async () => null, fallback })
    expect(await resolver.forWorkspace('workspace')).toEqual({
      gcs: client, bucket: 'deployment-files', uriScheme: 's3', byo: false,
    })
    expect(await resolver.forUri('workspace', 's3://deployment-files/workspace/file')).toBe(client)
  })

  it('keeps a workspace S3 binding ahead of the deployment default', async () => {
    const client = createS3FilesClient({ bucket: 'deployment-files' })
    const workspaceClient = createS3FilesClient({ bucket: 'workspace-files' })
    const fallback = createSingletonFilesClientResolver(client, 'deployment-files', 's3')
    const resolver = createCachedByoFilesResolver({
      lookup: async () => ({
        kind: 's3', bucket: 'workspace-files',
        credentials: { accessKeyId: 'test-access', secretAccessKey: 'test-secret' },
      }),
      createS3Client: () => workspaceClient,
      fallback,
    })
    expect(await resolver.forWorkspace('workspace')).toEqual({
      gcs: workspaceClient, bucket: 'workspace-files', uriScheme: 's3', byo: true,
    })
    expect(await resolver.forUri('workspace', 's3://workspace-files/workspace/file')).toBe(workspaceClient)
    expect(await resolver.forUri('workspace', 's3://deployment-files/workspace/file')).toBe(client)
  })
})
