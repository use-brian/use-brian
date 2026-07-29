"use client";

/**
 * Legacy `/feed/inbox` route — merged into `/feed/posts` by the revamp and
 * kept as a redirect so existing deep links do not 404 (feed-revamp.md D6).
 * The Approvals panel deep-links `distribution_draft` rows here.
 */

import { FeedLegacyRedirect } from "@/components/feed/feed-legacy-redirect";

export default function FeedLegacyInboxPage() {
  return <FeedLegacyRedirect status="review" />;
}
