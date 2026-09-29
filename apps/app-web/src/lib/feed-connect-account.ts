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

import type { ConnectableFeedPlatform } from "@/lib/feed-nav";

// Connectable platforms only — Instagram/XHS have no OAuth integration yet
// (docs/plans/feed-create-split.md D5/D11); their sidebar rows land on the
// coming-soon connection stub instead of an authorize URL.
export const OAUTH_PATH: Record<ConnectableFeedPlatform, string> = {
  threads: "/api/threads-oauth/authorize",
  twitter: "/api/twitter-oauth/authorize",
};

/**
 * The desktop shell's deep-link scheme (`apps/app-desktop/src/config.ts`
 * `PROTOCOL_SCHEME`). The server accepts exactly `usebrian://open?path=/...`.
 */
const DESKTOP_RETURN_SCHEME = "usebrian";

/**
 * Where the OAuth callback lands: the platform's Feed settings page, whose
 * connection card confirms the result (`useFeedConnectLanding`). Web returns
 * on this origin. The
 * desktop app returns through its `usebrian://open` deep link: consent runs in
 * the system browser, so any https return would strand the user there, and
 * the bundled renderer's `file://` origin is not a URL the server can accept.
 * Spec: docs/architecture/feed/twitter.md -> "Return landing".
 */
export function buildReturnTo(params: {
  platform: ConnectableFeedPlatform;
  origin: string;
  workspaceId: string;
  desktop: boolean;
}): string {
  const path = `/w/${params.workspaceId}/feed/${params.platform}/settings?connected=${params.platform}`;
  if (!params.desktop) return `${params.origin}${path}`;
  const link = new URL(`${DESKTOP_RETURN_SCHEME}://open`);
  link.searchParams.set("path", path);
  return link.toString();
}

/**
 * Build the distribution OAuth `/authorize` URL. `return_to` lands the user
 * back on the platform's Feed settings page, on the web or inside the desktop
 * app (`buildReturnTo`).
 */
export function buildAuthorizeUrl(params: {
  apiUrl: string;
  platform: ConnectableFeedPlatform;
  assistantId: string;
  origin: string;
  workspaceId: string;
  desktop?: boolean;
}): string {
  const { apiUrl, platform, assistantId, origin, workspaceId } = params;
  const returnTo = buildReturnTo({
    platform,
    origin,
    workspaceId,
    desktop: params.desktop === true,
  });
  // A `file://` renderer has no usable base; the API URL is absolute there.
  const url = new URL(`${apiUrl}${OAUTH_PATH[platform]}`, origin);
  url.searchParams.set("assistantId", assistantId);
  url.searchParams.set("return_to", returnTo);
  return url.toString();
}
