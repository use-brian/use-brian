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

import { useEffect, useState } from "react";
import {
  ArrowLeft,
  CalendarPlus,
  Check,
  ChevronRight,
  CircleHelp,
  Plus,
  RefreshCw,
  X,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { PlatformIcon } from "@/components/feed/platform-icon";
import { StatusDot } from "@/components/feed/feed-status";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Tooltip } from "@/components/ui/tooltip";
import type { ProposedSlot } from "@/lib/feed-plan-proposal";
import {
  PLAN_SLOT_STATUSES,
  PLAN_RAIL_DOCK_CLEARANCE_CLASS,
  parseIsoDay,
  type FeedIdea,
  type PlanBrief,
  type PlanSlotStatus,
} from "@/lib/feed-plan";

/**
 * The cadence field is a free text input, so anything can arrive. Out-of-range
 * or unparseable means "no cadence" rather than an error: the only thing it
 * drives is a dashed suggestion, and refusing to save a brief because someone
 * typed "3x" would be wildly out of proportion. The server re-validates.
 */
function parseCadenceInput(raw: string): number | null {
  const n = Number(raw.trim());
  if (!Number.isInteger(n) || n < 1 || n > 21) return null;
  return n;
}

function RailHelp({
  label,
  helpKey,
}: {
  label: string;
  helpKey: "brief" | "cadence" | "ideas" | "progress" | "proposals";
}) {
  const [open, setOpen] = useState(false);

  return (
    <Tooltip
      label={
        <span className="block max-w-64 whitespace-normal text-left font-normal leading-relaxed">
          {label}
        </span>
      }
      side="left"
      delay={200}
      closeOnClick={false}
      open={open}
      onOpenChange={setOpen}
    >
      <button
        type="button"
        onClick={() => setOpen(true)}
        data-plan-section-help={helpKey}
        aria-label={label}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/55 transition-colors hover:text-muted-foreground"
      >
        <CircleHelp className="size-3.5" aria-hidden />
      </button>
    </Tooltip>
  );
}

export function PlanBriefRail({
  view,
  month,
  brief,
  counts,
  canEdit,
  busy,
  proposals,
  showProposals,
  pullingProposals,
  acceptingProposalIndex,
  ideas,
  onSave,
  onRefreshProposals,
  onAcceptProposal,
  onAcceptAllProposals,
  onDismissProposal,
  onAddIdea,
  onDiscardIdea,
  onPlanIdea,
  onOpenBrief,
  onCloseBrief,
}: {
  view: "overview" | "brief";
  month: string;
  brief: PlanBrief | null;
  counts: Record<PlanSlotStatus, number>;
  canEdit: boolean;
  busy: boolean;
  /** Shared with the Month calendar; neither surface owns a private copy. */
  proposals: readonly ProposedSlot[];
  showProposals: boolean;
  pullingProposals: boolean;
  acceptingProposalIndex: number | null;
  /** The open backlog, newest first. */
  ideas: readonly FeedIdea[];
  onSave: (next: {
    brief: string;
    themes: string[];
    cadencePerWeek: number | null;
  }) => void;
  onRefreshProposals: () => void;
  onAcceptProposal: (proposal: ProposedSlot) => void;
  onAcceptAllProposals: () => void;
  onDismissProposal: (proposal: ProposedSlot) => void;
  /** Resolves true when the jot saved, so the input knows to clear. */
  onAddIdea: (text: string) => Promise<boolean>;
  onDiscardIdea: (idea: FeedIdea) => void;
  onPlanIdea: (idea: FeedIdea) => void;
  onOpenBrief: () => void;
  onCloseBrief: () => void;
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

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="border-b border-border/60 px-3 py-2">
        {view === "brief" ? (
          <button
            type="button"
            onClick={onCloseBrief}
            aria-label={tp.backToBrief}
            title={tp.backToBrief}
            className="inline-flex h-6 items-center gap-1.5 rounded text-[12.5px] font-medium text-foreground transition-colors hover:text-muted-foreground"
          >
            <ArrowLeft className="size-3.5" aria-hidden />
            {tp.briefHeading}
          </button>
        ) : (
          <div className="text-[12.5px] font-medium">{tp.railTitle}</div>
        )}
      </div>

      <div
        data-plan-brief-scroll
        className={cn(
          "min-h-0 flex-1 space-y-6 overflow-y-auto p-3",
          PLAN_RAIL_DOCK_CLEARANCE_CLASS,
        )}
      >
        {view === "brief" ? (
          /* The once-per-month artefact opens only on demand. Labels make the
             save boundary explicit, and the action stays beside its fields. */
          <section className="space-y-3" aria-labelledby="plan-brief-heading">
          <div className="flex items-center gap-1">
            <h3
              id="plan-brief-heading"
              className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
            >
              {tp.briefHeading}
            </h3>
            <RailHelp label={tp.briefDescription} helpKey="brief" />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="plan-goal"
              className="text-[11px] font-medium text-foreground"
            >
              {tp.goalLabel}
            </label>
            <textarea
              id="plan-goal"
              value={body}
              disabled={!canEdit}
              onChange={(e) => setBody(e.target.value)}
              placeholder={tp.briefPlaceholder}
              rows={5}
              className="w-full resize-y rounded-lg border border-border/60 bg-background px-2.5 py-2 text-[12.5px] leading-relaxed transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus-visible:shadow-none disabled:opacity-70"
            />
          </div>

          <div className="space-y-1.5">
            <label
              htmlFor="plan-themes"
              className="text-[11px] font-medium text-foreground"
            >
              {tp.themesLabel}
            </label>
            <input
              id="plan-themes"
              type="text"
              value={themes}
              disabled={!canEdit}
              onChange={(e) => setThemes(e.target.value)}
              placeholder={tp.themesPlaceholder}
              className="h-8 w-full rounded-lg border border-border/60 bg-background px-2.5 text-[12.5px] transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus-visible:shadow-none disabled:opacity-70"
            />
          </div>

          <div className="space-y-1.5">
            <div className="flex items-center gap-2">
              <label
                htmlFor="plan-cadence"
                className="text-[11px] font-medium text-foreground"
              >
                {tp.cadenceLabel}
              </label>
              <RailHelp label={tp.cadenceHint} helpKey="cadence" />
              <input
                id="plan-cadence"
                type="number"
                min={1}
                max={21}
                inputMode="numeric"
                value={cadence}
                disabled={!canEdit}
                onChange={(e) => setCadence(e.target.value)}
                className="h-7 w-14 rounded-md border border-border/60 bg-background px-2 text-[12.5px] tabular-nums transition-colors focus:border-primary/40 focus:outline-none focus-visible:shadow-none disabled:opacity-70"
              />
              <span className="text-[11px] text-muted-foreground">
                {tp.cadenceUnit}
              </span>
            </div>
          </div>

          {brief?.updatedAt ? (
            <p className="text-[11px] text-muted-foreground">
              {format(tp.briefUpdated, {
                when: new Date(brief.updatedAt).toLocaleDateString(),
              })}
            </p>
          ) : null}

          {canEdit ? (
            <button
              type="button"
              data-plan-brief-action
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
          ) : null}
          </section>
        ) : (
          <>
            <section aria-labelledby="plan-brief-launcher-heading">
              <button
                type="button"
                data-plan-brief-launcher
                onClick={onOpenBrief}
                className="flex w-full items-center justify-between gap-3 rounded-lg border border-border/60 bg-card px-2.5 py-2 text-left transition-colors hover:bg-accent"
              >
                <span className="flex min-w-0 items-center gap-2">
                  {brief?.updatedAt ? (
                    <Check className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  ) : null}
                  <span
                    id="plan-brief-launcher-heading"
                    className="truncate text-[12.5px] font-medium"
                  >
                    {tp.briefHeading}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
                  {brief?.updatedAt ? tp.editBrief : tp.setUpBrief}
                  <ChevronRight className="size-3" aria-hidden />
                </span>
              </button>
            </section>

            {/* Capture is explicit: Enter remains a shortcut, while the button
                makes the write action discoverable. */}
            <section className="space-y-2" aria-labelledby="plan-ideas-heading">
          <div className="flex items-center gap-1">
            <h3
              id="plan-ideas-heading"
              className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
            >
              {tp.ideasHeading}
            </h3>
            <RailHelp label={tp.ideasDescription} helpKey="ideas" />
          </div>
          {canEdit ? (
            <div className="flex items-center gap-1.5">
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
                className="h-8 min-w-0 flex-1 rounded-lg border border-border/60 bg-background px-2.5 text-[12.5px] transition-colors placeholder:text-muted-foreground/60 focus:border-primary/40 focus:outline-none focus-visible:shadow-none disabled:opacity-70"
              />
              <button
                type="button"
                disabled={!ideaText.trim() || savingIdea}
                onClick={() => void submitIdea()}
                className="inline-flex h-8 shrink-0 items-center justify-center gap-1 rounded-lg border border-border px-2.5 text-[11px] font-medium transition-colors hover:bg-accent disabled:opacity-50"
              >
                <Plus className="size-3" aria-hidden />
                {tp.addIdea}
              </button>
            </div>
          ) : null}
          {ideas.length > 0 ? (
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
          ) : null}
            </section>

        {/* Read-only status belongs after the editable planning inputs. */}
            <section className="space-y-2" aria-labelledby="plan-progress-heading">
          <div className="flex items-center gap-1">
            <h3
              id="plan-progress-heading"
              className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
            >
              {tp.progressHeading}
            </h3>
            <RailHelp label={tp.progressDescription} helpKey="progress" />
          </div>
          <ul className="grid grid-cols-2 gap-1.5">
            {PLAN_SLOT_STATUSES.filter((s) => s !== "skipped").map((status) => (
              <li
                key={status}
                className="flex items-center justify-between gap-2 rounded-lg border border-border/60 bg-card px-2.5 py-2"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <StatusDot status={status} />
                  <span className="truncate text-[11px] text-muted-foreground">
                    {tp.slotStatus[status]}
                  </span>
                </div>
                <span className="text-[13px] font-semibold tabular-nums">
                  {counts[status]}
                </span>
              </li>
            ))}
          </ul>
            </section>

        {/* Proposals are contextual output, so this section stays absent until
            the operator asks for a plan or a saved proposal actually exists. */}
            {showProposals ? (
              <section className="space-y-2" aria-labelledby="plan-proposals-heading">
            <div className="flex items-start justify-between gap-2">
              <div className="flex items-center gap-1">
                <h3
                  id="plan-proposals-heading"
                  className="text-[11px] font-medium uppercase tracking-[0.12em] text-muted-foreground"
                >
                  {tp.proposedHeading}
                </h3>
                <RailHelp
                  label={tp.proposedDescription}
                  helpKey="proposals"
                />
              </div>
              <button
                type="button"
                onClick={onRefreshProposals}
                disabled={pullingProposals}
                className="inline-flex h-7 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-50"
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
              </section>
            ) : null}
          </>
        )}
      </div>
    </div>
  );
}
