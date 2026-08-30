"use client";

/**
 * Live watch pane — token-by-token body of one focused session. The parent
 * Live surface owns the shared top-bar title and Open-in-chat action.
 * (docs/architecture/features/live-work.md §5.1).
 *
 * Reuse, not invention: transcript history loads once through the existing
 * `GET /api/sessions/:id/messages` (same `gateSessionRead` gate), then
 * exactly ONE `GET /api/sessions/:id/stream` reconnect relay streams the
 * in-flight turn (`status` → `snapshot` → `activity` → `turn_completed` →
 * `done`). Stream budget discipline (D7): one stream for the focused item,
 * closed on defocus/unmount (abort), on tab hide (`createVisibilityGate` —
 * the same 60s grace the workspace stream uses), and on `done`; a personal
 * session's ended stream is never reopened (§5.1 — the server closed it, a
 * new focus opens a new one).
 *
 * [COMP:app-web/live-watch-pane]
 */

import { useEffect, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Loader2,
  Wrench,
} from "lucide-react";
import { createSSEBuffer, parseSSEStream } from "@use-brian/chat-ui";
import { authFetch } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  extractMessageText,
  fetchSessionMessages,
  stripAttachmentMarkup,
  type DocSessionMessage,
} from "@/lib/api/sessions";
import {
  initialWatchState,
  reduceWatchEvent,
  type WatchState,
} from "@/lib/live-roster";
import { createVisibilityGate } from "@/lib/workspace-events";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** How much settled history the pane shows above the live turn. */
const HISTORY_TAIL = 8;

function coercePayload(data: unknown): Record<string, unknown> {
  return data && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function SignalBars({ active }: { active: boolean }) {
  const heights = [34, 58, 82, 48, 70, 40, 62];
  return (
    <div className="flex h-20 items-end justify-center gap-1.5 rounded-2xl bg-muted/35 px-4 py-3" aria-hidden>
      {heights.map((height, index) => (
        <span
          key={height}
          className={`w-1.5 rounded-full bg-primary/55 ${
            active ? "motion-safe:animate-pulse motion-reduce:animate-none" : "opacity-35"
          }`}
          style={{
            height: `${height}%`,
            animationDelay: `${index * 90}ms`,
            animationDuration: "760ms",
          }}
        />
      ))}
    </div>
  );
}

export function LiveWatchPane({
  sessionId,
}: {
  sessionId: string;
}) {
  const t = useT();
  const tl = t.liveApp;
  const [history, setHistory] = useState<DocSessionMessage[]>([]);
  const [watch, setWatch] = useState<WatchState>(initialWatchState());
  const [streaming, setStreaming] = useState(false);
  const cancelledRef = useRef(false);

  // Transcript history — one authed fetch under the same read gate.
  useEffect(() => {
    cancelledRef.current = false;
    const controller = new AbortController();
    void fetchSessionMessages(sessionId, { signal: controller.signal }).then(
      (messages) => {
        if (!cancelledRef.current) setHistory(messages.slice(-HISTORY_TAIL));
      },
    );
    return () => {
      cancelledRef.current = true;
      controller.abort();
    };
  }, [sessionId]);

  // The ONE watch stream. Visibility-gated; closed on defocus via unmount
  // (the parent keys this component by sessionId).
  useEffect(() => {
    let cancelled = false;
    let sawDone = false;
    let controller: AbortController | null = null;

    setWatch(initialWatchState());

    const connect = () => {
      if (cancelled || sawDone || controller) return;
      const local = new AbortController();
      controller = local;
      setStreaming(true);
      void (async () => {
        try {
          const res = await authFetch(
            `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/stream`,
            { signal: local.signal },
          );
          if (!res.ok || !res.body) return;
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          const buf = createSSEBuffer();
          for (;;) {
            const { done, value } = await reader.read();
            if (done || cancelled) break;
            for (const ev of parseSSEStream(decoder.decode(value, { stream: true }), buf)) {
              const frame = { event: ev.event, data: coercePayload(ev.data) };
              if (frame.event === "done") sawDone = true;
              setWatch((prev) => reduceWatchEvent(prev, frame));
            }
            if (sawDone) break;
          }
        } catch {
          // Abort / transport error — the gate or unmount owns recovery.
        } finally {
          if (controller === local) controller = null;
          if (!cancelled) setStreaming(false);
        }
      })();
    };

    const disconnect = () => {
      controller?.abort();
      controller = null;
    };

    const gate = createVisibilityGate({ connect, disconnect });
    const onVisibility = () => {
      if (cancelled) return;
      gate.onVisibility(document.visibilityState === "hidden" ? "hidden" : "visible");
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (document.visibilityState !== "hidden") connect();

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibility);
      gate.dispose();
      disconnect();
    };
  }, [sessionId]);

  const streamActive = streaming && !watch.ended;

  return (
    <div className="mx-auto grid w-full max-w-6xl items-start gap-4 xl:grid-cols-[minmax(0,1fr)_260px]">
      <div className="flex min-w-0 flex-col gap-3">
        {history.length > 0 ? (
          <div className="flex flex-col gap-2.5">
            {history.map((m) => {
              const text = stripAttachmentMarkup(extractMessageText(m.content));
              if (!text) return null;
              const assistant = m.role === "assistant";
              return (
                <div
                  key={m.id}
                  className={
                    assistant
                      ? "max-w-[92%] rounded-2xl rounded-bl-md border border-border/70 bg-card px-4 py-3 text-sm shadow-sm"
                      : "ml-auto max-w-[85%] rounded-2xl rounded-br-md bg-secondary px-4 py-3 text-sm text-secondary-foreground shadow-sm"
                  }
                >
                  {m.senderName ? (
                    <div className="mb-1 text-[11px] font-medium text-muted-foreground">
                      {m.senderName}
                    </div>
                  ) : null}
                  <div className="whitespace-pre-wrap break-words leading-relaxed">{text}</div>
                </div>
              );
            })}
          </div>
        ) : null}

        {!watch.ended && (watch.text || watch.activity || watch.reasoning || streaming) ? (
          <div className="relative overflow-hidden rounded-2xl border border-primary/25 bg-card px-4 py-3 text-sm shadow-sm">
            <span
              className="absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/70 to-transparent motion-safe:animate-pulse motion-reduce:animate-none"
              aria-hidden
            />
            <div className="mb-2 flex items-center gap-2 text-[11px] font-medium text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              {watch.activity
                ? format(tl.runningTool, { tool: watch.activity })
                : tl.working}
            </div>
            {watch.reasoning ? (
              <div className="mb-2 whitespace-pre-wrap break-words text-xs italic leading-relaxed text-muted-foreground">
                {watch.reasoning}
              </div>
            ) : null}
            {watch.text ? (
              <div className="whitespace-pre-wrap break-words leading-relaxed">{watch.text}</div>
            ) : null}
          </div>
        ) : null}

        {watch.ended ? (
          <div className="flex items-center gap-2 rounded-2xl border border-border/70 bg-card px-4 py-3 text-sm text-muted-foreground shadow-sm">
            {watch.endReason ? (
              <CircleAlert className="size-4 text-amber-500" aria-hidden />
            ) : (
              <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />
            )}
            {watch.endReason ? tl.turnEndedAbnormally : tl.turnEnded}
          </div>
        ) : null}
      </div>

      <aside
        data-live-activity-rail
        className="sticky top-0 flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 shadow-sm"
      >
        <div className="flex items-center justify-between gap-2">
          <span className="inline-flex items-center gap-2 text-xs font-semibold text-foreground">
            <Activity className="size-3.5 text-primary" aria-hidden />
            {tl.activity}
          </span>
          <span className="relative flex size-2 items-center justify-center" aria-hidden>
            {streamActive ? (
              <span className="absolute size-2 rounded-full bg-emerald-500/40 motion-safe:animate-ping motion-reduce:animate-none" />
            ) : null}
            <span className={`relative size-1.5 rounded-full ${streamActive ? "bg-emerald-500" : "bg-muted-foreground/30"}`} />
          </span>
        </div>

        <SignalBars active={streamActive} />

        {watch.feed.length > 0 ? (
          <ol className="flex flex-col gap-2.5">
            {watch.feed.slice(-6).map((entry, index) => (
              <li key={index} className="flex min-w-0 items-start gap-2 text-[11px] text-muted-foreground">
                <span className={`mt-0.5 grid size-5 shrink-0 place-items-center rounded-md ${entry.isError ? "bg-red-500/10 text-red-500" : "bg-muted text-muted-foreground"}`}>
                  <Wrench className="size-3" aria-hidden />
                </span>
                <span className="min-w-0 flex-1 truncate pt-0.5">
                  {entry.name ?? entry.message ?? entry.event}
                  {entry.isError ? ` · ${tl.toolFailed}` : ""}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </aside>
    </div>
  );
}
