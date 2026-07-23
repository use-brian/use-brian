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
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { ConnectBrowserButton } from "./connect-browser-button";

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
        right={<ConnectBrowserButton workspaceId={workspaceId} />}
      />
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>
  );
}
