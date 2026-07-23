"use client";

/**
 * Take-Over live view — `/w/[workspaceId]/computer/[sessionId]`.
 *
 * Renders as the detail pane of the Browsers operator surface: the layout
 * shell (`browsers-surface-shell.tsx`) frames this with the operator top bar
 * and the left live-session rail, so this page owns only the frame + controls.
 *
 * The web half of §4.8: a live look at the cloud sandbox browser for one
 * chat session's computer task. Transport ladder, best-first:
 *
 *   1. Duplex WebSocket straight to the sandbox bridge (binary JPEG frames
 *      down, JSON input up — sub-second, damage-driven, hover relay).
 *   2. SSE frames + per-event POST input against the same bridge (older
 *      backend or a WS-hostile network).
 *   3. The ~1 fps API frame poll + API input relay (bridge unreachable) —
 *      shown as "Delayed view", with periodic re-mint attempts to climb
 *      back up the ladder.
 *
 * Whichever rung is live, frames land through one `createFrameGate`: decoded
 * off-screen first, committed to the <img> second, so the view never blanks
 * between frames (a raw `src` swap discards what the element already painted).
 *
 * Clicks and keys forward into the page scaled to the real viewport (the
 * password never leaves the sandbox page); the first wheel tick of a scroll
 * relays immediately; a click shows a local ripple so the ocean round-trip
 * reads as feedback, not deadness. "I signed in" captures the session into a
 * profile; closing/stopping ends the task (close-to-stop). Channel tasks
 * (Telegram/Slack) deep-link here when they hit a login wall.
 *
 * `?flow=login&site=<site>` marks a Profile-Management "Sign in to a site"
 * task (§7): the site prefills from the query, and a successful capture
 * offers "Done" — completing the task (the sandbox existed only for this
 * sign-in) and returning to the workspace. A chat task never shows Done:
 * completing it would kill the sandbox the assistant is still using.
 *
 * [COMP:app-web/sandbox-takeover] — spec: docs/architecture/engine/computer-use.md §5.
 */

import { use as usePromise, useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  LOCAL_ONLY_KEYS,
  createFrameGate,
  createWheelForwarder,
  mapClickToFrame,
  normalizeNavigateUrl,
} from "@/lib/computer-takeover";
import {
  SearchableSelect,
  type SearchableSelectItem,
} from "@/components/ui/searchable-select";
import {
  completeComputerTask,
  getComputerFrame,
  getComputerTask,
  listBrowserProfiles,
  markComputerSessionCaptured,
  mintComputerStreamSession,
  resumeComputerTask,
  sendComputerInput,
  sendStreamInput,
  type ComputerTask,
  type TakeoverInput,
  type TakeoverStreamSession,
} from "@/lib/api/computer";

const FRAME_INTERVAL_MS = 1_200;
const MOVE_THROTTLE_MS = 50;
const REMINT_INTERVAL_MS = 20_000;
const REMINT_MAX_ATTEMPTS = 3;

type StreamMode = "connecting" | "ws" | "sse" | "poll";

/**
 * Decode a frame off-screen so the visible <img> only ever swaps to a picture
 * the browser can paint immediately. `decode()` is the fast path; a browser
 * that rejects it (or lacks it) falls back to the load event, so a frame is
 * never stuck behind a decode quirk.
 */
function decodeFrame(src: string): Promise<void> {
  const probe = new Image();
  probe.decoding = "async";
  probe.src = src;
  const settled = () =>
    new Promise<void>((resolve, reject) => {
      if (probe.complete) {
        if (probe.naturalWidth > 0) resolve();
        else reject(new Error("frame decode failed"));
        return;
      }
      probe.onload = () => resolve();
      probe.onerror = () => reject(new Error("frame decode failed"));
    });
  return typeof probe.decode === "function" ? probe.decode().catch(settled) : settled();
}

export default function ComputerTakeoverPage(props: {
  params: Promise<{ workspaceId: string; sessionId: string }>;
}) {
  const { workspaceId, sessionId } = usePromise(props.params);
  const t = useT();
  const router = useRouter();

  // Read once from the URL (window.location over useSearchParams keeps this
  // fully-client page out of the Suspense-boundary requirement).
  const [loginFlow] = useState(() => {
    if (typeof window === "undefined") return { isLogin: false, site: "" };
    const params = new URLSearchParams(window.location.search);
    return { isLogin: params.get("flow") === "login", site: params.get("site") ?? "" };
  });

  const [task, setTask] = useState<ComputerTask | null | "loading">("loading");
  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [stalled, setStalled] = useState(false);
  const [stream, setStream] = useState<TakeoverStreamSession | null>(null);
  const [mode, setMode] = useState<StreamMode>("connecting");
  const [ripple, setRipple] = useState<{ x: number; y: number; id: number } | null>(null);
  const [site, setSite] = useState("");
  const [capturing, setCapturing] = useState(false);
  const [captureStatus, setCaptureStatus] = useState<
    "idle" | "saved" | "failed" | "profile_required"
  >("idle");
  // Profile the session saves into when the task started identity-less (R2-4).
  const [profileItems, setProfileItems] = useState<SearchableSelectItem[]>([]);
  const [profileId, setProfileId] = useState<string>("");
  // The take-over toolbar's address bar (§5). Local until submitted — never
  // forwarded as keystrokes, only as a `navigate` goto.
  const [address, setAddress] = useState("");
  const imgRef = useRef<HTMLImageElement | null>(null);
  const frameBoxRef = useRef<HTMLDivElement | null>(null);
  const naturalSize = useRef<{ w: number; h: number } | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<TakeoverStreamSession | null>(null);
  streamRef.current = stream;

  // Every transport pushes frames through one gate: decode first, commit
  // second. Handing a fresh `src` straight to the <img> clears what it has
  // already painted until the new JPEG decodes — one blank frame per arrival,
  // which is the flicker on a damage-driven stream. The gate also owns the
  // object-url lifetime, so a url is freed only once it is off screen.
  const gateRef = useRef<ReturnType<typeof createFrameGate> | null>(null);
  if (!gateRef.current) {
    gateRef.current = createFrameGate({
      decode: decodeFrame,
      commit: setFrameSrc,
      release: (src) => {
        if (src.startsWith("blob:")) URL.revokeObjectURL(src);
      },
    });
  }
  useEffect(() => () => gateRef.current?.dispose(), []);

  // Arrival = the Take-Over begins: resolve the task and resume the paused
  // sandbox (§4.8 pauses it during the wait, not during the takeover).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const found = await getComputerTask(sessionId).catch(() => null);
      if (cancelled) return;
      setTask(found);
      if (found) {
        setSite(found.injectedSite ?? loginFlow.site);
        await resumeComputerTask(sessionId).catch(() => {});
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, loginFlow.site]);

  // Mint the live stream once the task is resolved. Any failure lands on
  // the polled fallback below - nothing breaks.
  useEffect(() => {
    if (!task || task === "loading") return;
    let cancelled = false;
    void mintComputerStreamSession(sessionId)
      .then((info) => {
        if (cancelled) return;
        setStream(info);
        setMode(info ? (info.wsUrl ? "ws" : "sse") : "poll");
      })
      .catch(() => {
        if (!cancelled) setMode("poll");
      });
    return () => {
      cancelled = true;
    };
  }, [task, sessionId]);

  // Rung 1 - duplex WebSocket: binary JPEG frames in, input out on the same
  // socket. Frames render via short-lived object URLs (no base64 inflation);
  // the gate holds each one until it decodes and frees it once superseded.
  useEffect(() => {
    if (!task || task === "loading" || mode !== "ws" || !stream?.wsUrl) return;
    let cancelled = false;
    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let failures = 0;
    const connect = () => {
      if (cancelled) return;
      ws = new WebSocket(stream.wsUrl as string);
      ws.binaryType = "blob";
      ws.onopen = () => {
        failures = 0;
        wsRef.current = ws;
      };
      ws.onmessage = (ev) => {
        if (!(ev.data instanceof Blob)) return;
        setStalled(false);
        gateRef.current?.push(URL.createObjectURL(ev.data));
      };
      const drop = () => {
        if (wsRef.current === ws) wsRef.current = null;
        if (cancelled) return;
        setStalled(true);
        failures += 1;
        // Two straight connection failures means the socket path is out
        // (proxy, extension, network) - drop one rung to SSE.
        if (failures >= 2) setMode("sse");
        else retryTimer = setTimeout(connect, 1_000);
      };
      ws.onclose = drop;
      ws.onerror = () => ws?.close();
    };
    connect();
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      wsRef.current = null;
      try {
        ws?.close();
      } catch {
        /* already closed */
      }
    };
  }, [task, mode, stream]);

  // Rung 2 - SSE from the bridge. Frames are JSON with a base64 JPEG in
  // `data`; the stream is damage-driven, so a static page sending nothing is
  // normal, and only transport errors count as stalls.
  useEffect(() => {
    if (!task || task === "loading" || mode !== "sse" || !stream) return;
    let errors = 0;
    const es = new EventSource(stream.framesUrl);
    const onFrame = (ev: MessageEvent) => {
      errors = 0;
      setStalled(false);
      try {
        const parsed = JSON.parse(String(ev.data)) as { data?: string };
        if (parsed.data) gateRef.current?.push(`data:image/jpeg;base64,${parsed.data}`);
      } catch {
        /* malformed frame - keep the last good one */
      }
    };
    es.addEventListener("frame", onFrame);
    es.onerror = () => {
      errors += 1;
      setStalled(true);
      // EventSource retries by itself; two straight failures means the
      // bridge is gone - drop to the polled fallback.
      if (errors >= 2) {
        es.close();
        setStream(null);
        setMode("poll");
      }
    };
    return () => {
      es.removeEventListener("frame", onFrame);
      es.close();
    };
  }, [task, sessionId, mode, stream]);

  // Rung 3 - the API frame poll (bridge unreachable).
  useEffect(() => {
    if (!task || task === "loading" || mode !== "poll") return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const frame = await getComputerFrame(sessionId).catch(() => null);
      if (cancelled) return;
      if (frame) {
        gateRef.current?.push(`data:${frame.mimeType};base64,${frame.data}`);
        setStalled(false);
      } else {
        setStalled(true);
      }
      timer = setTimeout(() => void tick(), FRAME_INTERVAL_MS);
    };
    void tick();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [task, sessionId, mode]);

  // While polled, periodically try to climb back up the ladder - a bridge
  // that was mid-restart (or a flaky hop) should not demote the whole visit.
  useEffect(() => {
    if (!task || task === "loading" || mode !== "poll") return;
    let cancelled = false;
    let attempts = 0;
    const timer = setInterval(() => {
      if (cancelled || attempts >= REMINT_MAX_ATTEMPTS) return;
      attempts += 1;
      void mintComputerStreamSession(sessionId)
        .then((info) => {
          if (cancelled || !info) return;
          setStream(info);
          setMode(info.wsUrl ? "ws" : "sse");
        })
        .catch(() => {});
    }, REMINT_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [task, sessionId, mode]);

  // One input door, best transport first: the duplex socket, the bridge's
  // POST route, then the API relay. `move` is socket-only by design.
  const forwardInput = useCallback(
    (event: TakeoverInput) => {
      const ws = wsRef.current;
      if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(event));
        return;
      }
      if (event.kind === "move") return;
      const apiEvent: TakeoverInput =
        event.kind === "click" ? { kind: "click", x: event.x, y: event.y } : event;
      const live = streamRef.current;
      if (live) {
        void sendStreamInput(live.inputUrl, event).then((ok) => {
          if (!ok) void sendComputerInput(sessionId, apiEvent);
        });
      } else {
        void sendComputerInput(sessionId, apiEvent);
      }
    },
    [sessionId],
  );

  const forwardClick = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const img = imgRef.current;
      const natural = naturalSize.current;
      if (!img || !natural) return;
      const point = mapClickToFrame(img.getBoundingClientRect(), natural, e.clientX, e.clientY);
      if (!point) return; // letterbox bar — nothing under it in the frame
      const box = frameBoxRef.current?.getBoundingClientRect();
      if (box) {
        setRipple({ x: e.clientX - box.left, y: e.clientY - box.top, id: Date.now() });
      }
      forwardInput({
        kind: "click",
        x: point.x,
        y: point.y,
        frameW: natural.w,
        frameH: natural.h,
      });
    },
    [forwardInput],
  );
  useEffect(() => {
    if (!ripple) return;
    const timer = setTimeout(() => setRipple(null), 450);
    return () => clearTimeout(timer);
  }, [ripple]);

  // Hover relay (socket-only): dropdown menus and hover states stay alive
  // under the viewer's cursor. Throttled, latest-position-wins.
  const moveLast = useRef(0);
  const moveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const forwardMove = useCallback(
    (e: React.MouseEvent<HTMLImageElement>) => {
      const ws = wsRef.current;
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const img = imgRef.current;
      const natural = naturalSize.current;
      if (!img || !natural) return;
      const point = mapClickToFrame(img.getBoundingClientRect(), natural, e.clientX, e.clientY);
      if (!point) return;
      const send = () => {
        moveLast.current = Date.now();
        forwardInput({ kind: "move", x: point.x, y: point.y, frameW: natural.w, frameH: natural.h });
      };
      if (Date.now() - moveLast.current >= MOVE_THROTTLE_MS) {
        send();
      } else if (!moveTimer.current) {
        moveTimer.current = setTimeout(() => {
          moveTimer.current = null;
          send();
        }, MOVE_THROTTLE_MS);
      }
    },
    [forwardInput],
  );
  useEffect(
    () => () => {
      if (moveTimer.current) clearTimeout(moveTimer.current);
    },
    [],
  );

  const forwardKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.metaKey || e.ctrlKey) return; // browser shortcuts stay local
      e.preventDefault();
      const text = e.key;
      if (!text || LOCAL_ONLY_KEYS.has(text)) return;
      forwardInput({ kind: "key", text });
    },
    [forwardInput],
  );

  // Wheel forwarding: leading-edge dispatch (the page starts moving on the
  // first tick), then one relayed scroll per flush window.
  const wheel = useRef<ReturnType<typeof createWheelForwarder> | null>(null);
  const forwardWheel = useCallback(
    (e: React.WheelEvent<HTMLDivElement>) => {
      if (!wheel.current) {
        wheel.current = createWheelForwarder((deltaY) => forwardInput({ kind: "scroll", deltaY }));
      }
      wheel.current.add(e.deltaY);
    },
    [forwardInput],
  );
  useEffect(
    () => () => {
      wheel.current?.dispose();
      wheel.current = null;
    },
    [],
  );

  // Browser-chrome navigation from the toolbar (§5): back/forward/reload need
  // no payload; the address bar normalizes to an http(s) url first (a bad
  // scheme is dropped here and re-rejected at the seam).
  const forwardNavigate = useCallback(
    (action: "back" | "forward" | "reload") => forwardInput({ kind: "navigate", action }),
    [forwardInput],
  );
  const onNavigateTo = useCallback(() => {
    const url = normalizeNavigateUrl(address);
    if (!url) return;
    forwardInput({ kind: "navigate", action: "goto", url });
  }, [address, forwardInput]);

  // An identity-less task needs a profile to save into (409 profile_required)
  // — offer the workspace's profiles to pick from.
  useEffect(() => {
    if (!task || task === "loading" || task.profileId) return;
    let cancelled = false;
    void listBrowserProfiles(workspaceId)
      .then((res) => {
        if (cancelled) return;
        setProfileItems(res.profiles.map((p) => ({ value: p.id, label: p.name })));
        if (res.profiles.length === 1) setProfileId(res.profiles[0].id);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [task, workspaceId]);

  const onCaptured = useCallback(async () => {
    const target = site.trim();
    if (!target) return;
    setCapturing(true);
    const result = await markComputerSessionCaptured(
      sessionId,
      target,
      profileId || undefined,
    ).catch(() => ({ ok: false, profileRequired: false }));
    setCapturing(false);
    setCaptureStatus(result.ok ? "saved" : result.profileRequired ? "profile_required" : "failed");
  }, [profileId, sessionId, site]);

  // Login-flow exit: the sandbox existed only for this sign-in, so a
  // successful capture can complete the task (capture + kill) and go home.
  const onLoginDone = useCallback(async () => {
    await completeComputerTask(sessionId, "completed").catch(() => {});
    router.push(`/w/${workspaceId}`);
  }, [router, sessionId, workspaceId]);

  const onStop = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t.computer.stopConfirmTitle,
      description: t.computer.stopConfirmBody,
      confirmLabel: t.computer.stopConfirmAction,
    });
    if (!confirmed) return;
    await completeComputerTask(sessionId, "failed").catch(() => {});
    // Return to the Browsers surface index — the session rail keeps any other
    // live sessions in view, rather than dropping to the workspace root.
    router.push(`/w/${workspaceId}/computer`);
  }, [router, sessionId, t, workspaceId]);

  if (task === "loading") {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        {t.computer.connecting}
      </div>
    );
  }

  if (!task) {
    return (
      <div className="flex h-full items-center justify-center p-8">
        <p className="max-w-md text-center text-sm text-muted-foreground">{t.computer.noTask}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-3 p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <h1 className="text-base font-semibold">{t.computer.liveViewTitle}</h1>
            {mode === "ws" || mode === "sse" ? (
              <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-emerald-500" />
                {t.computer.streamLive}
              </span>
            ) : mode === "poll" ? (
              <span className="flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                <span className="h-1.5 w-1.5 rounded-full bg-amber-500" />
                {t.computer.streamDelayed}
              </span>
            ) : null}
          </div>
          <p className="mt-0.5 max-w-xl text-xs text-muted-foreground">{t.computer.liveViewSubtitle}</p>
        </div>
        <button
          type="button"
          onClick={() => void onStop()}
          className="shrink-0 rounded-md border border-destructive/40 px-3 py-1.5 text-xs font-medium text-destructive hover:bg-destructive/10"
        >
          {t.computer.stopTask}
        </button>
      </div>

      {/* Browser chrome (§5) — back/forward/reload + address bar. Kept OUTSIDE
          the frame box so typing an address never forwards as page keystrokes. */}
      <div className="flex items-center gap-1 rounded-lg border border-border bg-muted/20 p-1.5">
        <button
          type="button"
          aria-label={t.computer.navBack}
          title={t.computer.navBack}
          onClick={() => forwardNavigate("back")}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M13 8H3m0 0l4-4M3 8l4 4" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={t.computer.navForward}
          title={t.computer.navForward}
          onClick={() => forwardNavigate("forward")}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M3 8h10m0 0l-4-4m4 4l-4 4" />
          </svg>
        </button>
        <button
          type="button"
          aria-label={t.computer.navReload}
          title={t.computer.navReload}
          onClick={() => forwardNavigate("reload")}
          className="rounded-md p-1.5 text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 16 16"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9M13.5 2v3h-3" />
          </svg>
        </button>
        <form
          className="flex flex-1 items-center gap-2 pl-1"
          onSubmit={(e) => {
            e.preventDefault();
            onNavigateTo();
          }}
        >
          <input
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder={t.computer.addressPlaceholder}
            aria-label={t.computer.addressBarLabel}
            inputMode="url"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-sm"
          />
          <button
            type="submit"
            className="shrink-0 rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
          >
            {t.computer.navGo}
          </button>
        </form>
      </div>

      <div
        ref={frameBoxRef}
        role="application"
        aria-label={t.computer.liveViewTitle}
        tabIndex={0}
        onKeyDown={forwardKey}
        onWheel={forwardWheel}
        className="relative flex-1 overflow-hidden rounded-lg border border-border bg-muted/30 outline-none focus:ring-2 focus:ring-ring"
      >
        {frameSrc ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img
            ref={imgRef}
            src={frameSrc}
            alt=""
            draggable={false}
            decoding="async"
            onLoad={(e) => {
              naturalSize.current = {
                w: e.currentTarget.naturalWidth,
                h: e.currentTarget.naturalHeight,
              };
            }}
            onClick={forwardClick}
            onMouseMove={forwardMove}
            className="h-full w-full cursor-pointer select-none object-contain"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {t.computer.connecting}
          </div>
        )}
        {ripple ? (
          <span
            key={ripple.id}
            className="pointer-events-none absolute h-5 w-5 animate-ping rounded-full border-2 border-primary/70"
            style={{ left: ripple.x - 10, top: ripple.y - 10 }}
          />
        ) : null}
        {stalled ? (
          <div className="absolute inset-x-0 bottom-0 bg-background/80 px-3 py-1.5 text-center text-xs text-muted-foreground">
            {t.computer.frameStalled}
          </div>
        ) : null}
      </div>

      <div className="flex flex-wrap items-end gap-2 rounded-lg border border-border p-3">
        <label className="flex min-w-56 flex-1 flex-col gap-1 text-xs font-medium">
          {t.computer.siteInputLabel}
          <input
            value={site}
            onChange={(e) => setSite(e.target.value)}
            placeholder="github.com"
            className="rounded-md border border-border bg-background px-2 py-1.5 text-sm font-normal"
          />
        </label>
        {task.profileId === null && profileItems.length > 0 ? (
          <label className="flex min-w-44 flex-col gap-1 text-xs font-medium">
            {t.computer.profileLabel}
            <SearchableSelect
              value={profileId}
              onValueChange={setProfileId}
              items={profileItems}
              aria-label={t.computer.profileLabel}
              popupClassName="w-64"
            />
          </label>
        ) : null}
        <button
          type="button"
          disabled={capturing || site.trim().length === 0}
          onClick={() => void onCaptured()}
          className="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
        >
          {t.computer.signedInCta}
        </button>
        <p className="w-full text-[11px] text-muted-foreground">{t.computer.signedInHint}</p>
        {captureStatus !== "idle" ? (
          <p
            role="status"
            className={
              captureStatus === "saved"
                ? "w-full text-[11px] text-primary"
                : "w-full text-[11px] text-destructive"
            }
          >
            {captureStatus === "saved"
              ? t.computer.captureSuccess
              : captureStatus === "profile_required"
                ? t.computer.profileRequired
                : t.computer.captureFailed}
          </p>
        ) : null}
        {loginFlow.isLogin && captureStatus === "saved" ? (
          <button
            type="button"
            onClick={() => void onLoginDone()}
            className="rounded-md border border-border px-3 py-1.5 text-xs font-medium hover:bg-accent"
          >
            {t.computer.loginDoneCta}
          </button>
        ) : null}
      </div>
    </div>
  );
}
