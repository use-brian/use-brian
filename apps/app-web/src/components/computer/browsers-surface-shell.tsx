"use client";

/**
 * Browsers operator surface — the shell every `/w/[id]/computer/*` route
 * renders inside (mounted by `computer/layout.tsx`).
 *
 * Mounts the shared operator top bar (`[COMP:app-web/operator-topbar]`, app
 * `browsers`) above a master-detail body: a LEFT rail listing the caller's
 * live browser sessions (`sandbox_tasks`, running/paused) and, on the right,
 * the per-session Take-Over live view (`[sessionId]/page.tsx`) or the index
 * prompt. Selecting a rail row is a route change to `/computer/<sessionId>`;
 * the shell persists across those transitions, so the rail is the "navigate
 * between views" spine and browser back/forward move between sessions.
 *
 * Discovery data is the same 20s poll of `GET /api/computer/tasks` the live
 * pill uses (`listActiveComputerTasks`) — the shell unmounts when you leave
 * the surface, so a mount-effect poll (not the workspace-events spine) is the
 * right fit here; it self-heals on every tick. Failures render an empty rail,
 * never a broken surface.
 *
 * Spec: docs/architecture/engine/computer-use.md §5;
 * docs/architecture/features/doc.md → "Home operator app-bar".
 * [COMP:app-web/browsers-surface]
 */

import { useEffect, useState, type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { ConnectBrowserButton } from "./connect-browser-button";
import {
  listActiveComputerTasks,
  type ComputerTaskSummary,
} from "@/lib/api/computer";

const POLL_MS = 20_000;

const COMPUTER_SESSION_RE = /\/computer\/([^/?#]+)/;

/** The session id the current `/computer/<sessionId>` route is viewing, or
 *  null at the `/computer` index. Exported for the SSR test. */
export function sessionIdFromPathname(
  pathname: string | null | undefined,
): string | null {
  if (!pathname) return null;
  const match = COMPUTER_SESSION_RE.exec(pathname);
  return match ? decodeURIComponent(match[1]) : null;
}

/** Pure render — exported for SSR tests; polling lives in the wrapper. */
export function SessionsRail({
  workspaceId,
  tasks,
  activeSessionId,
}: {
  workspaceId: string;
  tasks: ComputerTaskSummary[];
  activeSessionId: string | null;
}) {
  const t = useT().computer.sessions;
  const liveViewHref = (sessionId: string) =>
    `/w/${workspaceId}/computer/${encodeURIComponent(sessionId)}`;

  return (
    <aside className="flex w-56 shrink-0 flex-col border-r border-border/60 bg-background sm:w-60 lg:w-64">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2.5">
        <span className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
          {t.railTitle}
        </span>
        {tasks.length > 0 ? (
          <span className="tabular-nums text-[11px] text-muted-foreground">
            {tasks.length}
          </span>
        ) : null}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1.5">
        {tasks.length === 0 ? (
          <p className="px-2 py-3 text-xs text-muted-foreground">{t.railEmpty}</p>
        ) : (
          <ul className="flex flex-col gap-0.5">
            {tasks.map((task) => {
              const isActive = task.sessionId === activeSessionId;
              return (
                <li key={task.taskId}>
                  <Link
                    href={liveViewHref(task.sessionId)}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-sm transition-colors",
                      isActive
                        ? "bg-primary/5 text-foreground"
                        : "text-foreground/80 hover:bg-muted/50",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "size-1.5 shrink-0 rounded-full",
                        task.status === "running"
                          ? "claw-blink bg-emerald-500"
                          : "bg-amber-500",
                      )}
                    />
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate font-medium">
                        {task.injectedSite ?? t.unnamed}
                      </span>
                      <span className="truncate text-[11px] text-muted-foreground">
                        {task.status === "running"
                          ? t.statusRunning
                          : t.statusPaused}
                      </span>
                    </span>
                    {isActive ? (
                      <Eye className="size-3.5 shrink-0 text-primary" aria-hidden />
                    ) : null}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </aside>
  );
}

/** Polling wrapper mounted by `computer/layout.tsx`. */
export function BrowsersSurfaceShell({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  const t = useT().computer.sessions;
  const pathname = usePathname();
  const activeSessionId = sessionIdFromPathname(pathname);
  const [tasks, setTasks] = useState<ComputerTaskSummary[]>([]);

  useEffect(() => {
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
  }, [workspaceId]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <OperatorTopbar
        app="browsers"
        right={
          <div className="flex items-center gap-1">
            {tasks.length > 0 ? (
              <span className="inline-flex items-center gap-1.5 px-2 py-1 text-[12.5px] text-sidebar-foreground/70 max-sm:hidden">
                <span
                  aria-hidden
                  className="claw-blink size-1.5 rounded-full bg-emerald-500"
                />
                {format(t.liveCount, { count: tasks.length })}
              </span>
            ) : null}
            {/* Connect / reconnect the local Chrome. The browser affordance
                lives on the Browsers surface, not the global app-bar; it
                renders nothing where no relay is configured. */}
            <ConnectBrowserButton workspaceId={workspaceId} />
          </div>
        }
      />
      <div className="flex min-h-0 flex-1">
        <SessionsRail
          workspaceId={workspaceId}
          tasks={tasks}
          activeSessionId={activeSessionId}
        />
        <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
      </div>
    </div>
  );
}
