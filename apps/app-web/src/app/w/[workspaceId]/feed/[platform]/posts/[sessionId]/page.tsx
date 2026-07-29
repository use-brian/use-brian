"use client";

/**
 * One post, edited IN PLACE (feed-revamp.md §8a, D15) — the editor plus its
 * refine chat. Replaces the separate `draft-sessions/[sessionId]` page, which
 * now redirects here; the post list that used to sit beside it lives in the
 * sidebar (D14).
 *
 * Thin wrapper: the meat lives in `@/components/feed/post-editor`
 * (`[COMP:app-web/feed-post-editor]`) so the desktop SPA can import the
 * client component directly.
 */

import { useParams } from "next/navigation";
import { PostEditor } from "@/components/feed/post-editor";
import { isFeedPlatform } from "@/lib/feed-nav";

export default function FeedPostPage() {
  const params = useParams<{ platform: string; sessionId: string }>();
  const platform = isFeedPlatform(params?.platform) ? params.platform : null;
  if (!platform || !params?.sessionId) return null;
  return <PostEditor platform={platform} sessionId={params.sessionId} />;
}
