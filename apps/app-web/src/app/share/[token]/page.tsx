/**
 * Public shared-page route — `/share/[token]`.
 *
 * Unauthenticated (outside the `proxy.ts` matcher), server-rendered for
 * LLM-friendly HTML + OG previews, `noindex` by default (per-link opt-in
 * via `indexable`). Fetches the page server-side for the initial render,
 * then hands off to a client view that subscribes over SSE for live updates.
 *
 * [COMP:app-web/share-dialog]
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { buildShareMetadata, getPublicPage } from "@/lib/api/public-share";
import { PublicPageView } from "./public-page-view";

type Params = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params;
  return buildShareMetadata(await getPublicPage(token));
}

export default async function SharePage({ params }: Params) {
  const { token } = await params;
  const initial = await getPublicPage(token);
  if (!initial) notFound();
  return <PublicPageView source={{ kind: "link", token }} initial={initial} />;
}
