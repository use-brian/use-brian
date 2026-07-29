"use client";

/**
 * Feed surface index — the marketing Plan (calendar + month brief), or the
 * guided first run when the workspace has no brand voice yet. Plan owns the
 * bare `/feed` index rather than a `/feed/plan` segment (feed-revamp.md D5).
 *
 * Thin wrapper: the meat lives in `@/components/feed/feed-plan`
 * (`[COMP:app-web/feed-plan-surface]`) so the desktop SPA can import the
 * client component directly (docs/plans/feed-web-consolidation.md §6, §10).
 * The Suspense boundary covers `useSearchParams` (the `?connected=` OAuth
 * landing and the `?month=` deep link).
 */

import { Suspense } from "react";
import { FeedPlan } from "@/components/feed/feed-plan";

export default function FeedPlanPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-muted-foreground">…</div>}>
      <FeedPlan />
    </Suspense>
  );
}
