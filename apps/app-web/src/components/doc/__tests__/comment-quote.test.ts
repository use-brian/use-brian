import { describe, it, expect } from "vitest";
import {
  composeQuotedBody,
  parseLeadingQuote,
  quoteForRow,
  placeQuoteButton,
  QUOTE_BUTTON,
} from "../comment-quote";

/**
 * [COMP:app-web/comment-quote] quote-reply text round-trip + button placement.
 *
 * A quoted reply stores the quote as a leading Markdown blockquote prefixed to
 * the body (no per-message schema). `composeQuotedBody` writes it,
 * `parseLeadingQuote` reads it back into `{ quote, body }` for the amber bar, and
 * `quoteForRow` is the renderer gate (humans parse, assistants pass through).
 */
describe("[COMP:app-web/comment-quote] composeQuotedBody", () => {
  it("prefixes a single-line quote as a `> ` blockquote above the body", () => {
    expect(composeQuotedBody("the selected text", "my reply")).toBe(
      "> the selected text\n\nmy reply",
    );
  });

  it("prefixes every line of a multi-line selection", () => {
    expect(composeQuotedBody("line one\nline two", "reply")).toBe(
      "> line one\n> line two\n\nreply",
    );
  });

  it("keeps a blank quote line as a bare `>` (round-trips a paragraph gap)", () => {
    expect(composeQuotedBody("a\n\nb", "r")).toBe("> a\n>\n> b\n\nr");
  });

  it("trims surrounding whitespace on quote and body", () => {
    expect(composeQuotedBody("  quoted  ", "  reply  ")).toBe("> quoted\n\nreply");
  });

  it("emits just the body when the quote is blank (no dangling separator)", () => {
    expect(composeQuotedBody("   ", "only body")).toBe("only body");
  });

  it("emits just the quote when there's no body", () => {
    expect(composeQuotedBody("quoted", "")).toBe("> quoted");
  });
});

describe("[COMP:app-web/comment-quote] parseLeadingQuote", () => {
  it("splits a composed body back into quote + body", () => {
    expect(parseLeadingQuote("> the selected text\n\nmy reply")).toEqual({
      quote: "the selected text",
      body: "my reply",
    });
  });

  it("round-trips a multi-line quote", () => {
    const composed = composeQuotedBody("line one\nline two", "reply");
    expect(parseLeadingQuote(composed)).toEqual({
      quote: "line one\nline two",
      body: "reply",
    });
  });

  it("returns no quote for an ordinary comment", () => {
    expect(parseLeadingQuote("just a normal comment")).toEqual({
      quote: null,
      body: "just a normal comment",
    });
  });

  it("only consumes the LEADING blockquote, not a later `>`", () => {
    expect(parseLeadingQuote("> quoted\n\nreply > with an arrow")).toEqual({
      quote: "quoted",
      body: "reply > with an arrow",
    });
  });

  it("preserves a multi-line reply body below the quote", () => {
    expect(parseLeadingQuote("> q\n\nline 1\nline 2")).toEqual({
      quote: "q",
      body: "line 1\nline 2",
    });
  });

  it("keeps a bare `>` line (quote with no reply) as raw text", () => {
    // A user typing only "> note" has no reply body — render it literally rather
    // than as an empty-bodied amber bar.
    expect(parseLeadingQuote("> note")).toEqual({ quote: null, body: "> note" });
  });

  it("does not treat `>5` (no space) as a quote", () => {
    expect(parseLeadingQuote(">5 is bigger")).toEqual({
      quote: null,
      body: ">5 is bigger",
    });
  });
});

describe("[COMP:app-web/comment-quote] quoteForRow", () => {
  it("parses a human row", () => {
    expect(quoteForRow("> q\n\nbody", false)).toEqual({ quote: "q", body: "body" });
  });

  it("never parses an assistant row (its `>` is its own Markdown blockquote)", () => {
    expect(quoteForRow("> a quote the model wrote\n\ntext", true)).toEqual({
      quote: null,
      body: "> a quote the model wrote\n\ntext",
    });
  });
});

describe("[COMP:app-web/comment-quote] placeQuoteButton", () => {
  const vw = 1000;
  const vh = 800;

  it("centers the button horizontally over the selection", () => {
    const { left } = placeQuoteButton(
      { top: 400, bottom: 416, left: 300, width: 100 },
      vw,
      vh,
    );
    // center 350 − half button width
    expect(left).toBe(350 - QUOTE_BUTTON.width / 2);
  });

  it("sits above the selection when there's room", () => {
    const { top } = placeQuoteButton(
      { top: 400, bottom: 416, left: 300, width: 100 },
      vw,
      vh,
    );
    expect(top).toBe(400 - QUOTE_BUTTON.height - 8);
  });

  it("flips below when the selection is near the top edge", () => {
    const { top } = placeQuoteButton(
      { top: 4, bottom: 20, left: 300, width: 100 },
      vw,
      vh,
    );
    expect(top).toBe(20 + 8); // bottom + gap
  });

  it("clamps the button inside the viewport horizontally", () => {
    const nearRight = placeQuoteButton(
      { top: 400, bottom: 416, left: 980, width: 40 },
      vw,
      vh,
    );
    expect(nearRight.left).toBe(vw - QUOTE_BUTTON.width - 8);

    const nearLeft = placeQuoteButton(
      { top: 400, bottom: 416, left: -20, width: 10 },
      vw,
      vh,
    );
    expect(nearLeft.left).toBe(8);
  });
});
