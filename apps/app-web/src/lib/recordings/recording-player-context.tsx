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
import { createPortal } from "react-dom";
import { mediaOwner, ownsMedia, readOfflineMedia, removeOfflineMedia, downloadOfflineMedia } from "./offline-media";
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
  /** Retry playback in place without discarding the document. */
  retry: () => void;
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
  /**
   * True once the minted media reports a `video/*` mime. The media element is
   * ONE `<video>` either way (a video element plays audio-only sources fine);
   * this tells surfaces whether a visible picture exists to stage.
   */
  isVideo: boolean;
  /**
   * Register the DOM node the video picture should render INTO (the
   * `RecordingVideoStage` container). The provider portals its media element
   * there, so a citation seek moves the SAME element the stage displays — the
   * frame follows the timestamp by construction. Null unregisters (unmount).
   */
  registerVideoStage: (el: HTMLElement | null) => void;
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
  retry: () => {},
  transcriptFocus: null,
  showTranscriptAt: () => {},
  clearTranscriptFocus: () => {},
  isVideo: false,
  registerVideoStage: () => {},
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
  mintMediaUrl,
  children,
}: {
  recordingId: string | null;
  /** The stored duration, so the scrubber has a range before metadata loads. */
  durationMs?: number | null;
  /**
   * Mint (or re-mint) the playback URL. Defaults to the authed
   * `/api/recordings/:id/media-url` call; the anonymous shared-page surface
   * passes the public source-scoped fetcher instead — same `{url, expiresAt}`
   * contract, so the refresh-before-expiry machinery is shared.
   */
  mintMediaUrl?: (signal?: AbortSignal) => Promise<{ url: string; expiresAt: string; mime?: string }>;
  children: ReactNode;
}) {
  const owner = mintMediaUrl ? null : mediaOwner();
  const ownerKey = JSON.stringify(owner);
  const audioRef = useRef<HTMLVideoElement | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [mediaMime, setMediaMime] = useState<string | null>(null);
  const [videoStage, setVideoStage] = useState<HTMLElement | null>(null);

  const [currentMs, setCurrentMs] = useState(0);
  const [mediaDurationMs, setMediaDurationMs] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Playback intent survives URL renewal, including a paused playhead. */
  const pendingSeek = useRef<{ ms: number; play: boolean } | null>(null);
  const retryRef = useRef<() => void>(() => {});
  const mediaErrorRef = useRef<() => void>(() => {});
  const retry = useCallback(() => retryRef.current(), []);

  useEffect(() => {
    let live = true;
    let inFlight = false;
    let currentUrl: string | null = null;
    const cacheOwner = owner;
    let localUrl: string | null = null;
    let download = new AbortController();
    const useLocal = async () => {
      if (!recordingId || !cacheOwner || !ownsMedia(cacheOwner)) return false;
      const blob = await readOfflineMedia(cacheOwner, recordingId);
      if (!live || terminal || !blob || !ownsMedia(cacheOwner)) return false;
      if (!localUrl) localUrl = URL.createObjectURL(blob);
      rememberPosition(); currentUrl = localUrl; setUrl(localUrl); setMediaMime(blob.type); setError(null);
      mediaFailed = false; return true;
    };
    let expiry = 0;
    let failures = 0;
    let terminal = false;
    let mediaFailed = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let activeRequest: AbortController | null = null;
    setUrl(null);
    setMediaMime(null);
    setMediaDurationMs(0);
    setCurrentMs(0);
    setIsPlaying(false);
    setError(null);

    const rememberPosition = () => {
      const el = audioRef.current;
      if (el && currentUrl && !pendingSeek.current) {
        pendingSeek.current = { ms: el.currentTime * 1000, play: !el.paused };
      }
    };
    const scheduleRetry = () => {
      clearTimeout(timer);
      if (terminal || failures >= 5) return;
      timer = setTimeout(() => { void mint(); }, Math.min(1000 * 2 ** failures++, 30_000));
    };
    const mint = async () => {
      if (!live || !recordingId || inFlight) return;
      clearTimeout(timer);
      inFlight = true;
      const request = new AbortController();
      activeRequest = request;
      const timeout = setTimeout(() => request.abort(), 15_000);
      try {
        const media = await Promise.race([
          mintMediaUrl ? mintMediaUrl(request.signal) : getRecordingMediaUrl(recordingId, request.signal),
          new Promise<never>((_, reject) => request.signal.addEventListener("abort", () => reject(new Error("Playback request interrupted")), { once: true })),
        ]);
        if (!live) return;
        const sameUrl = currentUrl === media.url;
        if (!sameUrl || mediaFailed) rememberPosition();
        currentUrl = media.url;
        const parsedExpiry = Date.parse(media.expiresAt);
        expiry = Number.isFinite(parsedExpiry) ? parsedExpiry : Date.now() + 6 * 60_000;
        setUrl(media.url);
        if (media.mime !== undefined) setMediaMime(media.mime);
        if (cacheOwner && ownsMedia(cacheOwner)) {
          void readOfflineMedia(cacheOwner, recordingId).then(blob => {
            if (!blob && live) return downloadOfflineMedia(cacheOwner, recordingId, media.url,
              AbortSignal.any([download.signal, AbortSignal.timeout(120_000)]));
          }).catch(() => {});
        }
        setError(null);
        // A signer can return the same URL. React won't reload an unchanged src.
        if (sameUrl && mediaFailed) audioRef.current?.load();
        mediaFailed = false;
        timer = setTimeout(() => { void mint(); }, Math.max(expiry - Date.now() - REFRESH_MARGIN_MS, 60_000));
      } catch (err) {
        if (!live) return;
        const status = err && typeof err === "object" && "status" in err ? err.status : undefined;
        terminal = status === 401 || status === 403 || status === 404;
        if (terminal) {
          download.abort();
          if (cacheOwner) void removeOfflineMedia(cacheOwner, recordingId).catch(() => {});
          currentUrl = null;
          audioRef.current?.pause();
          audioRef.current?.removeAttribute("src");
          audioRef.current?.load();
          setUrl(null);
          setIsPlaying(false);
          pendingSeek.current = null;
        }
        if (!terminal && (!currentUrl || mediaFailed) && await useLocal().catch(() => false)) return;
        // Failed renewal must not hide a usable buffered source.
        if (!currentUrl || mediaFailed) setError(err instanceof Error ? err.message : String(err));
        scheduleRetry();
      } finally {
        clearTimeout(timeout);
        activeRequest = null;
        inFlight = false;
      }
    };
    const retryNow = () => {
      if (download.signal.aborted) download = new AbortController();
      terminal = false;
      failures = 0;
      void mint();
    };
    const recover = () => {
      if (document.visibilityState === "hidden" || terminal) return;
      if (!currentUrl || mediaFailed || expiry - Date.now() <= REFRESH_MARGIN_MS) retryNow();
    };
    retryRef.current = retryNow;
    mediaErrorRef.current = () => {
      if (terminal) return;
      rememberPosition();
      mediaFailed = true;
      setIsPlaying(false);
      setError("Media unavailable");
      scheduleRetry();
    };
    void useLocal().catch(() => {});
    void mint();
    window.addEventListener("online", recover);
    window.addEventListener("focus", recover);
    document.addEventListener("visibilitychange", recover);
    return () => {
      live = false;
      download.abort();
      if (localUrl) URL.revokeObjectURL(localUrl);
      activeRequest?.abort();
      pendingSeek.current = null;
      clearTimeout(timer);
      retryRef.current = () => {};
      mediaErrorRef.current = () => {};
      window.removeEventListener("online", recover);
      window.removeEventListener("focus", recover);
      document.removeEventListener("visibilitychange", recover);
    };
  }, [recordingId, mintMediaUrl, ownerKey]);

  const seekTo = useCallback((ms: number) => {
    const el = audioRef.current;
    if (!el || !el.src) {
      // The URL has not landed yet — remember it and apply on load rather than
      // silently dropping the user's click.
      pendingSeek.current = { ms, play: true };
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
  const registerVideoStage = useCallback((el: HTMLElement | null) => setVideoStage(el), []);
  const isVideo = mediaMime?.startsWith("video/") ?? false;

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
      retry,
      transcriptFocus,
      showTranscriptAt,
      clearTranscriptFocus,
      isVideo,
      registerVideoStage,
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
      retry,
      transcriptFocus,
      showTranscriptAt,
      clearTranscriptFocus,
      isVideo,
      registerVideoStage,
    ],
  );

  // ONE media element for audio and video alike — a `<video>` element plays an
  // audio-only source exactly as `<audio>` did, and using one element means a
  // recording's playhead, seek API, and (for video) its picture can never
  // disagree. When a surface registers a stage and the media is video, the
  // element PORTALS into the stage; otherwise it stays hidden chrome.
  const staged = isVideo && videoStage != null;
  const media = recordingId ? (
    <video
      ref={audioRef}
      {...(url ? { src: url } : {})}
      preload="metadata"
      playsInline
      className={staged ? "h-full w-full object-contain" : "hidden"}
      onClick={staged ? togglePlay : undefined}
      onTimeUpdate={(e) => setCurrentMs(e.currentTarget.currentTime * 1000)}
      onPlay={() => setIsPlaying(true)}
      onPause={() => setIsPlaying(false)}
      onLoadedMetadata={(e) => {
        const d = e.currentTarget.duration;
        if (Number.isFinite(d)) setMediaDurationMs(d * 1000);
        const intent = pendingSeek.current;
        if (intent) {
          pendingSeek.current = null;
          e.currentTarget.currentTime = Math.max(0, intent.ms / 1000);
          if (intent.play) void e.currentTarget.play().catch(() => {});
        }
      }}
      onError={() => mediaErrorRef.current()}
    />
  ) : null;

  return (
    <Ctx.Provider value={api}>
      {staged && media && videoStage ? createPortal(media, videoStage) : media}
      {children}
    </Ctx.Provider>
  );
}

/**
 * The visible picture for a video recording — the container the provider
 * portals its media element into. Renders nothing visible for an audio
 * recording (and unregisters cleanly on unmount), so every surface can mount
 * it unconditionally above its player bar. Clicking the picture toggles play;
 * a `[H:MM:SS]` citation click seeks the same element, so the stage lands on
 * that exact frame.
 */
export function RecordingVideoStage({ className }: { className?: string }) {
  const { isVideo, registerVideoStage } = useRecordingPlayer();
  return (
    <div
      ref={registerVideoStage}
      className={
        isVideo
          ? `aspect-video w-full overflow-hidden rounded-md border border-border bg-black ${className ?? ""}`
          : "hidden"
      }
    />
  );
}
