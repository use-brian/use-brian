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

export const MAX_POST_MEDIA = 10;

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
 * Whether approving a post on this platform actually ships its images.
 *
 * Only Threads does today (D34): its client already speaks IMAGE/CAROUSEL. X
 * accepts `mediaIds` but nothing in the tree uploads media to mint one, so
 * claiming otherwise would be the worst available failure - the tool reports
 * success, the model says the image is attached, and the adapter drops it.
 * Everything else is manual delivery by design.
 */
export function canPublishMedia(platform: FeedPlatform): boolean {
  return platform === "threads";
}
