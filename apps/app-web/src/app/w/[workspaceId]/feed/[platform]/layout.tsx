/**
 * Platform guard for `/w/[id]/feed/[platform]/*`.
 *
 * Draft-session detail URLs retain the target platform in the path in both
 * editions. Provider-backed pages sit below the `(hosted)` route group, whose
 * own layout enforces the edition boundary.
 */

import { notFound } from "next/navigation";
import { isFeedPlatform } from "@/lib/feed-nav";

export default async function FeedPlatformLayout(props: {
  children: React.ReactNode;
  params: Promise<{ platform: string }>;
}) {
  const { platform } = await props.params;
  if (!isFeedPlatform(platform)) notFound();
  return props.children;
}
