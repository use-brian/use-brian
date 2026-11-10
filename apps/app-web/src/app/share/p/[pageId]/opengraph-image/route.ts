/**
 * Social thumbnail for a published page `/share/p/[pageId]`.
 *
 * [COMP:app-web/page-social-image]
 */

import { getPublishedPage } from "@/lib/api/public-share";
import { socialImageResponse } from "@/lib/page-social-route";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, ctx: { params: Promise<{ pageId: string }> }) {
  const { pageId } = await ctx.params;
  return socialImageResponse(() => getPublishedPage(pageId));
}
