"use client";

/**
 * Durable Approvals entry — always reachable from the workspace sidebar.
 *
 * The Approvals queue lives as a doc-shell panel (`/p?panel=approvals`), not a
 * top-level surface. Home dock used to open the waiting card, but that entry
 * disappeared with the chat-first navigation reshape. This row restores a
 * permanent path into the queue on every `/w/[workspaceId]/*` surface.
 *
 * Badge count comes from the same home-dock signal `DocSidebarDataProvider`
 * already owns, so the number never disagrees with "Needs you".
 *
 * [COMP:app-web/approvals]
 */

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { ClipboardCheck } from "lucide-react";
import { format, useT } from "@/lib/i18n/client";
import { pendingApprovalTotal } from "@/lib/api/home-dock";
import { requestSidebarClose } from "@/lib/sidebar-close";
import { cn } from "@/lib/utils";
import { useSidebarData } from "./doc-sidebar-data";

export function ApprovalsNav({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const { dock } = useSidebarData();
  const pathname = usePathname() ?? "";
  const search = useSearchParams();
  const count = pendingApprovalTotal(dock);
  const href = `/w/${workspaceId}/p?panel=approvals`;
  const active =
    pathname.includes(`/w/${workspaceId}/p`) && search?.get("panel") === "approvals";

  return (
    <Link
      href={href}
      prefetch={false}
      aria-current={active ? "page" : undefined}
      onClick={() => requestSidebarClose()}
      data-approvals-nav
      className={cn(
        "group flex min-h-11 items-center gap-2.5 rounded-md px-2 py-0.5 text-sidebar-foreground hover:bg-sidebar-accent md:min-h-7",
        active && "bg-sidebar-accent text-sidebar-accent-foreground",
      )}
    >
      <ClipboardCheck className="size-4 shrink-0 text-sidebar-foreground/70" aria-hidden />
      <span className="min-w-0 flex-1 truncate text-[14px] font-medium">
        {t.approvalsPage.title}
      </span>
      {count > 0 && (
        <span
          aria-label={format(t.approvalsPage.pendingBadge, { count })}
          className="grid h-[18px] min-w-[18px] place-items-center rounded-[9px] bg-rose-500/15 px-1.5 text-[11px] font-bold text-rose-600 dark:text-rose-400"
        >
          {count > 99 ? "99+" : count}
        </span>
      )}
    </Link>
  );
}
