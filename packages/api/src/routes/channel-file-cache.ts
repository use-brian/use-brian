// [COMP:api/channel-file-cache] — inbound channel image → transient `file_cache`
// row, so the turn's `<attached_file id="…">` tag gives the model a promotable
// reference (`saveFileToBrain`) when the user asks to keep or reuse the photo.
//
// Deliberately on-request: nothing durable is written here — the cache row
// expires in 7 days (file-cache reaper). This is the image counterpart of the
// AUTOMATIC channel-document intake (documents/recordings auto-persist; images
// do not, per the 2026-07-06 product decision). See
// docs/architecture/engine/file-handling.md → "Save-on-request".

import type { FileStore } from '@use-brian/core/files/types.js'
import type { ContentBlock } from '@use-brian/agent-runtime/providers/types.js'
import type { IncomingFile } from '@use-brian/channels'
import { findOrCreateSession } from '../db/sessions.js'

export type CacheInboundImageInput = {
  fileStore: FileStore
  /** Session key — MUST match what the channel pipeline passes to
   *  `findOrCreateSession` for this turn (telegram official: the linked
   *  user id; telegram BYO: the channel user id). */
  channelType: string
  channelId: string
  userId: string
  assistant: { id: string; workspaceId?: string | null }
  file: { buffer: Buffer; mime: string; fileName: string }
}

/**
 * Cache an inbound channel image into `file_cache` and return the cache id
 * (or null). Additive by contract: a non-image mime, a workspace-less
 * assistant, or any failure returns null and the turn proceeds with the
 * pre-existing block-only behavior — this must never block a message.
 *
 * The row is stamped workspace-shared (`workspaceId` set, no user/assistant
 * pin): a photo posted into a channel the assistant reads is workspace-visible,
 * and the promotion-time tool context may carry a different identity (BYO
 * channel user vs owner) than the receive-time one.
 */
export async function cacheInboundImage(input: CacheInboundImageInput): Promise<string | null> {
  if (!input.file.mime.toLowerCase().startsWith('image/')) return null
  const workspaceId = input.assistant.workspaceId
  if (!workspaceId) return null
  try {
    // Idempotent pre-resolve of the turn's own session (same key the pipeline
    // uses) — `file_cache.session_id` is NOT NULL.
    const session = await findOrCreateSession({
      assistantId: input.assistant.id,
      userId: input.userId,
      channelType: input.channelType,
      channelId: input.channelId,
    })
    const cached = await input.fileStore.cache({
      sessionId: session.id,
      fileName: input.file.fileName,
      mimeType: input.file.mime,
      // Same data-URL format the web upload route stores and
      // `saveFileToBrain` / the chat attach seam decode.
      content: `data:${input.file.mime};base64,${input.file.buffer.toString('base64')}`,
      sizeBytes: input.file.buffer.length,
      workspaceId,
    })
    return cached.id
  } catch (err) {
    console.error('[channel-file-cache] image cache failed (turn continues without save-on-request):', err)
    return null
  }
}

/**
 * Cache an inbound image AND render the `<attached_file id="…">` envelope for
 * it — the whole save-on-request seam in one call.
 *
 * The envelope matches the one `buildFileContentBlocks` stamps in web chat.
 *
 * Returns `''` when there is nothing to reference (non-image, no store,
 * workspace-less assistant, or a cache failure) — every caller can append
 * unconditionally and keep the pre-existing block-only turn on any miss.
 */
export async function cacheInboundImageTag(input: CacheInboundImageInput): Promise<string> {
  const id = await cacheInboundImage(input)
  if (!id) return ''
  return `<attached_file id="${id}" name="${input.file.fileName}" type="${input.file.mime}">[image]</attached_file>`
}

/** Convert files in provider order after the route attempts each download. */
export async function buildDownloadedChannelContent(
  text: string,
  downloads: readonly (Pick<IncomingFile, 'name' | 'mimeType'> & { buffer: Buffer } | null)[],
  context: Omit<CacheInboundImageInput, 'fileStore' | 'file'> & { fileStore?: FileStore },
): Promise<ContentBlock[]> {
  const blocks: ContentBlock[] = text.trim() ? [{ type: 'text', text }] : []
  const { fileStore, ...session } = context
  for (const file of downloads) {
    if (!file) continue
    const { buffer, mimeType, name } = file
    if (mimeType.startsWith('image/') || mimeType === 'application/pdf') {
      blocks.push({ type: 'image', mimeType, data: buffer.toString('base64') })
      if (fileStore) {
        const tag = await cacheInboundImageTag({
          ...session,
          fileStore,
          file: { buffer, mime: mimeType, fileName: name },
        })
        if (tag) blocks.push({ type: 'text', text: tag })
      }
      continue
    }
    const { parseFileContent } = await import('@use-brian/core/files/parsers.js')
    const parsed = await parseFileContent(buffer, mimeType, name)
    if (parsed.mediaMimeType === 'application/pdf' || parsed.mediaMimeType?.startsWith('image/')) {
      blocks.push({ type: 'image', mimeType: parsed.mediaMimeType, data: buffer.toString('base64') })
    } else {
      blocks.push({
        type: 'text',
        text: `<attached_file name="${name}" type="${mimeType}">\n${parsed.text}\n</attached_file>`,
      })
    }
  }
  return blocks
}
