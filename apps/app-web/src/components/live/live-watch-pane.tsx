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

import { useCallback, useEffect, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Loader2,
  SendHorizontal,
  Square,
  Wrench,
} from "lucide-react";
import {
  createSSEBuffer,
  parseSSEStream,
  useMessageStream,
  type PendingConfirmation,
} from "@use-brian/chat-ui";
import { authFetch } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { requestApprovalsRefresh } from "@/lib/approvals-events";
import { respondByKind } from "@/lib/api/approvals";
import {
  fetchPendingSessionInput,
  toRestoredConfirmation,
  type PendingQuestion,
} from "@/lib/api/pending-questions";
import {
  extractMessageText,
  fetchSessionMessages,
  stopTurn,
  stripAttachmentMarkup,
  type DocSessionMessage,
} from "@/lib/api/sessions";
import type { LiveWorkState } from "@/lib/api/live";
import {
  joinQueuedInputs,
  useMidTurnQueue,
} from "@/lib/use-mid-turn-queue";
import {
  appliedInputIdFromWatchActivity,
  confirmationFromWatchActivity,
  initialWatchState,
  reduceWatchEvent,
  resolvedConfirmationIdFromWatchActivity,
  type WatchState,
} from "@/lib/live-roster";
import { createVisibilityGate } from "@/lib/workspace-events";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import { PendingQuestionPanel } from "@/components/chrome/pending-question-panel";
import { QueuedInputs } from "@/components/ui/queued-inputs";

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
  workspaceId,
  sessionState,
  canSteer,
}: {
  sessionId: string;
  workspaceId: string;
  sessionState: LiveWorkState;
  canSteer: boolean;
}) {
  const t = useT();
  const tl = t.liveApp;
  const [history, setHistory] = useState<DocSessionMessage[]>([]);
  const [watch, setWatch] = useState<WatchState>(initialWatchState());
  const [streaming, setStreaming] = useState(false);
  const [confirmation, setConfirmation] = useState<PendingConfirmation | null>(null);
  const [pendingQuestion, setPendingQuestion] = useState<PendingQuestion | null>(null);
  const [steerDraft, setSteerDraft] = useState("");
  const [stopping, setStopping] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const pendingRequestEpochRef = useRef(0);
  const interventionStream = useMessageStream();
  const midTurn = useMidTurnQueue({
    stream: interventionStream,
    getSessionId: () => sessionId,
    workspaceId,
  });
  const takeQueuedInput = midTurn.take;
  const drainQueuedInputs = midTurn.drain;

  const refreshPendingInput = useCallback(async () => {
    const epoch = ++pendingRequestEpochRef.current;
    try {
      const pending = await fetchPendingSessionInput(sessionId);
      if (pendingRequestEpochRef.current !== epoch) return;
      setPendingQuestion(pending.pending);
      setConfirmation(
        pending.toolConfirmation
          ? toRestoredConfirmation(pending.toolConfirmation, sessionId)
          : null,
      );
    } catch {
      // The live activity mirror can still supply a new confirmation. A
      // failed recovery probe must not take down the watch stream.
    }
  }, [sessionId]);

  useEffect(() => {
    setConfirmation(null);
    setPendingQuestion(null);
    void refreshPendingInput();
    return () => {
      pendingRequestEpochRef.current += 1;
    };
  }, [refreshPendingInput]);

  const restoreUnappliedSteering = useCallback(() => {
    const unapplied = drainQueuedInputs();
    if (unapplied.length === 0) return;
    const restored = joinQueuedInputs(unapplied);
    setSteerDraft((current) => [restored, current].filter(Boolean).join("\n\n"));
    setControlNotice(null);
    setControlError(tl.steerNotApplied);
  }, [drainQueuedInputs, tl.steerNotApplied]);

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
              if (frame.event === "activity") {
                const appliedInputId = appliedInputIdFromWatchActivity(frame.data);
                if (appliedInputId) takeQueuedInput(appliedInputId);

                const liveConfirmation = confirmationFromWatchActivity(
                  frame.data,
                  sessionId,
                );
                if (liveConfirmation) {
                  pendingRequestEpochRef.current += 1;
                  if (liveConfirmation.toolName === "askQuestion") {
                    void refreshPendingInput();
                  } else {
                    setConfirmation(liveConfirmation);
                    setPendingQuestion(null);
                  }
                }

                const resolvedId = resolvedConfirmationIdFromWatchActivity(frame.data);
                if (resolvedId) {
                  setConfirmation((current) =>
                    current?.toolCallId === resolvedId ? null : current,
                  );
                  void refreshPendingInput();
                }
              }
              if (frame.event === "turn_completed") {
                setConfirmation(null);
                setPendingQuestion(null);
                restoreUnappliedSteering();
              }
              if (frame.event === "done") {
                restoreUnappliedSteering();
                void refreshPendingInput();
              }
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
  }, [refreshPendingInput, restoreUnappliedSteering, sessionId, takeQueuedInput]);

  useEffect(() => {
    if (watch.ended) setStopping(false);
  }, [watch.ended]);

  const active = sessionState !== "settled" && !watch.ended;

  const forceStop = useCallback(async () => {
    if (stopping || !active) return;
    setStopping(true);
    setControlError(null);
    setControlNotice(null);
    try {
      const result = await stopTurn(sessionId);
      setControlNotice(result.stopped ? tl.stopRequested : tl.alreadyStopped);
    } catch {
      setControlError(tl.stopFailed);
    } finally {
      setStopping(false);
    }
  }, [active, sessionId, stopping, tl.alreadyStopped, tl.stopFailed, tl.stopRequested]);

  const steerNow = useCallback(() => {
    if (!active || !canSteer) return;
    if (!midTurn.queue(steerDraft, true)) {
      setControlError(tl.steerFailed);
      return;
    }
    setSteerDraft("");
    setControlError(null);
    setControlNotice(tl.steerQueued);
  }, [active, canSteer, midTurn, steerDraft, tl.steerFailed, tl.steerQueued]);

  const resolveConfirmation = useCallback(
    async (toolCallId: string, action: "approve" | "deny", comment?: string) => {
      if (!confirmation || confirmation.toolCallId !== toolCallId) return;
      setControlError(null);
      setConfirmation((current) =>
        current ? { ...current, status: action === "approve" ? "approving" : "denied" } : current,
      );
      try {
        let ok = false;
        let forbidden = false;
        if (confirmation.restored && confirmation.approvalId) {
          const result = await respondByKind(
            { id: confirmation.approvalId, kind: "tool_invocation" },
            action === "approve" ? "approved" : "rejected",
            comment,
          );
          ok = result.ok;
        } else {
          const res = await authFetch(`${API_URL}/api/chat/confirm`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId,
              toolCallId,
              decision: action === "approve" ? "allow" : "deny",
              ...(action === "deny" && comment ? { comment } : {}),
            }),
          });
          ok = res.ok;
          forbidden = res.status === 403;
        }
        if (!ok) {
          setConfirmation((current) =>
            current ? { ...current, status: "pending" } : current,
          );
          setControlError(forbidden ? t.chatApp.confirmNotAllowed : tl.decisionFailed);
          return;
        }
        setConfirmation(null);
        requestApprovalsRefresh(workspaceId);
        void refreshPendingInput();
      } catch {
        setConfirmation((current) =>
          current ? { ...current, status: "pending" } : current,
        );
        setControlError(tl.decisionFailed);
      }
    },
    [confirmation, refreshPendingInput, sessionId, t.chatApp.confirmNotAllowed, tl.decisionFailed, workspaceId],
  );

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

        {confirmation &&
        (confirmation.status === "pending" || confirmation.status === "approving") ? (
          <ChatConfirmationCard
            confirmation={confirmation}
            approveLabel={t.chat.confirmationApprove}
            denyLabel={t.chat.confirmationDeny}
            approvingLabel={t.chat.confirmationApproving}
            onApprove={(toolCallId) => void resolveConfirmation(toolCallId, "approve")}
            onDeny={(toolCallId, comment) =>
              void resolveConfirmation(toolCallId, "deny", comment)
            }
          />
        ) : null}

        {pendingQuestion ? (
          <PendingQuestionPanel
            sessionId={sessionId}
            approvalId={pendingQuestion.approvalId}
            dict={t.chat.pendingQuestion}
            onAnswered={() => {
              setPendingQuestion(null);
              requestApprovalsRefresh(workspaceId);
              void refreshPendingInput();
            }}
            onCancelled={() => {
              setPendingQuestion(null);
              requestApprovalsRefresh(workspaceId);
              void refreshPendingInput();
            }}
          />
        ) : null}

        <QueuedInputs
          inputs={midTurn.queued}
          dict={t.chat.queue}
          onSteer={midTurn.steer}
        />
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

        <div
          data-live-interventions
          className="flex flex-col gap-2.5 rounded-xl border border-border/70 bg-muted/25 p-3"
        >
          <span className="text-[11px] font-semibold text-foreground">
            {tl.intervene}
          </span>
          {active ? (
            <button
              type="button"
              onClick={() => void forceStop()}
              disabled={stopping}
              className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/25 bg-background px-3 py-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {stopping ? (
                <Loader2 className="size-3.5 animate-spin motion-reduce:animate-none" aria-hidden />
              ) : (
                <Square className="size-3 fill-current" aria-hidden />
              )}
              {stopping ? tl.stopping : tl.forceStop}
            </button>
          ) : null}

          {active && canSteer ? (
            <div className="space-y-2 border-t border-border/70 pt-2.5">
              <textarea
                value={steerDraft}
                onChange={(event) => setSteerDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (
                    event.key === "Enter" &&
                    (event.metaKey || event.ctrlKey) &&
                    !event.nativeEvent.isComposing
                  ) {
                    event.preventDefault();
                    steerNow();
                  }
                }}
                rows={3}
                maxLength={8_000}
                placeholder={tl.steerPlaceholder}
                className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:shadow-none"
              />
              <button
                type="button"
                onClick={steerNow}
                disabled={!steerDraft.trim()}
                className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-action px-3 py-2 text-xs font-medium text-action-foreground transition-colors hover:bg-action/90 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <SendHorizontal className="size-3.5" aria-hidden />
                {tl.steerNow}
              </button>
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                {tl.steerHint}
              </p>
            </div>
          ) : null}

          {controlNotice ? (
            <p className="text-[10px] leading-relaxed text-muted-foreground">
              {controlNotice}
            </p>
          ) : null}
          {controlError ? (
            <p className="text-[10px] leading-relaxed text-destructive">
              {controlError}
            </p>
          ) : null}
        </div>

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
