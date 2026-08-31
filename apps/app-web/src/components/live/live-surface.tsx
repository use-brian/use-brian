"use client";

/**
 * Live content pane. The roster lives in the persistent workspace sidebar;
 * this surface owns the shared top bar and the full-width focused detail.
 * Focus is URL-addressed by the sidebar (`focus=<kind>:<id>`), so browser
 * history and reload preserve the same watch target.
 *
 * Read/watch-only v1: no Stop and no composer. The top bar's right slot owns
 * the sanctioned handoff to Chat or the workflow-run detail.
 *
 * [COMP:app-web/live-app]
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  Activity,
  Bot,
  CheckCircle2,
  CircleAlert,
  Clock3,
  ExternalLink,
  GitBranch,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import type { LiveWorkItem, LiveWorkflowRunItem } from "@/lib/api/live";
import {
  LIVE_FOCUS_PARAM,
  canFocusLiveItem,
  canWatch,
  focusedLiveItem,
  liveItemTitle,
  summarizeRosterItems,
  type LiveRosterSummary,
} from "@/lib/live-roster";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { LiveWatchPane } from "@/components/live/live-watch-pane";
import { useLiveRoster } from "@/components/live/use-live-roster";

const topbarActionCls =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

type StatusMetricProps = {
  label: string;
  count: number;
  icon: typeof Activity;
  tone: string;
};

function StatusMetric({ label, count, icon: Icon, tone }: StatusMetricProps) {
  return (
    <div className="flex min-h-28 flex-col justify-between rounded-2xl border border-border/70 bg-card p-4 shadow-sm">
      <span className={`grid size-8 place-items-center rounded-xl ${tone}`}>
        <Icon className="size-4" strokeWidth={1.8} aria-hidden />
      </span>
      <span>
        <span className="block text-2xl font-semibold tabular-nums tracking-tight text-foreground">
          {count}
        </span>
        <span className="block text-[11px] font-medium text-muted-foreground">
          {label}
        </span>
      </span>
    </div>
  );
}

function PulseNode({
  count,
  label,
  icon: Icon,
  className,
  tone,
}: StatusMetricProps & { className: string }) {
  const active = count > 0;
  return (
    <span
      className={`absolute ${className} flex -translate-x-1/2 -translate-y-1/2 flex-col items-center gap-1.5`}
      aria-label={`${label}: ${count}`}
    >
      <span className="relative grid size-12 place-items-center">
        {active ? (
          <span
            className={`absolute inset-1 rounded-2xl opacity-35 motion-safe:animate-ping motion-reduce:animate-none ${tone}`}
            aria-hidden
          />
        ) : null}
        <span
          className={`relative grid size-10 place-items-center rounded-2xl border border-border/70 bg-background shadow-md ${
            active ? tone : "text-muted-foreground/35"
          }`}
        >
          <Icon className="size-[18px]" strokeWidth={1.8} aria-hidden />
        </span>
        <span className="absolute -right-1 -top-1 grid min-w-5 place-items-center rounded-full border border-border bg-background px-1 text-[10px] font-semibold tabular-nums text-foreground shadow-sm">
          {count}
        </span>
      </span>
      <span className="text-[10px] font-medium text-muted-foreground">{label}</span>
    </span>
  );
}

function ActivityTopology({
  summary,
  emptyLabel,
  labels,
}: {
  summary: LiveRosterSummary;
  emptyLabel: string;
  labels: Pick<
    ReturnType<typeof useT>["liveApp"],
    "stateWorking" | "stateWaiting" | "stateStalled" | "stateSettled"
  >;
}) {
  return (
    <div
      data-live-activity-graph
      className="relative min-h-[310px] overflow-hidden rounded-3xl border border-border/70 bg-gradient-to-br from-primary/[0.07] via-card to-violet-500/[0.06] shadow-sm"
    >
      <svg
        viewBox="0 0 620 310"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full text-border/80"
        fill="none"
        aria-hidden
      >
        <path d="M310 155 C235 155 220 72 135 72" stroke="currentColor" />
        <path d="M310 155 C385 155 400 72 485 72" stroke="currentColor" />
        <path d="M310 155 C235 155 220 238 135 238" stroke="currentColor" />
        <path d="M310 155 C385 155 400 238 485 238" stroke="currentColor" />
      </svg>

      <span className="absolute left-1/2 top-1/2 grid size-20 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-[1.6rem] border border-primary/20 bg-background/90 text-primary shadow-lg backdrop-blur-sm">
        {summary.active > 0 ? (
          <span
            className="absolute inset-2 rounded-[1.15rem] bg-primary/15 motion-safe:animate-pulse motion-reduce:animate-none"
            aria-hidden
          />
        ) : null}
        <Activity className="relative size-7" strokeWidth={1.7} aria-hidden />
        <span className="absolute -right-2 -top-2 grid min-w-7 place-items-center rounded-full bg-primary px-1.5 text-[11px] font-bold tabular-nums text-primary-foreground shadow-sm">
          {summary.active}
        </span>
      </span>

      <PulseNode
        className="left-[22%] top-[23%]"
        count={summary.working}
        label={labels.stateWorking}
        icon={Bot}
        tone="bg-emerald-500/15 text-emerald-600 dark:text-emerald-400"
      />
      <PulseNode
        className="left-[78%] top-[23%]"
        count={summary.waiting}
        label={labels.stateWaiting}
        icon={Clock3}
        tone="bg-amber-500/15 text-amber-600 dark:text-amber-400"
      />
      <PulseNode
        className="left-[22%] top-[77%]"
        count={summary.stalled}
        label={labels.stateStalled}
        icon={CircleAlert}
        tone="bg-red-500/15 text-red-600 dark:text-red-400"
      />
      <PulseNode
        className="left-[78%] top-[77%]"
        count={summary.settled}
        label={labels.stateSettled}
        icon={CheckCircle2}
        tone="bg-sky-500/15 text-sky-600 dark:text-sky-400"
      />

      <span className="absolute inset-x-0 bottom-3 text-center text-[11px] font-medium text-muted-foreground/70">
        {emptyLabel}
      </span>
    </div>
  );
}

export function LiveOverview({ items }: { items: LiveWorkItem[] }) {
  const tl = useT().liveApp;
  const summary = summarizeRosterItems(items);
  return (
    <div className="mx-auto grid w-full max-w-6xl items-stretch gap-4 lg:grid-cols-[minmax(0,1fr)_300px]">
      <ActivityTopology summary={summary} emptyLabel={tl.watchEmpty} labels={tl} />
      <div className="grid grid-cols-2 gap-3">
        <StatusMetric
          label={tl.stateWorking}
          count={summary.working}
          icon={Bot}
          tone="bg-emerald-500/12 text-emerald-600 dark:text-emerald-400"
        />
        <StatusMetric
          label={tl.stateWaiting}
          count={summary.waiting}
          icon={Clock3}
          tone="bg-amber-500/12 text-amber-600 dark:text-amber-400"
        />
        <StatusMetric
          label={tl.stateStalled}
          count={summary.stalled}
          icon={CircleAlert}
          tone="bg-red-500/12 text-red-600 dark:text-red-400"
        />
        <StatusMetric
          label={tl.stateSettled}
          count={summary.settled}
          icon={CheckCircle2}
          tone="bg-sky-500/12 text-sky-600 dark:text-sky-400"
        />
      </div>
    </div>
  );
}

export function LiveRunOverview({ item }: { item: LiveWorkflowRunItem }) {
  const tl = useT().liveApp;
  const stateLabel = {
    working: tl.stateWorking,
    waiting: tl.stateWaiting,
    stalled: tl.stateStalled,
    settled: tl.stateSettled,
  }[item.state];
  const active = item.state !== "settled";
  return (
    <div
      data-live-run-overview
      className="mx-auto grid w-full max-w-4xl overflow-hidden rounded-3xl border border-border/70 bg-card shadow-sm md:grid-cols-[280px_minmax(0,1fr)]"
    >
      <div className="relative min-h-56 overflow-hidden border-b border-border/70 bg-gradient-to-br from-violet-500/[0.08] via-background to-primary/[0.06] md:border-b-0 md:border-r">
        <span className="absolute left-1/2 top-1/2 h-px w-36 -translate-x-1/2 bg-border" aria-hidden />
        {["left-[25%]", "left-1/2", "left-[75%]"].map((position, index) => (
          <span
            key={position}
            className={`absolute top-1/2 ${position} grid size-9 -translate-x-1/2 -translate-y-1/2 place-items-center rounded-xl border border-border bg-background shadow-sm`}
          >
            {active && index === 1 ? (
              <span className="absolute inset-1 rounded-lg bg-violet-500/20 motion-safe:animate-ping motion-reduce:animate-none" aria-hidden />
            ) : null}
            <span className={`relative size-2 rounded-full ${index === 1 ? "bg-violet-500" : "bg-muted-foreground/35"}`} aria-hidden />
          </span>
        ))}
        <span className="absolute left-1/2 top-[22%] grid size-10 -translate-x-1/2 place-items-center rounded-2xl bg-violet-500/12 text-violet-600 dark:text-violet-400">
          <GitBranch className="size-5" strokeWidth={1.8} aria-hidden />
        </span>
      </div>
      <div className="flex min-w-0 flex-col justify-center gap-4 p-6 sm:p-8">
        <span className="inline-flex w-fit items-center gap-2 rounded-full border border-border/70 bg-muted/35 px-3 py-1.5 text-xs font-medium text-muted-foreground">
          <span className={`size-1.5 rounded-full ${active ? "bg-violet-500 motion-safe:animate-pulse motion-reduce:animate-none" : "bg-muted-foreground/40"}`} aria-hidden />
          {stateLabel}
        </span>
        {item.stepSummary ? (
          <p className="truncate text-lg font-semibold tracking-tight text-foreground">
            {format(tl.currentStep, { step: item.stepSummary })}
          </p>
        ) : null}
      </div>
    </div>
  );
}

export function LiveSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const tl = t.liveApp;
  const searchParams = useSearchParams();
  const { items, error } = useLiveRoster(workspaceId);
  const focusedCandidate = focusedLiveItem(
    items,
    searchParams.get(LIVE_FOCUS_PARAM),
  );
  const focused =
    focusedCandidate && canFocusLiveItem(focusedCandidate)
      ? focusedCandidate
      : null;

  const action = focused ? (
    focused.kind === "workflow_run" ? (
      <Link
        href={`/w/${workspaceId}/workflow/${focused.workflowId}/runs/${focused.id}`}
        className={topbarActionCls}
      >
        <ExternalLink className="size-3.5" aria-hidden />
        {tl.openRun}
      </Link>
    ) : (
      <Link
        href={`/w/${workspaceId}/chat?s=${encodeURIComponent(focused.id)}`}
        className={topbarActionCls}
      >
        <ExternalLink className="size-3.5" aria-hidden />
        {tl.openInChat}
      </Link>
    )
  ) : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OperatorTopbar
        identity={{ label: tl.title, icon: Activity }}
        center={
          focused ? (
            <span className="truncate text-sm font-medium text-sidebar-foreground/80">
              {liveItemTitle(focused)}
            </span>
          ) : null
        }
        right={action}
      />

      <div className="min-h-0 flex-1 overflow-y-auto bg-muted/[0.16] p-4 sm:p-6">
        {error ? (
          <div className="flex h-full items-center justify-center">
            <div className="flex max-w-sm items-center gap-3 rounded-2xl border border-destructive/20 bg-card px-4 py-3 text-sm text-destructive shadow-sm">
              <CircleAlert className="size-4 shrink-0" aria-hidden />
              {tl.loadError}
            </div>
          </div>
        ) : !focused ? (
          <div className="flex min-h-full items-center justify-center py-4">
            <LiveOverview items={items} />
          </div>
        ) : focused.kind === "workflow_run" ? (
          <div className="flex min-h-full items-center justify-center py-4">
            <LiveRunOverview item={focused} />
          </div>
        ) : canWatch(focused) ? (
          <LiveWatchPane key={focused.id} sessionId={focused.id} />
        ) : null}
      </div>
    </div>
  );
}
