"use client";

/**
 * UnconfirmedBanner — page-level summary nudge atop the Brain page,
 * shown when the workspace has brain entries the user hasn't confirmed
 * yet (`verified_by_user_id IS NULL`, counted via `brainInboxCount`).
 *
 * Distinct from the per-row `UnverifiedNudge` (which acts on one entry):
 * this is the catch-up affordance that tells the user *how many* entries
 * are waiting and routes them into the existing "Pending changes" filter
 * — it does not introduce a new route (IA rule: pending is a filter on
 * Brain, not its own page).
 *
 * Dismiss is permanent and per-user, reusing the chat-home
 * `dismissed_nudges` plumbing under the key `brain-unconfirmed`. The
 * page owns the count + dismissal state; this component is presentational.
 *
 * Spec: docs/architecture/brain/corrections.md → "Page-level unconfirmed banner".
 *
 * Ported verbatim from apps/web (docs/plans/doc-web-app-consolidation.md
 * §5a — brain surface migration). Presentational; no link / scope change.
 *
 * [COMP:app-web/brain-unconfirmed-banner]
 */

import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";

type Props = {
  /** Number of unconfirmed entries in the workspace (> 0 when shown). */
  count: number;
  /** Flip the page into the "Pending changes" review view. */
  onReview: () => void;
  /** Permanently dismiss the banner for this user. */
  onDismiss: () => void;
};

export function UnconfirmedBanner({ count, onReview, onDismiss }: Props) {
  const t = useT();
  const heading =
    count === 1
      ? t.brainPage.unconfirmedBanner.headingOne
      : format(t.brainPage.unconfirmedBanner.headingMany, { count });

  return (
    <div className="flex items-center gap-3 px-4 py-2.5 rounded-md border border-amber-500/30 bg-amber-500/5">
      <svg
        width={16}
        height={16}
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.75"
        aria-hidden
        className="text-amber-600 dark:text-amber-400 shrink-0"
      >
        <path d="M12 9v4M12 17h.01" />
        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z" />
      </svg>
      <p className="flex-1 min-w-0 text-sm font-medium text-foreground truncate">{heading}</p>
      <button
        type="button"
        onClick={onReview}
        className="shrink-0 text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90"
      >
        {t.brainPage.unconfirmedBanner.review}
      </button>
      <button
        type="button"
        onClick={onDismiss}
        aria-label={t.brainPage.unconfirmedBanner.dismissAria}
        className="shrink-0 text-xs px-3 py-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-muted"
      >
        {t.brainPage.unconfirmedBanner.dismiss}
      </button>
    </div>
  );
}
