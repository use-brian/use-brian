// [COMP:channels/open-host-factory] - OSS channel media composition.

import { randomUUID } from 'node:crypto'
import type { BootContext, ChannelHostHooks } from './boot.js'
import { buildStorageKey, buildStorageUri } from './files/gcs-client.js'
import { acquireChannelMedia } from './ingest/channel-media-acquirer.js'
import { CHANNEL_DOCUMENT_PARSE_MAX_BYTES, createOpenChannelMediaIntakeDeps } from './ingest/channel-media-deps.js'
import { classifyMedia } from './ingest/channel-media-intake.js'

export function buildOpenChannelHosts(ctx: BootContext): ChannelHostHooks {
  if (!ctx.filesResolver) return {}
  const intakeDeps = createOpenChannelMediaIntakeDeps({
    filesResolver: ctx.filesResolver,
    ...(ctx.filesApi ? { filesApi: ctx.filesApi } : {}),
    ...(ctx.brainEpisodeIngestor ? { brainIngestor: ctx.brainEpisodeIngestor } : {}),
  })

  const buildIntake = (channel: 'slack' | 'discord' | 'telegram') =>
    async (input: {
      source: { url: string; headers?: Record<string, string> }
      mime?: string
      fileName: string | null
      sizeBytes: number | null
      sender: { id: string; name: string | null }
      conversationId: string
      workspaceId: string
      assistantId: string | null
      actingUserId: string
    }) => {
      const fileId = `channel-media/${randomUUID()}`
      const resolved = await ctx.filesResolver!.forWorkspace(input.workspaceId)
      return acquireChannelMedia({
        source: input.source,
        key: buildStorageKey(input.workspaceId, fileId),
        ref: {
          channel,
          ...(input.mime ? { mime: input.mime } : {}),
          fileName: input.fileName,
          sender: input.sender,
          conversationId: input.conversationId,
          workspaceId: input.workspaceId,
          assistantId: input.assistantId,
          actingUserId: input.actingUserId,
          storageUri: buildStorageUri(resolved.bucket, input.workspaceId, fileId, resolved.uriScheme),
        },
        storage: resolved.gcs,
        intakeDeps,
        ...(input.mime && classifyMedia(input.mime) === 'document'
          ? { maxBytes: CHANNEL_DOCUMENT_PARSE_MAX_BYTES }
          : {}),
      })
    }

  return {
    slackIngestChannelMediaRef: buildIntake('slack') as NonNullable<ChannelHostHooks['slackIngestChannelMediaRef']>,
    discordIngestChannelMediaRef: buildIntake('discord') as NonNullable<ChannelHostHooks['discordIngestChannelMediaRef']>,
    telegramIngestChannelMediaRef: buildIntake('telegram'),
  }
}
