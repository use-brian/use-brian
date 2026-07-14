"use client";

/**
 * Brain top bar — the doc-style chrome row for the Brain surface (all three
 * sections AND the skill editor sub-route render it; there is never a second
 * stacked header).
 *
 * Mirrors `doc-topbar.tsx`'s left-cluster grammar on the page surface
 * (background tokens, not the sidebar palette):
 *
 *   [ ☰ ] [ ‹ ] [ › ]  Brain / {section}[ / tail]   {center}        {right}
 *    │      │     │      └─ breadcrumb: "Brain" jumps to Entries; on the
 *    │      │     │         editor route "Skills" jumps back to the library;
 *    │      │     │         `tail` is the editor's name + status badge.
 *    │      └─ browser history back / forward (no tab strip in v1 — locked)
 *    └─ desktop sidebar collapse, wired to the layout-level `useSidebarData()`
 *
 * `center` and `right` are composable slots the PAGES inject (entries' List |
 * Graph view tabs, the reviews pager, counts, the editor's Unsaved + Save) so
 * this bar never knows editor or section internals. The bar is sticky inside
 * the pane's scroll container and renders on all sizes — the collapse toggle
 * hides `<md` where the chrome hamburger drives the drawer (a spacer keeps
 * the row clear of it, same as doc-topbar).
 *
 * [COMP:app-web/brain-topbar]
 */

import { useRouter, usePathname } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT, format } from "@/lib/i18n/client";
import { useBrainSurface } from "@/contexts/brain-surface-context";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";

/** doc-topbar's icon-button recipe, recoloured for the page surface. */
const iconBtnCls =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35";

const crumbBtnCls =
  "shrink-0 rounded px-1 py-0.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

type Props = {
  workspaceId: string;
  /** Appended breadcrumb segments after "Brain / {tailSection}" — sub-routes
   *  inject their item name (+ badge) here. When set, the section segment is
   *  forced to `tailSection` and becomes a link back to that section. */
  tail?: React.ReactNode;
  /** Which section a `tail` route belongs to — the skill editor uses
   *  "skills" (the default, preserving its breadcrumb), the entry reader
   *  uses "entries", the blueprint detail editor uses "blueprints".
   *  Ignored when `tail` is absent. */
  tailSection?: "entries" | "skills" | "blueprints";
  /** Cluster after the breadcrumb (entries view tabs, the reviews pager). */
  center?: React.ReactNode;
  /** Right-aligned cluster (counts, quiet actions, the editor's Save). */
  right?: React.ReactNode;
};

export function BrainTopbar({
  workspaceId,
  tail,
  tailSection = "skills",
  center,
  right,
}: Props) {
  const t = useT();
  const docCopy = t.docPage;
  const brain = useBrainSurface();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { sidebarCollapsed, setSidebarCollapsed } = useSidebarData();

  // Breadcrumb segments navigate by section — and, from the editor
  // sub-route, walk back to the Brain root first so the page can react.
  const brainRoot = workspaceId ? `/w/${workspaceId}/brain` : null;
  const goSection = (section: "entries" | "skills" | "blueprints") => {
    brain.setSection(section);
    if (brainRoot && pathname !== brainRoot) router.push(brainRoot);
  };

  const sectionLabel = t.brainPage.sections[tail ? tailSection : brain.section];

  return (
    <div
      // Desktop-shell (Electron) chrome hooks, mirroring doc-topbar: the bar
      // is an OS window-drag handle, and when the sidebar is collapsed it
      // slides under the macOS traffic lights, so it takes the
      // `--doc-titlebar-lights` clearance (globals.css → "Desktop shell").
      // Unlike the doc topbar (whose collapsed flag lives on a doc-shell
      // ancestor), this bar carries `data-sidebar-collapsed` itself — the
      // Brain pages don't render inside `DocShell`.
      data-doc-chrome
      data-doc-topbar
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-0.5 border-b border-border bg-background/95 pl-1 pr-2 backdrop-blur">
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

      {/* Browser history — back / forward (no in-surface tab history in v1).
          Hidden below `sm`: bar width is scarce there (drawer spacer +
          breadcrumb + view toggle + counts collide at 360px) and phones have
          OS/browser back gestures. */}
      <button
        type="button"
        onClick={() => router.back()}
        aria-label={docCopy.topbarBackAria}
        title={docCopy.topbarBackAria}
        className={cn(iconBtnCls, "max-sm:hidden")}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        onClick={() => router.forward()}
        aria-label={docCopy.topbarForwardAria}
        title={docCopy.topbarForwardAria}
        className={cn(iconBtnCls, "mr-1", "max-sm:hidden")}
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>

      {/* Breadcrumb — Brain / {section} [/ tail]. */}
      <nav
        aria-label={t.brainPage.title}
        className="flex min-w-0 shrink-0 items-center gap-0.5"
      >
        <button
          type="button"
          onClick={() => goSection("entries")}
          className={crumbBtnCls}
        >
          {t.brainPage.title}
        </button>
        <span aria-hidden className="text-muted-foreground/40">
          /
        </span>
        {tail ? (
          <>
            <button
              type="button"
              onClick={() => goSection(tailSection)}
              className={crumbBtnCls}
            >
              {sectionLabel}
            </button>
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
            <span className="flex min-w-0 items-center gap-1.5 px-1 text-[13px] font-medium text-foreground">
              {tail}
            </span>
          </>
        ) : (
          <span className="shrink-0 px-1 py-0.5 text-[13px] font-medium text-foreground">
            {sectionLabel}
          </span>
        )}
      </nav>

      {/* Page-injected clusters. The center slot scrolls instead of letting
          content paint over the right cluster when the bar is cramped — a
          flex-shrunk `min-w-0` parent does NOT stop an inline-flex child
          (e.g. the entries List|Graph toggle) from overflowing visually. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pl-2">
        {center}
      </div>
      {right && (
        <div className="flex shrink-0 items-center gap-2">{right}</div>
      )}
    </div>
  );
}

/**
 * Queue pager for the Reviews section — "{n} of {m}" + prev/next, wired to
 * the shared review-queue selection by the Brain page. Lives in the topbar
 * on ALL sizes (it replaced `ReviewPanel`'s mobile-only position header).
 */
export function BrainTopbarPager({
  current,
  total,
  onPrev,
  onNext,
}: {
  /** 1-based position within the visible queue. */
  current: number;
  total: number;
  onPrev: () => void;
  onNext: () => void;
}) {
  const t = useT();
  const copy = t.brainPage.reviewPanel;
  return (
    <div className="flex items-center gap-0.5">
      <button
        type="button"
        onClick={onPrev}
        disabled={current <= 1}
        aria-label={copy.prevAria}
        title={copy.prevAria}
        className={iconBtnCls}
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <span className="px-0.5 text-xs tabular-nums text-muted-foreground">
        {format(copy.position, { current, total })}
      </span>
      <button
        type="button"
        onClick={onNext}
        disabled={current >= total}
        aria-label={copy.nextAria}
        title={copy.nextAria}
        className={iconBtnCls}
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </div>
  );
}
