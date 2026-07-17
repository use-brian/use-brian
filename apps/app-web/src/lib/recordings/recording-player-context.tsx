"use client";

/**
 * [COMP:recordings/player] — the recording player and its seek API.
 *
 * app-web had NO seek API before this: three `<audio>`/`<video>` tags in the
 * whole app, zero `currentTime` manipulation, no media ref, no waveform lib. A
 * citation had nothing to drive.
 *
 * PAGE CHROME, NOT A DOC BLOCK. The player is deliberately not a block in the
 * document. A block is user-editable content — the user can select it and press
 * delete, and then every citation on the page points at nothing. It would also
 * have to round-trip through Yjs and need `block-mapping` + `embed-view`
 * changes. As chrome it is always present, undeletable, and touches zero
 * doc-model surface.
 *
 * The context is what lets a citation ANYWHERE on the page drive the player
 * without prop-drilling through the editor.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { getRecordingMediaUrl } from "@/lib/api/recordings";

export type RecordingPlayerApi = {
  /** Null when the surrounding page has no recording — citations stay inert. */
  recordingId: string | null;
  /** Seek to a moment and play. The whole point of the context. */
  seekTo: (ms: number) => void;
  /** Current playhead, for highlighting the active transcript segment. */
  currentMs: number;
  /** Media duration once known; falls back to the stored `recordings.duration_ms`. */
  durationMs: number;
  isPlaying: boolean;
  togglePlay: () => void;
  /** True until the playback URL lands. */
  isLoading: boolean;
  /** Set when the media URL could not be minted; the bar renders the reason. */
  error: string | null;
  /**
   * The moment a citation asked to SHOW, or null. Distinct from `currentMs`:
   * seeking moves the playhead, but a reader clicking `[0:47:21]` in the brief
   * usually wants to *read around* that line, not just hear it — the audio may
   * even be unplayable while the transcript is perfectly readable. The chrome
   * watches this and pops the transcript card scrolled to the line.
   *
   * A monotonic `nonce` rides along so clicking the SAME citation twice
   * re-opens the card: the ms alone would be an unchanged value and the effect
   * would not re-fire.
   */
  transcriptFocus: { ms: number; nonce: number } | null;
  /** Ask the chrome to show the transcript at `ms`. */
  showTranscriptAt: (ms: number) => void;
  /** Dismiss the transcript card. */
  clearTranscriptFocus: () => void;
};

const NOOP: RecordingPlayerApi = {
  recordingId: null,
  seekTo: () => {},
  currentMs: 0,
  durationMs: 0,
  isPlaying: false,
  togglePlay: () => {},
  isLoading: false,
  error: null,
  transcriptFocus: null,
  showTranscriptAt: () => {},
  clearTranscriptFocus: () => {},
};

const Ctx = createContext<RecordingPlayerApi>(NOOP);

/**
 * Read the player. Safe outside a provider: `recordingId` is null, so a citation
 * on a page with no recording renders as plain text by construction rather than
 * as a dead link.
 */
export function useRecordingPlayer(): RecordingPlayerApi {
  return useContext(Ctx);
}

/** Refresh this long before `expiresAt` so a seek never races the expiry. */
const REFRESH_MARGIN_MS = 5 * 60 * 1000;

export function RecordingPlayerProvider({
  recordingId,
  durationMs: knownDurationMs = 0,
  children,
}: {
  recordingId: string | null;
  /** The stored duration, so the scrubber has a range before metadata loads. */
  durationMs?: number | null;
  children: ReactNode;
}) {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [currentMs, setCurrentMs] = useState(0);
  const [mediaDurationMs, setMediaDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** A seek requested before the URL landed — replayed once it does. */
  const pendingSeekMs = useRef<number | null>(null);

  const mint = useCallback(async () => {
    if (!recordingId) return;
    try {
      const media = await getRecordingMediaUrl(recordingId);
      setUrl(media.url);
      setExpiresAt(Date.parse(media.expiresAt));
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [recordingId]);

  useEffect(() => {
    setUrl(null);
    setExpiresAt(null);
    setError(null);
    void mint();
  }, [mint]);

  // Refresh BEFORE expiry rather than after a failure. A playback URL is a
  // time-limited bearer token; discovering that mid-scrub is a 403 the user
  // experiences as the player simply breaking.
  useEffect(() => {
    if (!expiresAt) return;
    const delay = Math.max(expiresAt - Date.now() - REFRESH_MARGIN_MS, 60_000);
    const t = setTimeout(() => void mint(), delay);
    return () => clearTimeout(t);
  }, [expiresAt, mint]);

  const seekTo = useCallback((ms: number) => {
    const el = audioRef.current;
    if (!el || !el.src) {
      // The URL has not landed yet — remember it and apply on load rather than
      // silently dropping the user's click.
      pendingSeekMs.current = ms;
      return;
    }
    el.currentTime = Math.max(0, ms / 1000);
    void el.play().catch(() => {
      /* autoplay policy — the seek still landed; the user can press play */
    });
  }, []);

  const togglePlay = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    if (el.paused) void el.play().catch(() => {});
    else el.pause();
  }, []);

  const [transcriptFocus, setTranscriptFocus] = useState<
    { ms: number; nonce: number } | null
  >(null);
  // The nonce makes a repeat click on the same citation re-open the card — the
  // ms alone would be an unchanged value and the consumer's effect would not
  // re-fire. A ref, not state: bumping it must not itself trigger a render.
  const focusNonce = useRef(0);
  const showTranscriptAt = useCallback((ms: number) => {
    focusNonce.current += 1;
    setTranscriptFocus({ ms, nonce: focusNonce.current });
  }, []);
  const clearTranscriptFocus = useCallback(() => setTranscriptFocus(null), []);

  const api = useMemo<RecordingPlayerApi>(
    () => ({
      recordingId,
      seekTo,
      currentMs,
      // Prefer what the media reports; fall back to the stored value so the
      // scrubber has a range before metadata loads.
      durationMs: mediaDurationMs || (knownDurationMs ?? 0),
      isPlaying,
      togglePlay,
      isLoading: recordingId != null && url == null && error == null,
      error,
      transcriptFocus,
      showTranscriptAt,
      clearTranscriptFocus,
    }),
    [
      recordingId,
      seekTo,
      currentMs,
      mediaDurationMs,
      knownDurationMs,
      isPlaying,
      togglePlay,
      url,
      error,
      transcriptFocus,
      showTranscriptAt,
      clearTranscriptFocus,
    ],
  );

  return (
    <Ctx.Provider value={api}>
      {recordingId ? (
        <audio
          ref={audioRef}
          {...(url ? { src: url } : {})}
          preload="metadata"
          className="hidden"
          onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
          onPlay={() => setIsPlaying(true)}
          onPause={() => setIsPlaying(false)}
          onLoadedMetadata={(e) => {
            const d = e.currentTarget.duration;
            if (Number.isFinite(d)) setMediaDurationMs(d * 1000);
            const ms = pendingSeekMs.current;
            if (ms != null) {
              pendingSeekMs.current = null;
              seekTo(ms);
            }
          }}
          onError={() => {
            // Most likely an expired URL (the token outlived the refresh timer —
            // e.g. the tab slept). Re-mint once and resume where we were.
            const at = audioRef.current?.currentTime ?? 0;
            pendingSeekMs.current = at * 1000;
            void mint();
          }}
        />
      ) : null}
      {children}
    </Ctx.Provider>
  );
}
