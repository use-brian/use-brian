"use client";

/** Page icons use the viewer-scoped, expiring surface cache.
 * Spec: docs/architecture/features/doc.md → "Protected durable-media display".
 * [COMP:app-web/page-icon]
 */
import type { LucideIcon } from "lucide-react";
import { parseImageIcon } from "@use-brian/shared/page-icon";
import { useDocMediaSrc } from "@/lib/use-doc-media";

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
  const parsed = icon ? parseImageIcon(icon) : null;
  const isImage = !!parsed;
  const url = useDocMediaSrc(parsed?.workspaceId ?? null, parsed?.fileId ?? null);

  if (isImage) {
    if (url) {
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
