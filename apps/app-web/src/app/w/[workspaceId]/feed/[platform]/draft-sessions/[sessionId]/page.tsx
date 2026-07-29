"use client";

/**
 * Legacy per-draft route — posts are edited in place at
 * `/feed/[platform]/posts/[sessionId]` now (feed-revamp.md §8a, D15). Kept as
 * a redirect: `distribution_events` deep links, the Approvals panel, and any
 * link the assistant has already sent point here.
 */

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { feedPostPath, isFeedPlatform } from "@/lib/feed-nav";

export default function FeedLegacyDraftSessionPage() {
  const params = useParams<{
    workspaceId: string;
    platform: string;
    sessionId: string;
  }>();
  const router = useRouter();

  useEffect(() => {
    const platform = isFeedPlatform(params?.platform) ? params.platform : null;
    if (!params?.workspaceId || !platform || !params?.sessionId) return;
    router.replace(
      feedPostPath(params.workspaceId, platform, params.sessionId),
    );
  }, [router, params]);

  return null;
}
