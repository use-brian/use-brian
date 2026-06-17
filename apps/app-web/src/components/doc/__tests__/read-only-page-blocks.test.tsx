// @vitest-environment jsdom
/**
 * [COMP:app-web/share-dialog] Read-only public renderer — simple-table block +
 * block-id comment anchoring.
 *
 * The anonymous share route renders a table block as a static `<table>` (no
 * editor, no Yjs). Header row/column map to `<th>`; everything else `<td>`.
 * Mentions are scrubbed server-side (`neutralizeBlocksForPublic`), so the
 * renderer only ever sees plain text in cells — asserted here via SSR.
 *
 * It also rebuilds a comment's in-doc highlight + rail anchor from the thread's
 * `anchorBlockId` for `heading`/`text` blocks (whose inline `comment` mark is
 * lost when they serialize to a flat `text` string) and for commented atoms —
 * asserted here via SSR + the pure `commentAnchorsByBlock` helper.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { ReadOnlyPageBlocks, commentAnchorsByBlock } from "../read-only-page-blocks";
import type { PublicBlock, PublicComment, PublicSource } from "@/lib/api/public-share";
import type { ViewPayload } from "@sidanclaw/views-renderer";

const cell = (text: string) => ({
  type: "doc",
  content: [{ type: "paragraph", content: [{ type: "text", text }] }],
});

const source: PublicSource = { kind: "link", token: "tok" };
const emptyPayload = { a2ui: "0.8", root: { type: "container", children: [] } } as unknown as ViewPayload;

const comment = (threadId: string, anchorBlockId: string | null): PublicComment => ({
  threadId,
  anchorBlockId,
  quote: null,
  messages: [{ author: "Ana", avatar: null, body: "hi", createdAt: "2026-06-11T00:00:00Z" }],
});

describe("[COMP:app-web/share-dialog] ReadOnlyPageBlocks table", () => {
  it("renders a <table> with header cells from the header flags", () => {
    const blocks: PublicBlock[] = [
      {
        kind: "table",
        id: "tb",
        hasHeaderRow: true,
        rows: [
          [cell("Name"), cell("Role")],
          [cell("Ana"), cell("Eng")],
        ],
      },
    ];
    const html = renderToString(
      <ReadOnlyPageBlocks blocks={blocks} payload={emptyPayload} source={source} />,
    );
    expect(html).toContain("<table");
    // Header row → <th>; body row → <td>.
    expect(html).toContain("<th");
    expect(html).toContain("<td");
    // Cell text (already scrubbed server-side) renders.
    expect(html).toContain("Name");
    expect(html).toContain("Ana");
  });

  it("renders nothing for a table with no rows", () => {
    const blocks: PublicBlock[] = [{ kind: "table", id: "tb", rows: [] }];
    const html = renderToString(
      <ReadOnlyPageBlocks blocks={blocks} payload={emptyPayload} source={source} />,
    );
    expect(html).not.toContain("<table");
  });
});

describe("[COMP:app-web/share-dialog] ReadOnlyPageBlocks toggle body", () => {
  it("wraps nested blocks in .doc-toggle-body with real heading/paragraph tags", () => {
    // The toggle body's vertical rhythm (heading gap + inter-block spacing) is
    // CSS-driven off `.doc-public-body .doc-toggle-body > …` — so the renderer
    // must keep emitting that wrapper AND real semantic tags inside it, or
    // nested blocks collapse together (the "not respecting page block styling"
    // bug). This guards the structural contract that the spacing rule keys on.
    const blocks: PublicBlock[] = [
      {
        kind: "toggle",
        id: "tg",
        expanded: true,
        richText: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Summary line" }] },
            { type: "heading", attrs: { level: 3 }, content: [{ type: "text", text: "Nested Heading" }] },
            { type: "paragraph", content: [{ type: "text", text: "Body paragraph" }] },
          ],
        },
      } as unknown as PublicBlock,
    ];
    const html = renderToString(
      <ReadOnlyPageBlocks blocks={blocks} payload={emptyPayload} source={source} />,
    );
    expect(html).toContain('class="doc-toggle-body"');
    // Nested heading is a real <h3> (so the heading margin rule applies), inside
    // the body wrapper — not flattened to body text.
    const body = html.slice(html.indexOf('class="doc-toggle-body"'));
    expect(body).toContain("<h3");
    expect(body).toContain("Nested Heading");
    expect(body).toContain("Body paragraph");
    // The summary line stays in <summary>, above the body wrapper.
    expect(html.indexOf("Summary line")).toBeLessThan(html.indexOf('class="doc-toggle-body"'));
  });

  it("renders the toggle collapsed even when authored expanded", () => {
    // A shared page reads scannable: every toggle starts collapsed regardless of
    // the authored `expanded`/`open` state, so the <details> must carry no `open`
    // attribute (the native element stays togglable, so a viewer can expand it).
    const blocks: PublicBlock[] = [
      {
        kind: "toggle",
        id: "tg",
        expanded: true,
        richText: {
          type: "doc",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "Summary line" }] },
            { type: "paragraph", content: [{ type: "text", text: "Body paragraph" }] },
          ],
        },
      } as unknown as PublicBlock,
    ];
    const html = renderToString(
      <ReadOnlyPageBlocks blocks={blocks} payload={emptyPayload} source={source} />,
    );
    expect(html).toContain("<details");
    // No `open` attribute on the <details> tag → collapsed by default.
    expect(html).not.toMatch(/<details[^>]*\bopen\b/);
  });
});

describe("[COMP:app-web/share-dialog] commentAnchorsByBlock", () => {
  it("maps anchorBlockId → threadId and skips unanchored threads", () => {
    const map = commentAnchorsByBlock([
      comment("t1", "b1"),
      comment("t2", null), // page-level / unanchored → no entry
      comment("t3", "b2"),
    ]);
    expect(map.get("b1")).toBe("t1");
    expect(map.get("b2")).toBe("t3");
    expect(map.size).toBe(2);
  });

  it("keeps the first thread when several anchor the same block", () => {
    const map = commentAnchorsByBlock([comment("first", "b1"), comment("second", "b1")]);
    expect(map.get("b1")).toBe("first");
  });
});

describe("[COMP:app-web/share-dialog] ReadOnlyPageBlocks comment highlights", () => {
  it("rebuilds the inline swatch + rail anchor on a commented heading", () => {
    // The heading's `comment` mark is dropped when it serializes to a flat
    // `text` string, so the highlight is rebuilt from the thread's anchorBlockId.
    const blocks: PublicBlock[] = [{ kind: "heading", id: "h1", level: 2, text: "Sources" }];
    const html = renderToString(
      <ReadOnlyPageBlocks
        blocks={blocks}
        payload={emptyPayload}
        source={source}
        comments={[comment("th-1", "h1")]}
      />,
    );
    // Inline swatch over the heading text, tagged for the rail + linked hover.
    expect(html).toContain('data-comment-thread="th-1"');
    expect(html).toContain('data-thread-id="th-1"');
    expect(html).toContain("doc-comment-hl");
    expect(html).toContain("Sources");
  });

  it("rebuilds the inline swatch on a commented paragraph", () => {
    const blocks: PublicBlock[] = [{ kind: "text", id: "p1", text: "A claim." }];
    const html = renderToString(
      <ReadOnlyPageBlocks
        blocks={blocks}
        payload={emptyPayload}
        source={source}
        comments={[comment("th-2", "p1")]}
      />,
    );
    expect(html).toContain('data-comment-thread="th-2"');
    expect(html).toContain("doc-comment-hl");
  });

  it("does not tag a heading with no anchored thread", () => {
    const blocks: PublicBlock[] = [{ kind: "heading", id: "h1", level: 2, text: "Sources" }];
    const html = renderToString(
      <ReadOnlyPageBlocks blocks={blocks} payload={emptyPayload} source={source} comments={[]} />,
    );
    expect(html).not.toContain("data-comment-thread");
    expect(html).not.toContain("doc-comment-hl");
  });

  it("gives a commented atom block a whole-block tint wrapper", () => {
    // An atom (bookmark here) has no inline text to mark → whole-block tint,
    // mirroring the editor's `doc-comment-block-hl`.
    const blocks: PublicBlock[] = [
      { kind: "bookmark", id: "bm1", url: "https://example.com", meta: { title: "Example" } },
    ];
    const html = renderToString(
      <ReadOnlyPageBlocks
        blocks={blocks}
        payload={emptyPayload}
        source={source}
        comments={[comment("th-3", "bm1")]}
      />,
    );
    expect(html).toContain("doc-comment-block-hl");
    expect(html).toContain('data-comment-thread="th-3"');
  });
});
