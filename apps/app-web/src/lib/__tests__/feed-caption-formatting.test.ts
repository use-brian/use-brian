/**
 * [COMP:app-web/caption-editor] Portable toolbar transforms.
 */

import { describe, expect, it } from "vitest";
import { applyCaptionFormatting } from "@/components/feed/caption-editor";

describe("[COMP:app-web/caption-editor] formatting toolbar", () => {
  it("wraps a selection with bold and keeps the selection inside the markers", () => {
    expect(applyCaptionFormatting("Make this clear", 5, 9, "bold")).toEqual({
      text: "Make **this** clear",
      selectionStart: 7,
      selectionEnd: 11,
    });
  });

  it("places the caret between italic markers when nothing is selected", () => {
    expect(applyCaptionFormatting("Start here", 6, 6, "italic")).toEqual({
      text: "Start **here",
      selectionStart: 7,
      selectionEnd: 7,
    });
  });

  it("applies and toggles a bulleted list across selected lines", () => {
    const applied = applyCaptionFormatting("Alpha\nBeta", 0, 10, "bullet");
    expect(applied.text).toBe("- Alpha\n- Beta");
    expect(applyCaptionFormatting(
      applied.text,
      applied.selectionStart,
      applied.selectionEnd,
      "bullet",
    ).text).toBe("Alpha\nBeta");
  });

  it("replaces an existing list prefix when switching to numbering", () => {
    expect(applyCaptionFormatting("- Alpha\n- Beta", 0, 14, "numbered").text)
      .toBe("1. Alpha\n2. Beta");
  });
});
