"use client";

/**
 * Feed ready-to-post route — approved drafts awaiting manual posting
 * (docs/plans/feed-create-split.md D2). Thin wrapper: the meat lives in
 * `@/components/feed/feed-ready` (`[COMP:app-web/feed-ready]`) so the
 * desktop SPA can import the client component directly.
 */

import { FeedReady } from "@/components/feed/feed-ready";

export default function FeedReadyPage() {
  return <FeedReady />;
}
