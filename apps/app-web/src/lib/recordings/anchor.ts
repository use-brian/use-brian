/**
 * The page → recording link.
 *
 * A synthesized brief is a `saved_views` row whose `anchor_key` is
 * `recording-synthesis:<recordingId>` (set by the synthesis run so a re-run
 * converges on the same page). That key is the ONLY thing tying a brief back to
 * the recording it was written from - which is what lets the doc shell mount a
 * player and turn the page's `[H:MM:SS]` citations into seek links.
 *
 * The prefix + parse now live in `@use-brian/shared` (`recording-anchor.ts`) so
 * the synthesizer that WRITES the key, this client that READS it, and the
 * public-share render that resolves a shared page's recording server-side all
 * hold the same string. Re-exported here so existing imports stay stable.
 */

export { recordingIdFromAnchorKey } from "@use-brian/shared";
