"use client";

/**
 * Browsers operator surface — the shell every `/w/[id]/computer/*` route
 * renders inside (mounted by `computer/layout.tsx`).
 *
 * Mounts the shared operator top bar (`[COMP:app-web/operator-topbar]`, app
 * `browsers`) above the pane, which is now the full-width Take-Over live view
 * (`[sessionId]/page.tsx`) or the index "pick a session" prompt. The
 * live-session LIST moved OUT of this shell into the persistent left sidebar
 * (`[COMP:app-web/browsers-surface]` sidebar-panel flavour,
 * `components/doc/sidebar-panels/browsers-sidebar-panel.tsx`), so Browsers now
 * hangs its navigation off `DocSidebar` like every other operator app instead
 * of wedging a second rail into the content pane. Selecting a session there is
 * a route change to `/computer/<sessionId>`; back/forward move between them.
 *
 * The top bar's `right` slot carries the `[COMP:app-web/connect-browser-button]`
 * "My Browser" connect control — the browser affordance lives on the Browsers
 * surface, not the global app-bar, and renders nothing where no relay is
 * configured. The live-session count is shown by the sidebar panel's header.
 *
 * Spec: docs/architecture/engine/computer-use.md §5;
 * docs/architecture/features/doc.md → "Home operator app-bar".
 * [COMP:app-web/browsers-surface]
 */

import { type ReactNode } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { ConnectBrowserButton } from "./connect-browser-button";

type BrowsersView = "live" | "profiles";

/** Static `/profiles` wins over `[sessionId]`; every other computer route is live. */
function browserViewFromPathname(pathname: string | null | undefined): BrowsersView {
  return pathname && /\/computer\/profiles(?:\/|$)/.test(pathname) ? "profiles" : "live";
}

function BrowsersViewToggle({ workspaceId }: { workspaceId: string }) {
  const t = useT().computer.sessions;
  const view = browserViewFromPathname(usePathname());
  const items: Array<{ id: BrowsersView; label: string; href: string }> = [
    { id: "live", label: t.liveView, href: `/w/${workspaceId}/computer` },
    { id: "profiles", label: t.profilesView, href: `/w/${workspaceId}/computer/profiles` },
  ];

  return (
    <nav
      aria-label={t.viewSwitcherAria}
      className="flex shrink-0 items-center gap-0.5 rounded-md bg-sidebar-accent/70 p-0.5"
    >
      {items.map((item) => {
        const active = item.id === view;
        return (
          <Link
            key={item.id}
            href={item.href}
            aria-current={active ? "page" : undefined}
            className={cn(
              "inline-flex h-7 items-center rounded px-2 text-xs font-medium whitespace-nowrap transition-colors sm:px-2.5",
              active
                ? "bg-background text-foreground shadow-sm"
                : "text-sidebar-foreground/65 hover:text-sidebar-accent-foreground",
            )}
          >
            {item.label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Wrapper mounted by `computer/layout.tsx` — top bar over the full-width pane. */
export function BrowsersSurfaceShell({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex h-full min-h-0 flex-col">
      <OperatorTopbar
        app="browsers"
        appChipClassName="hidden sm:flex sm:w-[200px]"
        center={<BrowsersViewToggle workspaceId={workspaceId} />}
        right={<ConnectBrowserButton workspaceId={workspaceId} />}
      />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
