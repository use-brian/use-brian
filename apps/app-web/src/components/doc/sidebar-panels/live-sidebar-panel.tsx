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
import { Inbox, Lock } from "lucide-react";
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
  "px-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45";

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
    const subtitle =
      item.kind === "workflow_run"
        ? `${tl.runLabel} · ${
            item.trigger === "scheduled"
              ? tl.triggerScheduled
              : item.trigger === "event"
                ? tl.triggerEvent
                : tl.triggerManual
          }`
        : [item.ownerName, item.assistantName, item.channelType]
            .filter(Boolean)
            .join(" · ");
    const className = cn(
      "flex w-full flex-col gap-0.5 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
      active
        ? "doc-nav-active text-sidebar-accent-foreground"
        : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
      presence && "cursor-default border border-dashed border-sidebar-border hover:bg-transparent",
    );
    const content = (
      <>
        <span className="flex min-w-0 items-center gap-1.5">
          {presence ? <Lock className="size-3 shrink-0 opacity-55" aria-hidden /> : null}
          <span className={cn("min-w-0 flex-1 truncate", !presence && "font-medium")}>
            {liveItemTitle(item)}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full px-1.5 py-0.5 text-[10px] leading-none",
              item.state === "working" && "bg-emerald-500/15 text-emerald-700 dark:text-emerald-400",
              item.state === "waiting" && "bg-amber-500/15 text-amber-700 dark:text-amber-400",
              item.state === "stalled" && "bg-red-500/15 text-red-700 dark:text-red-400",
              item.state === "settled" && "bg-sidebar-accent text-sidebar-foreground/55",
            )}
          >
            {stateLabel[item.state]}
          </span>
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-sidebar-foreground/50">
          <span className="min-w-0 flex-1 truncate">{subtitle}</span>
          <span className="shrink-0">{relativeAge(item.lastActiveAt, tl)}</span>
        </span>
        {presence ? (
          <span className="truncate text-[10px] text-sidebar-foreground/45">
            {tl.presenceHint}
          </span>
        ) : null}
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

      <section className="flex flex-col gap-1">
        <h2 className={sectionHeaderCls}>{tl.workingNow}</h2>
        {groups.working.length === 0 && loaded ? (
          <p className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
            {tl.emptyWorking}
          </p>
        ) : (
          <ul className="flex flex-col gap-0.5">{groups.working.map(renderRow)}</ul>
        )}
      </section>

      <section className="flex flex-col gap-1">
        <h2 className={sectionHeaderCls}>{tl.justFinished}</h2>
        {groups.finished.length === 0 && loaded ? (
          <p className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
            {tl.emptyFinished}
          </p>
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
