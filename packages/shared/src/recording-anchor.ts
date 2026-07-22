/**
 * The page → recording link key. `[COMP:media/recording-anchor]`
 *
 * A synthesized brief is a `saved_views` row whose `anchor_key` is
 * `recording-synthesis:<recordingId>` — set by the synthesis run so a re-run
 * converges on the same page. That key is the ONLY thing tying a brief back to
 * the recording it was written from, and THREE surfaces must agree on it: the
 * synthesizer that writes it (`recording-synthesizer.ts`), the doc shell that
 * mounts the player from it (`apps/app-web/src/lib/recordings/anchor.ts`), and
 * the public-share render that resolves a shared page's recording server-side
 * (`routes/_public-recording.ts`). One module, so the prefix is written once —
 * the same reason the `[H:MM:SS]` stamp format lives here in `shared`.
 */

export const RECORDING_SYNTHESIS_ANCHOR_PREFIX = 'recording-synthesis:'

/** The anchor key a synthesis run writes for its brief page. */
export function recordingAnchorKey(recordingId: string): string {
  return `${RECORDING_SYNTHESIS_ANCHOR_PREFIX}${recordingId}`
}

/** The recording a page was synthesized from, or null for any other page. */
export function recordingIdFromAnchorKey(anchorKey: string | null | undefined): string | null {
  if (!anchorKey?.startsWith(RECORDING_SYNTHESIS_ANCHOR_PREFIX)) return null
  const id = anchorKey.slice(RECORDING_SYNTHESIS_ANCHOR_PREFIX.length).trim()
  return id.length > 0 ? id : null
}
