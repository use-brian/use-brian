import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const pageSources = [
  new URL("../signed-in/page.tsx", import.meta.url),
  new URL("../connector-connected/page.tsx", import.meta.url),
].map((path) => readFileSync(path, "utf8"));

describe("[COMP:app-web/desktop-signed-in] [COMP:app-web/desktop-connector-connected] desktop confirmation branding", () => {
  it("renders the shared mark without a frame, ring, or shadow", () => {
    for (const source of pageSources) {
      expect(source).toContain('src="/icon.png"');
      expect(source).toContain('className="mx-auto h-14 w-14"');
      expect(source).not.toMatch(/rounded-|ring-|shadow-/);
    }
  });
});
