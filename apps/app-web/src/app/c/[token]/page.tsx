/**
 * Public chat link route — `/c/[token]`.
 *
 * Unauthenticated (a sibling of `/share`, outside the `proxy.ts` guard),
 * server-rendered: resolves the link meta server-side, 404s dead tokens,
 * then hands off to the client chat view. Always `noindex` — a chat link
 * is shared deliberately, not discovered by crawlers.
 *
 * Spec: docs/architecture/features/public-chat-link.md.
 * [COMP:app-web/public-chat-page]
 */

import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { getPublicChatMeta } from "@/lib/api/public-chat";
import { PublicChatView } from "./public-chat-view";

type Params = { params: Promise<{ token: string }> };

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { token } = await params;
  const meta = await getPublicChatMeta(token);
  return {
    title: meta ? meta.assistantName : "Chat",
    robots: { index: false, follow: false },
  };
}

export default async function PublicChatPage({ params }: Params) {
  const { token } = await params;
  const meta = await getPublicChatMeta(token);
  if (!meta) notFound();
  return <PublicChatView token={token} meta={meta} />;
}
