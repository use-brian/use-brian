/**
 * [COMP:app-web/desktop-windows-chrome] Windows desktop-shell chrome.
 *
 * The Windows shell (apps/app-desktop, `titleBarOverlay`) tags <html> with
 * `is-canvas-desktop-win`. Two rules hang off it: the top row clears the
 * min/max/close overlay, and the text cursor is a colour image instead of the
 * inverting system I-beam, which Remote Desktop / VMs / screen sharing cannot
 * draw (the pointer vanished over the whole page body).
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const globalsCss = readFileSync(new URL("../../app/globals.css", import.meta.url), "utf8");
const layoutTsx = readFileSync(new URL("../../app/layout.tsx", import.meta.url), "utf8");

function textCursorRule(): string {
  const start = globalsCss.indexOf("/* Windows text cursor.");
  expect(start).toBeGreaterThan(-1);
  return globalsCss.slice(start, globalsCss.indexOf("\n}\n", start) + 3);
}

describe("[COMP:app-web/desktop-windows-chrome] Windows desktop chrome", () => {
  it("tags Windows before first paint", () => {
    expect(layoutTsx).toContain('if(d.platform==="win32")c.add("is-canvas-desktop-win")');
  });

  it("insets the top row by the live window-controls overlay geometry", () => {
    expect(globalsCss).toMatch(/\.is-canvas-desktop-win \[data-doc-topbar\]\s*{\s*padding-right: calc\(0\.5rem \+ var\(--doc-titlebar-controls\)\);/);
    expect(globalsCss).toContain("env(titlebar-area-width, 100vw)");
  });

  it("replaces the inverting I-beam on editable text with an image cursor that falls back to text", () => {
    const rule = textCursorRule();
    // Below utilities (so cursor-pointer etc. still win) and zero-specificity.
    expect(rule).toMatch(/@layer base\s*{/);
    expect(rule).toMatch(/\.is-canvas-desktop-win\s*:where\(/);
    expect(rule).toMatch(/url\("data:image\/svg\+xml,[^"]+"\)\s*8 12,\s*text;/);
    // Non-editable islands and controls inside an editor keep their own cursor.
    expect(rule).toMatch(/:where\(\[contenteditable="false"\], button, \[role="button"\], select\)\s*{\s*cursor: auto;/);
  });

  it("ships a well-formed SVG with a visible halo", () => {
    const uri = /url\("data:image\/svg\+xml,([^"]+)"\)/.exec(textCursorRule())?.[1] ?? "";
    const svg = decodeURIComponent(uri);
    expect(svg).toMatch(/^<svg xmlns='http:\/\/www\.w3\.org\/2000\/svg' width='16' height='24'/);
    expect(svg).toContain("stroke='white'");
    expect(svg).toContain("stroke='black'");
    expect(svg).not.toContain("#"); // an unescaped # would truncate the data URI
  });
});
