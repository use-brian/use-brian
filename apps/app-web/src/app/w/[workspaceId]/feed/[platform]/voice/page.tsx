"use client";

/**
 * Platform voice — the rules that make ONE platform sound like itself, above
 * the company baseline it inherits (feed-revamp.md §8a, D13). Company-wide
 * rules live at `/feed/voice`.
 *
 * Thin wrapper: the meat lives in `@/components/feed/feed-voice`
 * (`[COMP:app-web/feed-voice]`) so the desktop SPA can import the client
 * component directly.
 */

import { useParams } from "next/navigation";
import { FeedVoice } from "@/components/feed/feed-voice";
import { isFeedPlatform } from "@/lib/feed-nav";

export default function FeedPlatformVoicePage() {
  const params = useParams<{ platform: string }>();
  const platform = isFeedPlatform(params?.platform) ? params.platform : null;
  // The parent `[platform]/layout.tsx` already 404s an unknown segment; this
  // narrow is for the type, not a second guard.
  return <FeedVoice scope={platform ?? "company"} />;
}
