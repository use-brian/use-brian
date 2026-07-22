"use client";

/**
 * Platform brand glyphs — monochrome inline SVGs for the four Feed target
 * platforms, replacing the letter-initial tiles (docs/plans/feed-create-split.md
 * D11 stubs shipped with "IG / @ / X / 小" placeholders). Rules:
 *
 *   - Pure inline SVG, `currentColor` only — the surrounding tile owns the
 *     colors, so the glyphs stay theme-aware for free and render identically
 *     on the neutral (`bg-muted`) and inverted (`bg-foreground`) tiles.
 *   - Instagram is drawn geometrically (rounded square + lens + dot — the
 *     actual glyph is these three primitives). X and Threads use their
 *     canonical logo paths. XHS has no monochrome logo mark (its identity is
 *     the red wordmark app tile), so it keeps a stroke-drawn 小 — now crisp
 *     vector strokes instead of a font glyph.
 *   - Decorative: always `aria-hidden` — the adjacent row/chip label names
 *     the platform, so the glyph carries no accessible text of its own.
 *
 * [COMP:app-web/feed-platform-icon]
 */

import type { FeedPlatform } from "@/lib/feed-nav";

export function PlatformIcon({
  platform,
  className,
}: {
  platform: FeedPlatform;
  className?: string;
}) {
  switch (platform) {
    case "instagram":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          aria-hidden
          data-platform-icon="instagram"
          className={className}
        >
          <rect x="2.6" y="2.6" width="18.8" height="18.8" rx="5.2" />
          <circle cx="12" cy="12" r="4.4" />
          <circle cx="17.4" cy="6.6" r="1.3" fill="currentColor" stroke="none" />
        </svg>
      );
    case "threads":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden
          data-platform-icon="threads"
          className={className}
        >
          <path d="M12.186 24h-.007c-3.581-.024-6.334-1.205-8.184-3.509C2.35 18.44 1.5 15.586 1.472 12.01v-.017c.03-3.579.879-6.43 2.525-8.482C5.845 1.205 8.6.024 12.18 0h.014c2.746.02 5.043.725 6.826 2.098 1.677 1.29 2.858 3.13 3.509 5.467l-2.04.569c-1.104-3.96-3.898-5.984-8.304-6.015-2.91.022-5.11.936-6.54 2.717C4.307 6.504 3.616 8.914 3.589 12c.027 3.086.718 5.496 2.057 7.164 1.43 1.783 3.631 2.698 6.54 2.717 2.623-.02 4.358-.631 5.8-2.045 1.647-1.613 1.618-3.593 1.09-4.798-.31-.71-.873-1.3-1.634-1.75-.192 1.352-.622 2.446-1.284 3.272-.886 1.102-2.14 1.704-3.73 1.79-1.202.065-2.361-.218-3.259-.801-1.063-.689-1.685-1.74-1.752-2.964-.065-1.19.408-2.285 1.33-3.082.88-.76 2.119-1.207 3.583-1.291a13.853 13.853 0 0 1 3.02.142c-.126-.742-.375-1.332-.75-1.757-.513-.586-1.308-.883-2.359-.89h-.029c-.844 0-1.992.232-2.721 1.32L7.734 5.965c.98-1.454 2.568-2.256 4.478-2.256h.044c3.194.02 5.097 1.975 5.287 5.388.108.046.216.094.321.142 1.49.7 2.58 1.761 3.154 3.07.797 1.82.871 4.79-1.548 7.158-1.85 1.81-4.094 2.628-7.277 2.633ZM13.19 12.31c-.242 0-.487.007-.739.021-1.836.103-2.98.946-2.916 2.143.067 1.256 1.452 1.839 2.784 1.767 1.224-.065 2.818-.543 3.086-3.71a10.5 10.5 0 0 0-2.215-.221Z" />
        </svg>
      );
    case "twitter":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="currentColor"
          aria-hidden
          data-platform-icon="twitter"
          className={className}
        >
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231ZM17.083 19.77h1.833L7.084 4.126H5.117Z" />
        </svg>
      );
    case "xhs":
      return (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2.2}
          strokeLinecap="round"
          aria-hidden
          data-platform-icon="xhs"
          className={className}
        >
          {/* 小 — center stroke with its bottom-left hook, then the two ticks. */}
          <path d="M12 3.5v13.2c0 1.9-1.2 3-3.1 3" />
          <path d="M6.7 9.8 4.2 14.6" />
          <path d="M17.3 9.8l2.5 4.8" />
        </svg>
      );
  }
}
