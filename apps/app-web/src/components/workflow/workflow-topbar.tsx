"use client";

/**
 * Workflow top bar — shared doc-style chrome for every Workflow route.
 *
 * Mirrors the Brain and Studio surface bars so Workflow keeps the same
 * workspace controls whether the user is viewing the list, editing a board,
 * or inspecting a run. `workflow/layout.tsx` owns the mount; route pages keep
 * their route-specific headers below it.
 *
 * Spec: docs/architecture/features/workflow.md → "Workflow top bar".
 * [COMP:app-web/workflow-topbar]
 */

import Link from "next/link";
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

/** Shared page-surface top-bar icon button recipe. */
const iconBtnCls =
  "inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35";

export function WorkflowTopbar({ workspaceId }: { workspaceId: string }) {
  const t = useT();
  const docCopy = t.docPage;
  const router = useRouter();
  const { sidebarCollapsed, setSidebarCollapsed } = useSidebarData();
  const workflowHref = `/w/${workspaceId}/workflow`;

  return (
    <div
      data-doc-chrome
      data-doc-topbar
      data-sidebar-collapsed={sidebarCollapsed ? "true" : "false"}
      className="sticky top-0 z-10 flex h-11 shrink-0 items-center gap-0.5 border-b border-border bg-background/95 pl-1 pr-2 backdrop-blur"
    >
      <button
        type="button"
        onClick={() => setSidebarCollapsed((value) => !value)}
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

      <nav aria-label={t.workflowPage.title} className="min-w-0">
        <Link
          href={workflowHref}
          className="block truncate rounded px-1 py-0.5 text-[13px] font-medium text-foreground transition-colors hover:bg-muted"
        >
          {t.workflowPage.title}
        </Link>
      </nav>
      <div className="min-w-0 flex-1" aria-hidden />
    </div>
  );
}
