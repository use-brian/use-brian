"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Live watch pane — token-by-token body of one focused session. The parent
 * Live surface owns the shared top-bar title and Open-in-chat action.
 * (docs/architecture/features/live-work.md §5.1).
 *
 * Reuse, not invention: transcript history loads once through the existing
 * `GET /api/sessions/:id/messages` (same `gateSessionRead` gate). The pane is
 * a presentation of the shared conversation controller (M5 WP-E): the
 * controller's one hydrate follow is the watch stream, `releaseOnDetach` ends
 * it on defocus/unmount, `setVisible` releases it after 60 s hidden, and a
 * personal stream ended at `done` is never reopened (D7, §5.1). Stop,
 * confirmations and the pending question are the controller's; the pane keeps
 * rendering (`reduceWatchEvent` over observed frames) and the steering-only
 * legacy queue (live-work.md → "Shared conversation controller").
 *
 * [COMP:app-web/live-watch-pane]
 */


import { useCallback, useEffect, useId, useRef, useState } from "react";
import {
  Activity,
  CheckCircle2,
  CircleAlert,
  Loader2,
  SendHorizontal,
  Square,
  Wrench,
} from "lucide-react";
import type { PendingConfirmation } from "@use-brian/chat-ui";
import { useConversation } from "@/lib/chat/use-conversation";
import type {
  ConversationController,
  ConversationState,
  PresentationCapabilities,
} from "@/lib/chat/conversation-controller";
import type { ClassifiedTurnFrame } from "@/lib/chat/turn-frames";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { createVisibleRecoveryLoop } from "@/lib/visible-recovery-loop";
import { APPROVALS_REFRESH_EVENT, requestApprovalsRefresh } from "@/lib/approvals-events";
import {
  extractMessageText,
  fetchSessionMessages,
  stripAttachmentMarkup,
  type DocSessionMessage,
} from "@/lib/api/sessions";
import type { LiveWorkState } from "@/lib/api/live";
import {
  initialWatchState,
  reduceWatchEvent,
  type WatchState,
} from "@/lib/live-roster";
import { ChatConfirmationCard } from "@/components/chrome/chat-confirmation-card";
import { PendingQuestionPanel } from "@/components/chrome/pending-question-panel";
import { QueuedInputs } from "@/components/ui/queued-inputs";

/** How much settled history the pane shows above the live turn. */
const HISTORY_TAIL = 8;

const ACTIVE_PHASES = new Set(["running", "suspended"]);

/** The slices this presentation renders; the controller owns everything else. */
export function selectWatch(state: ConversationState) {
  return {
    live: state.mirror.active || ACTIVE_PHASES.has(state.run.phase),
    stopRequested: state.run.stopRequested,
    confirmation: state.transcript.pendingConfirmations.find(
      (card) => card.status === "pending" || card.status === "approving",
    ) ?? null,
    // Its own field (C15): a restored approval card shows beside it.
    question: state.question,
    queued: state.queued,
    unsentCount: state.unsent.length,
  };
}

/**
 * The pane's presentation capabilities: no transcript preset is rendered
 * (`page` is the neutral default), the watch stream ends on defocus, and the
 * observer feeds the pane's own reducer.
 */
export function liveWatchCapabilities(onFrame: (frame: ClassifiedTurnFrame) => void): PresentationCapabilities {
  // `return`: steering left at the end of a turn comes back to the field and
  // never becomes an ordinary turn (live-work.md "Steer now").
  return { profile: "page", releaseOnDetach: true, queueDrain: "return", onFrame };
}

/** Force-stop outcome to this pane's copy keys. */
export function liveStopCopy(result: Awaited<ReturnType<ConversationController["stop"]>>): "stopRequested" | "alreadyStopped" | "stopFailed" {
  return result === "stopped" ? "stopRequested" : result === "failed" ? "stopFailed" : "alreadyStopped";
}

/** Confirmation outcome to this pane's copy (null when resolved). */
export function liveDecisionError(result: Awaited<ReturnType<ConversationController["respondConfirmation"]>>): "confirmNotAllowed" | "decisionFailed" | null {
  return result === "resolved" ? null : result === "forbidden" ? "confirmNotAllowed" : "decisionFailed";
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
  const presentationId = `live-watch:${useId()}`;
  const [history, setHistory] = useState<DocSessionMessage[]>([]);
  const [watch, setWatch] = useState<WatchState>(initialWatchState());
  const [steerDraft, setSteerDraft] = useState("");
  const [stopping, setStopping] = useState(false);
  const [controlError, setControlError] = useState<string | null>(null);
  const [controlNotice, setControlNotice] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  // The controller observes each admitted follow frame once; the pane folds
  // it into its own watch view. Steering is the controller's queue: a mirrored
  // `input_applied` retires an entry, and leftovers return as unsent text.
  const controllerRef = useRef<ReturnType<typeof useConversation>["controller"]>(null);
  const observe = (frame: ClassifiedTurnFrame) => {
    if (frame.stream !== "follow") return;
    const data = frame.payload;
    if (frame.event === "done") void controllerRef.current?.refreshPendingInput();
    setWatch((prev) => reduceWatchEvent(prev, { event: frame.event, data }));
  };

  const { controller, value } = useConversation({
    workspaceId,
    sessionId,
    provisionalKey: `live:${sessionId}`,
    presentationId,
    capabilities: liveWatchCapabilities(observe),
  }, selectWatch);
  controllerRef.current = controller;
  const live = value?.live ?? false;
  const confirmation: PendingConfirmation | null = value?.confirmation ?? null;
  const pendingQuestion = value?.question ?? null;
  const queued = value?.queued ?? [];
  const unsentCount = value?.unsentCount ?? 0;

  // Steering the turn never took comes back to the field, never resent.
  useEffect(() => {
    if (!controller || unsentCount === 0) return;
    const restored = controller.takeUnsent().join("\n\n");
    if (!restored) return;
    setSteerDraft((current) => [restored, current].filter(Boolean).join("\n\n"));
    setControlNotice(null);
    setControlError(tl.steerNotApplied);
  }, [controller, unsentCount, tl.steerNotApplied]);

  useEffect(() => { setWatch(initialWatchState()); }, [sessionId]);

  // Transcript history — one authed fetch under the same read gate.
  useEffect(() => {
    cancelledRef.current = false;
    const abort = new AbortController();
    void fetchSessionMessages(sessionId, { signal: abort.signal }).then(
      (messages) => {
        if (!cancelledRef.current) setHistory(messages.slice(-HISTORY_TAIL));
      },
    );
    return () => {
      cancelledRef.current = true;
      abort.abort();
    };
  }, [sessionId]);

  // A hidden tab releases the watch stream after the shared 60 s grace.
  useEffect(() => {
    if (!controller || typeof document === "undefined") return;
    const report = () => controller.setVisible(presentationId, document.visibilityState !== "hidden");
    report();
    document.addEventListener("visibilitychange", report);
    return () => document.removeEventListener("visibilitychange", report);
  }, [controller, presentationId]);

  // Read recovery delegates all interaction state and stream ownership to the
  // shared controller. This presentation never replays a consent mutation.
  useEffect(() => {
    if (!controller) return;
    const visible = () => document.visibilityState !== "hidden";
    const recovery = createVisibleRecoveryLoop({
      isVisible: visible,
      recover: () => controller.refreshPendingInput(),
    });
    // Attach already probes once; begin periodic recovery after that snapshot.
    const initial = setTimeout(recovery.wake, 5_000);
    const visibility = () => { if (visible()) recovery.wake(); else recovery.pause(); };
    const online = () => { if (visible()) { controller.notifyOnline(); recovery.wake(); } };
    const approvals = (event: Event) => {
      const scope = (event as CustomEvent<{ workspaceId?: string }>).detail?.workspaceId;
      if (!scope || scope === workspaceId) recovery.wake();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", online);
    window.addEventListener(APPROVALS_REFRESH_EVENT, approvals);
    return () => {
      clearTimeout(initial);
      recovery.dispose();
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", online);
      window.removeEventListener(APPROVALS_REFRESH_EVENT, approvals);
    };
  }, [controller, workspaceId]);

  useEffect(() => {
    if (watch.ended) setStopping(false);
  }, [watch.ended]);

  useEffect(() => {
    setStopping(false);
    setControlNotice(null);
    setControlError(null);
  }, [watch.turnId]);

  const active = (watch.status === "running" || sessionState !== "settled") && !watch.ended;

  const forceStop = useCallback(async () => {
    if (stopping || !active || !controller) return;
    setStopping(true);
    setControlError(null);
    setControlNotice(null);
    // The controller's compare-and-set Stop names the watched turn; the turn
    // still ends on the authoritative `turn_completed`.
    const copy = liveStopCopy(await controller.stop());
    if (copy === "stopFailed") setControlError(tl.stopFailed);
    else setControlNotice(tl[copy]);
    setStopping(false);
  }, [active, controller, stopping, tl.alreadyStopped, tl.stopFailed, tl.stopRequested]);

  const steerNow = useCallback(() => {
    if (!active || !canSteer) return;
    // Queued under this pane, so its `return` drain policy applies to it.
    if (!controller?.queue(steerDraft, true, { presentationId })) {
      setControlError(tl.steerFailed);
      return;
    }
    setSteerDraft("");
    setControlError(null);
    setControlNotice(tl.steerQueued);
  }, [active, canSteer, controller, presentationId, steerDraft, tl.steerFailed, tl.steerQueued]);

  const resolveConfirmation = useCallback(
    async (toolCallId: string, action: "approve" | "deny", comment?: string) => {
      if (!controller || confirmation?.toolCallId !== toolCallId) return;
      setControlError(null);
      const failure = liveDecisionError(await controller.respondConfirmation(toolCallId, action, comment));
      if (!failure) {
        requestApprovalsRefresh(workspaceId);
        void controller.refreshPendingInput();
      } else setControlError(failure === "confirmNotAllowed" ? t.chatApp.confirmNotAllowed : tl.decisionFailed);
    },
    [confirmation?.toolCallId, controller, t.chatApp.confirmNotAllowed, tl.decisionFailed, workspaceId],
  );

  const settleQuestion = (approvalId: string) => {
    controller?.questionSettled(approvalId);
    requestApprovalsRefresh(workspaceId);
  };

  const streamActive = (live || stopping || !!value?.stopRequested) && !watch.ended;
  const abnormalEnd = watch.endReason !== null && !["completed", "publication_recovered"].includes(watch.endReason);

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

        {!watch.ended && (watch.text || watch.activity || watch.reasoning || streamActive) ? (
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
            {abnormalEnd ? (
              <CircleAlert className="size-4 text-amber-500" aria-hidden />
            ) : (
              <CheckCircle2 className="size-4 text-emerald-500" aria-hidden />
            )}
            {abnormalEnd ? tl.turnEndedAbnormally : tl.turnEnded}
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
            onAnswered={() => settleQuestion(pendingQuestion.approvalId)}
            onCancelled={() => settleQuestion(pendingQuestion.approvalId)}
          />
        ) : null}

        <QueuedInputs
          inputs={[...queued]}
          dict={t.chat.queue}
          onSteer={(inputId) => { controller?.steer(inputId); }}
        />
      </div>

      <aside
        data-live-activity-rail
        // Below `xl` the grid is one column, so the rail rendered UNDER the
        // settled history and the growing live turn: on a phone Force stop was
        // off-screen exactly when the turn was running. `order-first` puts the
        // interventions above the transcript there; the rail sticks to the top
        // only in the two-column layout, where it has a column to stick in.
        className="order-first flex flex-col gap-3 rounded-2xl border border-border/70 bg-card p-4 shadow-sm xl:sticky xl:top-0 xl:order-none"
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
          className="flex flex-col gap-2.5 border-t border-border/70 pt-3"
        >
          <span className="text-[11px] font-semibold text-foreground">
            {tl.intervene}
          </span>
          {active ? (
            <button
              type="button"
              onClick={() => void forceStop()}
              disabled={stopping}
              className="inline-flex min-h-11 items-center justify-center gap-2 rounded-lg border border-destructive/25 bg-background px-3 py-2 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0"
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
                className="w-full resize-none rounded-lg border border-border bg-background px-2.5 py-2 text-[16px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:shadow-none md:text-xs"
              />
              <button
                type="button"
                onClick={steerNow}
                disabled={!steerDraft.trim()}
                className="inline-flex min-h-11 w-full items-center justify-center gap-2 rounded-lg bg-action px-3 py-2 text-xs font-medium text-action-foreground transition-colors hover:bg-action/90 disabled:cursor-not-allowed disabled:opacity-50 md:min-h-0"
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
