/**
 * Staging for attachments on live inbound channel messages.
 *
 * Replaces the platform-side media service. The bytes go to the archive now, so
 * this is a thin adapter that keeps the call shape the channel routes already
 * use while the storage moves behind it.
 *
 * [COMP:integrations/chat-archive-live-media]
 */

import type { CanonicalIngestMessageV2 } from '@use-brian/shared'
import type { MessageStoreClient, UploadMediaInput } from './message-store-client.js'

export type ChatArchiveMediaKind = 'image' | 'video' | 'voice' | 'file'

/** Per-kind ceilings, mirroring what the archive will accept. */
const BYTE_LIMITS: Record<ChatArchiveMediaKind, number> = {
  image: 32 * 1024 * 1024,
  voice: 128 * 1024 * 1024,
  video: 512 * 1024 * 1024,
  file: 128 * 1024 * 1024,
}

export function mediaByteLimit(kind: ChatArchiveMediaKind): number {
  return BYTE_LIMITS[kind] ?? BYTE_LIMITS.file
}

export type StagedArchiveMedia = {
  assetId: string
  sha256: string
  filename: string
  mime: string
  sizeBytes: number
}

/** Builds the append-contract media reference for a staged attachment. */
export function archiveMediaRef(
  staged: StagedArchiveMedia,
): NonNullable<CanonicalIngestMessageV2['media_ref']> {
  return {
    asset_id: staged.assetId,
    sha256: staged.sha256,
    availability: 'stored',
    filename: staged.filename,
    mime: staged.mime,
    size_bytes: staged.sizeBytes,
  }
}

export type ChatArchiveLiveMedia = {
  storeBuffer(input: Omit<UploadMediaInput, 'bytes'> & { bytes: Buffer }): Promise<StagedArchiveMedia>
}

export function createChatArchiveLiveMedia(client: MessageStoreClient): ChatArchiveLiveMedia {
  return {
    async storeBuffer(input) {
      const limit = mediaByteLimit(input.kind)
      if (input.bytes.length > limit) {
        throw new Error(`chat archive ${input.kind} attachment exceeds ${limit} bytes`)
      }
      const uploaded = await client.uploadMedia(input)
      return {
        assetId: uploaded.asset_id,
        sha256: uploaded.sha256,
        filename: input.filename,
        mime: input.mime,
        sizeBytes: uploaded.size_bytes,
      }
    },
  }
}
