/**
 * saveChatMedia — land an archived chat attachment in the workspace file
 * layer, where every delivery surface can reach it.
 *
 * The archive owns the bytes (content-addressed, keyed by sha256) and search
 * hits carry `media_sha256`/`media_mime`, but until now nothing could get the
 * bytes back OUT: "can you send me that file" dead-ended with "the record has
 * no downloadable path". This tool closes the loop the same way
 * `imapSaveAttachment` does for email: fetch from the seam → workspace file →
 * hand the returned `fileId` to `sendFile` for delivery or `ingestFile` for
 * consent-gated semantic reading (or let the user grab it in Files).
 *
 * Owner identity comes from ToolContext, never from the input schema — the
 * store additionally resolves the digest under the owner's row-level
 * security, so a foreign digest is a 404 indistinguishable from a missing one.
 *
 * [COMP:tools/chat-archive-save-media]
 */

import { z } from 'zod'
import {
  buildTool,
  toolFailure,
  workspaceFilesCtxFor,
  workspaceFilesErrorMessage,
  workspaceFilesGate,
  type FilesApi,
  type Tool,
} from '@use-brian/core'
import { CHAT_ARCHIVE_SAVE_MEDIA_TOOL } from './tool-catalog.js'
import type { MessageStoreClient } from './message-store-client.js'

/**
 * Buffered in memory on the way through, so this is deliberately far below
 * the archive's 512 MB video ceiling. Everything a chat delivers day to day
 * (images, voice notes, documents) fits with room to spare.
 */
export const MAX_SAVE_CHAT_MEDIA_BYTES = 128 * 1024 * 1024

const EXTENSION_BY_MIME: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/gif': '.gif',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
  'audio/ogg': '.ogg',
  'audio/mpeg': '.mp3',
  'application/pdf': '.pdf',
}

function safeFileName(raw: string | undefined, mime: string, sha256: string): string {
  const fallback = `chat-media-${sha256.slice(0, 12)}${EXTENSION_BY_MIME[mime] ?? ''}`
  if (!raw) return fallback
  const cleaned = raw
    .replace(/[/\\]/g, '-')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim()
    .slice(0, 160)
  return cleaned || fallback
}

export type SaveChatMediaDeps = {
  client: MessageStoreClient
  filesApi: FilesApi
}

export function createSaveChatMediaTool(deps: SaveChatMediaDeps): Tool {
  return buildTool({
    name: CHAT_ARCHIVE_SAVE_MEDIA_TOOL.name,
    description: CHAT_ARCHIVE_SAVE_MEDIA_TOOL.description,
    requiresCapability: 'files',
    inputSchema: z.object({
      sha256: z
        .string()
        .regex(/^[0-9a-fA-F]{64}$/)
        .describe('The `media_sha256` of a searchChatHistory hit. Identifies the exact stored bytes.'),
      filename: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe('Filename to save under. Defaults to a name derived from the digest and MIME type.'),
      title: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe('Display label for the saved file. Defaults to the filename.'),
    }),
    isConcurrencySafe: false,
    isReadOnly: false,
    requiresConfirmation: false,
    // A large voice note or document over loopback still lands well inside
    // this; the store serves from local disk.
    timeoutMs: 60_000,
    async execute(input, context) {
      const gate = workspaceFilesGate(context.workspaceId)
      if (gate) return gate
      try {
        const media = await deps.client.downloadMedia({
          ownerUserId: context.userId,
          sha256: input.sha256,
          maxBytes: MAX_SAVE_CHAT_MEDIA_BYTES,
        })
        const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
        const name = safeFileName(input.filename, media.mime, input.sha256.toLowerCase())
        const stored = await deps.filesApi.writeBytes(workspaceFilesCtxFor(context), {
          path: `/uploads/chat-archive/${stamp}-${name}`,
          bytes: media.bytes,
          mime: media.mime,
          title: input.title ?? name,
          // Personal chat media: internal by default, same stance as email
          // attachments — `sendFile`'s sensitivity gate stays the authority
          // for what may leave the workspace.
          sensitivity: 'internal',
        })
        if (!stored.ok) return { data: workspaceFilesErrorMessage(stored.error), isError: true }
        const file = stored.value
        return {
          data: {
            fileId: file.id,
            path: file.path,
            filename: name,
            mime: media.mime,
            sizeBytes: file.sizeBytes,
            next:
              'To deliver it in this chat, call sendFile with file="' + file.id + '". ' +
              'To read or analyze its contents, call ingestFile with fileId="' + file.id + '", ' +
              'relay the required confirmation to the user, and continue only after explicit approval.',
          },
        }
      } catch (err) {
        return toolFailure(err, {
          tool: CHAT_ARCHIVE_SAVE_MEDIA_TOOL.name,
          target: `archived media ${input.sha256.slice(0, 12)}…`,
          next:
            'A 404 means the archive holds no stored bytes under this digest for THIS user — re-run searchChatHistory and use the hit\'s exact `media_sha256`; a hit whose media coverage is `missing` or `pending` has no bytes to fetch yet. Never invent a digest.',
        })
      }
    },
  })
}
