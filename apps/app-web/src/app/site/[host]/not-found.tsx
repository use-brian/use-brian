/**
 * Branded 404 for customer custom domains — unknown slug, unpublished page,
 * or an unresolvable host. Server-rendered, noindex.
 * [COMP:app-web/site-route]
 */

import type { Metadata } from "next";
import { getServerDictionary } from "@/lib/i18n/server";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default async function SiteNotFound() {
  const { dict } = await getServerDictionary();
  const t = dict.sharedPage;
  return (
    <main className="mx-auto flex min-h-screen w-full max-w-3xl flex-col items-center justify-center gap-3 px-6 text-center">
      <h1 className="text-2xl font-semibold tracking-tight">{t.siteNotFoundTitle}</h1>
      <p className="text-sm text-muted-foreground">{t.siteNotFoundBody}</p>
    </main>
  );
}
