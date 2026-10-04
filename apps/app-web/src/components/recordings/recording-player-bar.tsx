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

import { useEffect, useState } from "react";
import { formatStamp } from "@use-brian/shared";
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
  const [copyStatus, setCopyStatus] = useState<"idle" | "copying" | "copied" | "failed">("idle");

  useEffect(() => {
    if (copyStatus !== "copied" && copyStatus !== "failed") return;
    const timer = setTimeout(() => setCopyStatus("idle"), 3_000);
    return () => clearTimeout(timer);
  }, [copyStatus]);

  const copyTimestamp = async () => {
    // Capture the click's moment even if playback advances while permission
    // resolves. Pasting uses the existing timestamp scanner and page pointer.
    const stamp = `[${formatStamp(currentMs)}]`;
    setCopyStatus("copying");
    try {
      await navigator.clipboard.writeText(stamp);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("failed");
    }
  };

  if (error) {
    return (
      <div className="rounded-md border border-border bg-muted/40 px-4 py-3 text-sm text-muted-foreground">
        {t.recordings.detailAudioError}
      </div>
    );
  }

  return (
    <div
      className={`flex flex-wrap items-center gap-3 rounded-md border border-border bg-background/95 px-4 py-3 backdrop-blur ${className}`}
    >
      <button
        type="button"
        onClick={togglePlay}
        disabled={isLoading}
        aria-label={isPlaying ? t.recordings.detailPause : t.recordings.detailPlay}
        className="inline-flex h-11 shrink-0 items-center rounded-full border border-border px-3 text-sm disabled:opacity-50 sm:h-7"
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
        // The element's own height is the touch hit box outside the thumb, so a
        // 4px track makes seeking by finger a precision drag (M3); the track
        // only shrinks back to a hairline once a pointer is in play.
        className="h-6 min-w-20 flex-1 cursor-pointer md:h-1"
      />
      <button
        type="button"
        onClick={() => void copyTimestamp()}
        disabled={isLoading || durationMs <= 0 || copyStatus === "copying"}
        title={t.recordings.copyTimestampHint}
        className="inline-flex h-9 shrink-0 items-center rounded px-2 text-xs text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50 sm:h-6"
      >
        {t.recordings.copyTimestamp}
      </button>
      {isLoading ? (
        <span className="shrink-0 text-xs text-muted-foreground">
          {t.recordings.detailLoadingAudio}
        </span>
      ) : null}
      <span role="status" className="basis-full text-xs text-muted-foreground">
        {copyStatus === "copied"
          ? t.recordings.timestampCopied
          : copyStatus === "failed"
            ? t.recordings.timestampCopyFailed
            : t.recordings.copyTimestampHint}
      </span>
    </div>
  );
}
