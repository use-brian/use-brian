/**
 * Social thumbnail for a token sub-page `/share/[token]/p/[pageId]`.
 *
 * [COMP:app-web/page-social-image]
 */

import { getPublicPage } from "@/lib/api/public-share";
import { socialImageResponse } from "@/lib/page-social-route";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  ctx: { params: Promise<{ token: string; pageId: string }> },
) {
  const { token, pageId } = await ctx.params;
  return socialImageResponse(() => getPublicPage(token, pageId));
}
