/**
 * Shared GET handler for public-page social images.
 *
 * [COMP:app-web/page-social-image]
 */

import { renderPageSocialImage } from "@/lib/page-social-image";
import type { SocialCardInput } from "@/lib/page-social-card";

export async function socialImageResponse(load: () => Promise<SocialCardInput | null>): Promise<Response> {
  try {
    return await renderPageSocialImage(await load());
  } catch (err) {
    console.error("[page-social-image] render failed:", err);
    return renderPageSocialImage(null);
  }
}
