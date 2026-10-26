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

const chatUiRoot = new URL("../../../../../../packages/chat-ui/", import.meta.url);
const chatUiPackage = JSON.parse(readFileSync(new URL("package.json", chatUiRoot), "utf8"));
const themeCss = readFileSync(new URL(chatUiPackage.exports["./theme.css"], chatUiRoot), "utf8");
const layout = readFileSync(new URL("../../../app/layout.tsx", import.meta.url), "utf8");

const globalsCss = readFileSync(
  new URL("../../../app/globals.css", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/collab-page-editor] CJK-safe code-block font", () => {
  it("falls back through the app's CJK-safe body stack before generic monospace", () => {
    expect(globalsCss).toContain('@import "@use-brian/chat-ui/theme.css";');
    expect(layout).toMatch(/import\s*{\s*JetBrains_Mono\s*}\s*from\s*"next\/font\/google"/);
    expect(layout).toMatch(/const jetbrainsMono = JetBrains_Mono\(\{[^}]*variable:\s*"--font-jetbrains-mono"/);
    expect(layout).toMatch(/<html\s[^>]*className=\{`\$\{jetbrainsMono\.variable\}/);
    expect(themeCss).toMatch(
      /--font-code:\s*var\(--font-jetbrains-mono,\s*ui-monospace\),\s*var\(--font-rocknroll\),\s*ui-monospace,\s*monospace;/,
    );
    expect(themeCss).toMatch(/--font-mono:\s*var\(--font-code\);/);
    expect(globalsCss).toMatch(
      /code, pre, kbd\s*{[^}]*font-family:\s*var\(--font-code\);/,
    );
    expect(globalsCss).toMatch(
      /\.chat-markdown code\s*{[^}]*font-family:\s*var\(--font-code\);/,
    );
  });
});
