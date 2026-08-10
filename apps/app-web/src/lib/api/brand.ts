/**
 * The Feed's read-only window onto the workspace brand.
 *
 * [COMP:app-web/brand-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";
import type { BrandRecord } from "@use-brian/shared/brand";

const apiUrl = (path: string) =>
  `${process.env.NEXT_PUBLIC_API_URL ?? ""}${path}`;

/**
 * The workspace's default brand, or null.
 *
 * Returns the APPROVED record only (`activeRecord`), never `brand.draft`
 * (feed-revamp-depth D35). A draft is a proposal and an assistant can write
 * one, so rendering it would let an unreviewed suggestion decide how the brand
 * appears on a public post preview.
 *
 * Null on any failure, including "no brand yet": every Feed consumer degrades
 * to exactly what it rendered before brand existed, so a brand read going down
 * can never take a composer with it.
 */
export async function fetchWorkspaceBrand(
  workspaceId: string,
): Promise<BrandRecord | null> {
  try {
    const res = await authFetch(
      apiUrl(`/api/workspaces/${workspaceId}/brand/default`),
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      brand?: { activeRecord?: BrandRecord | null } | null;
    };
    return body.brand?.activeRecord ?? null;
  } catch {
    return null;
  }
}
