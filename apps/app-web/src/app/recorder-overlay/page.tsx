"use client";

/**
 * Recorder overlay — the page the desktop shell's floating always-on-top
 * window loads while a latched capture runs
 * (docs/architecture/media/live-capture.md → "Desktop floating overlay").
 *
 * A separate renderer with NO recorder of its own: it mirrors state off the
 * `BroadcastChannel` (elapsed clock, paused flag, rolling mic-level
 * waveform) and posts pause / resume / stop commands back — the dock hook
 * in the main window executes them. The shell owns the window's lifetime
 * (`setRecording`), so the "not capturing" state here is only a brief blank
 * before the window closes.
 *
 * Chrome-less by design: the Electron window is frameless (macOS rounds
 * frameless corners natively) and this page fills it edge to edge. The
 * container is the drag region (`-webkit-app-region: drag`); controls opt
 * out so they stay clickable. In a regular browser tab this page is
 * inert-but-harmless (blank bar, disabled controls) — the shell is the
 * only intended host.
 *
 * [COMP:app-web/dock-recorder]
 */

import { useEffect, useRef, useState } from "react";
import { Pause, Play, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { formatElapsed } from "@/lib/recorder/recorder-gesture";
import {
  RECORDER_CHANNEL,
  WAVE_SAMPLES,
  isRecorderState,
  pushWaveSample,
  type RecorderCommandMessage,
} from "@/lib/recorder/recorder-broadcast";

export default function RecorderOverlayPage() {
  const t = useT().recorder;
  const [capturing, setCapturing] = useState(false);
  const [paused, setPaused] = useState(false);
  const [elapsedMs, setElapsedMs] = useState(0);
  const [wave, setWave] = useState<number[]>([]);
  const channelRef = useRef<BroadcastChannel | null>(null);

  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel(RECORDER_CHANNEL);
    channelRef.current = channel;
    channel.onmessage = (e) => {
      const msg: unknown = e.data;
      if (!isRecorderState(msg)) return;
      setCapturing(msg.capturing);
      setPaused(msg.paused);
      setElapsedMs(msg.elapsedMs);
      setWave((prev) => (msg.capturing && !msg.paused ? pushWaveSample(prev, msg.level) : prev));
    };
    return () => {
      channelRef.current = null;
      channel.close();
    };
  }, []);

  const send = (action: RecorderCommandMessage["action"]) => {
    channelRef.current?.postMessage({ type: "command", action } satisfies RecorderCommandMessage);
  };

  return (
    <div
      className="flex h-dvh w-full items-center overflow-hidden bg-background"
      style={{ WebkitAppRegion: "drag" } as React.CSSProperties}
    >
      <div className="flex h-full w-full items-center gap-2.5 border-t-2 border-destructive/60 px-3.5">
        <span
          aria-hidden
          className={cn(
            "size-2.5 shrink-0 rounded-full bg-destructive",
            capturing && !paused && "animate-pulse",
          )}
        />
        <span className="shrink-0 text-sm font-medium tabular-nums text-foreground">
          {formatElapsed(elapsedMs)}
        </span>
        {/* Rolling live waveform — one bar per broadcast sample. */}
        <span className="flex h-6 min-w-0 flex-1 items-center gap-px overflow-hidden" aria-hidden>
          {Array.from({ length: WAVE_SAMPLES }, (_, i) => {
            const level = wave[wave.length - WAVE_SAMPLES + i] ?? 0;
            return (
              <span
                key={i}
                className="w-[3px] shrink-0 rounded-full bg-destructive/70"
                style={{ height: `${Math.round((0.12 + level * 0.88) * 100)}%` }}
              />
            );
          })}
        </span>
        <span
          className="flex shrink-0 items-center gap-1"
          style={{ WebkitAppRegion: "no-drag" } as React.CSSProperties}
        >
          <button
            type="button"
            aria-label={paused ? t.resume : t.pause}
            title={paused ? t.resume : t.pause}
            disabled={!capturing}
            onClick={() => send(paused ? "resume" : "pause")}
            className="inline-flex size-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
          >
            {paused ? <Play className="size-4" aria-hidden /> : <Pause className="size-4" aria-hidden />}
          </button>
          <button
            type="button"
            aria-label={t.stop}
            title={t.stop}
            disabled={!capturing}
            onClick={() => send("stop")}
            className="inline-flex h-8 items-center gap-1.5 rounded-full bg-destructive px-3 text-xs font-medium text-destructive-foreground transition-colors hover:bg-destructive/90 disabled:opacity-40"
          >
            <Square className="size-3 fill-current" aria-hidden />
            {t.stop}
          </button>
        </span>
      </div>
    </div>
  );
}
