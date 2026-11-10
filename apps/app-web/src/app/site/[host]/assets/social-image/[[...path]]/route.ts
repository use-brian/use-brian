/**
 * Social thumbnail for a customer-domain page.
 *
 * Served under `/assets/social-image` because `assets` is a reserved page
 * slug, so the image address can never collide with a published path. The
 * host rewrite maps `https://<customer>/assets/social-image/<path>` here.
 *
 * [COMP:app-web/page-social-image]
 */

import { getSitePage } from "@/lib/api/public-share";
import { socialImageResponse } from "@/lib/page-social-route";

export const dynamic = "force-dynamic";

function sitePathOf(path: string[] | undefined): string {
  return (path ?? []).map(decodeURIComponent).join("/");
}

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ host: string; path?: string[] }> },
) {
  const { host, path } = await ctx.params;
  return socialImageResponse(async () => {
    const result = await getSitePage(host, sitePathOf(path));
    return result && result.kind === "page" ? result.page : null;
  });
}
