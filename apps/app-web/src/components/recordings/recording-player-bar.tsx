"use client";

/**
 * Transport + scrubber for a recording. Reads the player context, so it renders
 * wherever a `RecordingPlayerProvider` is mounted: the brief page (as sticky
 * page chrome above the doc) and the standalone recording detail route.
 *
 * **Chrome, never a doc block.** On the brief page this sits OUTSIDE the
 * ProseMirror doc: a block would be user-editable content they could delete,
 * orphaning every `[H:MM:SS]` citation on the page that seeks it. Same reason
 * the citations are a `Decoration` rather than a node.
 *
 * Extracted from the detail route so both surfaces share one implementation -
 * a second copy would drift, and the two are the same control.
 *
 * [COMP:app-web/recording-chrome]
 */

import { formatStamp } from "@sidanclaw/shared";
import { useT } from "@/lib/i18n/client";
import { useRecordingPlayer } from "@/lib/recordings/recording-player-context";

export function RecordingPlayerBar({
  title,
  className = "",
}: {
  title: string;
  className?: string;
}) {
  const t = useT();
  const { currentMs, durationMs, isPlaying, togglePlay, isLoading, error, seekTo } =
    useRecordingPlayer();

  if (error) {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        {t.recordings.detailAudioError}
      </div>
    );
  }

  return (
    <div
      className={`flex items-center gap-3 rounded-md border border-border bg-background/95 px-4 py-3 backdrop-blur ${className}`}
    >
      <button
        type="button"
        onClick={togglePlay}
        disabled={isLoading}
        aria-label={isPlaying ? t.recordings.detailPause : t.recordings.detailPlay}
        className="shrink-0 rounded-full border border-border px-3 py-1 text-sm disabled:opacity-50"
      >
        {isPlaying ? t.recordings.detailPause : t.recordings.detailPlay}
      </button>
      <span className="shrink-0 tabular-nums text-xs text-muted-foreground">
        {formatStamp(currentMs)} / {formatStamp(durationMs)}
      </span>
      <input
        type="range"
        min={0}
        max={Math.max(durationMs, 1)}
        value={Math.min(currentMs, durationMs || 0)}
        onChange={(e) => seekTo(Number(e.target.value))}
        aria-label={title}
        className="h-1 w-full cursor-pointer"
      />
      {isLoading ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {t.recordings.detailLoadingAudio}
        </span>
      ) : null}
    </div>
  );
}
