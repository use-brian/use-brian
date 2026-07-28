"use client";

/**
 * Feed settings route — the per-platform settings index (policy /
 * connection / members cards). Thin wrapper: the meat lives in
 * `@/components/feed/feed-settings` (`[COMP:app-web/feed-settings]`) so the
 * desktop SPA can import the client component directly
 * (docs/plans/feed-web-consolidation.md §6, §10). feed-web's metadata-only
 * `settings/layout.tsx` is folded, like every other ported feed route.
 */

import { FeedSettings } from "@/components/feed/feed-settings";

export default function FeedSettingsPage() {
  return <FeedSettings />;
}
