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
  LockKeyhole,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import type {
  LiveWorkItem,
  LiveWorkflowRunItem,
  LiveWorkState,
} from "@/lib/api/live";
import {
  LIVE_FOCUS_PARAM,
  canFocusLiveItem,
  canWatch,
  focusedLiveItem,
  liveItemHref,
  liveItemKey,
  liveItemTitle,
  summarizeRosterItems,
} from "@/lib/live-roster";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { LiveWatchPane } from "@/components/live/live-watch-pane";
import { useLiveRoster } from "@/components/live/use-live-roster";
import { cn } from "@/lib/utils";

const topbarActionCls =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";
const LIVE_ZONE_VISIBLE_ROWS = 6;

function zoneLayoutClass(count: number): string {
  const columns =
    count === 0
      ? "xl:col-span-2"
      : count === 1
        ? "xl:col-span-3"
        : count === 2
          ? "xl:col-span-4"
          : count <= 5
            ? "xl:col-span-6"
            : "xl:col-span-7";
  const rows =
    count <= 1
      ? "xl:row-span-6"
      : count === 2
        ? "xl:row-span-8"
        : count === 3
          ? "xl:row-span-10"
          : count === 4
            ? "xl:row-span-13"
            : count === 5
              ? "xl:row-span-15"
              : count === 6
                ? "xl:row-span-17"
                : "xl:row-span-18";
  return `${columns} ${rows}`;
}

type StatusTone = {
  panel: string;
  icon: string;
  count: string;
  row: string;
};

type LiveStatusZoneProps = {
  workspaceId: string;
  state: LiveWorkState;
  label: string;
  items: LiveWorkItem[];
  icon: typeof Activity;
  tone: StatusTone;
  emptyLabel: string;
};

function relativeAge(
  iso: string,
  copy: Pick<
    ReturnType<typeof useT>["liveApp"],
    "justNow" | "minutesAgo" | "hoursAgo"
  >,
): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return copy.justNow;
  if (minutes < 60) return format(copy.minutesAgo, { m: minutes });
  return format(copy.hoursAgo, { h: Math.floor(minutes / 60) });
}

function LiveStatusRow({
  workspaceId,
  item,
  rowTone,
}: {
  workspaceId: string;
  item: LiveWorkItem;
  rowTone: string;
}) {
  const tl = useT().liveApp;
  const presence = item.kind === "session" && item.tier === "presence";
  const focusable = canFocusLiveItem(item);
  const primary = item.kind === "session" ? item.assistantName : item.workflowName;
  const channel = item.kind === "session" ? item.channelType : tl.runLabel;
  const owner = item.kind === "session" && item.ownerName
    ? format(tl.forPerson, { name: item.ownerName })
    : null;
  const detail = item.kind === "session"
    ? item.tier === "full" && item.title && item.title !== item.assistantName
      ? item.title
      : null
    : [
        item.trigger === "scheduled"
          ? tl.triggerScheduled
          : item.trigger === "event"
            ? tl.triggerEvent
            : tl.triggerManual,
        item.stepSummary ? format(tl.currentStep, { step: item.stepSummary }) : null,
      ]
        .filter(Boolean)
        .join(" · ");
  const content = (
    <>
      <span
        className={cn("relative grid size-9 shrink-0 place-items-center rounded-xl", rowTone)}
        aria-hidden
      >
        {item.kind === "session" ? (
          <>
            <AssistantAvatar
              id={item.assistantId}
              name={item.assistantName}
              iconSeed={item.assistantIconSeed}
              size="sm"
            />
            {presence ? (
              <span className="absolute -bottom-0.5 -right-0.5 grid size-4 place-items-center rounded-full border border-border bg-background text-muted-foreground shadow-sm">
                <LockKeyhole className="size-2.5" strokeWidth={2} />
              </span>
            ) : null}
          </>
        ) : (
          <GitBranch className="size-4" strokeWidth={1.8} />
        )}
      </span>
      <span className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {primary}
          </span>
          <span className="max-w-[45%] shrink-0 truncate rounded-full border border-border/70 bg-background/80 px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
            {channel}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          {owner ? (
            <span className="shrink-0 font-medium text-foreground/70">{owner}</span>
          ) : null}
          {owner && detail ? <span aria-hidden>·</span> : null}
          {detail ? <span className="min-w-0 flex-1 truncate">{detail}</span> : <span className="flex-1" />}
          <span className="shrink-0 tabular-nums">{relativeAge(item.lastActiveAt, tl)}</span>
        </span>
        {presence ? <span className="sr-only">{tl.presenceHint}</span> : null}
      </span>
    </>
  );
  const className = cn(
    "flex min-h-16 items-center gap-3 rounded-2xl border border-border/60 bg-background/75 px-3 py-2.5 text-left shadow-sm transition-[border-color,background-color,box-shadow]",
    focusable && "hover:border-border hover:bg-background hover:shadow-md",
    presence && "border-dashed",
  );

  return (
    <li data-live-work-item={liveItemKey(item)}>
      {focusable ? (
        <Link href={liveItemHref(workspaceId, item)} className={className}>
          {content}
        </Link>
      ) : (
        <div aria-disabled="true" className={className}>
          {content}
        </div>
      )}
    </li>
  );
}

function LiveStatusZone({
  workspaceId,
  state,
  label,
  items,
  icon: Icon,
  tone,
  emptyLabel,
}: LiveStatusZoneProps) {
  const tl = useT().liveApp;
  const active = state === "working" && items.length > 0;
  const overflowing = items.length > LIVE_ZONE_VISIBLE_ROWS;
  const density =
    items.length === 0 ? "empty" : items.length >= 3 ? "busy" : "active";
  return (
    <section
      data-live-status-zone={state}
      data-live-zone-size={density}
      aria-label={`${label}: ${items.length}`}
      className={cn(
        "col-span-1 flex min-w-0 flex-col overflow-hidden rounded-3xl border p-4 shadow-sm sm:p-5 xl:h-full",
        zoneLayoutClass(items.length),
        tone.panel,
      )}
    >
      <header className="flex items-center gap-3">
        <span className={cn("relative grid size-10 place-items-center rounded-2xl", tone.icon)}>
          {active ? (
            <span
              className="absolute inset-1 rounded-xl bg-current opacity-20 motion-safe:animate-ping motion-reduce:animate-none"
              aria-hidden
            />
          ) : null}
          <Icon className="relative size-[18px]" strokeWidth={1.8} aria-hidden />
        </span>
        <h2 className="min-w-0 flex-1 text-sm font-semibold tracking-tight text-foreground">
          {label}
        </h2>
        <span className={cn("grid min-w-8 place-items-center rounded-full px-2 py-1 text-xs font-bold tabular-nums", tone.count)}>
          {items.length}
        </span>
      </header>

      {items.length > 0 ? (
        <ul
          className={cn(
            "mt-4 flex flex-col gap-2",
            overflowing &&
              "max-h-[26.5rem] overflow-y-auto overscroll-contain pr-1 [scrollbar-gutter:stable]",
          )}
          tabIndex={overflowing ? 0 : undefined}
          aria-label={
            overflowing ? format(tl.scrollRoster, { count: items.length }) : undefined
          }
        >
          {items.map((item) => (
            <LiveStatusRow
              key={liveItemKey(item)}
              workspaceId={workspaceId}
              item={item}
              rowTone={tone.row}
            />
          ))}
        </ul>
      ) : (
        <div
          aria-label={emptyLabel}
          className="mt-4 flex min-h-16 flex-1 items-center gap-3 rounded-2xl border border-dashed border-current/15 px-4 text-current/25"
        >
          <Icon className="size-4" strokeWidth={1.6} aria-hidden />
          <span className="h-px flex-1 bg-current/20" aria-hidden />
          <span className="size-1.5 rounded-full bg-current/35" aria-hidden />
        </div>
      )}
      {overflowing ? (
        <p className="mt-2 text-center text-[10px] font-medium text-muted-foreground">
          {format(tl.scrollRoster, { count: items.length })}
        </p>
      ) : null}
    </section>
  );
}

export function LiveOverview({
  workspaceId,
  items,
}: {
  workspaceId: string;
  items: LiveWorkItem[];
}) {
  const tl = useT().liveApp;
  const summary = summarizeRosterItems(items);
  const newestFirst = (a: LiveWorkItem, b: LiveWorkItem) =>
    a.lastActiveAt < b.lastActiveAt ? 1 : a.lastActiveAt > b.lastActiveAt ? -1 : 0;
  const byState = (state: LiveWorkState) =>
    items.filter((item) => item.state === state).sort(newestFirst);
  const zones: Array<Omit<LiveStatusZoneProps, "workspaceId" | "items">> = [
    {
      state: "working",
      label: tl.stateWorking,
      icon: Bot,
      emptyLabel: tl.emptyWorking,
      tone: {
        panel: "border-emerald-500/20 bg-emerald-500/[0.045]",
        icon: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
        count: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
        row: "bg-emerald-500/12 text-emerald-600 dark:text-emerald-400",
      },
    },
    {
      state: "waiting",
      label: tl.stateWaiting,
      icon: Clock3,
      emptyLabel: tl.emptyWorking,
      tone: {
        panel: "border-amber-500/20 bg-amber-500/[0.045]",
        icon: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
        count: "bg-amber-500/15 text-amber-700 dark:text-amber-300",
        row: "bg-amber-500/12 text-amber-600 dark:text-amber-400",
      },
    },
    {
      state: "stalled",
      label: tl.stateStalled,
      icon: CircleAlert,
      emptyLabel: tl.emptyWorking,
      tone: {
        panel: "border-red-500/20 bg-red-500/[0.04]",
        icon: "bg-red-500/15 text-red-600 dark:text-red-400",
        count: "bg-red-500/15 text-red-700 dark:text-red-300",
        row: "bg-red-500/12 text-red-600 dark:text-red-400",
      },
    },
    {
      state: "settled",
      label: tl.stateSettled,
      icon: CheckCircle2,
      emptyLabel: tl.emptyFinished,
      tone: {
        panel: "border-sky-500/20 bg-sky-500/[0.04]",
        icon: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
        count: "bg-sky-500/15 text-sky-700 dark:text-sky-300",
        row: "bg-sky-500/12 text-sky-600 dark:text-sky-400",
      },
    },
  ];
  return (
    <div
      data-live-overview-active={summary.active}
      className="mx-auto grid w-full max-w-6xl grid-cols-1 items-start gap-4 md:grid-cols-2 xl:grid-flow-row-dense xl:grid-cols-12 xl:auto-rows-[1rem] xl:items-stretch"
    >
      {zones.map((zone) => (
        <LiveStatusZone
          key={zone.state}
          {...zone}
          workspaceId={workspaceId}
          items={byState(zone.state)}
        />
      ))}
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
          <div className="min-h-full py-4">
            <LiveOverview workspaceId={workspaceId} items={items} />
          </div>
        ) : focused.kind === "workflow_run" ? (
          <div className="flex min-h-full items-center justify-center py-4">
            <LiveRunOverview item={focused} />
          </div>
        ) : canWatch(focused) ? (
          <LiveWatchPane
            key={focused.id}
            sessionId={focused.id}
            workspaceId={workspaceId}
            sessionState={focused.state}
            canSteer={focused.canSteer === true}
          />
        ) : null}
      </div>
    </div>
  );
}
