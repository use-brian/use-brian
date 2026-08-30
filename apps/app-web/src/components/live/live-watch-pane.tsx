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
import { Loader2 } from "lucide-react";
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

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-3">
      {history.length > 0 && (
        <div className="flex flex-col gap-2">
          {history.map((m) => {
            const text = stripAttachmentMarkup(extractMessageText(m.content));
            if (!text) return null;
            return (
              <div
                key={m.id}
                className={
                  m.role === "assistant"
                    ? "rounded-md bg-muted/40 px-3 py-2 text-sm"
                    : "rounded-md border px-3 py-2 text-sm"
                }
              >
                {m.senderName && (
                  <div className="mb-0.5 text-xs text-muted-foreground">{m.senderName}</div>
                )}
                <div className="whitespace-pre-wrap break-words">{text}</div>
              </div>
            );
          })}
        </div>
      )}

      {/* The live turn */}
      {!watch.ended && (watch.text || watch.activity || watch.reasoning || streaming) && (
        <div className="rounded-md border border-primary/30 bg-muted/20 px-3 py-2 text-sm">
          <div className="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground">
            <Loader2 className="h-3 w-3 animate-spin" aria-hidden />
            {watch.activity
              ? format(tl.runningTool, { tool: watch.activity })
              : tl.working}
          </div>
          {watch.reasoning && (
            <div className="mb-1 whitespace-pre-wrap break-words text-xs italic text-muted-foreground">
              {watch.reasoning}
            </div>
          )}
          {watch.text && (
            <div className="whitespace-pre-wrap break-words">{watch.text}</div>
          )}
        </div>
      )}

      {watch.feed.length > 0 && (
        <div className="flex flex-col gap-0.5 text-xs text-muted-foreground">
          {watch.feed.slice(-6).map((entry, i) => (
            <div key={i} className="truncate">
              {entry.name ?? entry.message ?? entry.event}
              {entry.isError ? ` · ${tl.toolFailed}` : ""}
            </div>
          ))}
        </div>
      )}

      {watch.ended && (
        <div className="text-sm text-muted-foreground">
          {watch.endReason ? tl.turnEndedAbnormally : tl.turnEnded}
        </div>
      )}
    </div>
  );
}
