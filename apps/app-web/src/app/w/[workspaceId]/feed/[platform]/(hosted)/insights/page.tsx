"use client";

/**
 * Feed insights route — per-post metrics dashboard. Thin wrapper: the meat
 * lives in `@/components/feed/feed-insights`
 * (`[COMP:app-web/feed-insights]`) so the desktop SPA can import the client
 * component directly (docs/plans/feed-web-consolidation.md §6, §10).
 */

import { FeedInsights } from "@/components/feed/feed-insights";

export default function FeedInsightsPage() {
  return <FeedInsights />;
}
