"use client";

/**
 * The Plan rail's default view: the month brief, the pipeline counts, the
 * idea backlog, and the assistant's proposed slots waiting to be accepted.
 *
 * The brief is the artefact the operator and the assistant actually iterate
 * (feed-revamp.md D8) - a bag of dated chips is not a plan. It edits as a
 * document, not a labelled form card, per the locked app-web editor idiom.
 *
 * The ideas tray is the capture end of the backlog: one input, Enter to jot,
 * and each open idea waits until the operator plans or discards it. Planning
 * an idea opens the slot editor prefilled from it (feed-plan.tsx wires the
 * promote), so a jot becomes a dated slot without retyping.
 *
 * The proposal cardboard reads `proposePlan` tool calls out of the plan
 * conversation and offers each slot for acceptance. Nothing the assistant
 * proposes is scheduled until the operator says so (D9), and slots that
 * already exist are filtered out so re-planning offers gaps, not duplicates.
 *
 * [COMP:app-web/plan-brief-rail]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CalendarPlus, Check, Lightbulb, RefreshCw, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { StatusDot } from "@/components/feed/feed-status";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  createPlanSlot,
  fetchFeedSessionIdByChannel,
} from "@/lib/api/feed";
import { fetchSessionMessages } from "@/lib/api/sessions";
import {
  pendingProposedSlots,
  replayPlanProposal,
  type ProposedSlot,
} from "@/lib/feed-plan-proposal";
import {
  PLAN_SLOT_STATUSES,
  PLAN_RAIL_DOCK_CLEARANCE_CLASS,
  parseIsoDay,
  type FeedIdea,
  type PlanBrief,
  type PlanSlot,
  type PlanSlotStatus,
} from "@/lib/feed-plan";

/** The sticky channel the plan conversation lives on (server twin: PLAN_CHANNEL_ID). */
const PLAN_CHANNEL_ID = "plan";

/**
 * How long to keep watching for a proposal after the operator asks for one.
 * A bounded poll rather than an open-ended one: the assistant either answers
 * within a couple of minutes or the operator can pull manually, and a rail
 * left open overnight should not keep hitting the API.
 */
const WATCH_INTERVAL_MS = 4_000;
const WATCH_TIMEOUT_MS = 120_000;

/**
 * The cadence field is a free text input, so anything can arrive. Out-of-range
 * or unparseable means "no cadence" rather than an error: the only thing it
 * drives is a dashed suggestion, and refusing to save a brief because someone
 * typed "3x" would be wildly out of proportion. The server re-validates.
 */
export function parseCadenceInput(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 21) return null;
  return n;
}

export function PlanBriefRail({
  month,
  brief,
  counts,
  canEdit,
  busy,
  assistantId,
  existingSlots,
  ideas,
  watchToken,
  onSave,
  onSlotsAccepted,
  onAddIdea,
  onDiscardIdea,
  onPlanIdea,
}: {
  month: string;
  brief: PlanBrief | null;
  counts: Record<PlanSlotStatus, number>;
  canEdit: boolean;
  busy: boolean;
  assistantId: string;
  existingSlots: readonly PlanSlot[];
  /** The open backlog, newest first. */
  ideas: readonly FeedIdea[];
  /** Bumped when the operator asks the assistant to plan; starts the watch. */
  watchToken: number;
  onSave: (next: {
    brief: string;
    themes: string[];
    cadencePerWeek: number | null;
  }) => void;
  onSlotsAccepted: () => void;
  /** Resolves true when the jot saved, so the input knows to clear. */
  onAddIdea: (text: string) => Promise<boolean>;
  onDiscardIdea: (idea: FeedIdea) => void;
  onPlanIdea: (idea: FeedIdea) => void;
}) {
  const t = useT().feedPage;
  const tp = t.plan;

  const [body, setBody] = useState(brief?.brief ?? "");
  const [themes, setThemes] = useState((brief?.themes ?? []).join(", "));
  const [cadence, setCadence] = useState(
    brief?.cadencePerWeek ? String(brief.cadencePerWeek) : "",
  );
  const [ideaText, setIdeaText] = useState("");
  const [savingIdea, setSavingIdea] = useState(false);

  async function submitIdea() {
    const text = ideaText.trim();
    if (!text || savingIdea) return;
    setSavingIdea(true);
    try {
      if (await onAddIdea(text)) setIdeaText("");
    } finally {
      setSavingIdea(false);
    }
  }
  // Re-seed the editor when the month (and so the brief) changes underneath.
  useEffect(() => {
    setBody(brief?.brief ?? "");
    setThemes((brief?.themes ?? []).join(", "));
    setCadence(brief?.cadencePerWeek ? String(brief.cadencePerWeek) : "");
  }, [brief]);

  const dirty =
    body !== (brief?.brief ?? "") ||
    themes !== (brief?.themes ?? []).join(", ") ||
    cadence !== (brief?.cadencePerWeek ? String(brief.cadencePerWeek) : "");

  // ── Proposal cardboard ────────────────────────────────────────────────
  const [proposed, setProposed] = useState<ProposedSlot[]>([]);
  const [dismissed, setDismissed] = useState<Set<number>>(new Set());
  const [pulling, setPulling] = useState(false);
  const [accepting, setAccepting] = useState<number | null>(null);

  const pullProposal = useCallback(async () => {
    setPulling(true);
    try {
      const sessionId = await fetchFeedSessionIdByChannel(
        assistantId,
        PLAN_CHANNEL_ID,
      );
      if (!sessionId) return;
      const rows = await fetchSessionMessages(sessionId);
      const proposal = replayPlanProposal(rows);
      setProposed(
        proposal?.month === month
          ? pendingProposedSlots(proposal, existingSlots)
          : [],
      );
    } finally {
      setPulling(false);
    }
  }, [assistantId, month, existingSlots]);

  useEffect(() => {
    void pullProposal();
  }, [pullProposal]);

  // Bounded watch: poll only after the operator asked for a plan, and stop
  // once something arrives or the window closes.
  const watchRef = useRef(0);
  useEffect(() => {
    if (watchToken === 0 || watchToken === watchRef.current) return;
    watchRef.current = watchToken;
    const startedAt = Date.now();
    let stopped = false;
    const timer = setInterval(() => {
      if (stopped || Date.now() - startedAt > WATCH_TIMEOUT_MS) {
        clearInterval(timer);
        return;
      }
      void pullProposal();
    }, WATCH_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [watchToken, pullProposal]);

  const visibleProposals = useMemo(
    () => proposed.filter((s) => !dismissed.has(s.index)),
    [proposed, dismissed],
  );

  async function acceptProposal(slot: ProposedSlot) {
    setAccepting(slot.index);
    try {
      const result = await createPlanSlot(assistantId, {
        platform: slot.platform,
        scheduledFor: slot.date,
        title: slot.title,
        ...(slot.brief ? { brief: slot.brief } : {}),
      });
      if (result.ok) {
        setDismissed((prev) => new Set(prev).add(slot.index));
        onSlotsAccepted();
      }
    } finally {
      setAccepting(null);
    }
  }

  async function acceptAll() {
    for (const slot of visibleProposals) {
      await acceptProposal(slot);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 px-3 py-2">
        <div className="text-[12.5px] font-medium">{tp.railTitle}</div>
      </div>

      <div className="min-h-0 flex-1 space-y-5 overflow-y-auto p-3">
        {/* Pipeline counts — the retired home dashboard's stat cards, moved
            next to the calendar they describe. */}
        <ul className="grid grid-cols-2 gap-1.5">
          {PLAN_SLOT_STATUSES.filter((s) => s !== "skipped").map((status) => (
            <li
              key={status}
              className="rounded-lg border border-border/60 bg-card px-2.5 py-2"
            >
              <div className="flex items-center gap-1.5">
                <StatusDot status={status} />
                <span className="text-[11px] text-muted-foreground">
                  {tp.slotStatus[status]}
                </span>
              </div>
              <div className="mt-0.5 text-[15px] font-semibold tabular-nums">
                {counts[status]}
              </div>
            </li>
          ))}
        </ul>

        {visibleProposals.length > 0 ? (
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                {tp.proposedHeading}
              </h3>
              {canEdit ? (
                <button
                  type="button"
                  onClick={() => void acceptAll()}
                  className="text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                >
                  {tp.acceptAll}
                </button>
              ) : null}
            </div>
            <ul className="space-y-1.5">
              {visibleProposals.map((slot) => {
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
                      <PlatformIcon
                        platform={slot.platform}
                        className="size-3"
                      />
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
                          disabled={accepting === slot.index}
                          onClick={() => void acceptProposal(slot)}
                          className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
                        >
                          <Check className="size-3" aria-hidden />
                          {tp.acceptSlot}
                        </button>
                        <button
                          type="button"
                          onClick={() =>
                            setDismissed((prev) =>
                              new Set(prev).add(slot.index),
                            )
                          }
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
          </section>
        ) : null}

        {/* The idea backlog: jot now, plan later. */}
        <section className="space-y-2">
          <h3 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
            <Lightbulb className="size-3" aria-hidden />
            {tp.ideasHeading}
          </h3>
          {canEdit ? (
            <input
              type="text"
              value={ideaText}
              disabled={savingIdea}
              onChange={(e) => setIdeaText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  void submitIdea();
                }
              }}
              placeholder={tp.ideaPlaceholder}
              aria-label={tp.ideasHeading}
              className="h-8 w-full rounded-lg border border-border/60 bg-background px-2.5 text-[12.5px] placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none disabled:opacity-70"
            />
          ) : null}
          {ideas.length === 0 ? (
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              {tp.ideasEmpty}
            </p>
          ) : (
            <ul className="space-y-1.5">
              {ideas.map((idea) => (
                <li
                  key={idea.id}
                  className="rounded-lg border border-border/60 bg-card p-2"
                >
                  <p className="line-clamp-3 whitespace-pre-wrap text-[12.5px] leading-relaxed">
                    {idea.text}
                  </p>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    {new Date(idea.createdAt).toLocaleDateString()}
                  </div>
                  {canEdit ? (
                    <div className="mt-2 flex items-center gap-1">
                      <button
                        type="button"
                        onClick={() => onPlanIdea(idea)}
                        className="inline-flex h-7 flex-1 items-center justify-center gap-1 rounded-md border border-border px-2 text-[11px] font-medium transition-colors hover:bg-accent"
                      >
                        <CalendarPlus className="size-3" aria-hidden />
                        {tp.planIdea}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          const ok = await confirmDialog({
                            title: tp.discardIdeaTitle,
                            description: format(tp.discardIdeaBody, {
                              text: idea.text,
                            }),
                            confirmLabel: tp.discardIdeaConfirm,
                            variant: "destructive",
                          });
                          if (ok) onDiscardIdea(idea);
                        }}
                        aria-label={tp.discardIdea}
                        title={tp.discardIdea}
                        className="inline-flex size-7 items-center justify-center rounded-md border border-border text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                      >
                        <X className="size-3" aria-hidden />
                      </button>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </section>

        {/* The month brief, edited as a document. */}
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
              {tp.briefHeading}
            </h3>
            <button
              type="button"
              onClick={() => void pullProposal()}
              disabled={pulling}
              aria-label={tp.refreshProposals}
              title={tp.refreshProposals}
              className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
            >
              <RefreshCw
                className={cn("size-3", pulling && "animate-spin")}
                aria-hidden
              />
            </button>
          </div>
          <textarea
            value={body}
            disabled={!canEdit}
            onChange={(e) => setBody(e.target.value)}
            placeholder={tp.briefPlaceholder}
            rows={7}
            className="w-full resize-y rounded-lg border border-border/60 bg-background px-2.5 py-2 text-[12.5px] leading-relaxed placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none disabled:opacity-70"
          />
          <input
            type="text"
            value={themes}
            disabled={!canEdit}
            onChange={(e) => setThemes(e.target.value)}
            placeholder={tp.themesPlaceholder}
            className="h-8 w-full rounded-lg border border-border/60 bg-background px-2.5 text-[12.5px] placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none disabled:opacity-70"
          />
          <div className="flex items-center gap-2">
            <label
              htmlFor="plan-cadence"
              className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
            >
              {tp.cadenceLabel}
            </label>
            <input
              id="plan-cadence"
              type="number"
              min={1}
              max={21}
              inputMode="numeric"
              value={cadence}
              disabled={!canEdit}
              onChange={(e) => setCadence(e.target.value)}
              className="h-7 w-14 rounded-md border border-border/60 bg-background px-2 text-[12.5px] tabular-nums focus:border-primary/40 focus:outline-none disabled:opacity-70"
            />
            <span className="text-[11px] text-muted-foreground">
              {tp.cadenceUnit}
            </span>
          </div>
          {/*
            The ghosts this drives are suggestions, not schedule. Saying so
            here is cheaper than an operator discovering it by clicking one.
          */}
          <p className="text-[11px] text-muted-foreground">{tp.cadenceHint}</p>

          {brief?.updatedAt ? (
            <p className="text-[11px] text-muted-foreground">
              {format(tp.briefUpdated, {
                when: new Date(brief.updatedAt).toLocaleDateString(),
              })}
            </p>
          ) : null}
        </section>
      </div>

      {canEdit ? (
        <div
          data-plan-rail-footer
          className={cn(
            "border-t border-border/60 p-3",
            PLAN_RAIL_DOCK_CLEARANCE_CLASS,
          )}
        >
          <button
            type="button"
            disabled={!dirty || busy}
            onClick={() =>
              onSave({
                brief: body,
                themes: themes
                  .split(",")
                  .map((s) => s.trim())
                  .filter(Boolean),
                cadencePerWeek: parseCadenceInput(cadence),
              })
            }
            className="inline-flex h-8 w-full items-center justify-center rounded-lg bg-action px-3 text-[12.5px] font-medium text-action-foreground transition-colors hover:bg-action/90 disabled:opacity-50"
          >
            {tp.saveBrief}
          </button>
        </div>
      ) : null}
    </div>
  );
}
