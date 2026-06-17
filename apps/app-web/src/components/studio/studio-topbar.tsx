"use client";

/**
 * Studio top bar — the doc-style chrome row for the Studio surface, mounted
 * once by `studio/layout.tsx` above every section page.
 *
 * Mirrors `brain-topbar.tsx`'s left-cluster grammar on the page surface
 * (background tokens, not the sidebar palette):
 *
 *   [ ☰ ] [ ‹ ] [ › ]  Studio / {section}
 *    │      │     │      └─ breadcrumb: "Studio" navigates to the studio
 *    │      │     │         root (→ Connectors); the section segment is the
 *    │      │     │         active section's label from `STUDIO_GROUPS`.
 *    │      └─ browser history back / forward
 *    └─ desktop sidebar collapse, wired to the layout-level `useSidebarData()`
 *
 * The bar is sticky inside the surface's one scroll container and renders on
 * all sizes — the collapse toggle hides `<md` where the chrome hamburger
 * drives the drawer (a spacer keeps the row clear of it, same as doc-topbar).
 *
 * Spec: docs/architecture/features/studio.md → "The Studio top bar".
 * [COMP:app-web/studio-topbar]
 */

import Link from "next/link";
import { useRouter, usePathname } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  PanelLeftClose,
  PanelLeftOpen,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { studioSectionFromPathname } from "@/lib/studio-nav";

/** doc-topbar's icon-button recipe, recoloured for the page surface. */
const iconBtnCls =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35";

const crumbBtnCls =
  "shrink-0 rounded px-1 py-0.5 text-[13px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

export function StudioTopbar({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const docCopy = t.docPage;
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { sidebarCollapsed, setSidebarCollapsed } = useSidebarData();

  const sectionKey = studioSectionFromPathname(pathname);
  const sectionLabel = sectionKey ? t.studioPage.sections[sectionKey] : null;

  return (
    <div
      // Desktop-shell (Electron) chrome hooks, mirroring brain-topbar: the
      // bar is an OS window-drag handle, and when the sidebar is collapsed it
      // takes the `--doc-titlebar-lights` clearance so it never slides under
      // the macOS traffic lights (globals.css → "Desktop shell"). Like the
      // Brain pages, Studio doesn't render inside `DocShell`, so the bar
      // carries `data-sidebar-collapsed` itself.
      data-doc-chrome
      data-doc-topbar
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-0.5 border-b border-border bg-background/95 pl-1 pr-2 backdrop-blur"
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

      {/* Breadcrumb — Studio / {section}. */}
      <nav
        aria-label={t.studioPage.title}
        className="flex min-w-0 shrink-0 items-center gap-0.5"
      >
        <Link href={`/w/${workspaceId}/studio`} className={crumbBtnCls}>
          {t.studioPage.title}
        </Link>
        {sectionLabel && (
          <>
            <span aria-hidden className="text-muted-foreground/40">
              /
            </span>
            <span className="shrink-0 px-1 py-0.5 text-[13px] font-medium text-foreground">
              {sectionLabel}
            </span>
          </>
        )}
      </nav>
    </div>
  );
}
