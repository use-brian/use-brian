"use client";

/**
 * Legacy `/feed/ready` route — merged into `/feed/posts` by the revamp and
 * kept as a redirect so existing deep links do not 404 (feed-revamp.md D6).
 */

import { FeedLegacyRedirect } from "@/components/feed/feed-legacy-redirect";

export default function FeedLegacyReadyPage() {
  return <FeedLegacyRedirect status="ready" />;
}
