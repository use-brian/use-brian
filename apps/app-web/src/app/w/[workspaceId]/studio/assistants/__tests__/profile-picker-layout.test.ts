import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../page.tsx", import.meta.url), "utf8");

describe("[COMP:app-web/studio-assistants] create-assistant profile picker", () => {
  it("keeps every profile visible without an internal scroll region", () => {
    expect(source).toContain("grid grid-cols-2 sm:grid-cols-3 gap-1.5");
    expect(source).not.toContain("max-h-48 overflow-y-auto");
  });

  it("renders the selected profile description once below the compact grid", () => {
    expect(source).toContain("data-assistant-profile-description");
    expect(source).toContain("{selectedProfileTagline}");
  });

  it("keeps profile labels on one line without letting long community titles resize a row", () => {
    expect(source).toContain("truncate whitespace-nowrap");
    expect(source).toContain("title={card.title}");
    expect(source).toContain("min-w-0 min-h-11");
  });
});
