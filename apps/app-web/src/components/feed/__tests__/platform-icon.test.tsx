/**
 * [COMP:app-web/feed-platform-icon] Platform brand glyphs — static render
 * contract. renderToString (node env) since the component is a pure SVG
 * switch with no effects.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { FEED_PLATFORMS } from "@/lib/feed-nav";
import { PlatformIcon } from "../platform-icon";

describe("[COMP:app-web/feed-platform-icon] Platform icons", () => {
  it("renders a decorative currentColor SVG for every target platform", () => {
    for (const platform of FEED_PLATFORMS) {
      const html = renderToString(<PlatformIcon platform={platform} />);
      expect(html).toContain("<svg");
      expect(html).toContain(`data-platform-icon="${platform}"`);
      expect(html).toContain('aria-hidden="true"');
      // Theme-agnostic: the tile owns colors, the glyph only ever uses
      // currentColor (no hard-coded hex/rgb).
      expect(html).toContain("currentColor");
      expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}[^-]/);
    }
  });

  it("forwards className to the svg root (tile sizing contract)", () => {
    const html = renderToString(
      <PlatformIcon platform="twitter" className="size-3.5" />,
    );
    expect(html).toContain('class="size-3.5"');
  });
});
