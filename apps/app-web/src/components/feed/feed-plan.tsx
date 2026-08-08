"use client";

/**
 * The Plan surface: the marketing calendar plus the month brief that drives
 * it (feed-revamp.md §3.1). Owns the bare `/feed` index (D5), so it also
 * renders the first-run onboarding when the workspace has no brand voice.
 *
 * Layout is calendar + one right rail. The rail shows the month brief by
 * default and swaps to the selected slot's editor, rather than opening a
 * third pane: the operator is always looking at either "what is this month
 * about" or "what is this one post", never both at once.
 *
 * The pipeline counts that used to be the retired home dashboard's stat cards
 * live at the top of the rail, where they annotate the calendar they describe.
 *
 * [COMP:app-web/feed-plan-surface]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { ChevronDown, Sparkles } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { useConnectAccount } from "@/components/feed/connect-account-dialog";
import { FeedOnboarding } from "@/components/feed/feed-onboarding";
import { cn } from "@/lib/utils";
import { PlanCalendar } from "@/components/feed/plan-calendar";
import { PlanList } from "@/components/feed/plan-list";
import { PlanWeek } from "@/components/feed/plan-week";
import {
  PlanSlotPeek,
  planSlotToDraft,
  type PlanSlotDraft,
} from "@/components/feed/plan-slot-peek";
import { PlanBriefRail } from "@/components/feed/plan-brief-rail";
import {
  createFeedIdea,
  createPlanSlot,
  deletePlanSlot,
  draftFromPlanSlot,
  ensurePlanSession,
  fetchFeedIdeas,
  fetchPlanBrief,
  fetchPlanSlots,
  savePlanBrief,
  updateFeedIdea,
  updatePlanSlot,
} from "@/lib/api/feed";
import {
  defaultFeedPlatform,
  feedPath,
  isFeedPlatform,
  type FeedPlatform,
} from "@/lib/feed-nav";
import {
  emptySlots,
  isoDay,
  monthKey,
  planCounts,
  type FeedIdea,
  type PlanBrief,
  type PlanSlot,
} from "@/lib/feed-plan";
import { requestFeedChatSeed } from "@/lib/feed-chat-seed";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { isHostedEdition } from "@/lib/edition";

export function FeedPlan() {
  const team = useFeedWorkspace();
  const { openConnect, dialog, isAdmin } = useConnectAccount();
  const canConnect = isAdmin && isHostedEdition();
  const [onboarded, setOnboarded] = useState(false);
  const handleReady = useCallback(() => setOnboarded(true), []);

  const brand = team.assistants[0] ?? team.profiles[0]?.assistant ?? null;

  return (
    <>
      {dialog}
      {!brand || !onboarded ? (
        <FeedOnboarding
          canCreateBrand={isAdmin}
          canConnect={canConnect}
          onConnect={() => void openConnect()}
          onReady={handleReady}
        />
      ) : (
        <PlanBoard assistantId={brand.id} />
      )}
    </>
  );
}

type RailView = { kind: "brief" } | { kind: "slot"; draft: PlanSlotDraft };

function PlanBoard({ assistantId }: { assistantId: string }) {
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const tp = t.plan;
  const router = useRouter();
  const searchParams = useSearchParams();

  // `today` is captured once per mount. Reading `new Date()` inside the
  // render would make the grid re-derive on every keystroke in the rail.
  const [today] = useState(() => new Date());
  const monthParam = searchParams.get("month");
  const [month, setMonth] = useState(() =>
    monthParam && /^\d{4}-\d{2}$/.test(monthParam)
      ? monthParam
      : monthKey(today),
  );

  // D25. Two views, both over the same slots and the same chip. `?view=` is
  // in the URL for the same reason `?month=` is: a linkable, reload-surviving
  // reading of the month.
  const viewParam = searchParams.get("view");
  const [view, setView] = useState<"month" | "list" | "week">(
    viewParam === "list" ? "list" : viewParam === "week" ? "week" : "month",
  );
  // The week the Week view is showing. Seeded from the month so switching
  // views lands where the operator was looking, not on today.
  const [weekAnchor, setWeekAnchor] = useState(() => isoDay(today));

  const [slots, setSlots] = useState<PlanSlot[]>([]);
  const [brief, setBrief] = useState<PlanBrief | null>(null);
  const [ideas, setIdeas] = useState<FeedIdea[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [rail, setRail] = useState<RailView>({ kind: "brief" });
  // Bumped when the operator asks for a plan; the rail then watches for the
  // assistant's `proposePlan` cardboard instead of polling all the time.
  const [watchToken, setWatchToken] = useState(0);

  // Open the sticky `mode='plan'` conversation so the dock resumes it and the
  // assistant gets the proposePlan tool. Idempotent, so a remount is free.
  useEffect(() => {
    void ensurePlanSession(assistantId);
  }, [assistantId]);

  const canEdit = team.role !== "member" || team.canDraft;

  const defaultPlatform: FeedPlatform = useMemo(
    () =>
      defaultFeedPlatform(
        team.workspaceId,
        team.profiles.map((p) => p.platform),
      ),
    [team.workspaceId, team.profiles],
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    const [nextSlots, nextBrief, nextIdeas] = await Promise.all([
      fetchPlanSlots(assistantId, month),
      fetchPlanBrief(assistantId, month),
      fetchFeedIdeas(assistantId, "open"),
    ]);
    if (nextSlots === null) setError(tp.loadFailed);
    setSlots(nextSlots ?? []);
    setBrief(nextBrief);
    setIdeas(nextIdeas ?? []);
    setLoading(false);
  }, [assistantId, month, tp.loadFailed]);

  useEffect(() => {
    void load();
  }, [load]);

  // Keep `?month=` in the URL so a month is linkable and survives a reload,
  // without pushing a history entry per arrow click.
  const firstMonthSync = useRef(true);
  useEffect(() => {
    if (firstMonthSync.current) {
      firstMonthSync.current = false;
      return;
    }
    const suffix = view === "month" ? "" : `&view=${view}`;
    router.replace(
      `${feedPath(team.workspaceId)}?month=${month}${suffix}`,
      { scroll: false },
    );
  }, [month, view, router, team.workspaceId]);

  const counts = useMemo(() => planCounts(slots), [slots]);

  const selectedSlot = useMemo(
    () =>
      rail.kind === "slot" && rail.draft.id
        ? (slots.find((s) => s.id === rail.draft.id) ?? null)
        : null,
    [rail, slots],
  );

  function openSlot(slot: PlanSlot) {
    setRail({ kind: "slot", draft: planSlotToDraft(slot) });
  }

  function openNewSlot(iso: string) {
    setRail({
      kind: "slot",
      draft: {
        id: null,
        platform: defaultPlatform,
        scheduledMinute: null,
        scheduledFor: iso,
        title: "",
        brief: "",
      },
    });
  }

  async function saveSlot() {
    if (rail.kind !== "slot") return;
    const { draft } = rail;
    const title = draft.title.trim();
    if (!title) return;
    setBusy(true);
    setError(null);
    try {
      const result = draft.id
        ? await updatePlanSlot(assistantId, draft.id, {
            title,
            brief: draft.brief.trim() || null,
            scheduledMinute: draft.scheduledMinute,
          })
        : await createPlanSlot(assistantId, {
            platform: draft.platform,
            scheduledFor: draft.scheduledFor,
            scheduledMinute: draft.scheduledMinute,
            title,
            ...(draft.brief.trim() ? { brief: draft.brief.trim() } : {}),
          });
      if (!result.ok) {
        setError(result.error ?? tp.saveFailed);
        return;
      }
      setSlots((prev) => {
        const next = prev.filter((s) => s.id !== result.slot.id);
        next.push(result.slot);
        return next.sort(
          (a, b) =>
            a.scheduledFor.localeCompare(b.scheduledFor) ||
            a.createdAt.localeCompare(b.createdAt),
        );
      });
      // A slot born from a backlog idea binds the idea, which is what flips
      // it to `promoted` and takes it off the open backlog. A failed bind
      // just leaves the idea open - never block the slot on it.
      if (!draft.id && draft.fromIdeaId) {
        const ideaId = draft.fromIdeaId;
        const bound = await updateFeedIdea(assistantId, ideaId, {
          slotId: result.slot.id,
        });
        if (bound.ok) setIdeas((prev) => prev.filter((i) => i.id !== ideaId));
      }
      setRail({ kind: "slot", draft: planSlotToDraft(result.slot) });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Drag-drop reschedule. The chip moves first and snaps back on failure, so
   * the gesture feels direct on a slow connection.
   */
  /**
   * One write for both axes. The Week view's drag can change the day and the
   * wall-clock minute in a single gesture, so `minute` is threaded through
   * rather than needing a second round-trip that could half-apply.
   * `undefined` means "leave the time alone" (the Month grid's day-only drag);
   * `null` clears it.
   */
  async function reschedule(
    slot: PlanSlot,
    iso: string,
    minute?: number | null,
  ) {
    const previous = { day: slot.scheduledFor, minute: slot.scheduledMinute };
    const nextMinute = minute === undefined ? slot.scheduledMinute : minute;
    setSlots((prev) =>
      prev.map((s) =>
        s.id === slot.id
          ? { ...s, scheduledFor: iso, scheduledMinute: nextMinute }
          : s,
      ),
    );
    const result = await updatePlanSlot(assistantId, slot.id, {
      scheduledFor: iso,
      ...(minute === undefined ? {} : { scheduledMinute: minute }),
    });
    if (!result.ok) {
      setSlots((prev) =>
        prev.map((s) =>
          s.id === slot.id
            ? { ...s, scheduledFor: previous.day, scheduledMinute: previous.minute }
            : s,
        ),
      );
      setError(result.error ?? tp.saveFailed);
      return;
    }
    setSlots((prev) => prev.map((s) => (s.id === slot.id ? result.slot : s)));
  }

  async function toggleSkip(slot: PlanSlot) {
    setBusy(true);
    try {
      const result = await updatePlanSlot(assistantId, slot.id, {
        status: slot.status === "skipped" ? "planned" : "skipped",
      });
      if (!result.ok) {
        setError(result.error ?? tp.saveFailed);
        return;
      }
      setSlots((prev) => prev.map((s) => (s.id === slot.id ? result.slot : s)));
      setRail({ kind: "slot", draft: planSlotToDraft(result.slot) });
    } finally {
      setBusy(false);
    }
  }

  /**
   * D29. Duplicate lands on the SAME day, unbound and untitled-suffixed: the
   * operator asked for another post like this one, not for a guess about when
   * it should go out. Any draft the original started stays with the original.
   */
  async function duplicateSlot(slot: PlanSlot) {
    setBusy(true);
    try {
      const result = await createPlanSlot(assistantId, {
        platform: slot.platform,
        scheduledFor: slot.scheduledFor,
        scheduledMinute: slot.scheduledMinute,
        title: slot.title,
        ...(slot.brief ? { brief: slot.brief } : {}),
      });
      if (!result.ok) {
        setError(result.error ?? tp.saveFailed);
        return;
      }
      setSlots((prev) => [...prev, result.slot]);
      setRail({ kind: "slot", draft: planSlotToDraft(result.slot) });
    } finally {
      setBusy(false);
    }
  }

  async function removeSlot(slot: PlanSlot) {
    setBusy(true);
    try {
      const result = await deletePlanSlot(assistantId, slot.id);
      if (!result.ok) {
        setError(result.error ?? tp.saveFailed);
        return;
      }
      setSlots((prev) => prev.filter((s) => s.id !== slot.id));
      setRail({ kind: "brief" });
    } finally {
      setBusy(false);
    }
  }

  async function startDrafting(slot: PlanSlot) {
    setBusy(true);
    try {
      const result = await draftFromPlanSlot(assistantId, slot.id);
      if (!result.ok) {
        setError(result.error ?? tp.saveFailed);
        return;
      }
      setSlots((prev) => prev.map((s) => (s.id === slot.id ? result.slot : s)));
      router.push(
        `${feedPath(team.workspaceId, {
          platform: slot.platform,
          segment: "draft-sessions",
        })}/${result.sessionId}`,
      );
    } finally {
      setBusy(false);
    }
  }

  function openExistingDraft(slot: PlanSlot) {
    if (!slot.sessionId) return;
    router.push(
      `${feedPath(team.workspaceId, {
        platform: slot.platform,
        segment: "draft-sessions",
      })}/${slot.sessionId}`,
    );
  }

  async function addIdea(text: string): Promise<boolean> {
    const result = await createFeedIdea(assistantId, { text });
    if (!result.ok) {
      setError(result.error ?? tp.ideaSaveFailed);
      return false;
    }
    setIdeas((prev) => [result.idea, ...prev]);
    return true;
  }

  /** Optimistic: the card leaves the tray first and snaps back on failure. */
  async function discardIdea(idea: FeedIdea) {
    setIdeas((prev) => prev.filter((i) => i.id !== idea.id));
    const result = await updateFeedIdea(assistantId, idea.id, {
      discarded: true,
    });
    if (!result.ok) {
      setIdeas((prev) => [idea, ...prev]);
      setError(result.error ?? tp.saveFailed);
    }
  }

  /**
   * "Plan it": open the slot editor prefilled from the jot, dated today (the
   * chip drags to its real day afterwards). Saving binds the idea (see
   * saveSlot), so nothing needs retyping and nothing is written until Save.
   */
  function planIdea(idea: FeedIdea) {
    const text = idea.text.trim();
    const firstLine = text.split("\n")[0]?.trim().slice(0, 200) ?? "";
    const title = firstLine || text.slice(0, 200);
    const overflow = text.length > title.length ? text : "";
    const briefText = [overflow, idea.note?.trim() ?? ""]
      .filter(Boolean)
      .join("\n\n");
    setRail({
      kind: "slot",
      draft: {
        id: null,
        platform: idea.platformHint ?? defaultPlatform,
        scheduledMinute: null,
        scheduledFor: isoDay(today),
        title,
        brief: briefText,
        fromIdeaId: idea.id,
      },
    });
  }

  async function saveBrief(next: {
    brief: string;
    themes: string[];
    cadencePerWeek: number | null;
  }) {
    setBusy(true);
    try {
      const result = await savePlanBrief(assistantId, { month, ...next });
      if (!result.ok) {
        setError(result.error ?? tp.saveFailed);
        return;
      }
      setBrief(result.brief);
    } finally {
      setBusy(false);
    }
  }

  /** Hand the assistant the month's context and let it propose the gaps. */
  function planWithAssistant() {
    const scheduled = slots
      .filter((s) => s.status !== "skipped")
      .map((s) => `- ${s.scheduledFor} (${t.platformLabels[s.platform]}): ${s.title}`)
      .join("\n");
    requestFeedChatSeed({
      prefill: format(tp.planWithAssistantPrompt, {
        month,
        brief: brief?.brief?.trim() || tp.noBriefYet,
        scheduled: scheduled || tp.nothingScheduledYet,
      }),
    });
    setWatchToken((n) => n + 1);
  }

  /**
   * D30, the opt-in half of the hybrid. It hands the assistant the month's
   * EMPTY slots by id and asks for briefs, not copy: nothing generates a
   * caption and nothing opens a session, so accepting a card is a PATCH of a
   * slot the operator already created rather than N drafts appearing unasked.
   */
  function fillEmptySlots() {
    const targets = emptySlots(slots);
    if (targets.length === 0) {
      setError(tp.fillEmptyNone);
      return;
    }
    const lines = targets
      .map(
        (s) =>
          `- ${s.scheduledFor} (${t.platformLabels[s.platform]}) slotId=${s.id}`,
      )
      .join("\n");
    requestFeedChatSeed({
      prefill: format(tp.fillEmptyPrompt, {
        month,
        brief: brief?.brief?.trim() || tp.noBriefYet,
        cadence: brief?.cadencePerWeek ? String(brief.cadencePerWeek) : tp.noCadenceYet,
        slots: lines,
      }),
    });
    setWatchToken((n) => n + 1);
  }

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
        <div className="mx-auto max-w-5xl space-y-4">
          <header className="flex items-start justify-between gap-4">
            <div className="space-y-1">
              <h1 className="text-[15px] font-semibold">{t.sections.plan}</h1>
              <p className="text-xs text-muted-foreground">{tp.subtitle}</p>
            </div>
            {canEdit ? (
              <div className="flex shrink-0 items-center">
                <button
                  type="button"
                  onClick={planWithAssistant}
                  className="inline-flex h-8 items-center gap-1.5 rounded-l-lg border border-border px-3 text-[12.5px] font-medium transition-colors hover:bg-accent"
                >
                  <Sparkles className="size-3.5" aria-hidden />
                  {tp.planWithAssistant}
                </button>
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label={tp.planMonthActions}
                        className="inline-flex h-8 items-center rounded-r-lg border border-l-0 border-border px-1.5 transition-colors hover:bg-accent"
                      >
                        <ChevronDown className="size-3.5" aria-hidden />
                      </button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem onClick={fillEmptySlots}>
                      {tp.fillEmptySlots}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ) : null}
          </header>

          {error ? (
            <div
              role="alert"
              className="rounded-xl border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive"
            >
              {error}
            </div>
          ) : null}

          {loading ? (
            <div className="h-[520px] animate-pulse rounded-xl border border-border/60 bg-muted/30" />
          ) : (
            <>
              <div className="mb-2 flex items-center justify-end">
                <div
                  role="tablist"
                  aria-label={tp.viewMonth}
                  className="inline-flex items-center gap-0.5 rounded-md border border-border/60 p-0.5"
                >
                  {(["month", "week", "list"] as const).map((key) => (
                    <button
                      key={key}
                      type="button"
                      role="tab"
                      aria-selected={view === key}
                      onClick={() => setView(key)}
                      className={cn(
                        "h-6 rounded px-2 text-[12.5px] font-medium transition-colors",
                        view === key
                          ? "bg-foreground text-background"
                          : "text-muted-foreground hover:bg-accent hover:text-foreground",
                      )}
                    >
                      {key === "month"
                        ? tp.viewMonth
                        : key === "week"
                          ? tp.viewWeek
                          : tp.viewList}
                    </button>
                  ))}
                </div>
              </div>

              {view === "month" ? (
                <PlanCalendar
                  month={month}
                  slots={slots}
                  today={today}
                  cadencePerWeek={brief?.cadencePerWeek ?? null}
                  selectedSlotId={rail.kind === "slot" ? rail.draft.id : null}
                  canEdit={canEdit}
                  onMonthChange={setMonth}
                  onAddOnDay={openNewSlot}
                  onSelectSlot={openSlot}
                  onReschedule={(slot, iso) => void reschedule(slot, iso)}
                  onDuplicateSlot={(slot) => void duplicateSlot(slot)}
                  onDeleteSlot={(slot) => void removeSlot(slot)}
                />
              ) : view === "week" ? (
                <PlanWeek
                  anchorIso={weekAnchor}
                  slots={slots}
                  today={today}
                  selectedSlotId={rail.kind === "slot" ? rail.draft.id : null}
                  canEdit={canEdit}
                  onAnchorChange={setWeekAnchor}
                  onSelectSlot={openSlot}
                  onMoveSlot={(slot, iso, minute) =>
                    void reschedule(slot, iso, minute)
                  }
                  onDuplicateSlot={(slot) => void duplicateSlot(slot)}
                  onDeleteSlot={(slot) => void removeSlot(slot)}
                />
              ) : (
                <PlanList
                  month={month}
                  slots={slots}
                  cadencePerWeek={brief?.cadencePerWeek ?? null}
                  today={today}
                  selectedSlotId={rail.kind === "slot" ? rail.draft.id : null}
                  canEdit={canEdit}
                  onAddOnDay={openNewSlot}
                  onSelectSlot={openSlot}
                  onDuplicateSlot={(slot) => void duplicateSlot(slot)}
                  onDeleteSlot={(slot) => void removeSlot(slot)}
                />
              )}
            </>
          )}
        </div>
      </div>

      <aside className="hidden w-80 shrink-0 border-l border-border/60 lg:block">
        {rail.kind === "slot" ? (
          <PlanSlotPeek
            draft={rail.draft}
            slot={selectedSlot}
            canEdit={canEdit}
            busy={busy}
            onChange={(draft) => setRail({ kind: "slot", draft })}
            onSave={() => void saveSlot()}
            onDelete={() => selectedSlot && void removeSlot(selectedSlot)}
            onDraftThis={() => selectedSlot && void startDrafting(selectedSlot)}
            onOpenDraft={() => selectedSlot && openExistingDraft(selectedSlot)}
            onToggleSkip={() => selectedSlot && void toggleSkip(selectedSlot)}
            onDiscuss={() =>
              selectedSlot &&
              requestFeedChatSeed({
                prefill: format(tp.discussSlotPrompt, {
                  title: selectedSlot.title,
                  date: selectedSlot.scheduledFor,
                  platform: t.platformLabels[selectedSlot.platform],
                  brief: selectedSlot.brief?.trim() || tp.noBriefYet,
                }),
              })
            }
            onBack={() => setRail({ kind: "brief" })}
          />
        ) : (
          <PlanBriefRail
            month={month}
            brief={brief}
            counts={counts}
            canEdit={canEdit}
            busy={busy}
            assistantId={assistantId}
            existingSlots={slots}
            ideas={ideas}
            watchToken={watchToken}
            onSave={(next) => void saveBrief(next)}
            onSlotsAccepted={() => void load()}
            onAddIdea={addIdea}
            onDiscardIdea={(idea) => void discardIdea(idea)}
            onPlanIdea={planIdea}
          />
        )}
      </aside>
    </div>
  );
}
