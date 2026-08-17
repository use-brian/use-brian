import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const apiKeysSource = readFileSync(
  new URL("../api-keys-tab.tsx", import.meta.url),
  "utf8",
);
const scrollableNavSource = readFileSync(
  new URL("../scrollable-nav.tsx", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/api-keys-tab] assistant API create layout", () => {
  it("uses the assistant pane at desktop widths without stretching indefinitely", () => {
    expect(apiKeysSource).toContain('className="w-full max-w-5xl space-y-5"');
    expect(apiKeysSource).toContain('className="grid gap-5 md:grid-cols-2 xl:grid-cols-3"');
    expect(apiKeysSource).not.toContain('className="space-y-4 max-w-md"');
  });

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

describe("[COMP:app-web/assistant-detail] assistant tab strip", () => {
  it("scrolls on the horizontal axis without native scrollbar chrome", () => {
    expect(scrollableNavSource).toContain("overflow-x-auto overflow-y-hidden");
    expect(scrollableNavSource).toContain("[scrollbar-width:none]");
    expect(scrollableNavSource).toContain("[&::-webkit-scrollbar]:hidden");
  });
});
