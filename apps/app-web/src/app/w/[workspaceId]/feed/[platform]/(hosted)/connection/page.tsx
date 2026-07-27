"use client";

/**
 * Feed connection route — connect / reconnect / disconnect for one platform
 * account. Thin wrapper: the meat lives in `@/components/feed/feed-connection`
 * (`[COMP:app-web/feed-connection]`) so the desktop SPA can import the client
 * component directly (docs/plans/feed-web-consolidation.md §6, §10).
 */

import { FeedConnection } from "@/components/feed/feed-connection";

export default function FeedConnectionPage() {
  return <FeedConnection />;
}
