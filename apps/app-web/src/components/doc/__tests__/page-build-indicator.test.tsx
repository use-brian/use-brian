/**
 * [COMP:app-web/page-build-indicator] Page-body "drafting" indicator +
 * the build-activity bus that feeds it.
 *
 * Node-only vitest (no jsdom): the indicator subscribes to the bus inside a
 * `useEffect`, which doesn't run under `renderToString`, so the SSR pass
 * shows the idle header — that's what we assert here. The bus itself is a
 * plain module, unit-tested directly.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PageBuildIndicator, TimelineStep } from "../page-build-indicator";
import type { ToolUsedWithOps } from "@/components/chrome/floating-chat";
import {
  publishBuildActivity,
  subscribeBuildActivity,
  type BuildActivity,
} from "@/lib/build-activity";

const step = (status: ToolUsedWithOps["status"]): ToolUsedWithOps => ({
  id: "t",
  name: "patchPage",
  status,
  description: "Updating the page",
});

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

describe("[COMP:app-web/page-build-indicator] Drafting banner", () => {
  it("renders the title, hint, and a thinking fallback while idle", () => {
    const html = wrap(<PageBuildIndicator />);
    expect(html).toContain(dict.docPage.landing.building);
    expect(html).toContain(dict.docPage.landing.buildingHint);
    expect(html).toContain(dict.docPage.landing.buildingThinking);
  });

  it("exposes a polite live region for assistive tech", () => {
    const html = wrap(<PageBuildIndicator />);
    expect(html).toMatch(/role="status"/);
    expect(html).toMatch(/aria-live="polite"/);
  });
});

describe("[COMP:app-web/page-build-indicator] Timeline step tone", () => {
  // Streaming colour semantics: the in-progress step reads in the active brand
  // colour; a finished step — done OR a failed/retried attempt — settles to the
  // muted/disabled colour. A failed attempt also strikes the label through.
  it("paints the in-progress step in the active brand colour", () => {
    const html = renderToString(<TimelineStep tool={step("running")} fallback="Working" />);
    expect(html).toContain("text-primary");
    expect(html).toContain("animate-spin");
    expect(html).not.toContain("text-muted-foreground");
    expect(html).not.toContain("line-through");
  });

  it("settles a done step to the disabled colour", () => {
    const html = renderToString(<TimelineStep tool={step("done")} fallback="Working" />);
    expect(html).toContain("text-muted-foreground");
    expect(html).not.toContain("text-primary");
    expect(html).not.toContain("line-through");
  });

  it("shows a failed/retried attempt in the disabled colour, struck through", () => {
    const html = renderToString(<TimelineStep tool={step("retried")} fallback="Working" />);
    expect(html).toContain("text-muted-foreground");
    expect(html).toContain("line-through");
    expect(html).not.toContain("text-primary");
  });
});

describe("[COMP:app-web/build-activity] Activity bus", () => {
  it("delivers the latest value to a new subscriber, then live updates", () => {
    const seen: BuildActivity[] = [];
    publishBuildActivity({ isStreaming: true, tools: [], text: "hello", reasoning: "", events: [] });
    const unsub = subscribeBuildActivity((a) => seen.push(a));
    // Immediate replay of the latest value.
    expect(seen.at(-1)).toEqual({ isStreaming: true, tools: [], text: "hello", reasoning: "", events: [] });

    publishBuildActivity({
      isStreaming: true,
      tools: [{ id: "t1", name: "patchPage", status: "running", description: "Updating the page" }],
      text: "hello world",
      reasoning: "",
      events: [],
    });
    expect(seen.at(-1)?.tools[0]?.description).toBe("Updating the page");
    expect(seen.at(-1)?.text).toBe("hello world");

    unsub();
    publishBuildActivity({ isStreaming: false, tools: [], text: "", reasoning: "", events: [] });
    // No further deliveries after unsubscribe.
    expect(seen.at(-1)?.text).toBe("hello world");
  });

  it("includes reasoning field in published activity", () => {
    const seen: BuildActivity[] = [];
    const unsub = subscribeBuildActivity((a) => seen.push(a));
    publishBuildActivity({ isStreaming: true, tools: [], text: "", reasoning: "Let me think about this…", events: [] });
    expect(seen.at(-1)?.reasoning).toBe("Let me think about this…");
    unsub();
  });

  it("publishes per-op opLines for patchPage tool entries", () => {
    const seen: BuildActivity[] = [];
    const unsub = subscribeBuildActivity((a) => seen.push(a));
    publishBuildActivity({
      isStreaming: true,
      tools: [{
        id: "t2",
        name: "patchPage",
        status: "running",
        description: "Writing content",
        // ToolUsedWithOps shape — opLines is an optional extension
        ...(({ opLines: ["Adding heading \"Overview\"", "Writing a paragraph"] } as Record<string, unknown>)),
      }],
      text: "",
      reasoning: "",
      events: [],
    });
    const tool = seen.at(-1)?.tools[0] as (typeof seen[0]["tools"][0]) & { opLines?: string[] };
    expect(tool?.opLines).toEqual(["Adding heading \"Overview\"", "Writing a paragraph"]);
    unsub();
  });
});
