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
import { buildTool, type Tool } from '../tools/types.js'
import { toolFailure } from '../tools/tool-failure.js'
import type { FilesApi } from './api.js'
import type { WorkspaceFile } from './types.js'
import {
  ctxFor as workspaceFilesCtxFor,
  errorMessage as workspaceFilesErrorMessage,
  workspaceGate as workspaceFilesGate,
  policyBlockGate as workspaceFilesPolicyBlockGate,
  policyConfirmation as workspaceFilesPolicyConfirmation,
  type ResolveFileToolPolicy,
} from './tool-helpers.js'

export const CHAT_ARCHIVE_SAVE_MEDIA_TOOL = {
  name: 'saveChatMedia',
  description:
    'Save a stored photo, voice note, video, or document from archived chat history into workspace files. ' +
    'Find the message with searchChatHistory and use its exact media_sha256. ' +
    'Use the returned fileId with fileReadBytes for an exact download, or sendFile for native chat delivery. ' +
    'Only stored media can be saved; a metadata-only record without a digest cannot supply the original bytes.',
  classification: 'write',
  defaultPolicy: 'allow',
} as const

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

/**
 * The workspace path a digest always lands on.
 *
 * Content-addressed, deliberately: the archive already stores one blob per
 * distinct file, so an image forwarded through ten chats is ten messages over
 * one set of bytes. A path keyed on anything else — a timestamp, a message id —
 * re-inflates that fan-out on this side of the boundary, and the write path's
 * own "does this path exist" check can never fire because every path it is
 * handed is novel by construction. Keying on the digest is what lets that
 * existing check do the deduplication.
 *
 * No extension. It would have to be derived from the MIME type, which lives on
 * the archive's asset row and is therefore not known until the bytes have been
 * fetched — which is the transfer this lookup exists to avoid. One digest, one
 * path, one `stat`. Type is carried by the file's own `mime` column, and the
 * human label by its `title`, which is what the Files view shows; paths were
 * never the UI.
 */
function archivePathFor(sha256: string): string {
  return `/uploads/chat-archive/${sha256}`
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

/**
 * One shape for "this file is in the workspace", whether this call put it
 * there or found it already there. The caller asked for a usable `fileId` and
 * gets one either way; distinguishing the two would only invite the model to
 * narrate a difference the user does not have.
 */
function savedResult(file: WorkspaceFile, mime: string, programmatic: boolean): {
  fileId: string
  path: string
  filename: string
  mime: string
  sizeBytes: number
  next: string
} {
  return {
    fileId: file.id,
    path: file.path,
    // The path is the digest, so the readable name lives in the title.
    filename: file.title ?? file.name,
    mime: file.mime || mime,
    sizeBytes: file.sizeBytes,
    next: programmatic
      ? 'To download the original bytes (up to 10 MiB), call fileReadBytes with file="' + file.id + '" and decode its base64 in client code. Larger files can be downloaded in the authenticated Files UI.'
      :
      'To deliver it in this chat, call sendFile with file="' + file.id + '". ' +
      'To read or analyze its contents, call ingestFile with fileId="' + file.id + '", ' +
      'relay the required confirmation to the user, and continue only after explicit approval.',
  }
}

export type SaveChatMediaDeps = {
  client: {
    downloadMedia(input: { ownerUserId: string; sha256: string; maxBytes: number }): Promise<{ bytes: Buffer; mime: string }>
  }
  filesApi: FilesApi
  resolvePolicy?: ResolveFileToolPolicy
}

export function createSaveChatMediaTool(deps: SaveChatMediaDeps): Tool {
  return buildTool({
    name: 'saveChatMedia',
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
    resolveConfirmation: workspaceFilesPolicyConfirmation(deps.resolvePolicy, 'saveChatMedia'),
    // A large voice note or document over loopback still lands well inside
    // this; the store serves from local disk.
    timeoutMs: 60_000,
    async execute(input, context) {
      const gate = workspaceFilesGate(context.workspaceId)
      if (gate) return gate
      const policyGate = await workspaceFilesPolicyBlockGate(deps.resolvePolicy, 'saveChatMedia', context)
      if (policyGate) return policyGate
      const digest = input.sha256.toLowerCase()
      const filesCtx = workspaceFilesCtxFor(context)
      const programmatic = context.channelType === 'programmatic' || context.programmaticPrincipal !== undefined
      try {
        // Saved once, not once per request. Metadata only, and it runs BEFORE
        // the transfer: asking again for a file already in the workspace should
        // move no bytes at all. A hit is success, not a conflict — the caller
        // wanted it present, and it is.
        const path = archivePathFor(digest)
        const existing = await deps.filesApi.stat(filesCtx, path)
        if (existing.ok) return { data: savedResult(existing.value, existing.value.mime, programmatic) }

        const media = await deps.client.downloadMedia({
          ownerUserId: context.userId,
          sha256: digest,
          maxBytes: MAX_SAVE_CHAT_MEDIA_BYTES,
        })
        const name = safeFileName(input.filename, media.mime, digest)
        const stored = await deps.filesApi.writeBytes(filesCtx, {
          path,
          bytes: media.bytes,
          mime: media.mime,
          title: input.title ?? name,
          // Personal chat media: internal by default, same stance as email
          // attachments — `sendFile`'s sensitivity gate stays the authority
          // for what may leave the workspace.
          sensitivity: 'internal',
        })
        if (!stored.ok) {
          // A concurrent save of the same digest raced us to this path. Both
          // callers wanted the same bytes there and they are: report the
          // winner rather than an error neither user caused.
          if (stored.error.kind === 'conflict') {
            const raced = await deps.filesApi.stat(filesCtx, path)
            if (raced.ok) return { data: savedResult(raced.value, media.mime, programmatic) }
          }
          return { data: workspaceFilesErrorMessage(stored.error), isError: true }
        }
        const file = stored.value
        return { data: savedResult(file, media.mime, programmatic) }
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
