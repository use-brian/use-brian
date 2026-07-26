"use client";

/**
 * Browsers surface layout — every `/w/[id]/computer/*` route renders inside
 * the `BrowsersSurfaceShell` (operator top bar over the full-width live view).
 * The live-session list lives in the persistent left sidebar
 * (`BrowsersSidebarPanel`), not this pane, so navigating between sessions
 * never remounts the chrome. See computer-use.md §5.
 *
 * [COMP:app-web/browsers-surface]
 */

import { useParams } from "next/navigation";
import { BrowsersSurfaceShell } from "@/components/computer/browsers-surface-shell";

export default function ComputerLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  return (
    <BrowsersSurfaceShell workspaceId={workspaceId}>
      {children}
    </BrowsersSurfaceShell>
  );
}
