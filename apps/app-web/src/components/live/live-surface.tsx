"use client";

/**
 * Live — the all-activity watch surface (docs/architecture/features/live-work.md).
 *
 * Master-detail: the tiered roster on the left (*Working now* — sessions and
 * workflow runs interleaved, newest activity first — over *Just finished*,
 * the server's 30-minute window), and the watch pane on the right for the
 * focused item. Read/watch-only v1 (D1): no Stop, no composer — the
 * conversational path is the "Open in chat" deep link (D11), and run rows
 * deep-link to the run detail.
 *
 * Realtime: this page is a normal navigable surface (it REMOUNTS), so
 * mount-fetch + subscribe is correct here — unlike persistent chrome, which
 * must be spine-subscribed (realtime-sync.md). It refetches on
 * `LIVE_REFRESH_EVENT` (the `session` primitive), `WORKFLOW_REFRESH_EVENT`
 * (run rows), and `SCHEDULED_JOB_REFRESH_EVENT` (schedule edits change what
 * is about to fire) — the first listener that event has ever had. Effects
 * follow `strict-mode-unmount-latch`: the cancelled latch resets on the way
 * IN.
 *
 * Presence rows (a teammate's personal session, D4) render compact and
 * visually distinct with NO open affordance — the §6.1 allowlist is all the
 * client ever receives, so there is nothing to open.
 *
 * [COMP:app-web/live-app]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { Activity, ExternalLink, Lock } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { fetchLiveRoster, type LiveWorkItem } from "@/lib/api/live";
import { canWatch, groupRosterItems } from "@/lib/live-roster";
import {
  LIVE_REFRESH_EVENT,
  SCHEDULED_JOB_REFRESH_EVENT,
} from "@/lib/workspace-events";
import { WORKFLOW_REFRESH_EVENT } from "@/lib/workflow-events";
import { LiveWatchPane } from "@/components/live/live-watch-pane";

const REFRESH_EVENTS = [
  LIVE_REFRESH_EVENT,
  WORKFLOW_REFRESH_EVENT,
  SCHEDULED_JOB_REFRESH_EVENT,
] as const;

function itemKey(item: LiveWorkItem): string {
  return `${item.kind}:${item.id}`;
}

function relativeAge(
  iso: string,
  t: { justNow: string; minutesAgo: string; hoursAgo: string },
): string {
  const ms = Date.now() - new Date(iso).getTime();
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return t.justNow;
  if (minutes < 60) return format(t.minutesAgo, { m: minutes });
  return format(t.hoursAgo, { h: Math.floor(minutes / 60) });
}

export function LiveSurface({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const tl = t.liveApp;
  const [items, setItems] = useState<LiveWorkItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const cancelledRef = useRef(false);

  const load = useCallback(async () => {
    try {
      const roster = await fetchLiveRoster(workspaceId);
      if (cancelledRef.current) return;
      setItems(roster);
      setError(false);
    } catch {
      if (!cancelledRef.current) setError(true);
    } finally {
      if (!cancelledRef.current) setLoaded(true);
    }
  }, [workspaceId]);

  useEffect(() => {
    if (!workspaceId) return;
    // Strict Mode runs mount → cleanup → mount: reset the latch on the way
    // in or the second mount believes it is already gone.
    cancelledRef.current = false;
    void load();
    const onRefresh = () => void load();
    for (const ev of REFRESH_EVENTS) window.addEventListener(ev, onRefresh);
    return () => {
      cancelledRef.current = true;
      for (const ev of REFRESH_EVENTS) window.removeEventListener(ev, onRefresh);
    };
  }, [workspaceId, load]);

  const groups = useMemo(() => groupRosterItems(items), [items]);
  const focused = useMemo(
    () => items.find((i) => itemKey(i) === focusedKey) ?? null,
    [items, focusedKey],
  );

  const stateLabel: Record<LiveWorkItem["state"], string> = {
    working: tl.stateWorking,
    waiting: tl.stateWaiting,
    stalled: tl.stateStalled,
    settled: tl.stateSettled,
  };

  const renderRow = (item: LiveWorkItem) => {
    const key = itemKey(item);
    const isFocused = key === focusedKey;
    const presence = item.kind === "session" && item.tier === "presence";
    const openable = !presence;
    const title =
      item.kind === "workflow_run"
        ? item.workflowName
        : (item.title ?? item.assistantName);
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
    return (
      <button
        key={key}
        type="button"
        disabled={!openable}
        onClick={() => (openable ? setFocusedKey(isFocused ? null : key) : undefined)}
        className={cn(
          "w-full rounded-md border px-3 py-2 text-left transition-colors",
          presence
            ? "cursor-default border-dashed bg-muted/30"
            : "hover:bg-accent/50",
          isFocused && "border-primary bg-accent/60",
        )}
        aria-pressed={isFocused}
      >
        <div className="flex items-center justify-between gap-2">
          <span className={cn("truncate text-sm", presence ? "text-muted-foreground" : "font-medium")}>
            {title}
          </span>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-0.5 text-[11px]",
              item.state === "working" && "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
              item.state === "waiting" && "bg-amber-500/15 text-amber-600 dark:text-amber-400",
              item.state === "stalled" && "bg-red-500/15 text-red-600 dark:text-red-400",
              item.state === "settled" && "bg-muted text-muted-foreground",
            )}
          >
            {stateLabel[item.state]}
          </span>
        </div>
        <div className="mt-0.5 flex items-center gap-1.5 text-xs text-muted-foreground">
          {presence && <Lock className="h-3 w-3 shrink-0" aria-hidden />}
          <span className="truncate">{subtitle}</span>
          <span className="ml-auto shrink-0">
            {relativeAge(item.lastActiveAt, tl)}
          </span>
        </div>
        {presence && (
          <div className="mt-0.5 text-[11px] text-muted-foreground/80">{tl.presenceHint}</div>
        )}
      </button>
    );
  };

  return (
    <div className="flex h-full min-h-0">
      {/* Roster */}
      <div className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r p-4">
        <div className="flex items-center gap-2">
          <Activity className="h-4 w-4 text-muted-foreground" aria-hidden />
          <h1 className="text-sm font-semibold">{tl.title}</h1>
        </div>
        {error && <div className="text-sm text-destructive">{tl.loadError}</div>}
        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {tl.workingNow}
          </h2>
          <div className="flex flex-col gap-1.5">
            {groups.working.length === 0 && loaded && (
              <p className="text-sm text-muted-foreground">{tl.emptyWorking}</p>
            )}
            {groups.working.map(renderRow)}
          </div>
        </section>
        <section>
          <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {tl.justFinished}
          </h2>
          <div className="flex flex-col gap-1.5">
            {groups.finished.length === 0 && loaded && (
              <p className="text-sm text-muted-foreground">{tl.emptyFinished}</p>
            )}
            {groups.finished.map(renderRow)}
          </div>
        </section>
      </div>

      {/* Watch pane */}
      <div className="min-w-0 flex-1 overflow-y-auto p-4">
        {!focused && (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {tl.watchEmpty}
          </div>
        )}
        {focused && focused.kind === "workflow_run" && (
          <div className="mx-auto max-w-xl space-y-3">
            <h2 className="text-base font-semibold">{focused.workflowName}</h2>
            <p className="text-sm text-muted-foreground">
              {stateLabel[focused.state]}
              {focused.stepSummary
                ? ` · ${format(tl.currentStep, { step: focused.stepSummary })}`
                : ""}
            </p>
            <Link
              href={`/w/${workspaceId}/workflow/${focused.workflowId}/runs/${focused.id}`}
              className="inline-flex items-center gap-1.5 text-sm text-primary hover:underline"
            >
              <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              {tl.openRun}
            </Link>
          </div>
        )}
        {focused && canWatch(focused) && (
          <LiveWatchPane
            key={focused.id}
            workspaceId={workspaceId}
            sessionId={focused.id}
            title={
              focused.kind === "session"
                ? (focused.title ?? focused.assistantName)
                : ""
            }
          />
        )}
      </div>
    </div>
  );
}
