import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("../events/event-page-editor.tsx", import.meta.url), "utf8");

describe("[COMP:app-web/association] F04 event editor interaction chrome", () => {
  it("keeps dragged and selected section feedback neutral", () => {
    // Source guard for the transient DnD state; jsdom cannot verify drag paint.
    expect(source).toContain('isDragging ? "z-10 border-interaction/60 bg-interaction/5 shadow-lg"');
    expect(source).toContain('selected ? "border-interaction/60 bg-interaction/5 ring-1 ring-interaction/20"');
    expect(source).toContain('focus.target !== "section" ? "border-interaction/60 bg-interaction/5 ring-1 ring-interaction/20"');
    expect(source).not.toMatch(/(?:border|ring)-primary/);
  });

  it("retains the website placement illustration and preview's authored rendering boundary", () => {
    expect(source).toContain("bg-primary/15");
    expect(source).toContain("bg-primary/30");
    expect(source).toContain('src={`${url.replace(/\\/$/, "")}/preview/event/`}');
    expect(source).toContain('frame.current?.contentWindow?.postMessage({ type: PREVIEW_MESSAGE, ...(payload as object) }, origin)');
  });
});
