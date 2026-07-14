/**
 * [COMP:app-web/computer-live-chip] Persistent live-browser chip for chat.
 *
 * Node-only vitest (no jsdom): the view renders via `renderToString`, so
 * assertions target the SSR output — the label, the Take-Over link target,
 * and the wrapper staying empty until the task probe confirms a live task
 * (effects never run in SSR, so the wrapper must render nothing).
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  ComputerLiveChip,
  ComputerLiveChipView,
  isBrowserToolName,
} from "../computer-live-chip";

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

describe("[COMP:app-web/computer-live-chip] Live-browser chip", () => {
  it("recognizes every browser-driving tool name and nothing else", () => {
    for (const name of [
      "browserNavigate",
      "browserSnapshot",
      "browserClick",
      "browserType",
      "browserCurrentUrl",
      "browserExplore",
      "runBrowserSkill",
    ]) {
      expect(isBrowserToolName(name)).toBe(true);
    }
    for (const name of ["webSearch", "runPython", "browserless", "listBrowserSkills"]) {
      expect(isBrowserToolName(name)).toBe(false);
    }
  });

  it("links the chip into the Take-Over live view for the session", () => {
    const html = wrap(<ComputerLiveChipView workspaceId="ws-1" sessionId="sess-1" />);
    expect(html).toContain("/w/ws-1/computer/sess-1");
    // SSR escapes the apostrophe in the label — assert on a clean substring.
    expect(html).toContain("browser is running");
    expect(html).toContain(en.computer.liveChip.watch);
  });

  it("renders nothing until the task probe confirms a live task", () => {
    const html = wrap(
      <ComputerLiveChip workspaceId="ws-1" sessionId="sess-1" browserToolSeen />,
    );
    expect(html).toBe("");
  });
});
