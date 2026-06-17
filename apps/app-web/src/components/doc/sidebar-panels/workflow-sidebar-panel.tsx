"use client";

/**
 * Workflow sidebar panel — the workspace's workflows as a quick-switcher,
 * ranked soonest-next-run first, shown in the left sidebar when the active
 * surface is Workflow (the sidebar body is surface-aware; the page tree is
 * Home-only).
 *
 * Ranking: enabled workflows first, ordered by their computed next fire time
 * (`workflowNextRun`); a workflow with no upcoming run (manual / webhook /
 * event / unparseable cron) sinks below the scheduled ones; disabled workflows
 * sink to the very bottom. The Workflow PAGE keeps its full card grid + Create
 * modal (this panel is a desktop convenience + the soonest-run ranking), so the
 * list is fetched here independently — a cheap GET that returns `[]` on failure.
 *
 * [COMP:app-web/sidebar-panel-workflow]
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Workflow as WorkflowIcon } from "lucide-react";
import { useT, useLocale, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { listWorkflows, type WorkflowSummary } from "@/lib/api/workflow";
import { workflowNextRun, compareByNextRun } from "@/lib/workflow-next-run";

/** Largest-unit relative time ("in 3 hours", "tomorrow"), locale-aware. */
function relativeWhen(target: Date, locale: string): string {
  const intlLocale = locale === "zh" ? "zh-Hant" : locale;
  const rtf = new Intl.RelativeTimeFormat(intlLocale, { numeric: "auto" });
  const diffMs = target.getTime() - Date.now();
  const minutes = Math.round(diffMs / 60_000);
  if (Math.abs(minutes) < 60) return rtf.format(minutes, "minute");
  const hours = Math.round(diffMs / 3_600_000);
  if (Math.abs(hours) < 24) return rtf.format(hours, "hour");
  const days = Math.round(diffMs / 86_400_000);
  return rtf.format(days, "day");
}

export function WorkflowSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const locale = useLocale();
  const pathname = usePathname() ?? "";
  const [workflows, setWorkflows] = useState<WorkflowSummary[] | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setWorkflows(null);
    void listWorkflows(workspaceId).then((list) => {
      if (!cancelled) setWorkflows(list);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // The currently-open workflow id (highlight it). The panel sits above the
  // `/workflow/[id]` route, so read it off the pathname rather than useParams.
  const activeId = useMemo(() => {
    const m = pathname.match(/\/workflow\/([^/]+)/);
    return m ? decodeURIComponent(m[1]) : null;
  }, [pathname]);

  // Pair each workflow with its next-run, then rank: enabled before disabled,
  // soonest fire time first, no-upcoming-run last. `new Date()` once per
  // recompute keeps the whole ranking on one clock.
  const ranked = useMemo(() => {
    const now = new Date();
    return (workflows ?? [])
      .map((w) => ({ w, next: w.enabled ? workflowNextRun(w.trigger, now) : null }))
      .sort((a, b) => {
        if (a.w.enabled !== b.w.enabled) return a.w.enabled ? -1 : 1;
        return compareByNextRun(a.next, b.next);
      });
  }, [workflows]);

  return (
    <div className="flex flex-col gap-1 px-1 pt-1">
      <div className="px-1 pb-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45">
        {t.docPage.sidebarWorkflowHeader}
      </div>

      {workflows === null ? (
        <div className="px-2 py-2 text-sm text-sidebar-foreground/45">…</div>
      ) : ranked.length === 0 ? (
        <div className="px-2 py-2 text-[13px] text-sidebar-foreground/55">
          {t.docPage.sidebarWorkflowEmpty}
        </div>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {ranked.map(({ w, next }) => {
            const active = w.id === activeId;
            const caption = !w.enabled
              ? t.docPage.sidebarWorkflowPaused
              : next
                ? format(t.docPage.sidebarWorkflowNextRun, {
                    when: relativeWhen(next, locale),
                  })
                : t.workflowPage.triggerShort[w.trigger.kind];
            return (
              <li key={w.id}>
                <Link
                  href={`/w/${workspaceId}/workflow/${encodeURIComponent(w.id)}`}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "flex items-start gap-2 rounded-md px-2 py-1.5 text-sm transition-colors",
                    active
                      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
                      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
                    !w.enabled && "opacity-70",
                  )}
                >
                  <WorkflowIcon className="mt-0.5 size-4 shrink-0 text-sidebar-foreground/55" />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{w.name}</span>
                    <span className="block truncate text-[11px] text-sidebar-foreground/50">
                      {caption}
                    </span>
                  </span>
                </Link>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
