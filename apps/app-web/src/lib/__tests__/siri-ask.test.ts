import { describe, expect, it } from "vitest";

import {
  MAX_SIRI_PROMPT_LENGTH,
  normalizeSiriPrompt,
  siriAskSuffix,
} from "../siri-ask";

describe("[COMP:app-web/siri-ask] Siri prompt handoff", () => {
  it("normalizes a bounded prompt", () => {
    expect(normalizeSiriPrompt("  What changed today?  ")).toBe(
      "What changed today?",
    );
    expect(
      normalizeSiriPrompt("x".repeat(MAX_SIRI_PROMPT_LENGTH)),
    ).toHaveLength(MAX_SIRI_PROMPT_LENGTH);
  });

  it("rejects absent, blank, and oversized prompts", () => {
    expect(normalizeSiriPrompt(null)).toBeNull();
    expect(normalizeSiriPrompt("   ")).toBeNull();
    expect(
      normalizeSiriPrompt("x".repeat(MAX_SIRI_PROMPT_LENGTH + 1)),
    ).toBeNull();
    expect(normalizeSiriPrompt(["first", "second"])).toBeNull();
  });

  it("carries only the one-shot signal through workspace routes", () => {
    expect(siriAskSuffix("1")).toBe("?ask=1");
    expect(siriAskSuffix("Ask about R&D + sales")).toBe("");
    expect(siriAskSuffix(["1", "1"])).toBe("");
  });
});
