"use client";

/**
 * Legacy Feed connection route. Account lifecycle now lives inline in the
 * platform Settings page; replace instead of pushing so Back skips this shim.
 * Client navigation is intentional because the desktop SPA has no server-side
 * redirect handler.
 */

import { useEffect } from "react";
import { useParams, useRouter } from "next/navigation";
import { feedPath, type FeedPlatform } from "@/lib/feed-nav";

export default function FeedConnectionPage() {
  const params = useParams<{ workspaceId: string; platform: FeedPlatform }>();
  const router = useRouter();

  useEffect(() => {
    router.replace(
      feedPath(params.workspaceId, {
        platform: params.platform,
        segment: "settings",
      }),
    );
  }, [params.platform, params.workspaceId, router]);

  return null;
}
