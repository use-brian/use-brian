/**
 * Published page route - `/share/p/[pageId]`.
 *
 * The "one universal URL" model: a page published to the web is addressed by
 * its id (no token). Server-rendered for LLM-friendly HTML + OG previews,
 * `noindex` unless the publisher opted into search indexing. Resolves through
 * `getPublishedPage` (active `published` grant + `clearance='public'` + the
 * workspace switch); unpublishing / raising clearance / flipping the switch all
 * 404 immediately. Hands off to the same client view the link route uses.
 *
 * [COMP:app-web/share-dialog]
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildShareMetadata, getPublishedPage } from "@/lib/api/public-share";
import { PublicPageView } from "../../[token]/public-page-view";

type Params = { params: Promise<{ pageId: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { pageId } = await params;
  return buildShareMetadata(await getPublishedPage(pageId));
}

export default async function PublishedPage({ params }: Params) {
  const { pageId } = await params;
  const initial = await getPublishedPage(pageId);
  if (!initial) notFound();
  return <PublicPageView source={{ kind: "published", pageId }} initial={initial} />;
}
