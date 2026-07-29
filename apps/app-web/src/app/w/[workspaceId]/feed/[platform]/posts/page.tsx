"use client";

/**
 * The platform's posts surface with nothing selected — the "+ New post"
 * target from the sidebar list (feed-revamp.md §8a, D14). Creating a post
 * navigates straight into its in-place editor.
 */

import { useParams } from "next/navigation";
import { PostEditor } from "@/components/feed/post-editor";
import { isFeedPlatform } from "@/lib/feed-nav";

export default function FeedPlatformPostsPage() {
  const params = useParams<{ platform: string }>();
  const platform = isFeedPlatform(params?.platform) ? params.platform : null;
  if (!platform) return null;
  return <PostEditor platform={platform} sessionId={null} />;
}
