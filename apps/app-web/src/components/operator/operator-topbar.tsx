"use client";

/**
 * Operator top bar — the ONE shared chrome row every non-Page operator app
 * surface (Tasks / CRM / Feed) opens with, so the four operator apps read as
 * one product under the Page app's top chrome:
 *
 *   [ ☰ ] [ ‹ ] [ › ]  ▣ Tasks   {center}                {right}
 *    │      │     │     └─ ONE non-closable active tab chip (the app's
 *    │      │     │        `APP_ICON` glyph + its `operatorBar` label) in the
 *    │      │     │        doc-topbar TabChip recipe: `bg-background` with a
 *    │      │     │        `-mb-px` bottom-merge so the tab flows into the
 *    │      │     │        surface below. NO multi-tab strip, NO `+` —
 *    │      │     │        `doc-tabs` (browse stacks, panel tabs) stays a
 *    │      │     │        Page-app concept; this chip is chrome that names
 *    │      │     │        where you are.
 *    │      └─ browser history back / forward (`router.back()`/`forward()`;
 *    │         always enabled — the router exposes no can-go signal)
 *    └─ desktop sidebar collapse, wired to the layout-level `useSidebarData()`
 *
 * `center` and `right` are composable slots the mounting surface fills
 * (Tasks: counts + Table|Board toggle; CRM: section switch + deals view
 * toggle) so the bar never knows surface internals — the brain-topbar slot
 * contract. Painted in the same warm-grey `--sidebar*` palette as
 * `doc-topbar.tsx`, whose class recipes this file copies verbatim.
 *
 * Mobile: the collapse toggle hides (the chrome's fixed hamburger drives the
 * drawer); a leading spacer keeps the row clear of it.
 *
 * Desktop-shell (Electron) parity mirrors brain/studio-topbar: the bar is an
 * OS window-drag handle (`data-doc-chrome`), and it SELF-sets
 * `data-sidebar-collapsed` for the traffic-light clearance — these surfaces
 * don't render inside `DocShell`, so the flag can't come from an ancestor.
 *
 * Spec: docs/architecture/features/doc.md → "Home operator app-bar" →
 * "Operator top bar".
 * [COMP:app-web/operator-topbar]
 */

import { useRouter } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { APP_ICON } from "@/components/doc/operator-app-bar";
import { type OperatorAppKey } from "@/lib/operator-apps";

/** doc-topbar's icon-button recipe (sidebar palette). */
const iconBtnCls =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-sidebar-foreground/70 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-35";

export function OperatorTopbar({
  app,
  center,
  right,
}: {
  /** Which operator app the chip names (icon + `operatorBar` label). */
  app: OperatorAppKey;
  /** Cluster after the tab chip (CRM's section switch). Scrolls instead of
   *  painting over the right cluster when the bar is cramped. */
  center?: React.ReactNode;
  /** Right-aligned cluster (counts, view toggles). */
  right?: React.ReactNode;
}) {
  const t = useT();
  const docCopy = t.docPage;
  const router = useRouter();
  const { sidebarCollapsed, setSidebarCollapsed } = useSidebarData();

  const Icon = APP_ICON[app];
  const label = t.operatorBar[app];

  return (
    <div
      data-doc-chrome
      data-doc-topbar
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      className="flex h-11 shrink-0 items-center gap-0.5 border-b border-sidebar-border bg-sidebar pr-2 pl-1"
    >
      {/* Sidebar collapse / expand — desktop only; the chrome's fixed
          hamburger owns the `<md` drawer, so a spacer clears it. */}
      <button
        type="button"
        onClick={() => setSidebarCollapsed((v) => !v)}
        aria-label={
          sidebarCollapsed
            ? docCopy.topbarSidebarExpandAria
            : docCopy.topbarSidebarCollapseAria
        }
        title={
          sidebarCollapsed
            ? docCopy.topbarSidebarExpandAria
            : docCopy.topbarSidebarCollapseAria
        }
        className={cn(iconBtnCls, "hidden md:inline-flex")}
      >
        {sidebarCollapsed ? (
          <PanelLeftOpen className="size-4" aria-hidden />
        ) : (
          <PanelLeftClose className="size-4" aria-hidden />
        )}
      </button>
      <div className="w-12 shrink-0 md:hidden" aria-hidden />

      {/* Browser history — back / forward. */}
      <button
        type="button"
        onClick={() => router.back()}
        aria-label={docCopy.topbarBackAria}
        title={docCopy.topbarBackAria}
        className={iconBtnCls}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => router.forward()}
        aria-label={docCopy.topbarForwardAria}
        title={docCopy.topbarForwardAria}
        className={cn(iconBtnCls, "mr-1")}
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>

      {/* The app's tab chip — bottom-aligned and full-bar-height so it can
          merge into the surface below (doc-topbar's active-TabChip recipe:
          `-mb-px border-b-0 bg-background` covers the bar's border-b). Inert
          chrome, not a button — there is nothing to switch to here. */}
      <div className="flex min-w-0 flex-1 items-end gap-1 self-stretch">
        <div
          className={cn(
            "flex h-9 w-[200px] min-w-0 items-center gap-1.5 rounded-t-lg pl-3 pr-3 text-sm",
            "relative z-10 -mb-px border border-b-0 border-sidebar-border bg-background font-medium text-foreground",
          )}
        >
          <span className="grid size-4 shrink-0 place-items-center">
            <Icon className="size-4 text-muted-foreground" aria-hidden />
          </span>
          <span className="min-w-0 flex-1 truncate text-left" title={label}>
            {label}
          </span>
        </div>

        {/* Surface-injected clusters. The center slot scrolls instead of
            letting content paint over the right cluster when the bar is
            cramped (the brain-topbar overflow rule). */}
        <div className="flex min-w-0 flex-1 items-center gap-2 self-center overflow-x-auto pl-2">
          {center}
        </div>
      </div>
      {right && (
        <div className="flex shrink-0 items-center gap-1 self-center">
          {right}
        </div>
      )}
    </div>
  );
}
