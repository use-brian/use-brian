"use client";

/**
 * Dock live-recording hook — the one recorder instance `FloatingChat` owns
 * and both render sites (collapsed pill, expanded composer) share
 * (docs/architecture/media/live-capture.md).
 *
 * The orchestration brain is `recorderTransition` — a PURE
 * (phase, event) → (phase, effect) machine exported for the node tests
 * (`[COMP:app-web/dock-recorder]`); the hook is the imperative shell that
 * runs the effects against the engine/spool/window. The gesture contract:
 * pointer-down starts capture immediately, release resolves it
 * (`resolveRelease`), stop forks on duration (`stopLane`).
 *
 * First-use permission: the press that triggers the browser's mic prompt
 * cannot capture (the stream lands only after the user clicks Allow). The
 * machine handles both intents honestly once the stream arrives: a
 * quick-tap press (latch intent) proceeds INTO a latched capture — the user
 * asked to record and the mic is now live; a long-hold press (walkie-talkie
 * intent) whose audio window already passed is cancelled with the
 * "mic enabled, press again" hint instead of sending a near-empty clip.
 *
 * Durability: latching arms the `beforeunload` guard and starts the
 * IndexedDB spool; on mount the hook lists orphaned spool sessions and
 * exposes them as `recovery` for the banner (save re-runs the same stop
 * fork off the spooled `elapsedMs`; discard confirmation is the UI's job).
 *
 * `?record=1` (the desktop `usebrian://record` deep link's landing) auto
 * starts a latched capture on mount; the param is stripped so a reload
 * does not re-trigger.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  PAUSE_AUTO_STOP_MS,
  captureFileName,
  resolveRelease,
  shouldAutoStop,
  stopLane,
  type CaptureLane,
} from "./recorder-gesture";
import { createRecorderEngine, type RecorderEngine } from "./recorder-engine";
import {
  LIVE_SESSION_GRACE_MS,
  assembleSpooledBlob,
  openRecorderSpool,
  recoverableSessions,
  rescueSessionMeta,
  type SpoolSessionMeta,
  type SpoolStore,
} from "./recorder-spool";
import { patchRecordingBlob } from "./webm-duration";
import { uploadVoiceClip } from "./voice-clip";
import {
  RECORDER_CHANNEL,
  isRecorderCommand,
  recorderStateMessage,
} from "./recorder-broadcast";
import { desktopBridge } from "@/lib/desktop-auth-source";

/**
 * Ask the browser to protect this origin's storage from eviction — the
 * spool may hold the ONLY copy of a meeting for days (a user deliberately
 * waiting for good wifi before pressing Save), and default "best-effort"
 * storage is evictable under disk pressure. Fire-and-forget: browsers may
 * decline (heuristics/permission) and the spool still works, just without
 * the guarantee.
 */
function requestPersistentStorage(): void {
  try {
    void navigator.storage?.persist?.()?.catch(() => {});
  } catch {
    // Insecure context / very old browser — nothing to ask.
  }
}

// ── The pure transition machine ──────────────────────────────────────────

export type RecorderPhase =
  | { kind: "idle" }
  /** `getUserMedia` in flight. `releasedAfterMs` set when the pointer already lifted; `auto` = deep-link start (straight to latched). */
  | { kind: "arming"; releasedAfterMs: number | null; auto: boolean }
  /** Capturing, pointer still down (gesture unresolved). */
  | { kind: "holding" }
  /** Capturing until an explicit stop. */
  | { kind: "latched"; paused: boolean }
  /** Stop requested; assembling + forking. */
  | { kind: "finishing" };

export type RecorderEvent =
  | { type: "press" }
  | { type: "auto-start" }
  | { type: "release"; heldMs: number; outside?: boolean }
  | { type: "armed" }
  | { type: "arm-failed" }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" }
  | { type: "discard" }
  | { type: "finished" };

export type RecorderEffect =
  | "start-capture"
  | "latch"
  | "stop-capture"
  | "cancel-capture"
  | "cancel-with-hint"
  | "pause"
  | "resume";

const IDLE: RecorderPhase = { kind: "idle" };

/** Pure. Unknown (phase, event) pairs are no-ops — a stale UI event must never corrupt the capture. */
export function recorderTransition(
  phase: RecorderPhase,
  ev: RecorderEvent,
): { phase: RecorderPhase; effect: RecorderEffect | null } {
  switch (phase.kind) {
    case "idle":
      if (ev.type === "press") {
        return { phase: { kind: "arming", releasedAfterMs: null, auto: false }, effect: "start-capture" };
      }
      if (ev.type === "auto-start") {
        return { phase: { kind: "arming", releasedAfterMs: null, auto: true }, effect: "start-capture" };
      }
      return { phase, effect: null };
    case "arming":
      if (ev.type === "release") {
        // Slide-away during arming = never mind.
        if (ev.outside) return { phase: IDLE, effect: "cancel-capture" };
        return { phase: { ...phase, releasedAfterMs: ev.heldMs }, effect: null };
      }
      if (ev.type === "armed") {
        if (phase.auto) return { phase: { kind: "latched", paused: false }, effect: "latch" };
        if (phase.releasedAfterMs === null) return { phase: { kind: "holding" }, effect: null };
        // The pointer lifted while the mic was still arming (usually the
        // first-use permission prompt). Latch intent proceeds — the user
        // asked to record and the mic is live now. Hold intent's audio
        // window already passed: cancel with the press-again hint.
        return resolveRelease(phase.releasedAfterMs) === "latch"
          ? { phase: { kind: "latched", paused: false }, effect: "latch" }
          : { phase: IDLE, effect: "cancel-with-hint" };
      }
      if (ev.type === "arm-failed") return { phase: IDLE, effect: null };
      if (ev.type === "discard") return { phase: IDLE, effect: "cancel-capture" };
      return { phase, effect: null };
    case "holding":
      if (ev.type === "release") {
        if (ev.outside) return { phase: IDLE, effect: "cancel-capture" };
        return resolveRelease(ev.heldMs) === "latch"
          ? { phase: { kind: "latched", paused: false }, effect: "latch" }
          : { phase: { kind: "finishing" }, effect: "stop-capture" };
      }
      if (ev.type === "discard") return { phase: IDLE, effect: "cancel-capture" };
      return { phase, effect: null };
    case "latched":
      if (ev.type === "stop") return { phase: { kind: "finishing" }, effect: "stop-capture" };
      if (ev.type === "discard") return { phase: IDLE, effect: "cancel-capture" };
      if (ev.type === "pause" && !phase.paused) return { phase: { kind: "latched", paused: true }, effect: "pause" };
      if (ev.type === "resume" && phase.paused) return { phase: { kind: "latched", paused: false }, effect: "resume" };
      return { phase, effect: null };
    case "finishing":
      if (ev.type === "finished") return { phase: IDLE, effect: null };
      return { phase, effect: null };
  }
}

// ── The hook ─────────────────────────────────────────────────────────────

/**
 * The transient notice under the recorder UI. Two are informational
 * ("micHint" = first-use press-again; "kept" = the capture is safe on this
 * device and will surface as recovery — shown when a long-lane hand-off
 * did not complete, whether an offline/failed upload or a cancelled
 * cost-confirm), the rest are errors. "kept" exists because the generic
 * failure copy reads as "your recording might be lost", which is exactly
 * the wrong thing to tell someone who just finished a 2-hour sales call
 * on hotel wifi.
 */
type RecorderNotice =
  | "micHint"
  | "kept"
  | "autoStopped"
  | "pauseStopped"
  | "denied"
  | "failed"
  | "voiceFailed";

export type DockRecorderApi = {
  phase: RecorderPhase;
  /** True whenever the recorder owns the pill (anything but idle). */
  active: boolean;
  /**
   * Recorder clock ACCESSOR, not state — the strip polls it into its own
   * local tick so a 2-hour capture re-renders the little strip, never the
   * whole dock (4 ticks/sec across a 3.8k-line tree was the alternative).
   */
  elapsedMs: () => number;
  notice: RecorderNotice | null;
  clearNotices: () => void;
  onPressStart: () => void;
  onPressEnd: (outside?: boolean) => void;
  stop: () => void;
  discard: () => void;
  pause: () => void;
  resume: () => void;
  level: () => number;
  recovery: SpoolSessionMeta[];
  saveRecovery: (sessionId: string) => Promise<void>;
  discardRecovery: (sessionId: string) => Promise<void>;
};

export function useDockRecorder(opts: {
  enabled: boolean;
  workspaceId: string;
  assistantId: string;
  /** Localized capture-name prefix ("Recording") for the file name. */
  captureNamePrefix: string;
  /** Short-lane hand-off: upload as a voice clip + auto-send the turn. Return false to surface the send error. */
  sendVoiceClip: (fileId: string) => Promise<boolean>;
  /** Session id accessor for the voice-clip cache upload (best-effort). */
  getSessionId?: () => string | undefined;
  /** Long-lane hand-off: the recording ingestion flow (`useRecordingUpload.run`). */
  onMeetingCapture: (file: File) => Promise<unknown>;
}): DockRecorderApi {
  const { enabled, workspaceId, assistantId, captureNamePrefix, sendVoiceClip, getSessionId, onMeetingCapture } =
    opts;
  const [phase, setPhase] = useState<RecorderPhase>(IDLE);
  const [notice, setNotice] = useState<RecorderNotice | null>(null);
  const [recovery, setRecovery] = useState<SpoolSessionMeta[]>([]);

  const phaseRef = useRef<RecorderPhase>(IDLE);
  const engineRef = useRef<RecorderEngine | null>(null);
  const pressStartedAtRef = useRef(0);
  /** Set by the auto-stop guards: the next stop goes straight to the spool, no hand-off. */
  const skipHandOffRef = useRef(false);
  /**
   * Set by the 2-hour limit only: after the stop finishes, immediately start
   * the NEXT latched segment — the meeting keeps recording with zero user
   * action (segment rollover). The pause cap never rolls over: a paused-out
   * capture is a user who stopped attending, and re-opening the mic
   * unattended is exactly what that guard exists to prevent.
   */
  const rollOverRef = useRef(false);
  const spoolRef = useRef<SpoolStore | null>(null);
  const spool = () => (spoolRef.current ??= openRecorderSpool());

  const applyPhase = (next: RecorderPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const refreshRecovery = useCallback(async () => {
    try {
      const sessions = await spool().listSessions();
      setRecovery(recoverableSessions(sessions, engineRef.current?.spoolSessionId() ?? null));
    } catch {
      setRecovery([]);
    }
  }, []);

  /**
   * Rescue-write a finished capture that was never live-spooled (only
   * hold-to-talk clips skip the spool) so a failed offline hand-off
   * recovers through the banner like everything else. Best-effort: if the
   * spool itself is unavailable, the failure notice already shown stands.
   */
  const rescueCapture = async (capture: {
    blob: Blob;
    mime: string;
    durationMs: number;
  }): Promise<boolean> => {
    try {
      requestPersistentStorage();
      const meta = rescueSessionMeta(
        crypto.randomUUID(),
        workspaceId,
        assistantId,
        capture,
        Date.now(),
      );
      await spool().createSession(meta);
      await spool().appendChunk(meta.id, 0, capture.blob, capture.durationMs);
      return true;
    } catch {
      // Spool unavailable — nothing more to hold the clip with; the failure
      // notice already shown stands.
      return false;
    }
  };

  const dropSpoolSession = async (sessionId: string | null) => {
    if (!sessionId) return;
    try {
      await spool().deleteSession(sessionId);
    } catch {
      // Best-effort — an undeleted session resurfaces as recovery, which is
      // the safe direction.
    }
  };

  /**
   * Run the stop fork on an assembled capture. Shared by live stop +
   * recovery save. Returns whether the spool copy is now SAFE TO DROP —
   * and this is load-bearing for long captures: unlike a dropped file
   * (which still exists on the user's disk), the spool is the ONLY copy of
   * a live capture, so a failed upload or a cancelled cost-confirm must
   * keep it (it resurfaces as recovery; an explicit Discard is the user's
   * way out). Only a deliberate discard-floor drop or a completed hand-off
   * (voice turn sent / recording queued) releases it.
   */
  const handOff = useCallback(
    async (blob: Blob, mime: string, durationMs: number): Promise<boolean> => {
      const lane: CaptureLane = stopLane(durationMs);
      if (lane === "discard") return true;
      const name = captureFileName(captureNamePrefix, new Date(), mime);
      if (lane === "voice") {
        const file = new File([blob], name, { type: mime });
        const fileId = await uploadVoiceClip(file, getSessionId?.());
        const sent = fileId ? await sendVoiceClip(fileId) : false;
        if (!sent) setNotice("voiceFailed");
        return sent;
      }
      const patched = await patchRecordingBlob(blob, durationMs);
      const file = new File([patched], name, { type: mime });
      // `useRecordingUpload.run` resolves the queued recording, or null on
      // BOTH cancel and failure — either way the audio must survive, and the
      // "kept" notice tells the user so (the generic failure copy would read
      // as "your recording might be lost").
      const queued = await onMeetingCapture(file);
      if (!queued) setNotice("kept");
      return Boolean(queued);
    },
    [captureNamePrefix, sendVoiceClip, getSessionId, onMeetingCapture],
  );

  const runEffect = useCallback(
    (effect: RecorderEffect) => {
      const engine = engineRef.current;
      switch (effect) {
        case "start-capture":
          void (async () => {
            try {
              engineRef.current = await createRecorderEngine({
                // The capture died underneath us (mic unplugged / input
                // switched / recorder error). Finalize instead of ticking a
                // zombie clock: a latched meeting stops-and-forks with
                // whatever was captured (the confirm dialog surfaces it); an
                // unresolved press has nothing worth keeping.
                onUnexpectedEnd: () => {
                  const kind = phaseRef.current.kind;
                  if (kind === "latched") dispatchRef.current({ type: "stop" });
                  else if (kind === "holding" || kind === "arming") {
                    setNotice("failed");
                    dispatchRef.current({ type: "discard" });
                  }
                },
              });
              dispatchRef.current({ type: "armed" });
            } catch (err) {
              setNotice(
                err instanceof DOMException && err.name === "NotAllowedError" ? "denied" : "failed",
              );
              dispatchRef.current({ type: "arm-failed" });
            }
          })();
          return;
        case "latch":
          if (engine) {
            requestPersistentStorage();
            engine.latch(spool(), {
              id: crypto.randomUUID(),
              workspaceId,
              assistantId,
              startedAt: Date.now(),
            });
          }
          return;
        case "pause":
          engine?.pause();
          return;
        case "resume":
          engine?.resume();
          return;
        case "cancel-with-hint":
          setNotice("micHint");
          engine?.cancel();
          engineRef.current = null;
          return;
        case "cancel-capture": {
          const sessionId = engine?.spoolSessionId() ?? null;
          engine?.cancel();
          engineRef.current = null;
          void dropSpoolSession(sessionId);
          return;
        }
        case "stop-capture":
          void (async () => {
            const eng = engineRef.current;
            if (!eng) {
              dispatchRef.current({ type: "finished" });
              return;
            }
            const sessionId = eng.spoolSessionId();
            // Ceiling auto-stop: skip the hand-off entirely — running it
            // would pop the cost-confirm modal MID-CALL, a worse disturb
            // than the stop itself. The capture lands in the spool (the
            // engine's stop flushes the final chunk there) and processes
            // from the recovery banner whenever the user is ready.
            const skipHandOff = skipHandOffRef.current;
            skipHandOffRef.current = false;
            let safeToDrop = false;
            let capture: { blob: Blob; mime: string; durationMs: number } | null = null;
            try {
              capture = await eng.stop();
              engineRef.current = null;
              if (!skipHandOff) {
                safeToDrop = await handOff(capture.blob, capture.mime, capture.durationMs);
              }
            } catch {
              setNotice("failed");
              engineRef.current = null;
            } finally {
              // The spool is the ONLY copy of a live capture — drop it only
              // on a completed hand-off; otherwise it resurfaces as recovery
              // (a cancelled confirm included: Save re-opens the flow). A
              // capture that was never live-spooled (hold-to-talk) gets a
              // RESCUE write on failure, so an offline voice clip recovers
              // too instead of dying with only a notice. The re-list waits
              // out the live-session grace window that would otherwise hide
              // the just-written session.
              if (safeToDrop) {
                void dropSpoolSession(sessionId);
              } else {
                if (!sessionId && capture) {
                  // A rescued clip upgrades the failure story: "could not
                  // send" becomes "kept on this device".
                  void rescueCapture(capture).then((ok) => {
                    if (ok) setNotice("kept");
                  });
                }
                setTimeout(() => void refreshRecovery(), LIVE_SESSION_GRACE_MS + 5_000);
              }
              dispatchRef.current({ type: "finished" });
              if (rollOverRef.current) {
                // Segment rollover (2-hour limit): the meeting is still
                // happening — start the next latched segment immediately.
                rollOverRef.current = false;
                dispatchRef.current({ type: "auto-start" });
              }
            }
          })();
          return;
      }
    },
    [workspaceId, assistantId, handOff, refreshRecovery],
  );

  const dispatch = useCallback(
    (ev: RecorderEvent) => {
      const { phase: next, effect } = recorderTransition(phaseRef.current, ev);
      applyPhase(next);
      if (effect) runEffect(effect);
    },
    [runEffect],
  );
  // The async effects (arm, stop) dispatch back after awaits — through a ref
  // so they always hit the latest closure.
  const dispatchRef = useRef(dispatch);
  dispatchRef.current = dispatch;

  // ── forgotten-recording watcher (ceiling + pause cap) ────────────────
  // One 30s ref-only check while latched (no re-renders) guards the two
  // ways a capture outlives its user's attention:
  // - CEILING: past the server's 180-minute transcription ceiling the
  //   capture could NEVER ingest (the estimate 413s `too_long` forever and
  //   a spooled capture has no splitter) — stop 10 minutes shy.
  // - FORGOTTEN PAUSE: a paused capture freezes the clock, so the ceiling
  //   alone would hold the mic stream and session FOREVER — stop after 30
  //   continuous paused minutes.
  // Both stop STRAIGHT to the spool (`skipHandOffRef` — no mid-call
  // cost-confirm modal) with an informational notice; press record to
  // continue, process from the banner whenever.
  const latched = phase.kind === "latched";
  const pausedSinceRef = useRef<number | null>(null);
  useEffect(() => {
    if (!latched) return;
    pausedSinceRef.current = null;
    const timer = setInterval(() => {
      const engine = engineRef.current;
      // phaseRef is updated synchronously by dispatch, so this also closes
      // the race with a manual stop landing between ticks — the guards must
      // never fire on a capture that is already finishing.
      if (!engine || phaseRef.current.kind !== "latched") return;
      if (engine.paused()) {
        pausedSinceRef.current ??= Date.now();
        if (Date.now() - pausedSinceRef.current >= PAUSE_AUTO_STOP_MS) {
          skipHandOffRef.current = true;
          setNotice("pauseStopped");
          dispatchRef.current({ type: "stop" });
        }
        return;
      }
      pausedSinceRef.current = null;
      if (shouldAutoStop(engine.elapsedMs())) {
        skipHandOffRef.current = true;
        rollOverRef.current = true;
        setNotice("autoStopped");
        dispatchRef.current({ type: "stop" });
      }
    }, 30_000);
    return () => clearInterval(timer);
  }, [latched]);

  // ── overlay bridge while latched ─────────────────────────────────────
  // The desktop shell's floating always-on-top overlay is a SEPARATE
  // renderer, so state rides a BroadcastChannel (5/s: elapsed, paused,
  // level) and its pause/resume/stop come back as commands — guarded, since
  // any same-origin page can post to the channel. `setRecording` tells the
  // shell to show/close the overlay window; it is absent on the web (a
  // browser has no always-on-top) and in older shells, and everything else
  // degrades to a no-op there.
  useEffect(() => {
    if (!latched) return;
    try {
      desktopBridge()?.setRecording?.(true);
    } catch {
      // Older shell without the method.
    }
    let channel: BroadcastChannel | null = null;
    let timer: ReturnType<typeof setInterval> | null = null;
    if (typeof BroadcastChannel !== "undefined") {
      channel = new BroadcastChannel(RECORDER_CHANNEL);
      const publish = () => {
        const engine = engineRef.current;
        if (!engine) return;
        channel?.postMessage(
          recorderStateMessage(true, engine.paused(), engine.elapsedMs(), engine.level()),
        );
      };
      publish();
      timer = setInterval(publish, 200);
      channel.onmessage = (e) => {
        const msg: unknown = e.data;
        if (!isRecorderCommand(msg)) return;
        if (msg.action === "pause") dispatchRef.current({ type: "pause" });
        else if (msg.action === "resume") dispatchRef.current({ type: "resume" });
        else dispatchRef.current({ type: "stop" });
      };
    }
    return () => {
      if (timer) clearInterval(timer);
      try {
        channel?.postMessage(recorderStateMessage(false, false, 0, 0));
      } catch {
        // Channel already gone.
      }
      channel?.close();
      try {
        desktopBridge()?.setRecording?.(false);
      } catch {
        // Older shell without the method.
      }
    };
  }, [latched]);

  // ── title marker while latched ───────────────────────────────────────
  // The strip only reminds a user who is LOOKING at the app. A backgrounded
  // tab or the desktop shell (no tab chrome) gets the 🔴 prefix on the
  // document/window title — visible in the tab strip, the taskbar, and the
  // macOS window switcher. Re-applied on an interval because route changes
  // rewrite the title; symbol-only so no locale copy is needed.
  useEffect(() => {
    if (!latched) return;
    const MARK = "\u{1F534} ";
    const apply = () => {
      if (!document.title.startsWith(MARK)) document.title = MARK + document.title;
    };
    apply();
    const timer = setInterval(apply, 2_000);
    return () => {
      clearInterval(timer);
      if (document.title.startsWith(MARK)) document.title = document.title.slice(MARK.length);
    };
  }, [latched]);

  // ── beforeunload while a latched capture is live ─────────────────────
  useEffect(() => {
    if (!latched) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [latched]);

  // ── recovery listing on mount ────────────────────────────────────────
  // Twice: once immediately, once past the live-session grace window — a
  // crash followed by a quick reload writes its last chunk seconds before
  // the remount, so the first list hides it as possibly-live.
  useEffect(() => {
    if (!enabled) return;
    void refreshRecovery();
    const late = setTimeout(() => void refreshRecovery(), LIVE_SESSION_GRACE_MS + 10_000);
    return () => clearTimeout(late);
  }, [enabled, refreshRecovery]);

  // ── connectivity return ──────────────────────────────────────────────
  // A capture stopped offline is retained as a spool session; when the
  // network comes back, re-list so the recovery banner (the retry
  // affordance) surfaces at exactly the moment Save can succeed — instead
  // of waiting for the next reload. Delayed past the grace window: the
  // retained session's last write may be seconds old.
  useEffect(() => {
    if (!enabled) return;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const onOnline = () => {
      void refreshRecovery();
      timers.push(setTimeout(() => void refreshRecovery(), LIVE_SESSION_GRACE_MS + 5_000));
    };
    window.addEventListener("online", onOnline);
    return () => {
      window.removeEventListener("online", onOnline);
      timers.forEach(clearTimeout);
    };
  }, [enabled, refreshRecovery]);

  // ── ?record=1 auto-start (desktop deep link) ─────────────────────────
  useEffect(() => {
    if (!enabled || typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("record") !== "1") return;
    params.delete("record");
    const query = params.toString();
    window.history.replaceState(null, "", `${window.location.pathname}${query ? `?${query}` : ""}`);
    dispatchRef.current({ type: "auto-start" });
    // Mount-once by design: the param is consumed and stripped.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [enabled]);

  // ── unmount: never leave the mic LED on ──────────────────────────────
  useEffect(() => {
    return () => {
      engineRef.current?.cancel();
      engineRef.current = null;
    };
  }, []);

  const onPressStart = useCallback(() => {
    if (!enabled) return;
    setNotice(null);
    if (phaseRef.current.kind === "idle") {
      pressStartedAtRef.current = Date.now();
      dispatch({ type: "press" });
    }
  }, [enabled, dispatch]);

  const onPressEnd = useCallback(
    (outside?: boolean) => {
      const kind = phaseRef.current.kind;
      if (kind !== "arming" && kind !== "holding") return;
      dispatch({ type: "release", heldMs: Date.now() - pressStartedAtRef.current, outside });
    },
    [dispatch],
  );

  const saveRecovery = useCallback(
    async (sessionId: string) => {
      const meta = recovery.find((s) => s.id === sessionId);
      if (!meta) return;
      try {
        const chunks = await spool().readChunks(sessionId);
        const safeToDrop = await handOff(assembleSpooledBlob(meta, chunks), meta.mime, meta.elapsedMs);
        // Same retention contract as a live stop: a cancelled confirm or a
        // failed upload keeps the session so Save can be retried.
        if (safeToDrop) await spool().deleteSession(sessionId);
      } catch {
        setNotice("failed");
      }
      void refreshRecovery();
    },
    [recovery, handOff, refreshRecovery],
  );

  const discardRecovery = useCallback(
    async (sessionId: string) => {
      await dropSpoolSession(sessionId);
      void refreshRecovery();
    },
    [refreshRecovery],
  );

  return {
    phase,
    active: phase.kind !== "idle",
    elapsedMs: useCallback(() => engineRef.current?.elapsedMs() ?? 0, []),
    notice,
    clearNotices: useCallback(() => setNotice(null), []),
    onPressStart,
    onPressEnd,
    stop: useCallback(() => dispatch({ type: "stop" }), [dispatch]),
    discard: useCallback(() => dispatch({ type: "discard" }), [dispatch]),
    pause: useCallback(() => dispatch({ type: "pause" }), [dispatch]),
    resume: useCallback(() => dispatch({ type: "resume" }), [dispatch]),
    level: useCallback(() => engineRef.current?.level() ?? 0, []),
    recovery,
    saveRecovery,
    discardRecovery,
  };
}
