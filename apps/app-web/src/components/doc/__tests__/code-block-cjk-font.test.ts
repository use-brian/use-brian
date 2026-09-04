/**
 * [COMP:app-web/collab-page-editor] CJK-safe code-block typography.
 *
 * Code blocks keep JetBrains Mono for supported code glyphs, but the font has
 * no CJK coverage. The explicit app body stack must precede generic monospace:
 * on some desktop font setups a bare generic fallback displays intact Chinese
 * text through the wrong glyph map, making a paste look encoded.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(
  new URL("../../../app/globals.css", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/collab-page-editor] CJK-safe code-block font", () => {
  it("falls back through the app's CJK-safe body stack before generic monospace", () => {
    expect(globalsCss).toMatch(
      /--font-code:\s*var\(--font-jetbrains-mono\),\s*var\(--font-rocknroll\),\s*ui-monospace,\s*monospace;/,
    );
    expect(globalsCss).toMatch(/--font-mono:\s*var\(--font-code\);/);
    expect(globalsCss).toMatch(
      /code, pre, kbd\s*{[^}]*font-family:\s*var\(--font-code\);/,
    );
    expect(globalsCss).toMatch(
      /\.chat-markdown code\s*{[^}]*font-family:\s*var\(--font-code\);/,
    );
  });
});
