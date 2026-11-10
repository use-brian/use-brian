/**
 * Pure decisions for a public page's social thumbnail: which marks to draw,
 * how to clip the title, and the absolute image URL crawlers should fetch.
 *
 * The image itself is square so a messaging app's square crop still shows the
 * workspace mark, the page icon, and the title together.
 *
 * [COMP:app-web/page-social-image]
 */

import { isImageIcon } from "@use-brian/shared/page-icon";
import { normalizeHostHeader } from "@/lib/site-hosts";

export const SOCIAL_IMAGE_SIZE = { width: 1200, height: 1200 } as const;
const SOCIAL_IMAGE_FALLBACK_TITLE = "Shared page";

const TITLE_CODEPOINTS = 64;

export type SocialCardInput = {
  title?: string | null;
  icon?: string | null;
  workspaceIcon?: { url?: string | null; seed?: number | null } | null;
};

export type PageMark =
  | { kind: "emoji"; emoji: string }
  | { kind: "glyph" };

/** Collapse whitespace and cap the title so the card stays two lines. */
export function socialCardTitle(title: string | null | undefined): string {
  const clean = (title ?? "").replace(/\s+/g, " ").trim();
  const value = clean || SOCIAL_IMAGE_FALLBACK_TITLE;
  const points = [...value];
  if (points.length <= TITLE_CODEPOINTS) return value;
  return `${points.slice(0, TITLE_CODEPOINTS - 3).join("")}...`;
}

/**
 * Emoji icons draw on the card. Image tokens stay the public-page document
 * glyph: those bytes are member-auth only.
 */
export function pageMark(icon: string | null | undefined): PageMark {
  if (!icon || isImageIcon(icon)) return { kind: "glyph" };
  return { kind: "emoji", emoji: icon };
}

export function workspaceIconSeed(page: SocialCardInput | null | undefined): number {
  const seed = page?.workspaceIcon?.seed;
  return typeof seed === "number" && Number.isFinite(seed) ? seed : 0;
}

/** Only the public workspace-icon proxy. Anything else is not fetched. */
export function isPublicWorkspaceIconUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return false;
    if (parsed.username || parsed.password) return false;
    return /^\/api\/workspace-icons\/[^/]+$/.test(parsed.pathname);
  } catch {
    return false;
  }
}

export function workspaceIconUrl(page: SocialCardInput | null | undefined): string | null {
  const url = page?.workspaceIcon?.url;
  return typeof url === "string" && isPublicWorkspaceIconUrl(url) ? url : null;
}

const RASTER = new Set(["image/png", "image/jpeg"]);

/** One emoji grapheme, or the raw string when the runtime has no segmenter. */
export function emojiGraphemes(icon: string): string[] {
  if (typeof Intl !== "undefined" && "Segmenter" in Intl) {
    return [...new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(icon)].map((part) => part.segment);
  }
  return [...icon];
}

/** Noto's color PNG for an emoji sequence. Variation selectors are omitted. */
export function notoEmojiPngUrl(emoji: string): string {
  const parts: string[] = [];
  for (const ch of emoji) {
    const cp = ch.codePointAt(0);
    if (cp === undefined || cp === 0xfe0f) continue;
    parts.push(cp.toString(16));
  }
  return `https://fonts.gstatic.com/s/e/notoemoji/latest/${parts.join("_")}/512.png`;
}

async function readRaster(res: Response): Promise<string | null> {
  const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
  if (!RASTER.has(type)) return null;
  const buf = await res.arrayBuffer();
  if (buf.byteLength === 0 || buf.byteLength > 2_000_000) return null;
  return `data:${type};base64,${Buffer.from(buf).toString("base64")}`;
}

/** Page-icon PNG, or null when the emoji artwork cannot be loaded. */
export async function loadEmojiRaster(emoji: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = notoEmojiPngUrl(emoji);
  if (!url.endsWith("/512.png") || url.includes("//512.png")) return null;
  try {
    const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return await readRaster(res);
  } catch {
    return null;
  }
}

/**
 * Load a workspace picture as a data URL Satori can embed. PNG and JPEG only.
 * A miss (type, size, network, redirect) returns null so the landmark shows.
 */
export async function loadWorkspaceIconRaster(
  url: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string | null> {
  if (!isPublicWorkspaceIconUrl(url)) return null;
  try {
    const res = await fetchImpl(url, { redirect: "error", signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return await readRaster(res);
  } catch {
    return null;
  }
}

/** Host for an absolute URL, keeping a non-default port from the request when it is the same site. */
export function hostForPublicUrl(routeHost: string, headerHost: string | null): string {
  const raw = (headerHost ?? "").split(",")[0].trim();
  if (raw && normalizeHostHeader(raw) === routeHost) return raw;
  return routeHost;
}

/** Origin of the request that rendered the page, so the image URL matches the host a crawler already fetched. */
export function requestPublicOrigin(protoHeader: string | null, hostHeader: string | null): string {
  const raw = (hostHeader ?? "localhost").split(",")[0].trim() || "localhost";
  const hostname = normalizeHostHeader(raw) || "localhost";
  const forwarded = (protoHeader ?? "").split(",")[0].trim().toLowerCase();
  const proto =
    forwarded === "http" || forwarded === "https"
      ? forwarded
      : hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname.endsWith(".localhost")
        ? "http"
        : "https";
  return `${proto}://${raw}`;
}

/**
 * Customer-domain image address. `assets` is a reserved page slug, so this
 * path can never be a published page.
 */
export function siteSocialImageUrl(
  host: string,
  canonicalPath: string | null | undefined,
  proto = "https",
): string {
  const safeProto = proto === "http" ? "http" : "https";
  const pagePath = !canonicalPath || canonicalPath === "/" ? "" : canonicalPath.startsWith("/") ? canonicalPath : `/${canonicalPath}`;
  return `${safeProto}://${host}/assets/social-image${pagePath}`;
}

export function joinSocialImageUrl(origin: string, pathname: string): string {
  const base = origin.replace(/\/$/, "");
  const path = pathname.startsWith("/") ? pathname : `/${pathname}`;
  return `${base}${path}`;
}
