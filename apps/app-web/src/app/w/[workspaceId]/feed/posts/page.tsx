"use client";

/**
 * Legacy workspace-level posts queue — retired when the post list moved into
 * the sidebar (feed-revamp.md §8a, D14), because a standalone queue page would
 * duplicate it. Kept as a redirect into the current platform's posts surface;
 * `/feed/drafts`, `/feed/inbox`, and `/feed/ready` all still land here first.
 */

import { Suspense, useEffect, useState } from "react";
import { useParams, useRouter, useSearchParams } from "next/navigation";
import { useFeedWorkspace } from "@/contexts/feed-profiles-context";
import { feedPath, resolveCurrentFeedPlatform } from "@/lib/feed-nav";

function FeedLegacyPostsRedirect() {
  const params = useParams<{ workspaceId: string }>();
  const workspaceId = params?.workspaceId ?? "";
  const router = useRouter();
  const team = useFeedWorkspace();
  const searchParams = useSearchParams();
  // Read the stored platform in an effect: it is localStorage, so reading it
  // during render would make SSR and the first client paint disagree.
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    if (!workspaceId || resolved) return;
    setResolved(true);
    const platform = resolveCurrentFeedPlatform({
      workspaceId,
      pathname: null,
      connectedPlatforms: team.profiles.map((p) => p.platform),
    });
    // Carry `?status=` through: `/feed/inbox` is the Approvals panel's deep
    // link, and landing on an unfiltered list would lose the intent.
    const status = searchParams.get("status");
    const base = feedPath(workspaceId, { platform, segment: "posts" });
    router.replace(status ? `${base}?status=${status}` : base);
  }, [workspaceId, resolved, router, team.profiles, searchParams]);

  return null;
}

export default function FeedLegacyPostsPage() {
  return (
    <Suspense fallback={null}>
      <FeedLegacyPostsRedirect />
    </Suspense>
  );
}
