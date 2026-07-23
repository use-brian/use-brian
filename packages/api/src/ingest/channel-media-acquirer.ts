// [COMP:brain/channel-media-acquirer] - backend-agnostic URL acquisition for
// channel attachments. The historical GCS name described the first backend;
// the FilesClientResolver now supplies GCS, S3, or local clients through the
// same streaming interface.

import { MediaTooLargeError, streamUrlToGcs, type GcsFilesClient } from '../files/gcs-client.js'
import {
  DEFAULT_CHANNEL_MEDIA_MAX_BYTES,
  ingestChannelMedia,
  type ChannelMediaIntakeDeps,
  type ChannelMediaIntakeResult,
  type ChannelMediaRef,
} from './channel-media-intake.js'

export type ChannelMediaSource = { url: string; headers?: Record<string, string> }

export async function acquireChannelMedia(args: {
  source: ChannelMediaSource
  key: string
  ref: Omit<ChannelMediaRef, 'gcsKey' | 'mime' | 'sizeBytes'> & { mime?: string }
  storage: Pick<GcsFilesClient, 'writeStream' | 'deleteBlob'>
  intakeDeps: ChannelMediaIntakeDeps
  maxBytes?: number
  fetchFn?: typeof fetch
}): Promise<ChannelMediaIntakeResult> {
  try {
    const streamed = await streamUrlToGcs({
      url: args.source.url,
      headers: args.source.headers,
      maxBytes: args.maxBytes ?? DEFAULT_CHANNEL_MEDIA_MAX_BYTES,
      fetchFn: args.fetchFn,
      openWrite: (mime) => args.storage.writeStream(args.key, {
        mime,
        metadata: { workspaceId: args.ref.workspaceId, mime },
      }),
    })
    const result = await ingestChannelMedia({
      ...args.ref,
      gcsKey: args.key,
      mime: args.ref.mime ?? streamed.mime,
      sizeBytes: streamed.bytesWritten,
    }, args.intakeDeps)
    if (result.status !== 'queued' && result.status !== 'pending_confirmation') {
      await args.storage.deleteBlob(args.key).catch(() => {})
    }
    return result
  } catch (err) {
    await args.storage.deleteBlob(args.key).catch(() => {})
    if (err instanceof MediaTooLargeError) return { status: 'rejected', reason: 'too_large' }
    throw err
  }
}
