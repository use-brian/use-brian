"use client";
import { InteractionSessionUnavailable } from "./dock-recorder-bridge";

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

import { interactionRequest } from "@/lib/live-interaction/api";
import { startInteractionCapture } from "@/lib/live-interaction/capture";
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
  ScreenCaptureCancelledError,
  ScreenCaptureError,
  SystemAudioCaptureError,
} from "./audio-mixer";
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
import type { LiveRecordingPage } from "@/lib/api/recordings";
import type { LiveWindow } from "@/lib/recordings/use-live-recording-page";
import type { RecordingUploadStatus } from "@/lib/recordings/use-recording-upload";

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

export const COMPUTER_AUDIO_PREFERENCE_KEY =
  "recorder:include-computer-audio";

type RecorderPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function browserPreferenceStorage(): RecorderPreferenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/**
 * Missing/unreadable preferences default ON: the desktop recorder shipped
 * computer-audio capture before the split-button choice, so an upgrade must
 * preserve that behavior. Any value except the one canonical OFF marker is
 * treated as the safe migration default.
 */
export function readComputerAudioPreference(
  storage: RecorderPreferenceStorage | null = browserPreferenceStorage(),
): boolean {
  if (!storage) return true;
  try {
    return storage.getItem(COMPUTER_AUDIO_PREFERENCE_KEY) !== "0";
  } catch {
    return true;
  }
}

/** Best-effort device-local persistence; capture must still work if blocked. */
export function writeComputerAudioPreference(
  include: boolean,
  storage: RecorderPreferenceStorage | null = browserPreferenceStorage(),
): void {
  if (!storage) return;
  try {
    storage.setItem(COMPUTER_AUDIO_PREFERENCE_KEY, include ? "1" : "0");
  } catch {
    // Private/locked storage — keep the in-memory choice for this page.
  }
}

/** Old shells/browsers can never be promoted by a persisted true value. */
export function shouldCaptureComputerAudio(
  desktopCapability: boolean | undefined,
  includePreference: boolean,
): boolean {
  return desktopCapability === true && includePreference;
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
 * The transient notice under the recorder UI. Informational kinds:
 * "micHint" = first-use press-again; "kept" = the capture is safe on this
 * device and will surface as recovery, shown when the user closed the
 * cost-confirm (a deferral, not a failure); "autoStopped" / "pauseStopped"
 * = the auto-stop guards; "queued" = the long-lane hand-off completed and
 * the recording is transcribing in the background. The rest are errors —
 * including "handOffFailed", the long lane's upload / estimate / queue
 * step breaking. Both hand-off kinds carry `text`: the step-aware,
 * already-localized line `useRecordingUpload.run` composed, so the notice
 * says WHICH boundary broke (or that the 202 landed) on every dock surface,
 * collapsed included. Before this a failed hand-off and a cancelled confirm
 * both showed "kept", and the reason rendered only in the expanded
 * composer — a slot a collapsed meeting capture never shows. "kept" stays
 * deliberately not error-styled because it is not one; a failure IS, but
 * its copy still names the on-device copy so it never reads as loss.
 */
export type RecorderNotice =
  | {
      kind:
        | "micHint"
        | "kept"
        | "autoStopped"
        | "pauseStopped"
        | "denied"
        | "systemAudioFailed"
        | "screenCaptureFailed"
        | "failed"
        | "voiceFailed";
    }
  | { kind: "queued"; text: string; recordingId: string }
  | { kind: "handOffFailed"; text: string };

/**
 * What the long-lane hand-off (`useRecordingUpload.run`) resolved to. The
 * three branches decide BOTH the notice and spool retention: only `queued`
 * releases the spool copy (`handOffVerdict`).
 */
export type MeetingCaptureOutcome =
  | { outcome: "queued"; message: string; recordingId: string }
  | { outcome: "cancelled" }
  | { outcome: "failed"; message: string };

/**
 * Pure fork of a long-lane hand-off result into (notice, spool verdict).
 * Exported for the node tests; the hook's concurrency contract is covered
 * separately with controlled engine, spool, and upload boundaries.
 */
export function handOffVerdict(result: MeetingCaptureOutcome): {
  notice: RecorderNotice;
  safeToDrop: boolean;
} {
  switch (result.outcome) {
    case "queued":
      return {
        notice: {
          kind: "queued",
          text: result.message,
          recordingId: result.recordingId,
        },
        safeToDrop: true,
      };
    case "cancelled":
      return { notice: { kind: "kept" }, safeToDrop: false };
    case "failed":
      return { notice: { kind: "handOffFailed", text: result.message }, safeToDrop: false };
  }
}

/**
 * What the next capture records. `'mic'` is the unchanged default. `'screen'`
 * records the display (desktop: the primary display via the shell handler;
 * browser: whatever the native picker grants — screen, window, or tab, with
 * that pick's audio when the user shares it). `'window'` is desktop-only
 * (needs the shell's source picker) and records one chosen window.
 * Session-sticky, never persisted: recording pixels is a deliberate
 * per-session choice, unlike the computer-audio preference.
 */
export type RecorderCaptureSource = "mic" | "screen" | "window";
export type PreparedCaptureSource = {
  source: Exclude<RecorderCaptureSource, "mic">;
  id: string;
};

export type DockRecorderApi = {
  workspaceId: string;
  phase: RecorderPhase;
  /** True whenever the recorder owns the pill (anything but idle). */
  active: boolean;
  /** Upload/confirm jobs are independent of the active capture and chat. */
  savingCount: number;
  /** The active serial save's visible transport/pre-flight state. */
  saveProgress: {
    status: RecordingUploadStatus;
    uploadProgress: number;
    message: string;
  } | null;
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
  /** True only in a hydrated desktop shell that offers loopback capture. */
  computerAudioAvailable: boolean;
  /** Device-local source choice used by the next capture. */
  includeComputerAudio: boolean;
  /** Changes the next-capture source choice; ignored while recording. */
  setIncludeComputerAudio: (include: boolean) => void;
  /** Opt-in live page path for the next capture. */
  interactionAvailable: boolean | null;
  interactionEnabled: boolean;
  setInteractionEnabled: (enabled: boolean) => void;
  interactionStatus: "idle" | "listening" | "gap" | "unavailable";
  interactionCaptureId?: string | null;
  interactionChatSessionId?: string | null;
  livePageEnabled: boolean;
  setLivePageEnabled: (enabled: boolean) => void;
  /** Visible trust signal for desktop remote-call capture. */
  includesSystemAudio: () => boolean;
  /** True when this environment can record a screen at all (getDisplayMedia). */
  screenCaptureAvailable: boolean;
  /** True only in a desktop shell that can list screens/windows for an explicit pick. */
  capturePickerAvailable: boolean;
  /** What the next capture records; ignored while a capture runs. */
  captureSource: RecorderCaptureSource;
  setCaptureSource: (source: RecorderCaptureSource) => void;
  /** Visible trust signal: the RUNNING capture records the screen. */
  capturesScreen: () => boolean;
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
  /** Reactive state from the recorder's private, non-blocking upload lane. */
  saveProgress?: {
    status: RecordingUploadStatus;
    uploadProgress: number;
    message: string;
  };
  /** Short-lane hand-off: upload as a voice clip + auto-send the turn. Return false to surface the send error. */
  sendVoiceClip: (fileId: string) => Promise<boolean>;
  /** Session id accessor for the voice-clip cache upload (best-effort). */
  getSessionId?: () => string | undefined;
  ensureInteractionSession?: () => Promise<string>;
  /**
   * Long-lane hand-off: the recording ingestion flow (`useRecordingUpload.run`).
   * The outcome forks retention + the notice (`handOffVerdict`); a caller
   * that also reports inline should dismiss its own line, since the
   * recorder's notice now carries the same text on every dock surface.
   */
  onMeetingCapture: (
    file: File,
    live?: { pageId: string; sessionId?: string; liveWindowsDone?: Promise<void> },
  ) => Promise<MeetingCaptureOutcome>;
  /** Pre-flight confirm + destination creation; null means the user cancelled. */
  prepareLivePage?: (navigate?: boolean) => Promise<LiveRecordingPage | null>;
  /** Desktop screen/window chooser; null means the user cancelled. */
  prepareCaptureSource?: (
    initialSource: Exclude<RecorderCaptureSource, "mic">,
  ) => Promise<PreparedCaptureSource | null>;
  /** Sequential provisional-window upload. */
  streamLiveWindow?: (window: LiveWindow, page: LiveRecordingPage) => Promise<void>;
}): DockRecorderApi {
  const { enabled, workspaceId, assistantId, captureNamePrefix, saveProgress, sendVoiceClip, getSessionId, onMeetingCapture, prepareLivePage, prepareCaptureSource, streamLiveWindow } =
    opts;
  const [phase, setPhase] = useState<RecorderPhase>(IDLE);
  const [notice, setNotice] = useState<RecorderNotice | null>(null);
  const [recovery, setRecovery] = useState<SpoolSessionMeta[]>([]);
  const [savingCount, setSavingCount] = useState(0);
  const pendingSavesRef = useRef(new Set<string>());
  const saveTailRef = useRef<Promise<void>>(Promise.resolve());
  const mountedRef = useRef(true);
  // Start SSR + hydration in the browser-safe shape (no desktop-only
  // chevron), then resolve the preload capability and device preference
  // after mount. The ref is the capture-time authority, including for a
  // ?record=1 auto-start whose effect runs later in this same mount pass.
  const [computerAudioAvailable, setComputerAudioAvailable] = useState(false);
  const [includeComputerAudio, setIncludeComputerAudioState] = useState(true);
  const includeComputerAudioRef = useRef(true);
  const [screenCaptureAvailable, setScreenCaptureAvailable] = useState(false);
  const [capturePickerAvailable, setCapturePickerAvailable] = useState(false);
  const [captureSource, setCaptureSourceState] = useState<RecorderCaptureSource>("mic");
  const captureSourceRef = useRef<RecorderCaptureSource>("mic");
  const [interactionAvailable, setInteractionAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    void interactionRequest<{ available: boolean }>("/settings").then(({ available }) => {
      if (!cancelled) setInteractionAvailable(available);
    }).catch(() => { if (!cancelled) setInteractionAvailable(false); });
    return () => { cancelled = true; };
  }, []);
  const [interactionEnabled, setInteractionEnabledState] = useState(false);
  const interactionEnabledRef = useRef(false);
  const [interactionStatus, setInteractionStatus] = useState<"idle" | "listening" | "gap" | "unavailable">("idle");
  const [interactionCaptureId, setInteractionCaptureId] = useState<string | null>(null);
  const [interactionChatSessionId, setInteractionChatSessionId] = useState<string | null>(null);
  const interactionAbortRef = useRef<AbortController | null>(null);
  const interactionRef = useRef<ReturnType<typeof startInteractionCapture> | null>(null);
  const stopInteraction = useCallback((drain?: Promise<void>) => {
    if (!drain) interactionAbortRef.current?.abort();
    interactionAbortRef.current = null;
    const pending = interactionRef.current;
    interactionRef.current = null;
    setInteractionCaptureId(null);
    setInteractionChatSessionId(null);
    // Full-file upload no longer consumes this promise when interaction is off.
    // Observe failures even when no interaction session needs closing.
    void drain?.catch(() => {});
    if (pending) void (async () => {
      try { await drain; } catch { /* Still close this capture after a failed drain. */ }
      const capture = await pending;
      await capture.stop();
    })().catch(() => {});
    setInteractionStatus("idle");
  }, []);
  const ensureInteractionSessionRef = useRef(opts.ensureInteractionSession);
  ensureInteractionSessionRef.current = opts.ensureInteractionSession;
  const [livePageEnabled, setLivePageEnabledState] = useState(false);
  const livePageEnabledRef = useRef(false);
  const livePageRef = useRef<LiveRecordingPage | null>(null);

  const phaseRef = useRef<RecorderPhase>(IDLE);
  const engineRef = useRef<RecorderEngine | null>(null);
  /** Invalidates an async permission/pre-flight arm that was cancelled or superseded. */
  const armAttemptRef = useRef(0);
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

  useEffect(() => {
    const available = desktopBridge()?.systemAudioCapture === true;
    const include = available ? readComputerAudioPreference() : false;
    includeComputerAudioRef.current = include;
    setIncludeComputerAudioState(include);
    setComputerAudioAvailable(available);
    setScreenCaptureAvailable(
      typeof navigator.mediaDevices?.getDisplayMedia === "function",
    );
    setCapturePickerAvailable(desktopBridge()?.captureSourcePicker === true);
  }, []);

  const applyPhase = (next: RecorderPhase) => {
    phaseRef.current = next;
    setPhase(next);
  };

  const refreshRecovery = useCallback(async () => {
    try {
      const sessions = await spool().listSessions();
      setRecovery(recoverableSessions(sessions, engineRef.current?.spoolSessionId() ?? null)
        .filter((session) => !pendingSavesRef.current.has(session.id)));
    } catch {
      setRecovery([]);
    }
  }, []);

  // One uploader/confirmation at a time, without owning the capture phase.
  // The job closure snapshots its destination and callback at enqueue time.
  const enqueueSave = useCallback((id: string, job: () => Promise<void>, serial = true): Promise<void> => {
    if (pendingSavesRef.current.has(id)) return Promise.resolve();
    pendingSavesRef.current.add(id);
    setSavingCount(pendingSavesRef.current.size);
    setRecovery((sessions) => sessions.filter((session) => session.id !== id));
    // Voice prompts must not wait behind a meeting's cost confirmation.
    const next = (serial ? saveTailRef.current : Promise.resolve()).then(async () => {
      try {
        // Unmount retains the spooled work; never open a new confirm after exit.
        if (mountedRef.current) await job();
      } catch {
        if (mountedRef.current) setNotice({ kind: "failed" });
      } finally {
        pendingSavesRef.current.delete(id);
        if (mountedRef.current) {
          setSavingCount(pendingSavesRef.current.size);
          void refreshRecovery();
        }
      }
    });
    if (serial) saveTailRef.current = next;
    return next;
  }, [refreshRecovery]);

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
    async (
      blob: Blob,
      mime: string,
      durationMs: number,
      recoveredLive?: { pageId?: string; sessionId?: string; liveWindowsDone?: Promise<void> },
    ): Promise<boolean> => {
      // Never consult the current capture here: an older save may be queued
      // behind another upload while a different live page is recording.
      const livePageId = recoveredLive?.pageId;
      const liveSessionId = recoveredLive?.sessionId;
      // A video capture always takes the recording lane (the voice lane's
      // file cache is audio-only) — same rule as the dropped-file fork.
      const isVideo = mime.startsWith("video/");
      const lane: CaptureLane =
        livePageId && durationMs >= 2_000 ? "recording" : stopLane(durationMs, undefined, isVideo);
      if (lane === "discard") return true;
      const name = captureFileName(captureNamePrefix, new Date(), mime);
      if (lane === "voice") {
        const file = new File([blob], name, { type: mime });
        const fileId = await uploadVoiceClip(file, getSessionId?.());
        const sent = fileId ? await sendVoiceClip(fileId) : false;
        if (!sent) setNotice({ kind: "voiceFailed" });
        return sent;
      }
      const patched = await patchRecordingBlob(blob, durationMs);
      const file = new File([patched], name, { type: mime });
      // `useRecordingUpload.run` names its branch: queued (202 landed),
      // cancelled (the user closed the cost confirm — a deferral, "kept"),
      // or failed (upload / estimate / queue broke — the notice carries the
      // step-aware reason). Either non-queued branch retains the audio.
      const { notice: verdict, safeToDrop } = handOffVerdict(
        await onMeetingCapture(
          file,
          livePageId ? { pageId: livePageId, ...(liveSessionId ? { sessionId: liveSessionId } : {}),
            ...(recoveredLive?.liveWindowsDone ? { liveWindowsDone: recoveredLive.liveWindowsDone } : {}) } : undefined,
        ),
      );
      setNotice(verdict);
      return safeToDrop;
    },
    [captureNamePrefix, sendVoiceClip, getSessionId, onMeetingCapture],
  );

  const runEffect = useCallback(
    (effect: RecorderEffect) => {
      const engine = engineRef.current;
      switch (effect) {
        case "start-capture":
          void (async () => {
            const attempt = ++armAttemptRef.current;
            try {
              // Resolve the ORIGINAL destination before opening the page picker.
              let interactionChatId: string | undefined;
              if (interactionEnabledRef.current) {
                try {
                  interactionChatId = await ensureInteractionSessionRef.current?.();
                  if (!interactionChatId) throw new InteractionSessionUnavailable();
                }
                catch (error) {
                  setInteractionStatus(error instanceof InteractionSessionUnavailable ? "unavailable" : "gap");
                  dispatchRef.current({ type: "arm-failed" });
                  return;
                }
              }
              let livePage: LiveRecordingPage | null = null;
              if (livePageEnabledRef.current) {
                livePage = livePageRef.current ?? (await prepareLivePage?.(!interactionEnabledRef.current)) ?? null;
                if (!livePage) {
                  dispatchRef.current({ type: "arm-failed" });
                  return;
                }
                // Rollover may reuse a destination, never its mutable interaction
                // binding: old final windows can still be draining in parallel.
                livePage = { ...livePage, interactionCaptureId: undefined, onInteractionGap: undefined };
                livePageRef.current = livePage;
              }
              // A new desktop shell resolves every video source BEFORE the
              // engine opens anything. The chooser can switch between screen
              // and window; its confirmed type becomes the running trust
              // signal, while the confirmed id owns the shell's next one-shot
              // display-media grant. Cancel is a changed mind: idle, no notice.
              let source = captureSourceRef.current;
              if (
                source !== "mic" &&
                desktopBridge()?.captureSourcePicker === true &&
                prepareCaptureSource
              ) {
                const selection = await prepareCaptureSource(source);
                if (!selection) {
                  dispatchRef.current({ type: "arm-failed" });
                  return;
                }
                source = selection.source;
                captureSourceRef.current = selection.source;
                setCaptureSourceState(selection.source);
                try {
                  const grantSource = desktopBridge()?.setCaptureSource;
                  if (!grantSource) {
                    throw new Error("The desktop capture-source grant is unavailable");
                  }
                  grantSource(selection.id);
                } catch (cause) {
                  throw new ScreenCaptureError("The selected source could not be granted", {
                    cause,
                  });
                }
              } else if (source === "screen") {
                try {
                  // Version-skew fallback: an old shell grants its primary
                  // display. Clear any stale selection first.
                  desktopBridge()?.setCaptureSource?.(null);
                } catch {
                  // Older shell without the method.
                }
              }
              // The user may slide away while the destination modal or API is
              // open. Never proceed to microphone access for a cancelled arm.
              if (attempt !== armAttemptRef.current || phaseRef.current.kind !== "arming") return;
              let interactionPending: ReturnType<typeof startInteractionCapture> | null = null;
              const armedEngine = await createRecorderEngine({
                interactionEnabled: interactionEnabledRef.current,
                onInteractionGap: () => livePage?.onInteractionGap?.(),
                // New macOS/Windows shells advertise this capability, but
                // the device-local split-button choice owns whether THIS
                // capture uses it. OFF bypasses getDisplayMedia completely.
                // Old shells and browsers stay mic-only during version skew.
                includeSystemAudio: shouldCaptureComputerAudio(
                  desktopBridge()?.systemAudioCapture,
                  includeComputerAudioRef.current,
                ),
                // Screen capture keeps the display video track. In browsers
                // (no shell loopback promise) display audio is opportunistic:
                // mixed when the user's pick grants it, ordinary when absent.
                captureScreen: source !== "mic",
                opportunisticDisplayAudio:
                  source !== "mic" && desktopBridge()?.systemAudioCapture !== true,
                ...(livePage && streamLiveWindow
                  ? { onLiveWindow: async (window: LiveWindow) => {
                      await interactionPending?.catch(() => {});
                      await streamLiveWindow(window, livePage);
                    } }
                  : {}),
                // The capture died underneath us (mic unplugged / input
                // switched / system stream ended / recorder error). Finalize
                // instead of ticking a zombie clock: a latched meeting stops-
                // and-forks with whatever was captured (the confirm dialog
                // surfaces it); an unresolved press has nothing worth keeping.
                onUnexpectedEnd: () => {
                  const kind = phaseRef.current.kind;
                  if (kind === "latched") dispatchRef.current({ type: "stop" });
                  else if (kind === "holding" || kind === "arming") {
                    setNotice({ kind: "failed" });
                    dispatchRef.current({ type: "discard" });
                  }
                },
              });
              // Likewise, permission may resolve after a cancel or a newer
              // capture started. Release the stale stream instead of leaving a
              // recorder running with no state-machine owner.
              if (attempt !== armAttemptRef.current || phaseRef.current.kind !== "arming") {
                armedEngine.cancel();
                return;
              }
              engineRef.current = armedEngine;
              if (interactionEnabledRef.current && interactionChatId && livePage) {
                const abort = new AbortController();
                interactionAbortRef.current = abort;
                setInteractionChatSessionId(interactionChatId);
                setInteractionStatus("listening");
                livePage.onInteractionGap = () => {
                  if (mountedRef.current && interactionAbortRef.current === abort && !abort.signal.aborted) setInteractionStatus("gap");
                };
                interactionPending = interactionRef.current = startInteractionCapture(
                  { workspaceId, assistantId, pageId: livePage.pageId, chatSessionId: interactionChatId },
                  livePage.onInteractionGap,
                  abort.signal,
                  (captureId) => {
                    if (!abort.signal.aborted) {
                      livePage.interactionCaptureId = captureId;
                      if (interactionAbortRef.current === abort) setInteractionCaptureId(captureId);
                    }
                  },
                );
                void interactionRef.current.catch(() => livePage.onInteractionGap?.());
              }
              dispatchRef.current({ type: "armed" });
            } catch (err) {
              // A dismissed screen picker is a changed mind, not a failure —
              // return to idle silently.
              if (!(err instanceof ScreenCaptureCancelledError)) {
                setNotice({
                  kind:
                    err instanceof ScreenCaptureError
                      ? "screenCaptureFailed"
                      : err instanceof SystemAudioCaptureError
                        ? "systemAudioFailed"
                        : err instanceof DOMException && err.name === "NotAllowedError"
                          ? "denied"
                          : "failed",
                });
              }
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
              ...(livePageRef.current
                ? {
                    livePageId: livePageRef.current.pageId,
                    liveSessionId: livePageRef.current.sessionId,
                  }
                : {}),
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
          armAttemptRef.current += 1;
          setNotice({ kind: "micHint" });
          stopInteraction();
          engine?.cancel();
          engineRef.current = null;
          return;
        case "cancel-capture": {
          armAttemptRef.current += 1;
          const sessionId = engine?.spoolSessionId() ?? null;
          stopInteraction();
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
            const live = livePageRef.current;
            // Ceiling auto-stop: skip the hand-off entirely — running it
            // would pop the cost-confirm modal MID-CALL, a worse disturb
            // than the stop itself. The capture lands in the spool (the
            // engine's stop flushes the final chunk there) and processes
            // from the recovery banner whenever the user is ready.
            const skipHandOff = skipHandOffRef.current;
            skipHandOffRef.current = false;
            try {
              const stopping = eng.stop();
              // Detach now so a newer capture owns the UI, but keep this server
              // session alive until its final queued /live/chunk request settles.
              stopInteraction(stopping.then((capture) => capture.liveWindowsDone));
              const capture = await stopping;
              engineRef.current = null;
              const save = async () => {
                let safeToDrop = false;
                try {
                  if (!skipHandOff) {
                    if (mountedRef.current) {
                      // Full-file upload is independent of provisional ASR/notes.
                      // Only window-based fallback needs to await the final window.
                      safeToDrop = await handOff(capture.blob, capture.mime, capture.durationMs,
                        live ? { ...live, liveWindowsDone: capture.liveWindowsDone } : undefined);
                    }
                  }
                } catch {
                  setNotice({ kind: "failed" });
                } finally {
                  // Only THIS job's spool can be released, and only after
                  // queue/send success. Failure and cancel remain recoverable.
                  if (safeToDrop) {
                    await dropSpoolSession(sessionId);
                  } else {
                    if (!sessionId && await rescueCapture(capture)) setNotice({ kind: "kept" });
                    setTimeout(() => void refreshRecovery(), LIVE_SESSION_GRACE_MS + 5_000);
                  }
                }
              };
              const lane = live && capture.durationMs >= 2_000
                ? "recording"
                : stopLane(capture.durationMs, undefined, capture.mime.startsWith("video/"));
              if (!skipHandOff && lane !== "discard") {
                void enqueueSave(sessionId ?? crypto.randomUUID(), save, lane === "recording");
              } else {
                // Ceiling stops retain their spool without opening a processing
                // dialog; sub-floor clips can be discarded immediately.
                await save();
              }
            } catch {
              setNotice({ kind: "failed" });
              engineRef.current = null;
              setTimeout(() => void refreshRecovery(), LIVE_SESSION_GRACE_MS + 5_000);
            } finally {
              // Capture lifecycle ends at the local flush, NOT upload completion.
              // No background job may dispatch into or clear the next capture.
              dispatchRef.current({ type: "finished" });
              if (!rollOverRef.current) livePageRef.current = null;
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
    [workspaceId, assistantId, handOff, enqueueSave, refreshRecovery, prepareLivePage, prepareCaptureSource, streamLiveWindow],
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
          setNotice({ kind: "pauseStopped" });
          dispatchRef.current({ type: "stop" });
        }
        return;
      }
      pausedSinceRef.current = null;
      if (shouldAutoStop(engine.elapsedMs())) {
        skipHandOffRef.current = true;
        rollOverRef.current = true;
        setNotice({ kind: "autoStopped" });
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

  // ── beforeunload while capturing or saving ──────────────────────────
  const finishing = phase.kind === "finishing";
  useEffect(() => {
    if (!latched && !finishing && savingCount === 0) return;
    const guard = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", guard);
    return () => window.removeEventListener("beforeunload", guard);
  }, [latched, finishing, savingCount]);

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
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      stopInteraction();
      engineRef.current?.cancel();
      engineRef.current = null;
    };
  }, []);

  const onPressStart = useCallback(() => {
    if (!enabled) return;
    // A queued recording continues processing independently of the next
    // capture. Keep its tracker mounted until it is dismissed or replaced by
    // the next hand-off; starting again should only clear transient notices.
    setNotice((current) => current?.kind === "queued" ? current : null);
    if (phaseRef.current.kind === "idle") {
      pressStartedAtRef.current = Date.now();
      // Live transcription is meeting intent, so it always latches and never
      // resolves as a walkie-talkie gesture after pre-flight. A screen/window
      // capture latches for the same reason: press-and-hold walkie-talkie
      // makes no sense while a picker dialog resolves.
      dispatch({
        type:
          livePageEnabledRef.current || captureSourceRef.current !== "mic"
            ? "auto-start"
            : "press",
      });
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

  const setIncludeComputerAudio = useCallback(
    (include: boolean) => {
      if (!computerAudioAvailable || phaseRef.current.kind !== "idle") return;
      includeComputerAudioRef.current = include;
      setIncludeComputerAudioState(include);
      writeComputerAudioPreference(include);
    },
    [computerAudioAvailable],
  );

  const setLivePageEnabled = useCallback((next: boolean) => {
    if (phaseRef.current.kind !== "idle") return;
    if (!next && interactionEnabledRef.current) return;
    livePageEnabledRef.current = next;
    setLivePageEnabledState(next);
  }, []);

  const setCaptureSource = useCallback(
    (source: RecorderCaptureSource) => {
      if (phaseRef.current.kind !== "idle") return;
      if (source !== "mic" && !screenCaptureAvailable) return;
      if (source === "window" && !capturePickerAvailable) return;
      captureSourceRef.current = source;
      setCaptureSourceState(source);
    },
    [screenCaptureAvailable, capturePickerAvailable],
  );

  const saveRecovery = useCallback(
    async (sessionId: string) => {
      const meta = recovery.find((s) => s.id === sessionId);
      if (!meta) return;
      await enqueueSave(sessionId, async () => {
        const chunks = await spool().readChunks(sessionId);
        const safeToDrop = await handOff(
          assembleSpooledBlob(meta, chunks),
          meta.mime,
          meta.elapsedMs,
          meta.livePageId || meta.liveSessionId
            ? { pageId: meta.livePageId, sessionId: meta.liveSessionId }
            : undefined,
        );
        // Same retention contract as a live stop: a cancelled confirm or a
        // failed upload keeps the session so Save can be retried.
        if (safeToDrop) await spool().deleteSession(sessionId);
      });
    },
    [recovery, handOff, enqueueSave],
  );

  const discardRecovery = useCallback(
    async (sessionId: string) => {
      if (pendingSavesRef.current.has(sessionId)) return;
      await dropSpoolSession(sessionId);
      void refreshRecovery();
    },
    [refreshRecovery],
  );

  return {
    workspaceId,
    phase,
    active: phase.kind !== "idle",
    savingCount,
    saveProgress: saveProgress ?? null,
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
    computerAudioAvailable,
    includeComputerAudio,
    setIncludeComputerAudio,
    interactionAvailable,
    interactionEnabled,
    interactionStatus,
    interactionCaptureId,
    interactionChatSessionId,
    setInteractionEnabled: (next: boolean) => {
      if (next && (phaseRef.current.kind !== "idle" || !interactionAvailable)) return;
      interactionEnabledRef.current = next;
      setInteractionEnabledState(next);
      if (next) { livePageEnabledRef.current = true; setLivePageEnabledState(true); }
      else {
        if (livePageRef.current) delete livePageRef.current.interactionCaptureId;
        engineRef.current?.setInteractionEnabled(false);
        stopInteraction();
      }
    },
    livePageEnabled,
    setLivePageEnabled,
    includesSystemAudio: useCallback(
      () => engineRef.current?.includesSystemAudio() ?? false,
      [],
    ),
    screenCaptureAvailable,
    capturePickerAvailable,
    captureSource,
    setCaptureSource,
    capturesScreen: useCallback(
      () => engineRef.current?.capturesVideo() ?? false,
      [],
    ),
    recovery,
    saveRecovery,
    discardRecovery,
  };
}
