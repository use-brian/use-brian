"use client";

/**
 * Chat surface sidebar panel — swapped into the persistent left sidebar while
 * the Chat operator surface is active. Deliberately minimal: the searchable
 * session rail with rename / delete lives IN the surface
 * (`components/chat-app/chat-surface.tsx`), where there is room for it. This
 * panel is the quick jump — New chat plus the handful of freshest threads —
 * so the sidebar is not blank on `/chat` and a recent is one click away from
 * anywhere in the app.
 *
 * Rows deep-link with `?s=<sessionId>`, the same URL state the surface reads,
 * so the two never need a private bus to agree on which thread is open.
 *
 * Fetches its own copy of the list (the "sidebar fetches its own copy"
 * pattern the Tasks panel established) — cheap, and it means the panel is
 * correct on a cold navigation into `/chat` from any other surface.
 *
 * Spec: docs/architecture/features/chat-app.md → "Sidebar panel".
 * [COMP:app-web/sidebar-panel-chat]
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { listWorkspaceAssistants } from "@/lib/api/views";
import { listSessions, type DocSession } from "@/lib/api/sessions";

/** How many recents the panel shows. The surface's rail holds the full list. */
const PANEL_RECENTS_CAP = 8;

/** The Brain panel's nav-row recipe — active is the `.doc-nav-active` pill. */
const rowCls = (active: boolean) =>
  cn(
    "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
    active
      ? "doc-nav-active font-medium text-sidebar-accent-foreground"
      : "text-sidebar-foreground/80 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground",
  );

const sectionHeaderCls =
  "px-1 pb-1.5 text-[11px] font-semibold uppercase tracking-wide text-sidebar-foreground/45";

export function ChatSidebarPanel({ workspaceId }: { workspaceId: string }) {
  const t = useT().chatApp;
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const activeSessionId = searchParams?.get("s") ?? null;

  const [rows, setRows] = useState<DocSession[] | null>(null);

  const refresh = useCallback(async () => {
    try {
      const assistants = await listWorkspaceAssistants(workspaceId);
      const primary = assistants.find((a) => a.kind === "primary") ?? assistants[0];
      if (!primary) {
        setRows([]);
        return;
      }
      setRows(await listSessions({ workspaceId, assistantId: primary.id }));
    } catch {
      setRows([]);
    }
  }, [workspaceId]);

  useEffect(() => {
    setRows(null);
    void refresh();
  }, [refresh]);

  const base = `/w/${workspaceId}/chat`;
  const onChatSurface = pathname === base;

  return (
    <div className="flex flex-col gap-3 px-1 pt-1">
      <Link
        href={base}
        aria-current={onChatSurface && !activeSessionId ? "page" : undefined}
        className={rowCls(onChatSurface && !activeSessionId)}
      >
        <Plus className="size-3.5 shrink-0" aria-hidden />
        <span className="min-w-0 flex-1 truncate">{t.newChat}</span>
      </Link>

      <div>
        <div className={sectionHeaderCls}>{t.railAria}</div>
        <div className="flex flex-col gap-0.5">
          {rows === null && (
            <div className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
              {t.loading}
            </div>
          )}
          {rows !== null && rows.length === 0 && (
            <div className="select-none px-2 py-1 text-[12px] text-sidebar-foreground/40">
              {t.railEmpty}
            </div>
          )}
          {(rows ?? []).slice(0, PANEL_RECENTS_CAP).map((row) => (
            <Link
              key={row.id}
              href={`${base}?s=${encodeURIComponent(row.id)}`}
              aria-current={row.id === activeSessionId ? "page" : undefined}
              className={rowCls(row.id === activeSessionId)}
            >
              <span className="min-w-0 flex-1 truncate">{row.title}</span>
            </Link>
          ))}
        </div>
      </div>
    </div>
  );
}
