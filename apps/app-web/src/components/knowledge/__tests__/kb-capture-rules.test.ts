import { describe, expect, it } from "vitest";
import { parseCapturePhrases } from "../kb-capture-rules";

describe("[COMP:app-web/kb-capture-rules] capture-rule editor", () => {
  it("parses newline and comma separated match phrases without duplicates", () => {
    expect(parseCapturePhrases("student discount\neducation offer, student discount\n"))
      .toEqual(["student discount", "education offer"]);
  });

  it("never turns an empty editor into a catch-all phrase", () => {
    expect(parseCapturePhrases("  \n, , ")).toEqual([]);
  });
});
