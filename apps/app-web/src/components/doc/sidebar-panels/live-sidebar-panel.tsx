"use client";

/**
 * Live surface sidebar panel. Live owns the former top-level Inbox slot; the
 * unchanged Inbox flyout is nested first here, followed by the Working now and
 * Just finished rosters. Focus is URL-addressed so sidebar selection, browser
 * history, reloads, and the full-width watch pane remain one state.
 *
 * [COMP:app-web/live-app] / [COMP:app-web/inbox-panel]
 */

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  GitBranch,
  Inbox,
  LockKeyhole,
  MessageSquare,
  Radio,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import type { LiveWorkItem } from "@/lib/api/live";
import {
  LIVE_FOCUS_PARAM,
  groupRosterItems,
  liveItemHref,
  liveItemKey,
  liveItemTitle,
} from "@/lib/live-roster";
import { cn } from "@/lib/utils";
import { useLiveRoster } from "@/components/live/use-live-roster";

const sectionHeaderCls =
  "text-[10px] font-semibold uppercase tracking-[0.14em] text-sidebar-foreground/40";

function stateDotClass(state: LiveWorkItem["state"]): string {
  if (state === "working") return "bg-emerald-500";
  if (state === "waiting") return "bg-amber-500";
  if (state === "stalled") return "bg-red-500";
  return "bg-sidebar-foreground/25";
}

function EmptySignal({ label }: { label: string }) {
  return (
    <div className="flex h-9 items-center gap-2 rounded-lg border border-dashed border-sidebar-border/70 px-2.5 text-sidebar-foreground/25">
      <Radio className="size-3.5" aria-hidden />
      <span className="sr-only">{label}</span>
      <span className="h-px flex-1 bg-sidebar-border/60" aria-hidden />
      <span className="size-1 rounded-full bg-current" aria-hidden />
    </div>
  );
}

function relativeAge(
  iso: string,
  copy: { justNow: string; minutesAgo: string; hoursAgo: string },
): string {
  const minutes = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return copy.justNow;
  if (minutes < 60) return format(copy.minutesAgo, { m: minutes });
  return format(copy.hoursAgo, { h: Math.floor(minutes / 60) });
}

export function LiveRosterList({
  workspaceId,
  items,
  loaded,
  error,
  activeFocus,
  inboxOpen,
  inboxCount,
  onToggleInbox,
}: {
  workspaceId: string;
  items: LiveWorkItem[];
  loaded: boolean;
  error: boolean;
  activeFocus: string | null;
  inboxOpen: boolean;
  inboxCount: number;
  onToggleInbox: () => void;
}) {
  const t = useT();
  const tl = t.liveApp;
  const groups = groupRosterItems(items);
  const stateLabel: Record<LiveWorkItem["state"], string> = {
    working: tl.stateWorking,
    waiting: tl.stateWaiting,
    stalled: tl.stateStalled,
    settled: tl.stateSettled,
  };

  const renderRow = (item: LiveWorkItem) => {
    const key = liveItemKey(item);
    const active = key === activeFocus;
    const presence = item.kind === "session" && item.tier === "presence";
    const subtitle = item.kind === "workflow_run"
      ? item.trigger === "scheduled"
        ? tl.triggerScheduled
        : item.trigger === "event"
          ? tl.triggerEvent
          : tl.triggerManual
      : presence
        ? [item.ownerName, item.assistantName].filter(Boolean).join(" · ")
        : [item.assistantName, item.channelType].filter(Boolean).join(" · ");
    const KindIcon = presence
      ? LockKeyhole
      : item.kind === "workflow_run"
        ? GitBranch
        : MessageSquare;
    const className = cn(
      "group flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-[background-color,color,box-shadow]",
      active
        ? "doc-nav-active text-sidebar-accent-foreground shadow-sm"
        : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      presence && "cursor-default border border-dashed border-sidebar-border/80 hover:bg-transparent",
    );
    const content = (
      <>
        <span
          className={cn(
            "grid size-7 shrink-0 place-items-center rounded-lg bg-sidebar-accent/75 text-sidebar-foreground/55 transition-colors",
            active && "bg-background/70 text-sidebar-accent-foreground",
          )}
        >
          <KindIcon className="size-3.5" strokeWidth={1.8} aria-hidden />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className={cn("truncate", !presence && "font-medium")}>
            {liveItemTitle(item)}
          </span>
          <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-sidebar-foreground/45">
            <span className="min-w-0 flex-1 truncate">{subtitle}</span>
            <span className="shrink-0 tabular-nums">
              {relativeAge(item.lastActiveAt, tl)}
            </span>
          </span>
          {presence ? <span className="sr-only">{tl.presenceHint}</span> : null}
        </span>
        <span
          role="img"
          aria-label={stateLabel[item.state]}
          title={stateLabel[item.state]}
          className="relative flex size-3 shrink-0 items-center justify-center"
        >
          {item.state === "working" ? (
            <span
              className="absolute size-2.5 rounded-full bg-emerald-500/35 motion-safe:animate-ping motion-reduce:animate-none"
              aria-hidden
            />
          ) : null}
          <span
            className={cn(
              "relative size-1.5 rounded-full",
              stateDotClass(item.state),
            )}
            aria-hidden
          />
        </span>
      </>
    );

    return presence ? (
      <li key={key} aria-disabled="true" className={className}>
        {content}
      </li>
    ) : (
      <li key={key}>
        <Link
          href={active ? `/w/${workspaceId}/live` : liveItemHref(workspaceId, item)}
          aria-current={active ? "page" : undefined}
          className={className}
        >
          {content}
        </Link>
      </li>
    );
  };

  return (
    <div className="flex flex-col gap-4 px-1 pt-1">
      <button
        type="button"
        aria-pressed={inboxOpen}
        onClick={onToggleInbox}
        className={cn(
          "flex h-8 w-full items-center gap-2 rounded-md px-2 text-sm transition-colors",
          inboxOpen
            ? "doc-nav-active font-medium text-sidebar-accent-foreground"
            : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
        )}
      >
        <Inbox className="size-4 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate text-left">{t.docPage.iconInbox}</span>
        {inboxCount > 0 ? (
          <span
            aria-label={t.docPage.iconInboxBadgeAria.replace("{count}", String(inboxCount))}
            className="inline-flex min-w-5 items-center justify-center rounded-full bg-primary px-1.5 text-[10px] font-semibold leading-5 text-primary-foreground"
          >
            {inboxCount > 99 ? "99+" : inboxCount}
          </span>
        ) : null}
      </button>

      {error ? <p className="px-1 text-xs text-destructive">{tl.loadError}</p> : null}

      <section className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 px-1">
          <h2 className={sectionHeaderCls}>{tl.workingNow}</h2>
          <span className="tabular-nums text-[10px] text-sidebar-foreground/35">
            {groups.working.length}
          </span>
        </div>
        {groups.working.length === 0 && loaded ? (
          <EmptySignal label={tl.emptyWorking} />
        ) : (
          <ul className="flex flex-col gap-0.5">{groups.working.map(renderRow)}</ul>
        )}
      </section>

      <section className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2 px-1">
          <h2 className={sectionHeaderCls}>{tl.justFinished}</h2>
          <span className="tabular-nums text-[10px] text-sidebar-foreground/35">
            {groups.finished.length}
          </span>
        </div>
        {groups.finished.length === 0 && loaded ? (
          <EmptySignal label={tl.emptyFinished} />
        ) : (
          <ul className="flex flex-col gap-0.5">{groups.finished.map(renderRow)}</ul>
        )}
      </section>
    </div>
  );
}

export function LiveSidebarPanel({
  workspaceId,
  inboxOpen,
  inboxCount,
  onToggleInbox,
}: {
  workspaceId: string;
  inboxOpen: boolean;
  inboxCount: number;
  onToggleInbox: () => void;
}) {
  const searchParams = useSearchParams();
  const roster = useLiveRoster(workspaceId);
  return (
    <LiveRosterList
      workspaceId={workspaceId}
      {...roster}
      activeFocus={searchParams.get(LIVE_FOCUS_PARAM)}
      inboxOpen={inboxOpen}
      inboxCount={inboxCount}
      onToggleInbox={onToggleInbox}
    />
  );
}
