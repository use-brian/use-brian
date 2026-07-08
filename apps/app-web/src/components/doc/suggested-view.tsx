"use client";

/**
 * Suggested-for-you — the full Home content-pane surface (doc-shell.tsx, the
 * `!urlViewId` index). A daily briefing the workspace assistant curates: a slim
 * build bar, a conversational note, the "needs you" actions, drafts to resume,
 * upcoming workflows, and brain growth - a full-width dashboard (main + rail).
 *
 * Data: the resolved dock (the assistant's layout artifact already merged over
 * live signals, dead cards dropped - the freshness contract lives server-side)
 * is OWNED by `DocSidebarDataProvider` and shared with the sidebar's badge
 * (`HomeDock`) — this view renders `useSidebarData().dock`, revalidates it on
 * re-entry via `reloadDock()`, and pushes the Refresh result (one primary-
 * assistant curation turn) back through `setDock`. The build bar calls
 * `onBuild` (the shell's page builder), so the type-a-prompt flow survives
 * here. Spec: docs/architecture/features/home-dock.md.
 *
 * [COMP:app-web/home-suggested]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  ArrowUp,
  Brain,
  Cable,
  CheckCircle2,
  ChevronRight,
  Clock,
  FileText,
  RefreshCw,
  Sparkles,
  Target,
  Workflow,
  X,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { SuggestedFileDrop } from "@/components/doc/suggested-file-drop";
import { getAssistantIdentity, type AssistantIdentity } from "@/lib/api/views";
import { refreshHomeDock, type ResolvedNeed } from "@/lib/api/home-dock";
import { type PanelId } from "@/lib/doc-page-url";
import { useSidebarData } from "./doc-sidebar-data";

type AccentKey = "review" | "approve" | "resume" | "workflow" | "alert" | "runs";

// Full literal class strings (Tailwind JIT can't see constructed names).
const ACCENT: Record<AccentKey, { text: string; chip: string; hover: string }> = {
  review: {
    text: "text-amber-600 dark:text-amber-400",
    chip: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
    hover: "hover:border-amber-500/40",
  },
  approve: {
    text: "text-rose-600 dark:text-rose-400",
    chip: "bg-rose-500/12 text-rose-600 dark:text-rose-400",
    hover: "hover:border-rose-500/40",
  },
  resume: {
    text: "text-blue-600 dark:text-blue-400",
    chip: "bg-blue-500/12 text-blue-600 dark:text-blue-400",
    hover: "hover:border-blue-500/40",
  },
  workflow: {
    text: "text-violet-600 dark:text-violet-400",
    chip: "bg-violet-500/12 text-violet-600 dark:text-violet-400",
    hover: "hover:border-violet-500/40",
  },
  alert: {
    text: "text-orange-600 dark:text-orange-400",
    chip: "bg-orange-500/12 text-orange-600 dark:text-orange-400",
    hover: "hover:border-orange-500/40",
  },
  runs: {
    text: "text-sky-600 dark:text-sky-400",
    chip: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
    hover: "hover:border-sky-500/40",
  },
};

type Props = {
  workspaceId: string;
  /** The workspace primary (doc) assistant — fronts the note card with its
   *  creature avatar + name. Optional: absent (or while resolving / on a
   *  failed fetch) the header degrades to the generic glyph + "Your assistant". */
  assistantId?: string;
  userName?: string | null;
  onBuild?: (text: string) => void;
  /** Open a needs-you panel (Approvals / Autopilot) as a doc-shell tab. When
   *  absent (e.g. a non-shell host), the cards fall back to their route link. */
  onOpenPanel?: (panel: PanelId) => void;
};

export function SuggestedView({
  workspaceId,
  assistantId,
  userName,
  onBuild,
  onOpenPanel,
}: Props) {
  const t = useT().docPage.suggested;
  const { dock, dockLoading: loading, reloadDock, setDock } = useSidebarData();
  const [assistant, setAssistant] = useState<AssistantIdentity | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [noteDismissed, setNoteDismissed] = useState(false);
  const [q, setQ] = useState("");

  // Revalidate the shared dock once when Home re-mounts (soft-nav back from
  // approvals/brain/etc., where the counts likely moved) — skipped while the
  // provider's initial fetch is still in flight, so the first open costs one
  // GET. The provider keeps the current dock until the fresh one lands.
  const revalidatedRef = useRef(false);
  useEffect(() => {
    if (revalidatedRef.current) return;
    revalidatedRef.current = true;
    if (!loading) reloadDock();
  }, [loading, reloadDock]);

  // The note card's identity header (getAssistantIdentity returns null on any
  // error, so a failed fetch just keeps the generic fallback).
  useEffect(() => {
    if (!assistantId) {
      setAssistant(null);
      return;
    }
    let alive = true;
    getAssistantIdentity(assistantId).then((identity) => {
      if (alive) setAssistant(identity);
    });
    return () => {
      alive = false;
    };
  }, [assistantId]);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    const d = await refreshHomeDock(workspaceId);
    setRefreshing(false);
    if (d) {
      setDock(d);
      setNoteDismissed(false);
    }
  }, [workspaceId]);

  function build() {
    const text = q.trim();
    if (!text) return;
    onBuild?.(text);
    setQ("");
  }

  const now = new Date();
  const hours = now.getHours();
  const greeting =
    hours < 12 ? t.greetingMorning : hours < 18 ? t.greetingAfternoon : t.greetingEvening;
  const dateLabel = now.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
  });

  const note = dock?.note && !noteDismissed ? dock.note : null;
  const needsYou = dock?.needsYou ?? [];
  const pickUp = dock?.pickUp ?? [];
  const comingUp = dock?.comingUp ?? [];
  const brain = dock?.brain ?? null;
  const mainEmpty = !note && needsYou.length === 0 && pickUp.length === 0;

  return (
    <div className="mx-auto w-full max-w-[1240px] px-8 pb-12 pt-11 lg:px-12">
      {/* Header */}
      <div className="flex items-start gap-3">
        <div className="flex-1">
          <div className="mb-1.5 text-[11.5px] font-bold uppercase tracking-wider text-muted-foreground/70">
            {dateLabel}
          </div>
          <h1 className="text-[28px] font-bold tracking-tight text-foreground">
            {userName ? `${greeting}, ${userName}` : greeting}
          </h1>
          <p className="mt-1.5 text-[13.5px] text-muted-foreground">{t.subtitle}</p>
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={refreshing}
          className="inline-flex shrink-0 items-center gap-1.5 rounded-lg border border-border bg-card px-3 py-1.5 text-[12.5px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-60"
        >
          <RefreshCw className={cn("size-3.5", refreshing && "animate-spin")} aria-hidden />
          {refreshing ? t.refreshing : t.refresh}
        </button>
      </div>

      {/* Slim build bar — keeps the type-a-prompt build flow in the new rhythm */}
      <div className="mt-5 flex items-center gap-2.5 rounded-xl border border-border bg-card px-3 py-2 shadow-sm transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30">
        <Sparkles className="size-[17px] shrink-0 text-muted-foreground/60" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              build();
            }
          }}
          placeholder={t.buildPlaceholder}
          /* The wrapping bar draws the focus ring (focus-within); the inner
             input opts out of the global :focus-visible box-shadow —
             `outline-none` alone never silences it (globals.css → ":focus-visible"). */
          className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none focus-visible:shadow-none placeholder:text-muted-foreground"
        />
        <button
          type="button"
          onClick={build}
          disabled={!q.trim()}
          aria-label={t.buildPlaceholder}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-foreground/10 disabled:text-muted-foreground"
        >
          <ArrowUp className="size-4" aria-hidden />
        </button>
      </div>

      {/* Drop files to add to the brain — store raw bytes + decompose content. */}
      <SuggestedFileDrop workspaceId={workspaceId} />

      {loading ? (
        <DockSkeleton />
      ) : (
        <div className="mt-6 grid grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_348px]">
          {/* ── MAIN ── */}
          <div>
            {note && (
              <div className="group relative overflow-hidden rounded-r-2xl border border-border/70 bg-gradient-to-br from-blue-500/[0.07] to-violet-500/[0.06] p-4 pl-5">
                <span className="absolute inset-y-0 left-0 w-[3px] bg-gradient-to-b from-blue-500 to-violet-500" />
                <button
                  type="button"
                  aria-label="Dismiss"
                  onClick={() => setNoteDismissed(true)}
                  className="absolute right-2.5 top-2.5 grid size-6 place-items-center rounded-md text-muted-foreground/40 opacity-0 transition-opacity hover:bg-accent hover:text-foreground group-hover:opacity-100"
                >
                  <X className="size-3.5" aria-hidden />
                </button>
                <div className="mb-2 flex items-center gap-2">
                  {assistant ? (
                    <span
                      aria-hidden
                      className="inline-flex size-[22px] shrink-0 overflow-hidden rounded-md ring-1 ring-black/10 dark:ring-white/15 [&>svg]:size-full"
                    >
                      <AssistantAvatar
                        id={assistant.id}
                        name={assistant.name}
                        iconSeed={assistant.iconSeed ?? undefined}
                        size="sm"
                      />
                    </span>
                  ) : (
                    <span className="grid size-[22px] place-items-center rounded-md bg-gradient-to-br from-blue-500 to-violet-500 text-white">
                      <Sparkles className="size-3" aria-hidden />
                    </span>
                  )}
                  <span className="text-[12px] font-semibold text-foreground">
                    {assistant?.name ?? t.assistant}
                  </span>
                </div>
                <p className="max-w-[64ch] pr-6 text-[15px] leading-relaxed text-foreground">
                  {note}
                </p>
              </div>
            )}

            {needsYou.length > 0 && (
              <>
                <GroupLabel count={needsYou.length} className={note ? "mt-7" : "mt-1"}>
                  {t.needsYou}
                </GroupLabel>
                {/* A lone card spans the column; two share the row 2-up. */}
                <div className={cn("grid grid-cols-1 gap-3", needsYou.length > 1 && "sm:grid-cols-2")}>
                  {needsYou.map((card) => (
                    <ActionCard
                      key={card.kind}
                      card={card}
                      workspaceId={workspaceId}
                      t={t}
                      onOpenPanel={onOpenPanel}
                    />
                  ))}
                </div>
              </>
            )}

            {pickUp.length > 0 && (
              <>
                <GroupLabel className="mt-7">{t.pickUp}</GroupLabel>
                {pickUp.map((p) => (
                  <ListRow
                    key={p.id}
                    accent="resume"
                    Icon={FileText}
                    href={`/w/${workspaceId}/p/${p.id}`}
                    title={p.name || "Untitled"}
                    sub={formatEdited(p.updatedAt)}
                    meta={`${t.resume} ›`}
                  />
                ))}
              </>
            )}

            {mainEmpty && (
              <div className="mt-2 rounded-2xl border border-border bg-card px-5 py-8 text-center">
                <div className="mx-auto mb-3 grid size-10 place-items-center rounded-full bg-emerald-500/12 text-emerald-600 dark:text-emerald-400">
                  <CheckCircle2 className="size-5" aria-hidden />
                </div>
                <h3 className="text-[15px] font-semibold text-foreground">{t.allClearTitle}</h3>
                <p className="mx-auto mt-1 max-w-sm text-[13px] text-muted-foreground">
                  {t.allClearBody}
                </p>
              </div>
            )}
          </div>

          {/* ── RAIL ── */}
          <aside>
            {brain && (
              <>
                <GroupLabel>{t.yourBrain}</GroupLabel>
                <div className="rounded-2xl border border-border bg-card p-4">
                  <div className="text-[28px] font-extrabold tracking-tight text-foreground">
                    {brain.entryCount}{" "}
                    <span className="text-[14px] font-semibold text-muted-foreground">
                      {t.entries}
                    </span>
                  </div>
                  <div className="mt-0.5 text-[12.5px] text-muted-foreground">
                    {brain.growth7d > 0 ? (
                      <>
                        <span className="font-bold text-emerald-600 dark:text-emerald-400">
                          +{brain.growth7d}
                        </span>{" "}
                        {t.thisWeek} {"·"} {t.growingSteadily}
                      </>
                    ) : (
                      t.quietWeek
                    )}
                  </div>
                  <svg
                    className="my-3.5 block w-full"
                    height="44"
                    viewBox="0 0 300 44"
                    fill="none"
                    preserveAspectRatio="none"
                    aria-hidden
                  >
                    <polyline
                      points={sparklinePoints(brain.sparkline, brain.entryCount)}
                      className="stroke-sky-500 dark:stroke-sky-400"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    />
                  </svg>
                  {!brain.hasConnector && (
                    <Link
                      href={`/w/${workspaceId}/studio`}
                      className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg border border-emerald-500/40 px-3 py-2 text-[12.5px] font-semibold text-emerald-600 transition-colors hover:bg-emerald-500/10 dark:text-emerald-400"
                    >
                      <Cable className="size-3.5" aria-hidden />
                      {t.connect}
                    </Link>
                  )}
                </div>
              </>
            )}

            {/* Coming up — the upcoming workflow schedule as a timeline, or a
                quiet build nudge when nothing is scheduled. Always rendered once
                the dock resolves so the rail fills the column. */}
            {dock && (
              <>
                <GroupLabel className={brain ? "mt-7" : undefined}>{t.comingUp}</GroupLabel>
                <div className="rounded-2xl border border-border bg-card p-4">
                  {comingUp.length > 0 ? (
                    <ol className="relative">
                      {comingUp.length > 1 && (
                        <span
                          className="absolute bottom-3 left-[5.5px] top-1.5 w-px bg-border"
                          aria-hidden
                        />
                      )}
                      {comingUp.map((w, i) => (
                        <li key={w.id} className={cn("relative flex gap-3", i > 0 && "mt-3.5")}>
                          <span
                            className="relative z-10 mt-[3px] size-3 shrink-0 rounded-full border-2 border-violet-500/70 bg-card"
                            aria-hidden
                          />
                          <Link href={`/w/${workspaceId}/workflow`} className="group min-w-0 flex-1">
                            <span className="block text-[12px] font-semibold text-violet-600 dark:text-violet-400">
                              {formatScheduleWhen(w.nextRunAt, t)}
                            </span>
                            <span className="block truncate text-[13px] text-foreground group-hover:underline">
                              {w.name}
                            </span>
                          </Link>
                        </li>
                      ))}
                    </ol>
                  ) : (
                    <div className="py-1.5 text-center">
                      <div className="mx-auto mb-2 grid size-9 place-items-center rounded-full bg-violet-500/12 text-violet-600 dark:text-violet-400">
                        <Clock className="size-[18px]" strokeWidth={1.8} aria-hidden />
                      </div>
                      <p className="text-[13px] font-medium text-foreground">{t.noScheduledTitle}</p>
                      <p className="mx-auto mt-0.5 max-w-[28ch] text-[12px] leading-snug text-muted-foreground">
                        {t.noScheduledBody}
                      </p>
                      <Link
                        href={`/w/${workspaceId}/workflow`}
                        className="mt-3 inline-flex items-center gap-1 text-[12.5px] font-semibold text-violet-600 transition-colors hover:underline dark:text-violet-400"
                      >
                        {t.buildWorkflow}
                        <ChevronRight className="size-3.5" aria-hidden />
                      </Link>
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}

type SuggestedT = ReturnType<typeof useT>["docPage"]["suggested"];

function ActionCard({
  card,
  workspaceId,
  t,
  onOpenPanel,
}: {
  card: ResolvedNeed;
  workspaceId: string;
  t: SuggestedT;
  onOpenPanel?: (panel: PanelId) => void;
}) {
  const cfg = cardConfig(card.kind, workspaceId, t);
  const a = ACCENT[cfg.accent];
  // `items-stretch` is load-bearing: panel cards render as <button>, and the
  // browser UA stylesheet gives buttons `align-items: flex-start`, which
  // shrink-wraps the header row so the count's ml-auto has nothing to push
  // against (the Link cards stretch fine — that's why only they looked right).
  const cardClass = cn(
    "group relative flex flex-col items-stretch rounded-2xl border border-border bg-card p-4 text-left transition-all hover:shadow-md",
    a.hover,
  );
  const inner = (
    <>
      <div className="mb-3 flex items-center">
        <span className={cn("grid size-9 place-items-center rounded-[10px]", a.chip)}>
          <cfg.Icon className="size-[18px]" strokeWidth={1.8} aria-hidden />
        </span>
        <span className={cn("ml-auto text-[20px] font-extrabold leading-none", a.text)}>
          {card.count}
        </span>
      </div>
      <h3 className="text-[14.5px] font-semibold text-foreground">{cfg.title}</h3>
      <p className="mt-1 flex-1 text-[12.5px] leading-snug text-muted-foreground">
        {card.caption ?? cfg.fallbackCaption}
      </p>
      <span
        className={cn(
          "mt-3 inline-flex items-center gap-1 text-[12.5px] font-semibold",
          a.text,
        )}
      >
        {cfg.cta}
        <ChevronRight className="size-3.5" aria-hidden />
      </span>
    </>
  );

  // Panel cards (Approvals / Autopilot) open as a doc-shell tab when the shell
  // provides a handler; otherwise (and for the Brain card) they route-link.
  if (cfg.panel && onOpenPanel) {
    const panel = cfg.panel;
    return (
      <button type="button" onClick={() => onOpenPanel(panel)} className={cardClass}>
        {inner}
      </button>
    );
  }
  return (
    <Link href={cfg.href} className={cardClass}>
      {inner}
    </Link>
  );
}

/** Per-kind card chrome: accent, icon, destination, copy. `panel` is set for
 *  kinds that open as a doc-shell tab; the href is the no-JS / other-host
 *  fallback (and the real destination for full-surface kinds). */
function cardConfig(kind: ResolvedNeed["kind"], workspaceId: string, t: SuggestedT) {
  switch (kind) {
    case "brain_review":
      return {
        accent: "review" as const,
        Icon: Brain,
        // Deep-link straight into the Reviews section (brain/page.tsx seeds
        // section='reviews' from ?pending=true), not the grouped overview.
        href: `/w/${workspaceId}/brain?pending=true`,
        // Brain is a full surface, not a doc-shell panel.
        panel: null as PanelId | null,
        title: t.reviewTitle,
        fallbackCaption: t.reviewCaption,
        cta: t.reviewCta,
      };
    case "approvals":
      return {
        accent: "approve" as const,
        Icon: CheckCircle2,
        // The route redirects to the panel; `onOpenPanel` opens it as a tab
        // directly (the href is the no-JS / other-host fallback).
        href: `/w/${workspaceId}/approvals`,
        panel: "approvals" as PanelId | null,
        title: t.approvalsTitle,
        fallbackCaption: t.approvalsCaption,
        cta: t.approvalsCta,
      };
    case "autopilot":
      // Autopilot — draft goals awaiting a confirm + blocked goals. The
      // goals board has no sidebar slot (Approvals precedent): this card
      // and the Brain task panel are its entry points.
      return {
        accent: "workflow" as const,
        Icon: Target,
        href: `/w/${workspaceId}/goals`,
        panel: "goals" as PanelId | null,
        title: t.autopilotTitle,
        fallbackCaption: t.autopilotCaption,
        cta: t.autopilotCta,
      };
    case "connector_attention":
      // A connected tool's credentials died at call time (health_status =
      // 'auth_failed') — ingestion is silently paused until reconnected.
      return {
        accent: "alert" as const,
        Icon: Cable,
        href: `/w/${workspaceId}/studio/connectors`,
        panel: null as PanelId | null,
        title: t.connectorTitle,
        fallbackCaption: t.connectorCaption,
        cta: t.connectorCta,
      };
    case "workflow_attention":
      return {
        accent: "runs" as const,
        Icon: Workflow,
        href: `/w/${workspaceId}/workflow`,
        panel: null as PanelId | null,
        title: t.workflowRunsTitle,
        fallbackCaption: t.workflowRunsCaption,
        cta: t.workflowRunsCta,
      };
  }
}

function GroupLabel({
  children,
  count,
  className,
}: {
  children: React.ReactNode;
  count?: number;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "mb-3 flex items-center gap-2 text-[12px] font-bold uppercase tracking-wider text-muted-foreground/70",
        className,
      )}
    >
      {children}
      {count != null && (
        <span className="rounded-full bg-accent px-2 py-0.5 text-[11px] font-semibold normal-case tracking-normal text-muted-foreground">
          {count}
        </span>
      )}
    </div>
  );
}

function ListRow({
  accent,
  Icon,
  href,
  title,
  sub,
  meta,
}: {
  accent: AccentKey;
  Icon: LucideIcon;
  href: string;
  title: string;
  sub: string;
  meta: string;
}) {
  const a = ACCENT[accent];
  return (
    <Link
      href={href}
      className="mb-2 flex w-full items-center gap-3 rounded-xl border border-border bg-card px-3 py-2.5 text-left transition-colors hover:bg-accent/40"
    >
      <span className={cn("grid size-[30px] shrink-0 place-items-center rounded-lg", a.chip)}>
        <Icon className="size-4" strokeWidth={1.8} aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-[13.5px] font-medium text-foreground">{title}</span>
        <span className="block truncate text-[12px] text-muted-foreground">{sub}</span>
      </span>
      <span className="shrink-0 whitespace-nowrap text-[12px] font-medium text-muted-foreground/70">
        {meta}
      </span>
    </Link>
  );
}

function DockSkeleton() {
  return (
    <div className="mt-6 grid grid-cols-1 items-start gap-8 lg:grid-cols-[1fr_348px]">
      <div className="space-y-3">
        <div className="h-24 animate-pulse rounded-2xl bg-muted/50" />
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="h-32 animate-pulse rounded-2xl bg-muted/50" />
          <div className="h-32 animate-pulse rounded-2xl bg-muted/50" />
        </div>
      </div>
      <div className="space-y-3">
        <div className="h-40 animate-pulse rounded-2xl bg-muted/50" />
        <div className="h-32 animate-pulse rounded-2xl bg-muted/50" />
      </div>
    </div>
  );
}

// The brain card's growth curve: cumulative entry total over the daily
// new-entry counts the signals provide, normalized into the 300x44 viewBox.
// No data (older API response, empty workspace) or a flat window renders a
// level line rather than a fake upward one.
function sparklinePoints(daily: number[] | undefined, entryCount: number): string {
  const MID = "0,22 300,22";
  if (!daily || daily.length < 2) return MID;
  const added = daily.reduce((sum, d) => sum + d, 0);
  let running = Math.max(0, entryCount - added);
  const series = daily.map((d) => (running += d));
  const min = Math.min(...series);
  const span = Math.max(...series) - min;
  if (span === 0) return MID;
  const TOP = 5;
  const BOTTOM = 39;
  return series
    .map((v, i) => {
      const x = (i * 300) / (daily.length - 1);
      const y = BOTTOM - ((v - min) / span) * (BOTTOM - TOP);
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(" ");
}

function formatEdited(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

// Schedule label for a workflow's next run: "Today, 3:00 PM" / "Tomorrow,
// 9:00 AM" / "Tue, Jun 17, 9:00 AM". Day diff is computed on calendar days so a
// run at 11pm tonight still reads "Today".
function formatScheduleWhen(iso: string, t: SuggestedT): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const time = d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
  const days = Math.round((startOfDay(d) - startOfDay(new Date())) / 86_400_000);
  if (days === 0) return `${t.today}, ${time}`;
  if (days === 1) return `${t.tomorrow}, ${time}`;
  const day = d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  return `${day}, ${time}`;
}
