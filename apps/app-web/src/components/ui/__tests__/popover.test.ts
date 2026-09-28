/**
 * [COMP:app-web/popover] Popover clamp (responsive contract M5).
 *
 * A popover is a primary container on a phone (the workspace switcher is the
 * admin menu), so it must never be wider than the viewport and never taller
 * than what fits - the 320px switcher menu clipped "Add another account" and
 * "Log out" in 375px-tall landscape with no way to scroll. The clamp lives on
 * the PRIMITIVE so every consumer inherits it; the switcher additionally caps
 * its own width. Graded repo-wide by `invariants/popover-width-clamp`; this
 * pins the primitive itself.
 */

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const popover = readFileSync(new URL("../popover.tsx", import.meta.url), "utf8");
const switcher = readFileSync(
  new URL("../../workspace-switcher.tsx", import.meta.url),
  "utf8",
);

describe("[COMP:app-web/popover] PopoverContent clamps to the phone viewport", () => {
  it("carries the width and height clamps and scrolls its overflow", () => {
    const cls = /className=\{cn\(\s*(?:\/\/[^\n]*\n\s*)*"([^"]+)"/.exec(popover)?.[1] ?? "";
    expect(cls).toContain("max-w-[calc(var(--native-app-width,100vw)-1rem)]");
    expect(cls).toContain("max-h-[min(80dvh,var(--available-height))]");
    expect(cls).toContain("overflow-y-auto");
  });

  it("the workspace switcher never asks for more than the viewport", () => {
    expect(switcher).toContain('className="w-[min(20rem,calc(100vw-1rem))] gap-3 p-3"');
    expect(switcher).not.toContain('className="w-80 gap-3 p-3"');
  });
});
