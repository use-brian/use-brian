"use client";

/**
 * Legacy `/feed/drafts` route — merged into `/feed/posts` by the revamp and
 * kept as a redirect so existing deep links do not 404 (feed-revamp.md D6).
 */

import { FeedLegacyRedirect } from "@/components/feed/feed-legacy-redirect";

export default function FeedLegacyDraftsPage() {
  return <FeedLegacyRedirect status="drafting" />;
}
