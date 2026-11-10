/**
 * [COMP:app-web/doc-shell] Page body scrollbar gutter.
 *
 * The classic bar used to appear only once the page overflowed, which narrowed
 * the centered column and parked a heavy thumb on the floating recorder. The
 * page scroller reserves that gutter up front and paints a thinner, fainter
 * thumb.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const src = (rel: string) => readFileSync(resolve(process.cwd(), rel), "utf8");

describe("[COMP:app-web/doc-shell] page scrollbar gutter", () => {
  it("reserves a stable gutter and a lighter thumb on the page scroller", () => {
    const shell = src("src/components/doc/doc-shell.tsx");
    const css = src("src/app/globals.css");
    const scroller = shell.slice(
      shell.indexOf('className="doc-page-scroll'),
      shell.indexOf("doc-page-content"),
    );

    expect(scroller).toContain("overflow-y-auto");

    const rule = css.slice(css.indexOf(".doc-page-scroll {"), css.indexOf("@supports selector(::-webkit-scrollbar) {\n    .doc-page-scroll"));
    expect(rule).toContain("scrollbar-gutter: stable");
    expect(css).toContain(".doc-page-scroll {\n      scrollbar-width: auto;\n      scrollbar-color: auto;\n    }");
    expect(css).toContain(".doc-page-scroll::-webkit-scrollbar {\n      width: 8px;");
    expect(css).toMatch(/\.doc-page-scroll::-webkit-scrollbar-thumb \{\s*background-color: color-mix\(in srgb, var\(--muted-foreground\) 16%/);
  });
});
