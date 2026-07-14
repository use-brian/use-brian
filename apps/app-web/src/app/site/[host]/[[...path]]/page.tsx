/**
 * Custom-domain site route — the render target `proxy.ts` rewrites every
 * customer-host request to (`docs.acme.com/<path>` → `/site/docs.acme.com/<path>`).
 * Never addressable directly on an app origin (the middleware 404s it there).
 *
 * Unauthenticated Server Component like `/share/[token]`: SSR for
 * LLM-friendly HTML + OG previews, then the shared client view subscribes
 * over SSE. Historical slugs and `/p/<id>`-with-slug arrive as a redirect
 * directive from the API and 301 here. Canonical URLs point at the customer
 * domain. Spec: docs/architecture/features/custom-domains.md.
 *
 * [COMP:app-web/site-route]
 */

import type { Metadata } from "next";
import { headers } from "next/headers";
import { notFound, permanentRedirect } from "next/navigation";
import { buildShareMetadata, getSitePage } from "@/lib/api/public-share";
import { isAppHost, normalizeHostHeader } from "@/lib/site-hosts";
import { PublicPageView } from "@/app/share/[token]/public-page-view";

type Params = { params: Promise<{ host: string; path?: string[] }> };

function sitePathOf(path: string[] | undefined): string {
  return (path ?? []).map(decodeURIComponent).join("/");
}

/** Only the middleware rewrite (a customer Host) reaches this route
 *  legitimately. Direct `/site/...` requests on an app origin 404 here — the
 *  middleware's own block can be bypassed by dot-containing paths (the broad
 *  matcher excludes them), so the route re-checks the ORIGINAL Host header,
 *  which a rewrite preserves. */
async function requestedByCustomHost(): Promise<boolean> {
  const h = await headers();
  const host = normalizeHostHeader(h.get("x-forwarded-host") ?? h.get("host") ?? "");
  return !isAppHost(host);
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { host, path } = await params;
  const result = await getSitePage(host, sitePathOf(path));
  if (!result || result.kind === "redirect") {
    return { robots: { index: false, follow: false } };
  }
  const page = result.page;
  return {
    ...buildShareMetadata(page),
    alternates: {
      canonical: `https://${host}${page.canonicalPath ?? "/"}`,
    },
  };
}

export default async function SitePage({ params }: Params) {
  if (!(await requestedByCustomHost())) notFound();
  const { host, path } = await params;
  const sitePath = sitePathOf(path);
  const result = await getSitePage(host, sitePath);
  if (!result) notFound();
  if (result.kind === "redirect") permanentRedirect(result.location);
  const page = result.page;
  return (
    <PublicPageView
      source={{ kind: "site", host, path: sitePath, pageId: page.pageId }}
      initial={page}
    />
  );
}
