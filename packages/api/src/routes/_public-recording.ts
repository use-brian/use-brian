/**
 * The shared page's recording surface, server side. `[COMP:doc/public-recording]`
 *
 * A brief page carries its recording as chrome (player + transcript +
 * clickable `[H:MM:SS]` citations) on the authed surface; this module is what
 * lets the SAME surface render on an anonymously shared page. All three public
 * sources (link token, published id, custom-domain site) call into here after
 * their own share resolution:
 *
 *   - `resolvePublicPageRecording` — page id → the page's recording, via the
 *     page's OWN pointer (`anchor_key` wins over `linked_recording_id`, same
 *     precedence as the doc shell). The recording id is derived server-side
 *     from the page row and NEVER read from client input, so there is no id to
 *     enumerate. Only a `processed` same-workspace recording resolves.
 *   - `publicRecordingSummary` — the neutral projection embedded in the public
 *     page JSON (no file name, no storage keys, no participants).
 *   - `sendPublicRecordingMediaUrl` / `sendPublicRecordingTranscript` — the
 *     route bodies behind `<source>/recording/media-url` and
 *     `<source>/recording/transcript`, shared so the three mounts cannot
 *     drift.
 *
 * AUTHORIZATION POSTURE: the resolved share chain IS the grant — the same
 * stance as the public media route, which serves any image/file block on a
 * shared page with no per-file sensitivity check. The publisher chose to
 * share a page whose brief already quotes the meeting; the recording pointer
 * on that page was set either by synthesis (the page's identity) or by a
 * member the write route RLS-validated. See recordings.md → "The shared page
 * carries the recording too" and `readRecordingRangePublic` for why the
 * transcript read must be system-side.
 */

import type { Request, Response } from 'express'
import { recordingIdFromAnchorKey } from '@use-brian/shared'
import { getPageRecordingPointerSystem } from '../db/saved-views-store.js'
import { getRecordingSystem, type Recording } from '../db/recordings-store.js'
import { readRecordingRangePublic } from '../db/retrieval-store.js'
import type { GcsFilesClient } from '../files/gcs-client.js'

/**
 * Playback-URL TTL — mirrors the authed route's reasoning (recordings.md →
 * "The playback URL"): recordings run to a 3-hour ceiling, so the signed URL
 * must outlive a full listen plus pauses; 6h is short enough that a leaked
 * bearer URL dies the same working day. `expiresAt` is returned so the player
 * refreshes proactively instead of discovering expiry as a 403 mid-scrub.
 */
export const PUBLIC_RECORDING_MEDIA_URL_TTL_SEC = 6 * 60 * 60

/** Max transcript segments one anonymous request may pull (authed parity). */
export const PUBLIC_TRANSCRIPT_PAGE = 200

/**
 * BYO-storage signer seam: a recording carrying a `storage_uri` must be signed
 * by THAT bucket's client — the platform client would mint a URL for the wrong
 * bucket. Absent (OSS default) → the platform `gcs` client signs everything.
 */
export type ResolveRecordingReadClient = (
  workspaceId: string,
  storageUri: string | null | undefined,
) => Promise<Pick<GcsFilesClient, 'signedReadUrl'>>

/** What the public page JSON carries. Deliberately narrow: enough to mount the
 *  player (id keys the client's provider; unguessable and grants nothing on
 *  its own — every public read re-resolves the share chain server-side). */
export type PublicRecordingSummary = {
  recordingId: string
  durationMs: number | null
  truncated: boolean
}

/**
 * The page's recording id from its pointer row. Anchor wins over the manual
 * link — a brief's recording is its identity, the same precedence the doc
 * shell applies (recordings.md). Pure + exported for the unit test.
 */
export function pageRecordingIdOf(pointer: {
  anchorKey: string | null
  linkedRecordingId: string | null
}): string | null {
  return recordingIdFromAnchorKey(pointer.anchorKey) ?? pointer.linkedRecordingId
}

/**
 * The shared page's recording, or null when the page has none / it is not
 * `processed` yet / the pointer crosses workspaces (defense in depth — the
 * manual-link write route already enforces same-workspace).
 */
export async function resolvePublicPageRecording(
  pageId: string,
  workspaceId: string,
): Promise<Recording | null> {
  const pointer = await getPageRecordingPointerSystem(pageId)
  if (!pointer) return null
  const recordingId = pageRecordingIdOf(pointer)
  if (!recordingId) return null
  const rec = await getRecordingSystem(recordingId)
  if (!rec || rec.workspaceId !== workspaceId) return null
  // The public surface is a player + transcript; both are empty before
  // processing finishes, so an in-flight recording renders no chrome at all
  // rather than a broken one (same rule as the recordings board rows).
  if (rec.status !== 'processed') return null
  return rec
}

export function publicRecordingSummary(rec: Recording): PublicRecordingSummary {
  return {
    recordingId: rec.id,
    durationMs: rec.durationMs,
    truncated: rec.truncated,
  }
}

/** Summary-or-null for embedding in a public page response; render failures
 *  must not take the page down, so any error degrades to "no recording". */
export async function publicRecordingSummaryFor(
  pageId: string,
  workspaceId: string,
): Promise<PublicRecordingSummary | null> {
  try {
    const rec = await resolvePublicPageRecording(pageId, workspaceId)
    return rec ? publicRecordingSummary(rec) : null
  } catch (err) {
    console.error('[public-recording] resolve failed:', err)
    return null
  }
}

/**
 * `GET <source>/recording/media-url` — JSON `{url, expiresAt, mime,
 * durationMs}`, the same contract as the authed `/api/recordings/:id/media-url`
 * so the one player provider consumes both. JSON rather than a 302 for the
 * same reason: the `<audio>` element needs a stable src plus a way to re-mint
 * on expiry, and the signed GCS URL honors Range natively.
 */
export async function sendPublicRecordingMediaUrl(
  res: Response,
  args: {
    pageId: string
    workspaceId: string
    gcs: GcsFilesClient | null
    resolveReadClient?: ResolveRecordingReadClient
  },
): Promise<void> {
  const rec = await resolvePublicPageRecording(args.pageId, args.workspaceId)
  if (!rec || !rec.gcsKey || !args.gcs) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  try {
    // The resolver is for the BYO case only (authed-route parity): a platform
    // recording signs with the same blob client the page-media route uses.
    const signer =
      rec.storageUri && args.resolveReadClient
        ? await args.resolveReadClient(rec.workspaceId, rec.storageUri)
        : args.gcs
    const url = await signer.signedReadUrl(rec.gcsKey, PUBLIC_RECORDING_MEDIA_URL_TTL_SEC)
    res.json({
      url,
      expiresAt: new Date(Date.now() + PUBLIC_RECORDING_MEDIA_URL_TTL_SEC * 1000).toISOString(),
      mime: rec.mime,
      durationMs: rec.durationMs,
    })
  } catch (err) {
    console.error('[public-recording] media-url failed:', err)
    res.status(500).json({ error: 'Failed to load media' })
  }
}

/** Clamp an anonymous transcript request to a bounded `[from, to]` window.
 *  Pure + exported for the unit test (authed-route parity: an unbounded
 *  request must not pull a 1000-segment meeting whole). */
export function transcriptWindow(fromRaw: unknown): { from: number; to: number } | null {
  const from = Number(typeof fromRaw === 'string' && fromRaw !== '' ? fromRaw : 0)
  if (!Number.isFinite(from) || from < 0) return null
  const flooredFrom = Math.floor(from)
  return { from: flooredFrom, to: flooredFrom + PUBLIC_TRANSCRIPT_PAGE - 1 }
}

/**
 * `GET <source>/recording/transcript?fromIndex=` — one bounded page of
 * `transcript_segments`, same response shape as the authed transcript route
 * (`{recordingId, fromIndex, toIndex, segments, hasMore}`) so the one
 * transcript pane consumes both.
 */
export async function sendPublicRecordingTranscript(
  req: Request,
  res: Response,
  args: { pageId: string; workspaceId: string },
): Promise<void> {
  const rec = await resolvePublicPageRecording(args.pageId, args.workspaceId)
  if (!rec) {
    res.status(404).json({ error: 'Not found' })
    return
  }
  const window = transcriptWindow(req.query.fromIndex)
  if (!window) {
    res.status(400).json({ error: 'fromIndex must be a non-negative number' })
    return
  }
  try {
    const segments = await readRecordingRangePublic(rec.workspaceId, rec.id, {
      fromIndex: window.from,
      toIndex: window.to,
    })
    res.json({
      recordingId: rec.id,
      fromIndex: window.from,
      toIndex: window.to,
      segments,
      hasMore: segments.length === window.to - window.from + 1,
    })
  } catch (err) {
    console.error('[public-recording] transcript failed:', err)
    res.status(500).json({ error: 'Failed to load transcript' })
  }
}
