import { describe, expect, it } from "vitest";
import {
  docToMarkdown,
  markdownToDoc,
  SKILL_BODY_MAX_CHARS,
  SKILL_BODY_WARN_AT,
} from "../skill-markdown";

/** One parse→serialize pass. */
const roundTrip = (md: string) => docToMarkdown(markdownToDoc(md));

/** Canonical markdown must survive a round-trip unchanged — otherwise an
 *  untouched body would arm the Save button with phantom diffs. */
function expectIdentity(md: string) {
  expect(roundTrip(md)).toBe(md);
}

/** Anything must be a fixed point after ONE pass. */
function expectStable(md: string) {
  const once = roundTrip(md);
  expect(roundTrip(once)).toBe(once);
}

describe("[COMP:app-web/skill-body-editor] markdown round-trip identity (enabled blocks)", () => {
  it("the seeded 'Weekly pipeline recap' shape (heading + numbered list)", () => {
    expectIdentity(
      "# Weekly pipeline recap\n\n1. Pull the open deals\n2. Summarize stage changes\n3. Send to #sales",
    );
  });

  it("headings 1-3", () => {
    expectIdentity("# One\n\n## Two\n\n### Three");
  });

  it("paragraphs with every enabled mark", () => {
    expectIdentity(
      "Plain with **bold**, *italic*, `code`, ~~strike~~, and [a link](https://example.com).",
    );
  });

  it("bullet lists with `-` markers, including nesting", () => {
    expectIdentity("- First\n- Second\n  - Nested\n- Third");
  });

  it("ordered lists, including a non-1 start", () => {
    expectIdentity("1. a\n2. b\n3. c");
    expectIdentity("3. third\n4. fourth");
  });

  it("blockquote (single- and multi-paragraph)", () => {
    expectIdentity("> Careful with prod.");
    expectIdentity("> Careful with prod.\n>\n> Second paragraph.");
    // Lazy continuation lines are ONE paragraph in commonmark — they join
    // with a space (same as any soft-wrapped paragraph), then stay fixed.
    expectStable("> Careful with prod.\n> Two lines.");
  });

  it("fenced code block with a language", () => {
    expectIdentity("```js\nconst x = 1;\n```");
  });

  it("code block containing triple backticks picks a longer fence", () => {
    const md = "````\nuse ``` to fence\n````";
    expectIdentity(md);
  });

  it("horizontal rule + hard break", () => {
    expectIdentity("Above\n\n---\n\nBelow");
    expectIdentity("line one\\\nline two");
  });

  it("empty body", () => {
    expectIdentity("");
  });

  it("a full mixed body", () => {
    expectIdentity(
      "## Steps\n\n- First *thing*\n- Second **thing** with `code`\n- ~~dropped~~\n\n> Note: be careful.\n\n```js\nconst x = 1;\n```\n\n---\n\nDone. See [docs](https://example.com).",
    );
  });
});

describe("[COMP:app-web/skill-body-editor] unknown-md fallback (preserved, one-pass stable)", () => {
  it("tables flatten to literal paragraph text (commonmark has no table rule)", () => {
    const md = "| a | b |\n|---|---|\n| 1 | 2 |";
    const once = roundTrip(md);
    // Content preserved as text (soft breaks join with spaces)...
    expect(once).toBe("| a | b | |---|---| | 1 | 2 |");
    // ...and stable from then on.
    expectStable(md);
  });

  it("images survive as a literal bang + clickable link", () => {
    const md = "![alt](https://x.test/i.png)";
    const once = roundTrip(md);
    expect(once).toBe("\\![alt](https://x.test/i.png)");
    expectStable(md);
  });

  it("raw html is kept as literal text", () => {
    const md = "Text <b>html</b> here.";
    expect(roundTrip(md)).toContain("<b>html</b>");
    expectStable(md);
  });

  it("task syntax round-trips as a plain bullet with escaped brackets", () => {
    // Task list is intentionally NOT enabled (no markdown-it plugin).
    const md = "- [ ] call them\n- [x] done";
    expectStable(md);
    expect(roundTrip(md)).toContain("call them");
  });

  it("non-canonical md normalizes once then stays fixed", () => {
    expectStable("Setext\n======");
    expectStable("* star bullets\n* two");
    expectStable("1) paren list");
  });

  it("h4+ clamps to heading level 3", () => {
    expect(roundTrip("#### Deep")).toBe("### Deep");
  });
});

describe("[COMP:app-web/skill-body-editor] limits", () => {
  it("exports the shared char budget (mirrors the API cap)", () => {
    expect(SKILL_BODY_MAX_CHARS).toBe(5000);
    expect(SKILL_BODY_WARN_AT).toBeLessThan(SKILL_BODY_MAX_CHARS);
  });
});
