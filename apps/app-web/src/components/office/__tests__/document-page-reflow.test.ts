/**
 * [COMP:app-web/office-document-editor] Phone page reflow (plan decision 6.2,
 * report B row 17). The rules live in `app/globals.css`; this pins the shape
 * so the fixed Letter / A4 geometry cannot quietly come back below md and the
 * desktop / export geometry cannot quietly lose it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../../app/globals.css", import.meta.url), "utf8");
const phoneBlock = /@media \(max-width: 767px\) \{([\s\S]*?)\n\}/.exec(css.slice(css.indexOf("Phones reflow the page")))?.[1] ?? "";

describe("[COMP:app-web/office-document-editor] document page reflow below md", () => {
  it("keeps the canonical page geometry as the default rule", () => {
    expect(css).toMatch(/\.office-document-section \{[^}]*width: var\(--office-page-width, 612pt\);/);
    expect(css).toMatch(/\.office-document-stage \{[^}]*width: max-content;/);
  });
  it("reflows the stage and section to the viewport width on phones", () => {
    expect(phoneBlock).toContain(".office-document-stage { width: 100%; min-width: 0; }");
    expect(phoneBlock).toContain("width: min(var(--office-page-width, 612pt), 100%);");
    expect(phoneBlock).toContain("min-height: auto;");
    expect(phoneBlock).toContain(".office-document-body { min-height: 0; }");
    expect(phoneBlock).toContain(".office-document-prosemirror { min-width: 0; }");
  });
});
