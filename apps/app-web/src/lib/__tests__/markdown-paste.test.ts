/**
 * [COMP:app-web/markdown-paste] In-editor Markdown paste (journey E).
 * Spec: docs/architecture/features/doc-conversion.md.
 */

import { describe, it, expect } from "vitest";
import { looksLikeBlockMarkdown, markdownPasteToPMDoc } from "../markdown-paste";

describe("[COMP:app-web/markdown-paste] looksLikeBlockMarkdown", () => {
  it("is false for a single inline line (let default paste run)", () => {
    expect(looksLikeBlockMarkdown("just some text")).toBe(false);
    expect(looksLikeBlockMarkdown("a word")).toBe(false);
  });

  it("is true for headings / lists / fences / quotes / tables", () => {
    expect(looksLikeBlockMarkdown("# Title\nbody")).toBe(true);
    expect(looksLikeBlockMarkdown("- one\n- two")).toBe(true);
    expect(looksLikeBlockMarkdown("1. a\n2. b")).toBe(true);
    expect(looksLikeBlockMarkdown("> quote\n> more")).toBe(true);
    expect(looksLikeBlockMarkdown("```\ncode\n```")).toBe(true);
    expect(looksLikeBlockMarkdown("| a | b |\n| - | - |")).toBe(true);
  });

  it("is true for a blank-line paragraph split", () => {
    expect(looksLikeBlockMarkdown("para one\n\npara two")).toBe(true);
  });

  it("is false for a multi-line soft wrap with no block markers", () => {
    expect(looksLikeBlockMarkdown("line one\nline two")).toBe(false);
  });
});

describe("[COMP:app-web/markdown-paste] markdownPasteToPMDoc", () => {
  it("returns null for inline text (default paste handles it)", () => {
    expect(markdownPasteToPMDoc("just a word")).toBeNull();
  });

  it("converts block Markdown to a ProseMirror doc JSON", () => {
    const pm = markdownPasteToPMDoc("# Heading\n\nBody paragraph.\n\n- one\n- two");
    expect(pm).not.toBeNull();
    expect(pm!.type).toBe("doc");
    expect(Array.isArray(pm!.content)).toBe(true);
    const types = pm!.content.map((n) => n.type);
    expect(types).toContain("heading");
    expect(types).toContain("paragraph");
    expect(types).toContain("bulletList");
  });

  it("maps a GFM table to a table node", () => {
    const pm = markdownPasteToPMDoc("| Name | Age |\n| --- | --- |\n| Al | 30 |");
    expect(pm).not.toBeNull();
    expect(pm!.content.some((n) => n.type === "table")).toBe(true);
  });

  it("every node carries a blockId attr (the editor schema requires it)", () => {
    const pm = markdownPasteToPMDoc("# H\n\nbody");
    expect(pm!.content.every((n) => typeof n.attrs?.blockId === "string")).toBe(true);
  });
});
