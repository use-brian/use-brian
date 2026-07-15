"use client";

/**
 * Workspace-global live-browser affordance ([COMP:app-web/computer-live-pill]).
 *
 * The composer chip (computer-live-chip.tsx) only exists inside the one chat
 * whose session is browsing — a task started from Telegram, a workflow, or a
 * goal, or simply viewed from another surface, had no in-app trail to its
 * live view. This pill closes that: mounted once in the workspace layout, it
 * polls the caller's live tasks and floats a pulsing pill from any surface,
 * one click from the Take-Over page.
 *
 * Suppressed on `/computer/` routes (the user is already watching). Discovery
 * chrome only: presence is probed off `GET /api/computer/tasks?workspaceId=`,
 * failures render nothing.
 *
 * Spec: docs/architecture/engine/computer-use.md §5.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Eye } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { listActiveComputerTasks, type ComputerTaskSummary } from "@/lib/api/computer";

const POLL_MS = 20_000;

/** Pure render — exported for SSR tests; polling lives in the wrapper. */
export function ComputerLivePillView({
  workspaceId,
  tasks,
}: {
  workspaceId: string;
  tasks: ComputerTaskSummary[];
}) {
  const t = useT();
  const [expanded, setExpanded] = useState(false);
  if (tasks.length === 0) return null;

  const label =
    tasks.length === 1
      ? t.computer.livePill.active
      : `${tasks.length} · ${t.computer.livePill.active}`;
  const liveViewHref = (sessionId: string) =>
    `/w/${workspaceId}/computer/${encodeURIComponent(sessionId)}`;

  return (
    <div className="fixed bottom-4 left-4 z-40 flex flex-col items-start gap-1.5">
      {expanded && tasks.length > 1 ? (
        <ul className="w-64 rounded-lg border border-border bg-card p-1.5 shadow-lg">
          {tasks.map((task) => (
            <li key={task.taskId}>
              <Link
                href={liveViewHref(task.sessionId)}
                className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-accent"
              >
                <span aria-hidden className="claw-blink size-1.5 shrink-0 rounded-full bg-primary" />
                <span className="min-w-0 flex-1 truncate">
                  {task.injectedSite ?? t.computer.livePill.unnamedTask}
                </span>
                <Eye className="size-3 shrink-0 text-primary" aria-hidden />
              </Link>
            </li>
          ))}
        </ul>
      ) : null}
      {tasks.length === 1 ? (
        <Link
          href={liveViewHref(tasks[0].sessionId)}
          className="flex items-center gap-2 rounded-full border border-primary/30 bg-card px-3 py-1.5 text-[11px] shadow-md hover:bg-accent"
        >
          <span aria-hidden className="claw-blink size-1.5 shrink-0 rounded-full bg-primary" />
          <span className="text-foreground">{label}</span>
          <span className="inline-flex items-center gap-1 font-medium text-primary">
            <Eye className="size-3" aria-hidden />
            {t.computer.livePill.watch}
          </span>
        </Link>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          className="flex items-center gap-2 rounded-full border border-primary/30 bg-card px-3 py-1.5 text-[11px] shadow-md hover:bg-accent"
        >
          <span aria-hidden className="claw-blink size-1.5 shrink-0 rounded-full bg-primary" />
          <span className="text-foreground">{label}</span>
          <span className="inline-flex items-center gap-1 font-medium text-primary">
            <Eye className="size-3" aria-hidden />
            {t.computer.livePill.watch}
          </span>
        </button>
      )}
    </div>
  );
}

/** Polling wrapper mounted once in the workspace layout. */
export function ComputerLivePill({ workspaceId }: { workspaceId: string }) {
  const pathname = usePathname();
  const [tasks, setTasks] = useState<ComputerTaskSummary[]>([]);
  const onLiveView = pathname?.includes("/computer/") ?? false;

  useEffect(() => {
    if (onLiveView) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const probe = async () => {
      const found = await listActiveComputerTasks(workspaceId);
      if (cancelled) return;
      setTasks(found);
      timer = setTimeout(() => void probe(), POLL_MS);
    };
    void probe();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [workspaceId, onLiveView]);

  if (onLiveView) return null;
  return <ComputerLivePillView workspaceId={workspaceId} tasks={tasks} />;
}
