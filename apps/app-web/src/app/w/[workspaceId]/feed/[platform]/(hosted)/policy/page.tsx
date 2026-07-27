"use client";

/**
 * Feed reply-policy route — the structured auto-reply policy editor. Thin
 * wrapper: the meat lives in `@/components/feed/feed-policy`
 * (`[COMP:app-web/feed-policy]`) so the desktop SPA can import the client
 * component directly (docs/plans/feed-web-consolidation.md §6, §10).
 */

import { FeedPolicy } from "@/components/feed/feed-policy";

export default function FeedPolicyPage() {
  return <FeedPolicy />;
}
