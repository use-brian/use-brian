"use client";

/**
 * Draft auto-prune affordance shown beneath a draft row in the Doc
 * sidebar — shared by the nested tree (`sidebar-tree-node.tsx`) and the
 * flat search list (`doc-sidebar-row.tsx`).
 *
 * At rest it reads as a muted countdown — "{N}d until auto-delete", with
 * amber → destructive escalation as the prune date nears. It is a *button*:
 * hovering or keyboard-focusing it swaps the countdown for a "Save page"
 * call-to-action (★ + label), and activating it promotes the draft into the
 * Favorites (saved) tree via `onSave`. This gives every draft a one-click
 * rescue path exactly where its expiry is surfaced, instead of burying Save
 * in the row's overflow menu.
 *
 * The parent reveals this caption on row hover / when the draft is the
 * active page and collapses it otherwise (a `grid-rows 0fr→1fr` height
 * track); `interactive` mirrors that revealed state so the button is only
 * focusable/clickable while visible. `relative z-10` lifts it above the flat
 * row's full-card navigation overlay so a click saves rather than navigates.
 *
 * [COMP:app-web/draft-prune-button]
 */

import { Star } from "lucide-react";
import { useT, format } from "@/lib/i18n/client";

/** Countdown copy + tone, escalating as the prune date nears. */
function caption(
  days: number,
  t: ReturnType<typeof useT>["docPage"],
): { text: string; tone: string } {
  if (days < 0)
    return { text: t.sidebarDraftPruneOverdue, tone: "text-destructive/80" };
  if (days === 0)
    return {
      text: t.sidebarDraftPruneSoon,
      tone: "text-amber-600 dark:text-amber-400",
    };
  if (days === 1)
    return { text: t.sidebarDraftPruneOne, tone: "text-muted-foreground/70" };
  return {
    text: format(t.sidebarDraftPrune, { days: String(days) }),
    tone: "text-muted-foreground/70",
  };
}

export function DraftPruneButton({
  days,
  onSave,
  interactive,
}: {
  days: number;
  onSave: () => void;
  /** True while the parent has the caption revealed (hover / active). */
  interactive: boolean;
}) {
  const t = useT().docPage;
  const { text, tone } = caption(days, t);
  return (
    <button
      type="button"
      tabIndex={interactive ? 0 : -1}
      aria-label={t.sidebarDraftSave}
      title={t.sidebarDraftSave}
      onClick={(e) => {
        e.stopPropagation();
        onSave();
      }}
      className="group/save relative z-10 inline-flex items-center gap-1 rounded text-xs leading-none outline-none focus-visible:ring-1 focus-visible:ring-ring"
    >
      {/* Countdown at rest → "Save page" CTA on hover / keyboard focus. */}
      <span
        className={`${tone} group-hover/save:hidden group-focus-visible/save:hidden`}
      >
        {text}
      </span>
      <span className="hidden items-center gap-1 font-medium text-primary group-hover/save:inline-flex group-focus-visible/save:inline-flex">
        <Star className="size-3" aria-hidden />
        {t.sidebarDraftSave}
      </span>
    </button>
  );
}
