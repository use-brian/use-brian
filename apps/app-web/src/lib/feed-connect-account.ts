/**
 * Feed connect-account OAuth URL builder. Ported from
 * `apps/feed-web/src/lib/connect-account.ts`
 * (docs/plans/feed-web-consolidation.md §4); the `return_to` now lands inside
 * app-web's Feed surface instead of feed.usebrian.ai (origin allowlisted
 * server-side against `env.AUTHED_APP_URL` — `threads-oauth.ts` /
 * `twitter-oauth.ts` in `packages/api-platform`).
 *
 * [COMP:app-web/feed-connect-account]
 */

import type { FeedPlatform } from "@/lib/feed-nav";

export const OAUTH_PATH: Record<FeedPlatform, string> = {
  threads: "/api/threads-oauth/authorize",
  twitter: "/api/twitter-oauth/authorize",
};

/**
 * Build the distribution OAuth `/authorize` URL. `return_to` lands the user
 * back on the Feed surface home (`/w/<id>/feed?connected=<platform>`), where
 * the dashboard toasts the fresh connection and refreshes profiles.
 */
export function buildAuthorizeUrl(params: {
  apiUrl: string;
  platform: FeedPlatform;
  assistantId: string;
  origin: string;
  workspaceId: string;
}): string {
  const { apiUrl, platform, assistantId, origin, workspaceId } = params;
  const returnTo = `${origin}/w/${workspaceId}/feed?connected=${platform}`;
  const url = new URL(`${apiUrl}${OAUTH_PATH[platform]}`);
  url.searchParams.set("assistantId", assistantId);
  url.searchParams.set("return_to", returnTo);
  return url.toString();
}
