"use client";

/**
 * The Plan rail as the plan chat, docked — the same `channel_id='plan'`
 * master control conversation the floating Feed dock hosts, re-hosted the
 * way the post editor docks its refine chat
 * (docs/plans/feed-plan-chat-first.md P1). Mounted only at `lg`+ on the
 * Plan index, where the floating dock stands down (P4) — exactly one live
 * `TuningChatPanel` per plan session, always.
 *
 * Three pieces above the conversation:
 *  - the preset context header (P2): what the assistant drafts FROM — the
 *    month brief headline, cadence, voice status, and open-ideas count,
 *    each tapping through to its editor;
 *  - the `proposePlan` cardboard (D19's accept-before-write contract,
 *    unchanged — shared with the calendar's dashed previews);
 *  - quick-action chips (P3), which replaced the header's "Plan with
 *    assistant" split button.
 *
 * Seeds arrive over the same `feed:chat-open` / `feed:chat-seed` bus the
 * floating dock listens on, so slot-peek "Discuss" and the top-bar opener
 * keep working when this rail is the live host; `onActivate` lets the board
 * fold any overlay (slot peek, brief editor) back to the conversation.
 *
 * [COMP:app-web/feed-plan-chat]
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Lightbulb, Mic2, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { StatusDot } from "@/components/feed/feed-status";
import {
  TuningChatPanel,
  type TuningChatPanelHandle,
} from "@/components/feed/tuning-chat-panel";
import { useGlobalDockRecorder } from "@/lib/recorder/dock-recorder-bridge";
import {
  ensurePlanSession,
  fetchFeedVoiceMemories,
} from "@/lib/api/feed";
import { feedPath } from "@/lib/feed-nav";
import {
  PLAN_SLOT_STATUSES,
  parseIsoDay,
  type PlanBrief,
  type PlanSlotStatus,
} from "@/lib/feed-plan";
import type { ProposedSlot } from "@/lib/feed-plan-proposal";
import {
  FEED_CHAT_OPEN_EVENT,
  FEED_CHAT_SEED_EVENT,
  type FeedChatSeed,
} from "@/lib/feed-chat-seed";

/** Sticky conversation identity (server twin: PLAN_CHANNEL_ID). */
const PLAN_CHANNEL_ID = "plan";

export type PlanQuickAction = {
  key: string;
  label: string;
  run: () => void;
};

export function PlanChatRail({
  assistantId,
  assistantName,
  iconSeed,
  workspaceId,
  month,
  brief,
  counts,
  openIdeasCount,
  canEdit,
  proposals,
  showProposals,
  pullingProposals,
  acceptingProposalIndex,
  quickActions,
  onAcceptProposal,
  onAcceptAllProposals,
  onDismissProposal,
  onRefreshProposals,
  onOpenBrief,
  onTurnComplete,
  onActivate,
}: {
  assistantId: string;
  assistantName: string;
  iconSeed?: number;
  workspaceId: string;
  month: string;
  brief: PlanBrief | null;
  counts: Record<PlanSlotStatus, number>;
  /** Open backlog size — capture lives in the main column, the header only counts. */
  openIdeasCount: number;
  canEdit: boolean;
  /** Shared with the Month calendar; neither surface owns a private copy. */
  proposals: readonly ProposedSlot[];
  showProposals: boolean;
  pullingProposals: boolean;
  acceptingProposalIndex: number | null;
  quickActions: readonly PlanQuickAction[];
  onAcceptProposal: (proposal: ProposedSlot) => void;
  onAcceptAllProposals: () => void;
  onDismissProposal: (proposal: ProposedSlot) => void;
  onRefreshProposals: () => void;
  onOpenBrief: () => void;
  /** A turn finished — the board re-reads the proposal cardboard. */
  onTurnComplete: () => void;
  /** A seed/open event landed — fold any rail overlay back to the chat. */
  onActivate: () => void;
}) {
  const t = useT().feedPage;
  const tp = t.plan;
  const chatRef = useRef<TuningChatPanelHandle>(null);
  const dockRecorder = useGlobalDockRecorder();

  // Provision the mode='plan' row before the composer can send — the same
  // idempotent ensure the floating dock runs (wire name /plan-session).
  const [sessionId, setSessionId] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setSessionId(null);
    void ensurePlanSession(assistantId).then((result) => {
      if (!cancelled && result) setSessionId(result.sessionId);
    });
    return () => {
      cancelled = true;
    };
  }, [assistantId]);

  // Voice status for the context header: does the team voice carry any rule
  // yet? Best-effort — an error hides the status rather than blocking chat.
  const [voiceTuned, setVoiceTuned] = useState<boolean | null>(null);
  useEffect(() => {
    let cancelled = false;
    setVoiceTuned(null);
    fetchFeedVoiceMemories(assistantId, { limit: 1 })
      .then(({ total }) => {
        if (!cancelled) setVoiceTuned(total > 0);
      })
      .catch(() => {
        if (!cancelled) setVoiceTuned(null);
      });
    return () => {
      cancelled = true;
    };
  }, [assistantId]);

  // The same bus the floating dock listens on. While this rail is the live
  // host (lg+ Plan index) the dock is unmounted, so these listeners are the
  // only pair — a seed lands here or there, never both.
  const onActivateRef = useRef(onActivate);
  useEffect(() => {
    onActivateRef.current = onActivate;
  }, [onActivate]);
  useEffect(() => {
    function openHandler() {
      onActivateRef.current();
    }
    function seedHandler(e: Event) {
      const detail = (e as CustomEvent<FeedChatSeed>).detail;
      if (!detail?.prefill?.trim()) return;
      onActivateRef.current();
      // The panel stays mounted under overlays, so the ref is live.
      requestAnimationFrame(() =>
        chatRef.current?.insertPrompt(detail.prefill, {
          researchMode: detail.researchMode,
        }),
      );
    }
    window.addEventListener(FEED_CHAT_OPEN_EVENT, openHandler);
    window.addEventListener(FEED_CHAT_SEED_EVENT, seedHandler);
    return () => {
      window.removeEventListener(FEED_CHAT_OPEN_EVENT, openHandler);
      window.removeEventListener(FEED_CHAT_SEED_EVENT, seedHandler);
    };
  }, []);

  const monthDate = /^\d{4}-\d{2}$/.test(month)
    ? new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)) - 1, 1)
    : null;
  const monthLabel = monthDate
    ? new Intl.DateTimeFormat(undefined, {
        month: "long",
        year: "numeric",
      }).format(monthDate)
    : month;
  const briefLine = brief?.brief?.trim().split("\n")[0]?.trim() || null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Preset context header (P2): the facts the assistant plans from,
          visible so operator and assistant see one truth (§6). */}
      <div
        data-plan-context-header
        className="shrink-0 space-y-2 border-b border-border/60 px-3 py-2.5"
      >
        <button
          type="button"
          data-plan-brief-launcher
          onClick={onOpenBrief}
          aria-label={tp.contextEditBriefAria}
          className="flex w-full items-center justify-between gap-2 rounded-lg border border-border/60 bg-card px-2.5 py-2 text-left transition-colors hover:bg-accent"
        >
          <span className="min-w-0 space-y-0.5">
            <span className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {monthLabel}
              {brief?.updatedAt ? (
                <Check className="size-3 shrink-0" aria-hidden />
              ) : null}
            </span>
            <span className="block truncate text-[12.5px] font-medium">
              {briefLine ?? tp.contextBriefUnset}
            </span>
          </span>
          <ChevronRight
            className="size-3.5 shrink-0 text-muted-foreground"
            aria-hidden
          />
        </button>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-muted-foreground">
          <span className="tabular-nums">
            {brief?.cadencePerWeek
              ? format(tp.contextCadence, { count: String(brief.cadencePerWeek) })
              : tp.contextCadenceUnset}
          </span>
          <Link
            href={feedPath(workspaceId, { segment: "voice" })}
            className="inline-flex items-center gap-1 transition-colors hover:text-foreground"
          >
            <Mic2 className="size-3" aria-hidden />
            {voiceTuned === false ? tp.contextVoiceUntuned : tp.contextVoiceTuned}
          </Link>
          <span className="inline-flex items-center gap-1">
            <Lightbulb className="size-3" aria-hidden />
            {format(tp.contextIdeas, { count: String(openIdeasCount) })}
          </span>
        </div>
        <ul className="flex items-center gap-3">
          {PLAN_SLOT_STATUSES.filter((s) => s !== "skipped").map((status) => (
            <li
              key={status}
              className="flex items-center gap-1 text-[11px] text-muted-foreground"
              title={tp.slotStatus[status]}
            >
              <StatusDot status={status} />
              <span className="tabular-nums font-medium text-foreground">
                {counts[status]}
              </span>
              <span className="sr-only">{tp.slotStatus[status]}</span>
            </li>
          ))}
        </ul>
      </div>

      {/* Assistant proposals — contextual output, absent until the operator
          asks for a plan or a saved proposal exists (D19). */}
      {showProposals ? (
        <div
          className="max-h-72 shrink-0 space-y-2 overflow-y-auto border-b border-border/60 px-3 py-2.5"
          aria-labelledby="plan-proposals-heading"
        >
          <div className="flex items-start justify-between gap-2">
            <h3
              id="plan-proposals-heading"
              className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
            >
              {tp.proposedHeading}
            </h3>
            <button
              type="button"
              onClick={onRefreshProposals}
              disabled={pullingProposals}
              className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw
                className={cn("size-3", pullingProposals && "animate-spin")}
                aria-hidden
              />
              {tp.refreshProposals}
            </button>
          </div>

          {proposals.length === 0 ? (
            <p className="rounded-lg border border-dashed border-border p-2.5 text-[11px] leading-relaxed text-muted-foreground">
              {tp.proposalsPending}
            </p>
          ) : (
            <>
              {canEdit && proposals.length > 1 ? (
                <div className="flex justify-end">
                  <button
                    type="button"
                    onClick={onAcceptAllProposals}
                    className="text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    {tp.acceptAll}
                  </button>
                </div>
              ) : null}
              <ul className="space-y-1.5">
                {proposals.map((slot) => {
                  const parsed = parseIsoDay(slot.date);
                  const dayLabel = parsed
                    ? new Intl.DateTimeFormat(undefined, {
                        weekday: "short",
                        month: "short",
                        day: "numeric",
                      }).format(parsed)
                    : slot.date;
                  return (
                    <li
                      key={slot.index}
                      className="rounded-lg border border-dashed border-border bg-card/60 p-2"
                    >
                      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                        <PlatformIcon platform={slot.platform} className="size-3" />
                        <span>{t.platformLabels[slot.platform]}</span>
                        <span aria-hidden>·</span>
                        <span>{dayLabel}</span>
                      </div>
                      <div className="mt-1 text-[12.5px] font-medium">
                        {slot.title}
                      </div>
                      {slot.brief ? (
                        <p className="mt-1 line-clamp-3 text-[11px] leading-relaxed text-muted-foreground">
                          {slot.brief}
                        </p>
                      ) : null}
                      {canEdit ? (
                        <div className="mt-2 flex items-center gap-1">
                          <button
                            type="button"
                            disabled={acceptingProposalIndex === slot.index}
                            onClick={() => onAcceptProposal(slot)}
                            className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
                          >
                            <Check className="size-3" aria-hidden />
                            {tp.acceptSlot}
                          </button>
                          <button
                            type="button"
                            onClick={() => onDismissProposal(slot)}
                            aria-label={tp.dismissSlot}
                            title={tp.dismissSlot}
                            className="inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                          >
                            <X className="size-3" aria-hidden />
                          </button>
                        </div>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
            </>
          )}
        </div>
      ) : null}

      {/* Quick actions (P3) — the retired header split button's jobs, as
          seeded prompts the operator still reads before sending. */}
      {canEdit && quickActions.length > 0 ? (
        <div
          role="group"
          aria-label={tp.quickActionsAria}
          className="flex shrink-0 flex-wrap items-center gap-1.5 border-b border-border/60 px-3 py-2"
        >
          {quickActions.map((action) => (
            <button
              key={action.key}
              type="button"
              onClick={action.run}
              className="inline-flex h-7 items-center rounded-full border border-border px-2.5 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            >
              {action.label}
            </button>
          ))}
        </div>
      ) : null}

      <div className="min-h-0 flex-1">
        <TuningChatPanel
          key={`${assistantId}:${PLAN_CHANNEL_ID}`}
          docked
          ref={chatRef}
          assistantId={assistantId}
          assistantName={assistantName}
          iconSeed={iconSeed}
          workspaceId={workspaceId}
          channelId={PLAN_CHANNEL_ID}
          sessionId={sessionId ?? undefined}
          ready={sessionId !== null}
          onTurnComplete={onTurnComplete}
          dockRecorder={dockRecorder ?? undefined}
          ownsDockRecorderTarget
        />
      </div>
    </div>
  );
}
