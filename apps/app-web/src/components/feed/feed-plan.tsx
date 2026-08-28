"use client";

/**
 * The Plan surface: the marketing calendar plus the month brief that drives
 * it (feed-revamp.md §3.1). Owns the bare `/feed` index (D5), so it also
 * renders the first-run onboarding when the workspace has no brand voice.
 *
 * Layout is calendar + the docked plan chat rail
 * (docs/plans/feed-plan-chat-first.md P1): the right rail hosts the
 * `channel_id='plan'` master conversation, and the selected-slot editor and
 * once-per-month brief open as overlays over it, returning to the chat.
 *
 * [COMP:app-web/feed-plan-surface]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
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
import { PlanBriefEditor } from "@/components/feed/plan-brief-editor";
import {
  PlanChatRail,
  type PlanQuickAction,
} from "@/components/feed/plan-chat-rail";
import { useLgViewport } from "@/components/feed/use-lg-viewport";
import {
  PeekResizeHandle,
  usePeekResize,
} from "@/components/operator/resizable-peek";
import {
  createFeedIdea,
  createPlanSlot,
  deletePlanSlot,
  draftFromPlanSlot,
  ensurePlanSession,
  fetchFeedIdeas,
  fetchFeedSessionIdByChannel,
  fetchPlanBrief,
  fetchPlanSlots,
  savePlanBrief,
  updateFeedIdea,
  updatePlanSlot,
} from "@/lib/api/feed";
import { fetchSessionMessages } from "@/lib/api/sessions";
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
import {
  pendingProposedSlots,
  replayPlanProposal,
  type ProposedSlot,
} from "@/lib/feed-plan-proposal";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

export function FeedPlan() {
  const team = useFeedWorkspace();
  const { openConnect, dialog, isAdmin } = useConnectAccount();
  const router = useRouter();
  const canConnect = isAdmin;
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
          onConnect={() => {
            const cloudState = team.cloudLink?.state ?? "native";
            if (cloudState === "native" || cloudState === "linked") {
              void openConnect();
              return;
            }
            const platform = defaultFeedPlatform(
              team.workspaceId,
              team.profiles.map((profile) => profile.platform),
            );
            router.push(feedPath(team.workspaceId, { platform, segment: "settings" }));
          }}
          onReady={handleReady}
        />
      ) : (
        <PlanBoard assistantId={brand.id} />
      )}
    </>
  );
}

/**
 * The rail's state machine: the chat is the base state (P9), the brief and
 * slot editors are overlays that fold back to it. The chat rail underneath
 * stays MOUNTED (hidden + inert) so its stream survives an overlay.
 */
type RailView =
  | { kind: "chat" }
  | { kind: "brief" }
  | { kind: "slot"; draft: PlanSlotDraft };

/** Sticky conversation identity (server twin: PLAN_CHANNEL_ID). */
const PLAN_CHANNEL_ID = "plan";
/** Bounded proposal watch: fast enough to feel live, never an idle poller. */
const PROPOSAL_WATCH_INTERVAL_MS = 4_000;
const PROPOSAL_WATCH_TIMEOUT_MS = 120_000;

function PlanBoard({ assistantId }: { assistantId: string }) {
  const team = useFeedWorkspace();
  const t = useT().feedPage;
  const tp = t.plan;
  const router = useRouter();
  const searchParams = useSearchParams();
  // User-adjustable rail width — the shared peek-resize behavior (drag the
  // left edge, double-click to reset). Floor below the shared default so the
  // rail can stay at its compact 320px baseline.
  const {
    width: railWidth,
    resizing: railResizing,
    handleProps: railHandleProps,
  } = usePeekResize("feed:plan-rail-width", { minWidth: 280 });

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
  const [rail, setRail] = useState<RailView>({ kind: "chat" });
  // Bumped when the operator asks for a plan; the board watches for the
  // assistant's `proposePlan` cardboard so calendar and rail share one set.
  const [watchToken, setWatchToken] = useState(0);
  const [proposed, setProposed] = useState<ProposedSlot[]>([]);
  const [dismissedProposals, setDismissedProposals] = useState<Set<number>>(
    new Set(),
  );
  const [pullingProposals, setPullingProposals] = useState(false);
  const [acceptingProposalIndex, setAcceptingProposalIndex] = useState<
    number | null
  >(null);

  // Open the sticky `mode='plan'` conversation so the dock resumes it and the
  // assistant gets the proposePlan tool. Idempotent, so a remount is free.
  useEffect(() => {
    void ensurePlanSession(assistantId);
  }, [assistantId]);

  const canEdit = team.role !== "member" || team.canDraft;

  // The docked chat rail is live only where it is visible; below `lg` the
  // floating Feed dock hosts the same session instead (P4).
  const isLg = useLgViewport();

  // Identity for the chat rail's panel header. A connected profile carries
  // the avatar seed; an unconnected brand voice has name only.
  const railAssistant = useMemo(() => {
    const fromProfile = team.profiles.find(
      (p) => p.assistant.id === assistantId,
    )?.assistant;
    if (fromProfile) {
      return { name: fromProfile.name, iconSeed: fromProfile.iconSeed };
    }
    const fromBrand = team.assistants.find((a) => a.id === assistantId);
    return { name: fromBrand?.name ?? "", iconSeed: undefined };
  }, [team.profiles, team.assistants, assistantId]);

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

  const pullProposal = useCallback(async () => {
    setPullingProposals(true);
    try {
      const sessionId = await fetchFeedSessionIdByChannel(
        assistantId,
        PLAN_CHANNEL_ID,
      );
      if (!sessionId) {
        setProposed([]);
        return;
      }
      const rows = await fetchSessionMessages(sessionId);
      const proposal = replayPlanProposal(rows);
      setProposed(
        proposal?.month === month
          ? pendingProposedSlots(proposal, slots)
          : [],
      );
    } finally {
      setPullingProposals(false);
    }
  }, [assistantId, month, slots]);

  useEffect(() => {
    void pullProposal();
  }, [pullProposal]);

  // Poll only after a planning request, and stop after two minutes. The same
  // callback updates both the rail and calendar previews atomically.
  const proposalWatchRef = useRef(0);
  useEffect(() => {
    if (watchToken === 0 || watchToken === proposalWatchRef.current) return;
    proposalWatchRef.current = watchToken;
    const startedAt = Date.now();
    let stopped = false;
    const timer = setInterval(() => {
      if (
        stopped ||
        Date.now() - startedAt > PROPOSAL_WATCH_TIMEOUT_MS
      ) {
        clearInterval(timer);
        return;
      }
      void pullProposal();
    }, PROPOSAL_WATCH_INTERVAL_MS);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, [watchToken, pullProposal]);

  const visibleProposals = useMemo(
    () => proposed.filter((slot) => !dismissedProposals.has(slot.index)),
    [dismissedProposals, proposed],
  );

  // A month change resets the contextual detail. Carrying an editor from the
  // previous month into a new calendar is surprising and makes the rail feel
  // permanent rather than tied to what the operator is viewing now.
  useEffect(() => {
    setRail({ kind: "chat" });
    setProposed([]);
    setDismissedProposals(new Set());
  }, [month]);

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
      setRail({ kind: "chat" });
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
      setRail({ kind: "chat" });
    } finally {
      setBusy(false);
    }
  }

  /**
   * Quick actions (P3): the retired header split button's jobs, seeded into
   * the docked plan chat. Each seeds the composer — the operator reads and
   * sends — and bumps the proposal watch so the cardboard follows.
   */
  function planNextWeek() {
    const start = isoDay(today);
    const endDate = new Date(today);
    endDate.setDate(endDate.getDate() + 7);
    const end = isoDay(endDate);
    const scheduled = slots
      .filter(
        (s) =>
          s.status !== "skipped" &&
          s.scheduledFor >= start &&
          s.scheduledFor < end,
      )
      .map((s) => `- ${s.scheduledFor} (${t.platformLabels[s.platform]}): ${s.title}`)
      .join("\n");
    requestFeedChatSeed({
      prefill: format(tp.planWeekPrompt, {
        start,
        brief: brief?.brief?.trim() || tp.noBriefYet,
        scheduled: scheduled || tp.nothingScheduledYet,
      }),
    });
    setWatchToken((n) => n + 1);
  }

  /**
   * Review, not fill: hands the assistant the WHOLE month with slot ids so a
   * proposed change patches the slot in place (the D25 `slotId` idiom)
   * rather than duplicating beside it.
   */
  function reviewMonth() {
    const scheduled = slots
      .filter((s) => s.status !== "skipped")
      .map(
        (s) =>
          `- ${s.scheduledFor} (${t.platformLabels[s.platform]}) slotId=${s.id}: ${s.title}`,
      )
      .join("\n");
    requestFeedChatSeed({
      prefill: format(tp.reviewMonthPrompt, {
        month,
        brief: brief?.brief?.trim() || tp.noBriefYet,
        cadence: brief?.cadencePerWeek ? String(brief.cadencePerWeek) : tp.noCadenceYet,
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

  /**
   * The only proposal-to-calendar write boundary. Both the calendar preview
   * and rail call this function, so Add cannot behave differently by surface.
   */
  async function acceptProposal(slot: ProposedSlot) {
    setAcceptingProposalIndex(slot.index);
    try {
      // A card carrying slotId fills an existing empty slot. Creating beside
      // it would defeat the opt-in fill flow and produce a duplicate.
      const result = slot.slotId
        ? await updatePlanSlot(assistantId, slot.slotId, {
            title: slot.title,
            brief: slot.brief ?? null,
          })
        : await createPlanSlot(assistantId, {
            platform: slot.platform,
            scheduledFor: slot.date,
            title: slot.title,
            ...(slot.brief ? { brief: slot.brief } : {}),
          });
      if (!result.ok) {
        setError(result.error ?? tp.saveFailed);
        return;
      }
      setDismissedProposals((prev) => new Set(prev).add(slot.index));
      setSlots((prev) => {
        const next = prev.filter((existing) => existing.id !== result.slot.id);
        next.push(result.slot);
        return next.sort(
          (a, b) =>
            a.scheduledFor.localeCompare(b.scheduledFor) ||
            a.createdAt.localeCompare(b.createdAt),
        );
      });
    } finally {
      setAcceptingProposalIndex(null);
    }
  }

  async function acceptAllProposals() {
    for (const slot of visibleProposals) {
      await acceptProposal(slot);
    }
  }

  function dismissProposal(slot: ProposedSlot) {
    setDismissedProposals((prev) => new Set(prev).add(slot.index));
  }

  const showProposals = watchToken > 0 || visibleProposals.length > 0;

  // P3: the three locked chips. Plain array — each `run` closes over the
  // current month/brief/slots, and the rail re-renders with the board.
  const quickActions: PlanQuickAction[] = [
    { key: "fill-empty", label: tp.quickFillEmpty, run: fillEmptySlots },
    { key: "plan-week", label: tp.quickPlanWeek, run: planNextWeek },
    { key: "review-month", label: tp.quickReviewMonth, run: reviewMonth },
  ];

  return (
    <div className="flex h-full min-h-0">
      <div className="min-w-0 flex-1 overflow-y-auto px-4 py-5 md:px-6">
        <div className="mx-auto max-w-5xl space-y-4">
          {/* One primary action per surface: the header carries none — the
              assistant-led verbs live as quick-action chips in the chat rail
              (P3), and capture owns the primary affordance (P5, phase 2). */}
          <header className="space-y-1">
            <h1 className="text-[15px] font-semibold">{t.sections.plan}</h1>
            <p className="text-xs text-muted-foreground">{tp.subtitle}</p>
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
                  proposals={visibleProposals}
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
                  acceptingProposalIndex={acceptingProposalIndex}
                  onAcceptProposal={(proposal) => void acceptProposal(proposal)}
                  onAcceptAllProposals={() => void acceptAllProposals()}
                  onDismissProposal={dismissProposal}
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

      <aside
        style={railWidth !== null ? { width: railWidth } : undefined}
        className={cn(
          "relative hidden w-80 shrink-0 border-l border-border/60 lg:block",
          railResizing && "select-none",
        )}
      >
        <PeekResizeHandle resizing={railResizing} {...railHandleProps} />
        {/* Mount-gated on the same breakpoint that hides the aside: below
            `lg` the floating Feed dock is the live chat host, and a second
            mounted panel on the same plan session would double-subscribe
            its stream (P4). */}
        {isLg ? (
          <>
            {/* The chat rail is the base state and stays MOUNTED under an
                overlay (hidden + inert) so its stream survives (P9). */}
            <div
              className={cn("h-full min-h-0", rail.kind !== "chat" && "hidden")}
              aria-hidden={rail.kind !== "chat"}
              inert={rail.kind !== "chat"}
            >
              <PlanChatRail
                assistantId={assistantId}
                assistantName={railAssistant.name}
                iconSeed={railAssistant.iconSeed}
                workspaceId={team.workspaceId}
                month={month}
                brief={brief}
                counts={counts}
                openIdeasCount={ideas.length}
                canEdit={canEdit}
                proposals={visibleProposals}
                showProposals={showProposals}
                pullingProposals={pullingProposals}
                acceptingProposalIndex={acceptingProposalIndex}
                quickActions={quickActions}
                onAcceptProposal={(proposal) => void acceptProposal(proposal)}
                onAcceptAllProposals={() => void acceptAllProposals()}
                onDismissProposal={dismissProposal}
                onRefreshProposals={() => void pullProposal()}
                onOpenBrief={() => setRail({ kind: "brief" })}
                onTurnComplete={() => void pullProposal()}
                onActivate={() => setRail({ kind: "chat" })}
              />
            </div>
            {rail.kind === "slot" ? (
              <div className="absolute inset-0 bg-background">
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
                  onBack={() => setRail({ kind: "chat" })}
                />
              </div>
            ) : rail.kind === "brief" ? (
              <div className="absolute inset-0 bg-background">
                <PlanBriefEditor
                  brief={brief}
                  canEdit={canEdit}
                  busy={busy}
                  onSave={(next) => void saveBrief(next)}
                  onBack={() => setRail({ kind: "chat" })}
                />
              </div>
            ) : null}
          </>
        ) : null}
      </aside>
    </div>
  );
}
