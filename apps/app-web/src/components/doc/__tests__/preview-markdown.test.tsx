/**
 * [COMP:app-web/preview-markdown] Inline-only markdown for preview rows.
 *
 * app-web vitest is node-only, so we render to static markup and assert on
 * the emitted HTML. The contract: inline marks render formatted (no raw `**`),
 * and NO block-level node (`<p>`, `<ul>`, `<h1>`, `<a>`) leaks out to break the
 * parent `truncate` / `line-clamp` clamp.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { PreviewMarkdown } from "../preview-markdown";

describe("[COMP:app-web/preview-markdown] PreviewMarkdown", () => {
  it("renders bold inline instead of literal asterisks", () => {
    const html = renderToStaticMarkup(
      <PreviewMarkdown text={'updated **"AI Trading Research Overview"** (version 5)'} />,
    );
    expect(html).toContain("<strong>");
    // (React escapes the quotes in text, so match the inner words.)
    expect(html).toContain("AI Trading Research Overview");
    // The raw markdown markers must not survive to the DOM.
    expect(html).not.toContain("**");
  });

  it("emits no block-level wrapper that would break a clamp", () => {
    const html = renderToStaticMarkup(
      <PreviewMarkdown text={"# A heading line\n\nwith a paragraph"} />,
    );
    expect(html).not.toMatch(/<p[ >]/);
    expect(html).not.toMatch(/<h[1-6][ >]/);
    // Heading marker is consumed by the parser, not shown.
    expect(html).not.toContain("#");
    expect(html).toContain("A heading line");
  });

  it("renders a markdown link as a non-interactive span, never a nested <a>", () => {
    const html = renderToStaticMarkup(
      <PreviewMarkdown text={"see [the report](https://example.com) now"} />,
    );
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("href=");
    expect(html).toContain("the report");
  });

  it("flattens a bullet list to inline text with no <ul>/<li>", () => {
    const html = renderToStaticMarkup(
      <PreviewMarkdown text={"- first\n- second"} />,
    );
    expect(html).not.toContain("<ul");
    expect(html).not.toContain("<li");
    expect(html).toContain("first");
    expect(html).toContain("second");
  });
});
