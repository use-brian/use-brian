"use client";

/**
 * Feed inspiration route — keyword-scan candidates to reply to / quote.
 * Thin wrapper: the meat lives in `@/components/feed/feed-inspiration`
 * (`[COMP:app-web/feed-inspiration]`) so the desktop SPA can import the
 * client component directly (docs/plans/feed-web-consolidation.md §6, §10).
 */

import { FeedInspiration } from "@/components/feed/feed-inspiration";

export default function FeedInspirationPage() {
  return <FeedInspiration />;
}
