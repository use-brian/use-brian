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
import { Activity, ExternalLink } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  LIVE_FOCUS_PARAM,
  canFocusLiveItem,
  canWatch,
  focusedLiveItem,
  liveItemTitle,
} from "@/lib/live-roster";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { LiveWatchPane } from "@/components/live/live-watch-pane";
import { useLiveRoster } from "@/components/live/use-live-roster";

const topbarActionCls =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground";

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
  const stateLabel = focused
    ? {
        working: tl.stateWorking,
        waiting: tl.stateWaiting,
        stalled: tl.stateStalled,
        settled: tl.stateSettled,
      }[focused.state]
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

      <div className="min-h-0 flex-1 overflow-y-auto p-4">
        {error ? (
          <div className="flex h-full items-center justify-center text-sm text-destructive">
            {tl.loadError}
          </div>
        ) : !focused ? (
          <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
            {tl.watchEmpty}
          </div>
        ) : focused.kind === "workflow_run" ? (
          <div className="mx-auto flex h-full max-w-xl flex-col items-center justify-center gap-2 text-center">
            <p className="text-sm font-medium">{stateLabel}</p>
            {focused.stepSummary ? (
              <p className="text-sm text-muted-foreground">
                {format(tl.currentStep, { step: focused.stepSummary })}
              </p>
            ) : null}
          </div>
        ) : canWatch(focused) ? (
          <LiveWatchPane key={focused.id} sessionId={focused.id} />
        ) : null}
      </div>
    </div>
  );
}
