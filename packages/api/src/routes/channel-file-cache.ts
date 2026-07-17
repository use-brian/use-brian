// [COMP:api/channel-file-cache] — inbound channel image → transient `file_cache`
// row, so the turn's `<attached_file id="…">` tag gives the model a promotable
// reference (`saveFileToBrain`) when the user asks to keep or reuse the photo.
//
// Deliberately on-request: nothing durable is written here — the cache row
// expires in 7 days (file-cache reaper). This is the image counterpart of the
// AUTOMATIC channel-document intake (documents/recordings auto-persist; images
// do not, per the 2026-07-06 product decision). See
// docs/architecture/engine/file-handling.md → "Save-on-request".

import type { FileStore } from '@use-brian/core'
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
