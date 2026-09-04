import { describe, expect, it } from "vitest";

import {
  MAX_SIRI_PROMPT_LENGTH,
  normalizeUseBrianPrompt,
  useBrianSuffix,
  useBrianWorkspacePath,
} from "../siri-use-brian";

describe("[COMP:app-web/siri-use-brian] Siri prompt handoff", () => {
  it("normalizes a bounded prompt", () => {
    expect(normalizeUseBrianPrompt("  What changed today?  ")).toBe(
      "What changed today?",
    );
    expect(
      normalizeUseBrianPrompt("x".repeat(MAX_SIRI_PROMPT_LENGTH)),
    ).toHaveLength(MAX_SIRI_PROMPT_LENGTH);
  });

  it("rejects absent, blank, and oversized prompts", () => {
    expect(normalizeUseBrianPrompt(null)).toBeNull();
    expect(normalizeUseBrianPrompt("   ")).toBeNull();
    expect(
      normalizeUseBrianPrompt("x".repeat(MAX_SIRI_PROMPT_LENGTH + 1)),
    ).toBeNull();
    expect(normalizeUseBrianPrompt(["first", "second"])).toBeNull();
  });

  it("carries only the one-shot signal through workspace routes", () => {
    expect(useBrianSuffix("1")).toBe("?useBrian=1");
    expect(useBrianSuffix("Use Brian for R&D + sales")).toBe("");
    expect(useBrianSuffix(["1", "1"])).toBe("");

    expect(useBrianWorkspacePath("workspace-1", "1")).toBe(
      "/w/workspace-1/p?useBrian=1",
    );
    expect(useBrianWorkspacePath("workspace-1", "0")).toBeNull();
  });
});
