/**
 * Same-tab bridge between the dock recorder's live streaming and the doc
 * page's live transcript pane: each successfully transcribed window is
 * dispatched as a CustomEvent so the pane (when the streamed page is open in
 * this tab) appends instantly instead of waiting for its next poll. Other
 * tabs/members converge through the pane's poll — payloads here are a
 * latency optimization, never the source of truth.
 *
 * [COMP:app-web/live-transcript-pane]
 */

import type { LiveTranscriptLine } from "@/lib/api/recordings";

export const LIVE_TRANSCRIPT_WINDOW_EVENT = "sidan:live-transcript-window";

export type LiveTranscriptWindowDetail = {
  pageId: string;
  chunkId: string;
  offsetMs: number;
  durationMs: number;
  missedBefore: number;
  lines: LiveTranscriptLine[];
};

export function dispatchLiveTranscriptWindow(detail: LiveTranscriptWindowDetail): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(LIVE_TRANSCRIPT_WINDOW_EVENT, { detail }));
}
