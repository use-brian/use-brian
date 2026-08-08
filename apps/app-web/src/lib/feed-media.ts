/**
 * Pure media rules for a post (feed-revamp-depth D32/D34).
 *
 * [COMP:app-web/feed-media]
 */

import type { FeedPlatform } from "@/lib/feed-nav";

export type PostMedia = {
  fileId: string;
  mimeType: string;
  alt?: string;
};

/** Still images only. Video is excluded by the upload mime allowlist too. */
export const ACCEPTED_MEDIA_MIME = [
  "image/png",
  "image/jpeg",
  "image/webp",
  "image/gif",
] as const;

const MAX_POST_MEDIA = 10;

/**
 * Per-platform ceilings. These are the PLATFORM's limits, not ours, so a
 * composer never lets an operator attach something the target will reject.
 */
const PLATFORM_MEDIA_CAP: Record<FeedPlatform, number> = {
  threads: 10,
  twitter: 4,
  instagram: 10,
  xhs: 9,
  linkedin: 1,
};

export function mediaCapFor(platform: FeedPlatform): number {
  return Math.min(PLATFORM_MEDIA_CAP[platform] ?? 1, MAX_POST_MEDIA);
}

/**
 * Whether approving a post on this platform CAN ship its images at all.
 *
 * Threads and X both can now (D34). Everything else is manual delivery by
 * design, and saying so is the point: a surface that accepts an image the
 * approve path will drop is the worst failure available here.
 */
export function canPublishMedia(platform: FeedPlatform): boolean {
  return platform === "threads" || platform === "twitter";
}

/**
 * Whether THIS connection will ship them.
 *
 * Separate from `canPublishMedia` because the two genuinely differ for X: the
 * platform supports it, but a connection made before the `media.write` scope
 * was requested does not carry the grant, and scopes are not retroactive. The
 * honest answer there is "reconnect", which only a per-connection check can
 * give. `undefined` means the server did not say, which is treated as the
 * platform default rather than as a failure.
 */
export function connectionPublishesMedia(
  platform: FeedPlatform,
  connectionCanPublish: boolean | undefined,
): boolean {
  if (!canPublishMedia(platform)) return false;
  return connectionCanPublish ?? true;
}
