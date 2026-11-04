import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const apiKeysSource = readFileSync(
  new URL("../api-keys-tab.tsx", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/api-keys-tab] assistant API create layout", () => {
  it("defaults external chat keys to the immutable research-only ceiling", () => {
    expect(apiKeysSource).toContain(
      'useState<ApiKeyToolPolicy>("public_research")',
    );
    expect(apiKeysSource).toContain(
      'audience === "external" && scope === "chat" ? toolPolicy : "assistant"',
    );
    expect(apiKeysSource).toContain(
      'audience === "external" && scope === "chat"',
    );
    expect(apiKeysSource).toContain('setToolPolicy("assistant")');
  });
});
