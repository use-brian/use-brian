/**
 * [COMP:app-web/doc-shell] Mobile workspace navigation trigger styling.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  new URL("../workspace-chrome.tsx", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/doc-shell] mobile workspace menu", () => {
  it("uses the compact top-bar button treatment without a floating card", () => {
    const triggerClass = source.match(
      /data-doc-mobile-menu[\s\S]*?className="([^"]+)"/,
    )?.[1];

    expect(triggerClass).toBeDefined();
    expect(triggerClass).toContain("fixed left-2 top-2");
    expect(triggerClass).toContain("size-7");
    expect(triggerClass).toContain("hover:bg-muted");
    expect(triggerClass).toContain("focus-visible:ring-2");
    expect(triggerClass).not.toMatch(
      /\b(?:h-9|w-9|bg-background\/80|shadow|ring-1|backdrop-blur)\b/,
    );
  });
});
