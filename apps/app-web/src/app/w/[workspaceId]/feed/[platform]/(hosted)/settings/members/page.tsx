"use client";

/**
 * Feed settings members route — per-member draft-access management. Thin
 * wrapper: the meat lives in `@/components/feed/feed-settings-members`
 * (`[COMP:app-web/feed-settings]`) so the desktop SPA can import the client
 * component directly (docs/plans/feed-web-consolidation.md §6, §10).
 */

import { FeedSettingsMembers } from "@/components/feed/feed-settings-members";

export default function FeedSettingsMembersPage() {
  return <FeedSettingsMembers />;
}
