/**
 * Public-share SDK — anonymous read of an externally shared doc page.
 *
 * Unlike every other SDK here, these calls use a PLAIN `fetch` (no
 * `authFetch`, no Authorization header, no token refresh): the route is
 * unauthenticated and access is by the link token in the URL. Used by the
 * `/share/[token]` route (its server render plus the client's SSE
 * subscription on `/public/pages/:token/stream`).
 *
 * [COMP:app-web/share-dialog]
 */

import type { Metadata } from "next";
import type { ViewPayload } from "@sidanclaw/views-renderer";

// Client base: intentionally "" in dev (next.config sets NEXT_PUBLIC_API_URL
// to "" there) so browser requests stay relative and the Next.js `/api/*`
// rewrite proxies them to the backend. In prod it's the absolute API origin.
const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Base URL for a fetch that may run on the SERVER (the `/share/[token]` route
 * is an SSR Server Component, and its client view also re-fetches). A relative
 * URL has no origin to resolve against on the server, so `fetch("/api/...")`
 * throws there. On the client we keep the relative/proxied base (`API_URL`);
 * on the server we resolve an absolute backend URL. `??` is not enough because
 * `NEXT_PUBLIC_API_URL` is the empty string (not undefined) in dev, so we use
 * `||` to fall through to the localhost default.
 */
function fetchApiBase(): string {
  if (typeof window !== "undefined") return API_URL;
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
}

/** Loose block shape — the public response mirrors the core Block union. */
export type PublicBlock = { kind: string; id: string } & Record<string, unknown>;

/** A read-only comment thread shown on a shared page (Notion-style). */
export type PublicComment = {
  threadId: string;
  anchorBlockId: string | null;
  quote: string | null;
  messages: { author: string; avatar: string | null; body: string; createdAt: string }[];
};

export type PublicPage = {
  title: string;
  icon: string | null;
  fullWidth: boolean;
  indexable: boolean;
  /** The link's role — drives whether the guest comment composer shows. */
  role: "view" | "comment" | "edit" | "full";
  blocks: PublicBlock[];
  payload: ViewPayload;
  /** Read-only existing comments on the page (member + guest), if any. */
  comments?: PublicComment[];
  /** Ancestor chain (root → current). Published context: from the topmost
   *  published root, crumbs link to `/share/p/<pageId>`. Token sub-page
   *  context: from the token's root, crumbs link token-scoped
   *  (`/share/<token>`, `/share/<token>/p/<pageId>`). Empty for a link root
   *  that isn't inside any published subtree. */
  breadcrumb?: { pageId: string; title: string; icon: string | null }[];
  /** Custom-domain (site) responses only — the resolved page id. */
  pageId?: string;
  /** Custom-domain responses only — this page's canonical site path. */
  canonicalPath?: string;
  /** Custom-domain responses only — canonical site path per referenced page
   *  (breadcrumb + child_page blocks): `/`, `/<slug>`, or `/p/<id>`. */
  paths?: Record<string, string>;
};

/** An emoji rendered as an SVG data-URL favicon (Notion uses the page icon). */
function emojiFaviconDataUrl(emoji: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${emoji}</text></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/** First non-empty plain-text block, as a social/SEO description (~160 chars). */
function firstTextSnippet(blocks: PublicBlock[]): string {
  for (const b of blocks) {
    const t = typeof b.text === "string" ? b.text.trim() : "";
    if (t) return t.length > 160 ? `${t.slice(0, 157)}...` : t;
  }
  return "";
}

/**
 * Build Next.js page metadata from a shared page: the page's own title +
 * first-paragraph description, the emoji icon as the favicon (so a shared tab
 * shows the page's identity, not a generic app icon), and `noindex` unless the
 * publisher opted into search indexing. Used by both share routes.
 */
export function buildShareMetadata(page: PublicPage | null, fallbackTitle = "Shared page"): Metadata {
  if (!page) return { title: fallbackTitle, robots: { index: false, follow: false } };
  const title = page.title || fallbackTitle;
  const description = firstTextSnippet(page.blocks) || undefined;
  return {
    title,
    description,
    robots: page.indexable ? undefined : { index: false, follow: false },
    openGraph: { title, type: "article", description },
    icons: page.icon ? { icon: emojiFaviconDataUrl(page.icon) } : undefined,
  };
}

type GuestComment = { body: string; createdAt: string };
export type GuestThreadView = {
  threadId: string;
  anchorBlockId: string | null;
  quote: string | null;
  createdAt: string;
  authorName: string | null;
  comments: GuestComment[];
};

/** `?page=<id>` suffix scoping a token route to a sub-page of the shared root
 *  (subtree cascade); empty for the root itself. */
function pageScope(pageId?: string): string {
  return pageId ? `?page=${encodeURIComponent(pageId)}` : "";
}

/** Absolute URL for a shared page's media (image/file) byte stream. */
function publicMediaUrl(token: string, blockId: string, pageId?: string): string {
  return `${API_URL}/api/public/pages/${encodeURIComponent(token)}/media/${encodeURIComponent(blockId)}${pageScope(pageId)}`;
}

/** Absolute URL for the shared page's SSE stream (grant + refresh signals). */
function publicStreamUrl(token: string, pageId?: string): string {
  return `${API_URL}/api/public/pages/${encodeURIComponent(token)}/stream${pageScope(pageId)}`;
}

/** Media/stream URLs for a page published by id (the "one universal URL" model). */
function publishedMediaUrl(pageId: string, blockId: string): string {
  return `${API_URL}/api/public/published/${encodeURIComponent(pageId)}/media/${encodeURIComponent(blockId)}`;
}
function publishedStreamUrl(pageId: string): string {
  return `${API_URL}/api/public/published/${encodeURIComponent(pageId)}/stream`;
}

/** Media/stream URLs for a page served on a customer's custom domain. */
function siteMediaUrl(host: string, blockId: string, pageId?: string): string {
  return `${API_URL}/api/public/sites/${encodeURIComponent(host)}/media/${encodeURIComponent(blockId)}${pageScope(pageId)}`;
}
function siteStreamUrl(host: string, pageId?: string): string {
  return `${API_URL}/api/public/sites/${encodeURIComponent(host)}/stream${pageScope(pageId)}`;
}

/**
 * A public viewer's source: either an "anyone with the link" token (optionally
 * scoped to a sub-page of the shared root via `pageId` — the subtree cascade),
 * or a page published to the web by its id (one universal URL). The viewer
 * components are parameterized over this so the same renderer serves both.
 */
export type PublicSource =
  | { kind: "link"; token: string; pageId?: string }
  | { kind: "published"; pageId: string }
  | {
      kind: "site";
      /** The customer hostname the page is served on. */
      host: string;
      /** The site path being viewed ("" for the root). */
      path: string;
      /** The resolved page id (scopes media/stream for sub-pages). */
      pageId?: string;
    };

export function publicMediaUrlFor(source: PublicSource, blockId: string): string {
  if (source.kind === "site") return siteMediaUrl(source.host, blockId, source.pageId);
  return source.kind === "link"
    ? publicMediaUrl(source.token, blockId, source.pageId)
    : publishedMediaUrl(source.pageId, blockId);
}
export function publicStreamUrlFor(source: PublicSource): string {
  if (source.kind === "site") return siteStreamUrl(source.host, source.pageId);
  return source.kind === "link"
    ? publicStreamUrl(source.token, source.pageId)
    : publishedStreamUrl(source.pageId);
}
export async function fetchPublicPageFor(source: PublicSource, opts?: { signal?: AbortSignal }): Promise<PublicPage | null> {
  if (source.kind === "site") {
    const result = await getSitePage(source.host, source.path, opts);
    if (!result) return null;
    if (result.kind === "redirect") {
      // A live viewer's slug changed under them — follow the new address.
      if (typeof window !== "undefined") window.location.replace(result.location);
      return null;
    }
    return result.page;
  }
  return source.kind === "link"
    ? getPublicPage(source.token, source.pageId, opts)
    : getPublishedPage(source.pageId, opts);
}

export type SitePageResult =
  | { kind: "page"; page: PublicPage }
  | { kind: "redirect"; location: string };

/**
 * Fetch a page served on a custom domain by host + site path. Distinguishes
 * a redirect directive (historical slug / canonicalization) from a render;
 * null on any non-200 (unknown host, unpublished, bad path).
 */
export async function getSitePage(
  host: string,
  path: string,
  opts?: { signal?: AbortSignal },
): Promise<SitePageResult | null> {
  try {
    const res = await fetch(
      `${fetchApiBase()}/api/public/sites/${encodeURIComponent(host)}/page?path=${encodeURIComponent(path)}`,
      { cache: "no-store", signal: opts?.signal },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as PublicPage | { redirect: string };
    if ("redirect" in body && typeof body.redirect === "string") {
      return { kind: "redirect", location: body.redirect };
    }
    return { kind: "page", page: body as PublicPage };
  } catch {
    return null;
  }
}

/**
 * Fetch a shared page (or, with `pageId`, a sub-page of the shared root).
 * Returns null on any non-200 (revoked / expired / not-public /
 * sharing-disabled / not-a-descendant all 404 server-side). `cache:
 * 'no-store'` so each SSE-triggered re-fetch sees current content.
 */
export async function getPublicPage(
  token: string,
  pageId?: string,
  opts?: { signal?: AbortSignal },
): Promise<PublicPage | null> {
  try {
    const res = await fetch(
      `${fetchApiBase()}/api/public/pages/${encodeURIComponent(token)}${pageScope(pageId)}`,
      { cache: "no-store", signal: opts?.signal },
    );
    if (!res.ok) return null;
    return (await res.json()) as PublicPage;
  } catch {
    return null;
  }
}

/** Fetch a page published to the web by its id (the universal-URL model). */
export async function getPublishedPage(
  pageId: string,
  opts?: { signal?: AbortSignal },
): Promise<PublicPage | null> {
  try {
    const res = await fetch(
      `${fetchApiBase()}/api/public/published/${encodeURIComponent(pageId)}`,
      { cache: "no-store", signal: opts?.signal },
    );
    if (!res.ok) return null;
    return (await res.json()) as PublicPage;
  } catch {
    return null;
  }
}

/** Token-route URL with path suffix + query params (handles `?`/`&` joining). */
const pub = (token: string, suffix = "", params: Record<string, string | undefined> = {}) => {
  const qs = Object.entries(params)
    .filter((e): e is [string, string] => Boolean(e[1]))
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${API_URL}/api/public/pages/${encodeURIComponent(token)}${suffix}${qs ? `?${qs}` : ""}`;
};

/** Post a new guest comment thread (on the root, or a sub-page via `pageId`).
 *  Returns the (possibly newly minted) guest token. */
export async function postGuestComment(
  token: string,
  args: { guestName: string; guestSessionToken?: string; body: string },
  pageId?: string,
): Promise<{ threadId: string; guestSessionToken: string } | null> {
  try {
    const res = await fetch(pub(token, "/comment-threads", { page: pageId }), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(args),
    });
    if (!res.ok) return null;
    return (await res.json()) as { threadId: string; guestSessionToken: string };
  } catch {
    return null;
  }
}

/** List the guest's own comment threads (scoped by their token). */
export async function listGuestComments(
  token: string,
  guestSessionToken: string,
  pageId?: string,
): Promise<GuestThreadView[]> {
  try {
    const res = await fetch(
      pub(token, "/comments", { guestSessionToken, page: pageId }),
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const body = (await res.json()) as { threads: GuestThreadView[] };
    return body.threads ?? [];
  } catch {
    return [];
  }
}
