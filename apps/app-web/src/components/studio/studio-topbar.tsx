"use client";

import { WorkspaceTopbar, useWorkspaceTopbarShell } from "@/components/chrome/workspace-topbar";

/** Studio breadcrumbs and the route-owned action portal in the shared header.
 * Mounted once above section pages; section state stays with its route.
 * Spec: docs/architecture/features/workspace-navigation.md → "Shared top bar".
 * [COMP:app-web/studio-topbar] */

import { useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import { SlidersHorizontal } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { studioSectionFromPathname } from "@/lib/studio-nav";
import { requestSidebarClose } from "@/lib/sidebar-close";

export const STUDIO_TOPBAR_ACTIONS_ID = "studio-topbar-actions";

/**
 * Mount a route page's stateful primary action in the persistent Studio chrome.
 * The page remains the action's React owner, so opening an inline form does not
 * require lifting section-specific state into `studio/layout.tsx`.
 */
export function StudioTopbarActions({ children }: { children: ReactNode }) {
  const [target, setTarget] = useState<HTMLElement | null>(null);
  const headerHost = useWorkspaceTopbarShell()?.toolbar;

  useEffect(() => {
    setTarget(document.getElementById(STUDIO_TOPBAR_ACTIONS_ID));
  }, [headerHost]);

  return target ? createPortal(children, target) : null;
}

export function StudioTopbar({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { sidebarCollapsed } = useSidebarData();

  const sectionKey = studioSectionFromPathname(pathname);
  const sectionLabel = sectionKey ? t.studioPage.sections[sectionKey] : null;

  const appIdentity = <Link data-workspace-app-identity href={`/w/${workspaceId}/studio/connectors`} onClick={requestSidebarClose} className="flex min-w-0 items-center gap-2 rounded text-foreground hover:text-foreground/75">
    <SlidersHorizontal className="size-4 shrink-0" aria-hidden /><span className="truncate">{t.studioPage.title}</span>
  </Link>;

  return (
    <WorkspaceTopbar identity={appIdentity} sidebarCollapsed={sidebarCollapsed} history={{ onBack: () => router.back(), onForward: () => router.forward() }}>
      {/* Breadcrumb — Studio / {section}. */}
      <nav
        aria-label={t.studioPage.title}
        className="flex min-w-0 items-center gap-1 overflow-hidden text-sm"
      >
        {sectionLabel && (
          <>
            <span className="truncate px-1 py-0.5 text-sm font-medium text-foreground">
              {sectionLabel}
            </span>
          </>
        )}
      </nav>

      <div className="min-w-2 flex-1" aria-hidden />
      <div
        id={STUDIO_TOPBAR_ACTIONS_ID}
        className="flex shrink-0 items-center gap-2 pl-2"
      />
    </WorkspaceTopbar>
  );
}
