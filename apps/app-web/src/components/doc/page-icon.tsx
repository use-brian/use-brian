"use client";

/**
 * PageIcon — the one renderer for a page's leading icon, shared by every
 * surface that shows one (page header, sidebar rows/tree, tabs, breadcrumb,
 * chat page cards, child-page blocks, landing lists).
 *
 * A `saved_views.icon` value is either an emoji grapheme or an image token
 * `img:<workspaceId>/<fileId>` (minted by the assistant's `fetchSiteIcon`
 * tool — see `@sidanclaw/shared` `page-icon.ts`). Emoji render as the
 * historical `<span>`; image tokens render an `<img>` whose bytes load
 * through `GET /api/doc-files/:workspaceId/:fileId` — that route is
 * Bearer-auth only (no cookie), so a plain `<img src>` can't reach it:
 * we `authFetch` the bytes (following the 302 to the signed GCS URL) and
 * hand the element a blob object-URL.
 *
 * Object-URLs are cached module-level by token — a sidebar of N rows for
 * the same page must not fetch N times, and re-mounts (tab switches,
 * sidebar reloads) reuse the same blob. Never revoked: icons are tiny and
 * the set per workspace is bounded. A failed load (revoked access, deleted
 * file, other-workspace token) falls back to the derived lucide glyph —
 * same as no icon.
 *
 * Spec: docs/architecture/features/doc.md → "Image icons".
 *
 * [COMP:app-web/page-icon]
 */

import * as React from "react";
import type { LucideIcon } from "lucide-react";
import { parseImageIcon } from "@sidanclaw/shared/page-icon";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** token → resolved object-URL (or in-flight promise). Module-level. */
const iconUrlCache = new Map<string, string | Promise<string>>();

async function loadIconUrl(icon: string): Promise<string> {
  const parsed = parseImageIcon(icon);
  if (!parsed) throw new Error("not an image icon");
  const res = await authFetch(
    `${API_URL}/api/doc-files/${encodeURIComponent(parsed.workspaceId)}/${encodeURIComponent(parsed.fileId)}`,
  );
  if (!res.ok) throw new Error(`icon fetch failed: HTTP ${res.status}`);
  const blob = await res.blob();
  return URL.createObjectURL(blob);
}

/**
 * Resolve an image-icon token to a blob object-URL. Returns `null` while
 * loading and `"error"` on failure (caller falls back to the glyph).
 * Non-image icons resolve to `null` forever (callers branch on
 * `parseImageIcon` first, this is belt-and-braces).
 */
function useImageIconUrl(icon: string | null | undefined): string | null | "error" {
  const token = icon && parseImageIcon(icon) ? icon : null;
  const cached = token ? iconUrlCache.get(token) : undefined;
  const [state, setState] = React.useState<string | null | "error">(
    typeof cached === "string" ? cached : null,
  );

  React.useEffect(() => {
    if (!token) return;
    const existing = iconUrlCache.get(token);
    if (typeof existing === "string") {
      setState(existing);
      return;
    }
    let alive = true;
    const promise = existing ?? loadIconUrl(token);
    if (!existing) {
      iconUrlCache.set(token, promise);
      promise.then(
        (url) => iconUrlCache.set(token, url),
        () => iconUrlCache.delete(token),
      );
    }
    promise.then(
      (url) => alive && setState(url),
      () => alive && setState("error"),
    );
    return () => {
      alive = false;
    };
  }, [token]);

  return token ? state : null;
}

type PageIconProps = {
  /** The `saved_views.icon` value: emoji, `img:` token, or null/undefined. */
  icon: string | null | undefined;
  /** Derived lucide glyph (from `derivePageIcon`) for no-icon / load-failure. */
  fallback: LucideIcon;
  /** Classes for the emoji `<span>` (font size / line height). */
  emojiClassName?: string;
  /** Classes for the fallback lucide glyph. */
  glyphClassName?: string;
  /** Classes for the `<img>`; callers size it to match the glyph box. */
  imgClassName?: string;
};

export function PageIcon({
  icon,
  fallback: Fallback,
  emojiClassName,
  glyphClassName,
  imgClassName,
}: PageIconProps) {
  const isImage = !!(icon && parseImageIcon(icon));
  const url = useImageIconUrl(isImage ? icon : null);

  if (isImage) {
    if (url && url !== "error") {
      // Decorative: the page name always sits next to the icon.
      // eslint-disable-next-line @next/next/no-img-element
      return <img src={url} alt="" aria-hidden className={imgClassName} />;
    }
    // Loading or failed → the derived glyph keeps the slot stable.
    return <Fallback className={glyphClassName} aria-hidden />;
  }
  if (icon) {
    return (
      <span aria-hidden className={emojiClassName}>
        {icon}
      </span>
    );
  }
  return <Fallback className={glyphClassName} aria-hidden />;
}
