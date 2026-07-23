"use client";

/**
 * Browsers surface sidebar panel — swapped into the persistent left sidebar
 * while the Browsers operator surface (`/w/[id]/computer/*`) is active, the
 * same way every other operator app hangs its list off `DocSidebar`
 * (Tasks / CRM / Brain / …). Before this, Browsers was the lone operator app
 * that rendered its list as an in-content rail; it now lives in the sidebar
 * with the rest, freeing the whole content pane for the Take-Over live view.
 *
 * Renders the caller's live browser sessions (`sandbox_tasks`, running/paused)
 * in the shared sidebar-panel recipe (uppercase block header + count, quiet
 * `.doc-nav-active` nav rows). A row `<Link>`s to `/computer/<sessionId>`, so
 * the Take-Over view fills the content pane and browser back/forward move
 * between sessions; the active row is marked (`aria-current` + the eye glyph).
 *
 * Discovery data is the same 20s poll of `GET /api/computer/tasks` the live
 * pill + the surface top bar use (`listActiveComputerTasks`). The panel is
 * mounted only while `activeSurface === "computer"` (it unmounts on a surface
 * switch), so a mount-effect poll is the right fit — it self-heals on every
 * tick and tears down its timer on leave; this is NOT the persistent-layout
 * mount-effect anti-pattern (that one is about surfaces that never unmount).
 *
 * Spec: docs/architecture/engine/computer-use.md §5;
 * docs/architecture/features/doc.md → "Home operator app-bar".
 * [COMP:app-web/browsers-surface] (the sidebar-panel flavour)
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { Eye } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
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

const sectionHeaderCls =
  "px-1 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45";

/** The Brain/Tasks panel nav-row recipe — active is the `.doc-nav-active` pill. */
const rowCls = (active: boolean) =>
  cn(
    "flex items-center gap-2.5 rounded-md px-2 py-1.5 text-sm transition-colors",
    active
      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

/** Pure render — exported for SSR tests; polling lives in the wrapper. */
export function BrowsersSessionList({
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
    <div className="flex flex-col gap-1 px-1 pt-1">
      <div className="flex items-center justify-between gap-2 pb-0.5">
        <span className={sectionHeaderCls}>{t.railTitle}</span>
        {tasks.length > 0 ? (
          <span className="shrink-0 tabular-nums text-[11px] text-sidebar-foreground/50">
            {tasks.length}
          </span>
        ) : null}
      </div>
      {tasks.length === 0 ? (
        <p className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
          {t.railEmpty}
        </p>
      ) : (
        <ul className="flex flex-col gap-0.5">
          {tasks.map((task) => {
            const isActive = task.sessionId === activeSessionId;
            return (
              <li key={task.taskId}>
                <Link
                  href={liveViewHref(task.sessionId)}
                  aria-current={isActive ? "page" : undefined}
                  className={rowCls(isActive)}
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
                    <span className="truncate text-[11px] text-sidebar-foreground/50">
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
  );
}

/** Polling wrapper rendered by `DocSidebar` for the `computer` surface. */
export function BrowsersSidebarPanel({ workspaceId }: { workspaceId: string }) {
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
    <BrowsersSessionList
      workspaceId={workspaceId}
      tasks={tasks}
      activeSessionId={activeSessionId}
    />
  );
}
