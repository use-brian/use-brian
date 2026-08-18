/**
 * Live meeting capture — the one string both sides must agree on.
 *
 * The live route seeds a caption block whose id carries this prefix; the doc
 * shell reads the same prefix to know a page has a live capture surface (and
 * so mounts the live transcript pane). Writer and reader change together or
 * the pane never mounts. [COMP:media/live-recording-marker]
 */
export const LIVE_MARKER_ID_PREFIX = 'live:'

/** True when a page's block list carries the live capture marker. */
export function hasLiveMarkerBlock(blocks: Array<{ id?: unknown }> | undefined | null): boolean {
  return !!blocks?.some(
    (block) => typeof block.id === 'string' && block.id.startsWith(LIVE_MARKER_ID_PREFIX),
  )
}
