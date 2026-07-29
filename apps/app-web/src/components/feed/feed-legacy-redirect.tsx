"use client";

/**
 * Redirect shim for the three Create routes the revamp merged into
 * `/feed/posts` (feed-revamp.md D6).
 *
 * `/feed/drafts`, `/feed/inbox`, and `/feed/ready` are linked from
 * `distribution_events` deep links, the Approvals panel's `distribution_draft`
 * rows, and the Studio mini-apps gallery, so deleting the routes would 404
 * live links. They stay mounted and forward into the merged queue with the
 * matching status filter pre-applied.
 *
 * `router.replace` rather than `next/navigation`'s `redirect()`: this runs in
 * the desktop SPA build too, where a thrown redirect has no server to handle
 * it. Replace (not push) keeps Back going where the user came from instead of
 * bouncing them through the dead route again.
 *
 * [COMP:app-web/feed-legacy-redirect]
 */

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { feedPath } from "@/lib/feed-nav";
import type { PostQueueStatus } from "@/lib/feed-posts";

export function FeedLegacyRedirect({ status }: { status: PostQueueStatus }) {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const router = useRouter();

  useEffect(() => {
    if (!workspaceId) return;
    router.replace(
      `${feedPath(workspaceId, { segment: "posts" })}?status=${status}`,
    );
  }, [router, status, workspaceId]);

  return null;
}
