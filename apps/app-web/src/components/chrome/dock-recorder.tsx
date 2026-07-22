"use client";

/**
 * Dock live-recording UI (docs/architecture/media/live-capture.md) — the
 * record affordance + live recorder strip + crash-recovery notice, rendered
 * by `FloatingChat` in BOTH its render sites (the collapsed launcher row
 * and the expanded composer) off the ONE `useDockRecorder` instance, so a
 * capture started collapsed keeps running when the panel expands.
 *
 * The idle affordance is a record-DOT glyph, not a microphone — a mic reads
 * as voice-input-for-chat, and this button's short lane is only one of its
 * outcomes. While capturing, the strip is the pill body: red dot, elapsed
 * clock, live level meter (the "is it hearing the room" trust signal),
 * pause/discard/stop, and the fork telegraph label ("Voice message" →
 * "Meeting recording" once elapsed crosses the threshold), so stopping is
 * never a surprise.
 *
 * Gesture surface: pointer-down starts capture; release resolves via the
 * hook. While the pointer is held, release is listened for on the DOCUMENT
 * (the feed `VoiceRecorder` lesson — a finger sliding off the button must
 * not wedge the recording), and releasing OUTSIDE the button cancels
 * (slide-away-to-cancel). Discard while latched confirms through
 * `confirmDialog` (never `window.confirm`).
 *
 * [COMP:app-web/dock-recorder]
 */

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Square, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { Tooltip } from "@/components/ui/tooltip";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { captureLabelLane, formatElapsed } from "@/lib/recorder/recorder-gesture";
import type { DockRecorderApi } from "@/lib/recorder/use-dock-recorder";
import type { SpoolSessionMeta } from "@/lib/recorder/recorder-spool";

/** The record-dot glyph — deliberately not a microphone. */
function RecordDot({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" className={className} aria-hidden>
      <circle cx="12" cy="12" r="8.5" stroke="currentColor" strokeWidth="1.8" />
      <circle cx="12" cy="12" r="4" fill="currentColor" />
    </svg>
  );
}

/** ~10fps mic-level poll → 5 bars. Poll-render only while mounted (the strip). */
function LevelMeter({ level }: { level: () => number }) {
  const [value, setValue] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setValue(level()), 100);
    return () => clearInterval(timer);
  }, [level]);
  return (
    <span className="flex h-4 items-end gap-0.5" aria-hidden>
      {[0.15, 0.35, 0.6, 0.35, 0.15].map((weight, i) => {
        const h = 0.2 + Math.min(1, value * (1.6 - weight)) * 0.8;
        return (
          <span
            key={i}
            className="w-0.5 rounded-full bg-destructive/80 transition-[height] duration-100"
            style={{ height: `${Math.round(h * 100)}%` }}
          />
        );
      })}
    </span>
  );
}

/**
 * The record button. Stays mounted (and pressed-styled) through
 * arming/holding — it is the anchor of the live press gesture, and
 * unmounting it mid-hold would break slide-away-to-cancel. It hides only
 * once the capture is latched/finishing, when the strip owns the pill.
 */
export function DockRecorderButton({
  rec,
  disabled,
  className,
}: {
  rec: DockRecorderApi;
  disabled?: boolean;
  className?: string;
}) {
  const t = useT().recorder;
  const outsideRef = useRef(false);

  // While a press-gesture is unresolved, resolve release from ANYWHERE in
  // the document — a finger sliding off the button must still stop.
  const gestureLive = rec.phase.kind === "arming" || rec.phase.kind === "holding";
  useEffect(() => {
    if (!gestureLive) return;
    const onUp = () => rec.onPressEnd(outsideRef.current);
    document.addEventListener("pointerup", onUp);
    document.addEventListener("pointercancel", onUp);
    return () => {
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, [gestureLive, rec]);

  if (rec.phase.kind === "latched" || rec.phase.kind === "finishing") return null;
  return (
    <Tooltip label={t.start}>
      <button
        type="button"
        disabled={disabled}
        aria-label={t.start}
        aria-pressed={gestureLive}
        onPointerDown={(e) => {
          e.preventDefault();
          outsideRef.current = false;
          rec.onPressStart();
        }}
        onPointerLeave={() => {
          outsideRef.current = true;
        }}
        onPointerEnter={() => {
          outsideRef.current = false;
        }}
        className={cn(
          "shrink-0 inline-flex h-9 w-9 items-center justify-center rounded-md",
          "transition-colors disabled:opacity-50 disabled:pointer-events-none",
          gestureLive
            ? "bg-destructive/10 text-destructive animate-pulse"
            : "text-muted-foreground hover:bg-accent hover:text-destructive",
          className,
        )}
      >
        <RecordDot className="size-[18px]" />
      </button>
    </Tooltip>
  );
}

/**
 * The live recorder strip — the pill body while a capture runs. The
 * elapsed clock ticks as LOCAL state polled off `rec.elapsedMs()` so a
 * 2-hour capture re-renders this strip 4×/sec, never the whole dock.
 * The finishing state (assembling + upload + confirm) shows label-only.
 */
export function DockRecorderStrip({ rec, className }: { rec: DockRecorderApi; className?: string }) {
  const t = useT().recorder;
  const [elapsed, setElapsed] = useState(0);
  const capturing =
    rec.phase.kind === "arming" || rec.phase.kind === "holding" || rec.phase.kind === "latched";
  useEffect(() => {
    if (!capturing) return;
    setElapsed(rec.elapsedMs());
    const timer = setInterval(() => setElapsed(rec.elapsedMs()), 250);
    return () => clearInterval(timer);
  }, [capturing, rec]);
  if (!rec.active) return null;
  const finishing = rec.phase.kind === "finishing";
  const paused = rec.phase.kind === "latched" && rec.phase.paused;
  const latched = rec.phase.kind === "latched";
  const label = finishing
    ? t.finishing
    : captureLabelLane(elapsed) === "recording"
      ? t.meetingRecording
      : t.voiceMessage;
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2.5 rounded-full border border-destructive/40 bg-background/95 py-1.5 pl-3 pr-2 shadow-lg backdrop-blur",
        className,
      )}
    >
      <span
        aria-hidden
        className={cn("size-2 shrink-0 rounded-full bg-destructive", !paused && !finishing && "animate-pulse")}
      />
      <span className="min-w-0 truncate text-xs text-foreground/80">{label}</span>
      {!finishing ? (
        <>
          <span className="text-xs font-medium tabular-nums text-foreground">
            {formatElapsed(elapsed)}
          </span>
          <LevelMeter level={rec.level} />
        </>
      ) : null}
      {latched ? (
        <>
          <button
            type="button"
            aria-label={paused ? t.resume : t.pause}
            title={paused ? t.resume : t.pause}
            onClick={() => (paused ? rec.resume() : rec.pause())}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            {paused ? <Play className="size-3.5" aria-hidden /> : <Pause className="size-3.5" aria-hidden />}
          </button>
          <button
            type="button"
            aria-label={t.discard}
            title={t.discard}
            onClick={() => {
              void confirmDialog({
                title: t.discardTitle,
                description: t.discardBody,
                confirmLabel: t.discardAction,
              }).then((ok) => {
                if (ok) rec.discard();
              });
            }}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-destructive"
          >
            <X className="size-3.5" aria-hidden />
          </button>
          <button
            type="button"
            aria-label={t.stop}
            title={t.stop}
            onClick={() => rec.stop()}
            className="inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full bg-destructive px-2.5 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90"
          >
            <Square className="size-3 fill-current" aria-hidden />
            {t.stop}
          </button>
        </>
      ) : null}
    </div>
  );
}

/**
 * Transient notices: first-use mic hint, the "kept on this device"
 * reassurance (a long capture whose upload failed or whose cost-confirm
 * was cancelled — informational, NOT error-styled: the audio is safe and
 * will surface as recovery), and capture/send errors.
 */
export function DockRecorderNotice({ rec, className }: { rec: DockRecorderApi; className?: string }) {
  const t = useT().recorder;
  if (!rec.notice) return null;
  const informational =
    rec.notice === "micHint" ||
    rec.notice === "kept" ||
    rec.notice === "autoStopped" ||
    rec.notice === "pauseStopped";
  const text =
    rec.notice === "micHint"
      ? t.micHint
      : rec.notice === "kept"
        ? t.keptOnDevice
        : rec.notice === "autoStopped"
          ? t.autoStopped
          : rec.notice === "pauseStopped"
            ? t.pauseStopped
            : rec.notice === "denied"
              ? t.micDenied
              : rec.notice === "voiceFailed"
                ? t.voiceFailed
                : t.captureFailed;
  return (
    <div
      role="status"
      className={cn(
        "flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs",
        informational
          ? "border-border bg-background/95 text-muted-foreground"
          : "border-destructive/30 bg-destructive/10 text-destructive",
        className,
      )}
    >
      <span className="min-w-0 flex-1">{text}</span>
      <button
        type="button"
        aria-label={t.dismiss}
        onClick={rec.clearNotices}
        className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}

/**
 * Crash-recovery banner: one row per orphaned spool session. Save re-runs
 * the stop fork off the spooled audio; Discard confirms first.
 */
export function DockRecorderRecovery({ rec, className }: { rec: DockRecorderApi; className?: string }) {
  const t = useT().recorder;
  const [busy, setBusy] = useState<string | null>(null);
  if (rec.recovery.length === 0) return null;
  const timeOf = (s: SpoolSessionMeta) =>
    new Date(s.startedAt).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  return (
    <div className={cn("flex flex-col gap-1.5", className)}>
      {rec.recovery.map((s) => (
        <div
          key={s.id}
          className="flex items-center gap-2 rounded-md border border-border bg-background/95 px-2.5 py-1.5 text-xs shadow-sm backdrop-blur"
        >
          <span aria-hidden className="size-2 shrink-0 rounded-full bg-destructive/70" />
          <span className="min-w-0 flex-1 truncate text-foreground/80">
            {format(t.recoveryFrom, { time: timeOf(s) })}
          </span>
          <button
            type="button"
            disabled={busy === s.id}
            onClick={() => {
              setBusy(s.id);
              void rec.saveRecovery(s.id).finally(() => setBusy(null));
            }}
            className="shrink-0 rounded-md bg-primary px-2 py-1 font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
          >
            {busy === s.id ? t.recoverySaving : t.recoverySave}
          </button>
          <button
            type="button"
            disabled={busy === s.id}
            onClick={() => {
              void confirmDialog({
                title: t.discardTitle,
                description: t.recoveryDiscardBody,
                confirmLabel: t.discardAction,
              }).then((ok) => {
                if (ok) void rec.discardRecovery(s.id);
              });
            }}
            className="shrink-0 rounded-md px-2 py-1 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
          >
            {t.recoveryDiscard}
          </button>
        </div>
      ))}
    </div>
  );
}
