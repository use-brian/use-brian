"use client";

/** Shared workspace header frame. Surface wrappers own navigation and actions.
 * Spec: docs/architecture/features/workspace-navigation.md → "Shared top bar".
 * [COMP:app-web/workspace-topbar] */
import { createContext, useContext, useMemo, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { ChevronLeft, ChevronRight, PanelLeftClose, PanelLeftOpen } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { WorkspaceSearchSlot } from "@/components/workspace-search/workspace-search-provider";

type TopbarShell = {
  toolbar: HTMLDivElement | null;
  title: HTMLDivElement | null;
  setToolbar: (element: HTMLDivElement | null) => void;
  setTitle: (element: HTMLDivElement | null) => void;
  onToggleSidebar?: () => void;
};
const ShellContext = createContext<TopbarShell | null>(null);

export function WorkspaceTopbarProvider({ children, onToggleSidebar }: { children: ReactNode; onToggleSidebar?: () => void }) {
  const [toolbar, setToolbar] = useState<HTMLDivElement | null>(null);
  const [title, setTitle] = useState<HTMLDivElement | null>(null);
  const value = useMemo(() => ({ toolbar, title, setToolbar, setTitle, onToggleSidebar }), [toolbar, title, onToggleSidebar]);
  return <ShellContext.Provider value={value}>{children}</ShellContext.Provider>;
}

/** Also signals when route-owned action portals can resolve their header target. */
export function useWorkspaceTopbarShell() { return useContext(ShellContext); }

export function WorkspaceTopbarHost({ children }: { children?: ReactNode }) {
  const shell = useWorkspaceTopbarShell();
  return <div ref={shell?.setToolbar} data-workspace-topbar-host data-workspace-window-header data-doc-chrome className="relative z-20 h-11 shrink-0 md:h-9 [&_[data-workspace-search-fallback]]:border-transparent [&_[data-workspace-search-fallback]]:bg-transparent">{children}</div>;
}

export function WorkspaceAppTitleHost({ className, children }: { className?: string; children?: ReactNode }) {
  const shell = useWorkspaceTopbarShell();
  return <div data-workspace-app-heading className={cn("flex min-w-0 flex-1 items-center", className)}>
    <div ref={shell?.setTitle} className="flex min-w-0 shrink items-center text-lg font-semibold [&_svg:not([data-heading-chevron])]:hidden [&_[data-workspace-app-icon]]:hidden [&_[data-workspace-app-identity]]:flex [&_[data-workspace-app-identity]]:min-h-11 md:[&_[data-workspace-app-identity]]:min-h-9 [&_[data-workspace-app-identity]]:max-w-full [&_[data-workspace-app-identity]:not([data-workspace-heading-control])]:px-0 [&_[data-workspace-app-identity]]:text-lg [&_[data-workspace-app-identity]]:font-semibold" />
    {children}
  </div>;
}

type History = {
  onBack: () => void;
  onForward: () => void;
  canBack?: boolean;
  canForward?: boolean;
  /** Pages has active-tab history that phone browser gestures cannot replace. */
  onPhone?: boolean;
};

export function WorkspaceTopbar({ children, identity, sidebarCollapsed, history }: {
  children: ReactNode;
  identity?: ReactNode;
  sidebarCollapsed: boolean;
  history: History;
}) {
  const t = useT().docPage;
  const shell = useWorkspaceTopbarShell();
  const buttonClass = cn(
    "inline-flex size-11 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:pointer-events-none disabled:opacity-35 md:size-7",
    !history.onPhone && "max-md:hidden",
  );
  const frame = (
    <div data-workspace-topbar data-doc-chrome data-doc-topbar
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      className={cn("sticky top-0 z-10 flex h-11 shrink-0 items-center gap-0.5 border-b px-2 md:h-9 md:gap-2 md:px-4", shell ? "border-transparent bg-transparent" : "border-border bg-background")}>
      <div className="w-10 shrink-0 md:hidden" aria-hidden />
      <div data-workspace-window-navigation className={cn("flex shrink-0 items-center gap-1", !history.onPhone && "max-md:hidden", shell && "md:mr-2 md:border-r md:border-border/60 md:pr-2", shell && !sidebarCollapsed && "md:w-[calc(3.5rem+var(--workspace-sidebar-width,14rem)-var(--workspace-header-leading,1rem))]")}>
      <div data-workspace-history className={cn("flex shrink-0 items-center gap-0.5", !history.onPhone && "max-md:hidden")}>
        <button type="button" aria-label={t.topbarBackAria} title={t.topbarBackAria} onClick={history.onBack} disabled={history.canBack === false} className={buttonClass}>
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button type="button" aria-label={t.topbarForwardAria} title={t.topbarForwardAria} onClick={history.onForward} disabled={history.canForward === false} className={buttonClass}>
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
      {shell?.onToggleSidebar && <button type="button" data-workspace-sidebar-toggle aria-label={sidebarCollapsed ? t.topbarSidebarExpandAria : t.topbarSidebarCollapseAria} aria-expanded={!sidebarCollapsed} onClick={shell.onToggleSidebar} className="ml-2 hidden size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 md:inline-flex">
        {sidebarCollapsed ? <PanelLeftOpen className="size-4" aria-hidden /> : <PanelLeftClose className="size-4" aria-hidden />}
      </button>}
      </div>
      {!shell && identity}
      {children}
      <WorkspaceSearchSlot />
    </div>
  );
  if (!shell) return frame;
  return <>
    {shell.title && identity ? createPortal(identity, shell.title) : null}
    {shell.toolbar ? createPortal(frame, shell.toolbar) : null}
  </>;
}
