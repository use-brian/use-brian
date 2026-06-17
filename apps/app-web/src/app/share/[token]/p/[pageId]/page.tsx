/**
 * Token-scoped sub-page route - `/share/[token]/p/[pageId]`.
 *
 * The subtree cascade for link shares: a page shared by token exposes every
 * page nested under it through the SAME token, addressed by the child's id.
 * Resolves through `GET /api/public/pages/:token?page=<pageId>`
 * (`resolveLinkPage`: live link grant + the ROOT still public + the workspace
 * switch + the target being a descendant of the root - revoke / raise the
 * root's clearance / flip the switch all 404 the whole subtree). Unauthed,
 * server-rendered, `noindex` unless the link opted into indexing. Hands off
 * to the same client view the root token route uses.
 *
 * [COMP:app-web/share-dialog]
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildShareMetadata, getPublicPage } from "@/lib/api/public-share";
import { PublicPageView } from "../../public-page-view";

type Params = { params: Promise<{ token: string; pageId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token, pageId } = await params;
  return buildShareMetadata(await getPublicPage(token, pageId));
}

export default async function SharedSubPage({ params }: Params) {
  const { token, pageId } = await params;
  const initial = await getPublicPage(token, pageId);
  if (!initial) notFound();
  return <PublicPageView source={{ kind: "link", token, pageId }} initial={initial} />;
}
