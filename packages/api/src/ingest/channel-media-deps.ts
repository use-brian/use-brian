// [COMP:brain/open-channel-media-deps] - open universal intake dependencies.

import { parseFileContent, type FilesApi, type FilesContext } from '@use-brian/core'
import { createRecording } from '../db/recordings-store.js'
import { createEpisode } from '../db/episodes-store.js'
import { countRecentRecordingJobs, enqueueRecordingJob } from '../db/recording-jobs-store.js'
import { countRecentFileIngestJobs, enqueueFileIngestJob } from '../db/file-ingest-jobs-store.js'
import type { FilesClientResolver } from '../files/files-api.js'
import type { BrainEpisodeIngestor } from '../ingest-port.js'
import type { ChannelMediaIntakeDeps } from './channel-media-intake.js'

export const CHANNEL_DOCUMENT_PARSE_MAX_BYTES = 25 * 1024 * 1024

export function createOpenChannelMediaIntakeDeps(infra: {
  filesResolver: FilesClientResolver
  filesApi?: FilesApi
  brainIngestor?: BrainEpisodeIngestor
}): ChannelMediaIntakeDeps {
  return {
    createEpisode,
    createRecording,
    enqueueRecordingJob,
    checkQuota: async (ref) => {
      const since = Date.now() - 24 * 60 * 60 * 1000
      const [recordings, files] = await Promise.all([
        countRecentRecordingJobs(ref.workspaceId, since),
        countRecentFileIngestJobs(ref.workspaceId, since),
      ])
      return recordings + files < 50 ? { ok: true } : { ok: false, reason: 'daily_limit' }
    },
    ingestDocument: infra.brainIngestor
      ? async ({ gcsKey, storageUri, mime, fileName, sizeBytes, workspaceId, assistantId, actingUserId, sensitivity }) => {
          if (!assistantId) return { status: 'skipped_no_assistant' }
          if (sizeBytes != null && sizeBytes > CHANNEL_DOCUMENT_PARSE_MAX_BYTES) {
            return {
              status: 'too_large',
              sizeBytes,
              limitBytes: CHANNEL_DOCUMENT_PARSE_MAX_BYTES,
            }
          }
          const storage = storageUri
            ? await infra.filesResolver.forUri(workspaceId, storageUri)
            : (await infra.filesResolver.forWorkspace(workspaceId)).gcs
          const blob = await storage.readBlob(gcsKey)
          if (!blob) return { status: 'empty' }
          if (blob.bytes.length > CHANNEL_DOCUMENT_PARSE_MAX_BYTES) {
            return {
              status: 'too_large',
              sizeBytes: blob.bytes.length,
              limitBytes: CHANNEL_DOCUMENT_PARSE_MAX_BYTES,
            }
          }
          const { text, summary } = await parseFileContent(blob.bytes, mime, fileName ?? 'document')
          if (!text.trim()) return { status: 'empty' }

          if (infra.filesApi) {
            const ctx: FilesContext = { workspaceId, userId: actingUserId, assistantId }
            const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
            const safeName = (fileName ?? 'document').replace(/[^\p{L}\p{N}._-]+/gu, '-').slice(0, 120) || 'document'
            const stored = await infra.filesApi.writeBytes(ctx, {
              path: `/uploads/channel/${stamp}-${safeName}`,
              bytes: blob.bytes,
              mime,
              title: fileName ?? 'document',
              ...(summary ? { summary } : {}),
              sensitivity: sensitivity === 'private' || sensitivity === 'secret' ? 'confidential' : sensitivity,
            })
            if (stored.ok) {
              await enqueueFileIngestJob({
                fileId: stored.value.id,
                workspaceId,
                actingUserId,
                assistantId,
                sourceLabel: 'channel-document',
              })
              return { status: 'accepted', episodeId: null, fileId: stored.value.id, path: stored.value.path }
            }
            if (stored.error.kind === 'quota_exceeded') return { status: 'storage_quota' }
          }

          await infra.brainIngestor!({
            workspaceId,
            userId: actingUserId,
            assistantId,
            content: text,
            occurredAt: new Date(),
            sourceLabel: 'channel-document',
            sensitivity,
          })
          return { status: 'accepted', episodeId: null }
        }
      : undefined,
  }
}
