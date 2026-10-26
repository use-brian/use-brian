"use client";

import { WorkspaceTopbar } from "@/components/chrome/workspace-topbar";

/** Brain breadcrumbs, view controls and actions in the shared workspace header.
 * One row serves the root and detail routes; surface state owns navigation.
 * Spec: docs/architecture/features/workspace-navigation.md → "Shared top bar".
 * [COMP:app-web/brain-topbar] */

import { useRouter, usePathname } from "next/navigation";
import {
  ChevronLeft,
  ChevronRight,
  Brain,
} from "lucide-react";
import { useT, format } from "@/lib/i18n/client";
import { useBrainSurface } from "@/contexts/brain-surface-context";
import { useSidebarData } from "@/components/doc/doc-sidebar-data";
import { requestSidebarClose } from "@/lib/sidebar-close";

/** doc-topbar's icon-button recipe, recoloured for the page surface. */
const iconBtnCls =
  "inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:pointer-events-none disabled:opacity-35 md:size-7";

const crumbBtnCls =
  "min-w-0 truncate rounded px-1 py-0.5 text-sm max-md:min-h-11 text-muted-foreground transition-colors hover:bg-muted hover:text-foreground";

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
  const brain = useBrainSurface();
  const router = useRouter();
  const pathname = usePathname() ?? "";
  const { sidebarCollapsed } = useSidebarData();

  // Breadcrumb segments navigate by section — and, from the editor
  // sub-route, walk back to the Brain root first so the page can react.
  const brainRoot = workspaceId ? `/w/${workspaceId}/brain` : null;
  const goSection = (section: "entries" | "skills" | "blueprints") => {
    brain.setSection(section);
    if (brainRoot && pathname !== brainRoot) router.push(brainRoot);
  };

  const sectionLabel = t.brainPage.sections[tail ? tailSection : brain.section];

  const appIdentity = <button type="button" data-workspace-app-identity onClick={() => { requestSidebarClose(); goSection("entries"); }} className="flex min-w-0 items-center gap-2 rounded text-foreground hover:text-foreground/75">
    <Brain className="size-4 shrink-0" aria-hidden /><span className="truncate">{t.brainPage.title}</span>
  </button>;

  return (
    <WorkspaceTopbar identity={appIdentity} sidebarCollapsed={sidebarCollapsed} history={{ onBack: () => router.back(), onForward: () => router.forward() }}>
      {/* Breadcrumb — Brain / {section} [/ tail]. */}
      <nav
        aria-label={t.brainPage.title}
        className="flex min-w-0 max-w-[40%] shrink items-center gap-1 text-sm md:max-w-[50%]"
      >
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
            <span className="flex min-w-0 items-center gap-1.5 overflow-hidden px-1 text-sm font-medium text-foreground">
              {tail}
            </span>
          </>
        ) : (
          <span className="min-w-0 truncate px-1 py-0.5 text-sm font-medium text-foreground">
            {sectionLabel}
          </span>
        )}
      </nav>

      {/* Page-injected clusters. The center slot scrolls instead of letting
          content paint over the right cluster when the bar is cramped — a
          flex-shrunk `min-w-0` parent does NOT stop an inline-flex child
          (e.g. the entries List|Graph toggle) from overflowing visually. */}
      <div className="flex min-w-0 flex-1 items-center gap-2 overflow-x-auto pl-1 md:pl-0">
        {center}
      </div>
      {right && (
        <div className="flex shrink-0 items-center gap-2">{right}</div>
      )}
    </WorkspaceTopbar>
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
