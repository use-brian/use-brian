/**
 * [COMP:app-web/computer-live-pill] Workspace-global live-browser pill.
 *
 * Node-only vitest (no jsdom): the view renders via `renderToString`. The
 * pill is the discovery surface for browser tasks started ANYWHERE (Telegram,
 * workflows, goals) — it must link into the Take-Over live view, and render
 * nothing at all when no task is live.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { ComputerTaskSummary } from "@/lib/api/computer";
import { ComputerLivePillView } from "../computer-live-pill";

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

function task(overrides: Partial<ComputerTaskSummary>): ComputerTaskSummary {
  return {
    taskId: "task-1",
    sessionId: "sess-1",
    status: "running",
    profileId: null,
    injectedSite: null,
    createdAt: 1,
    lastActivityAt: 1,
    ...overrides,
  };
}

describe("[COMP:app-web/computer-live-pill] Live-browser pill", () => {
  it("renders nothing with no live tasks", () => {
    expect(wrap(<ComputerLivePillView workspaceId="ws-1" tasks={[]} />)).toBe("");
  });

  it("links a single task straight into its Take-Over live view", () => {
    const html = wrap(<ComputerLivePillView workspaceId="ws-1" tasks={[task({})]} />);
    expect(html).toContain("/w/ws-1/computer/sess-1");
    expect(html).toContain(en.computer.livePill.active);
    expect(html).toContain(en.computer.livePill.watch);
  });

  it("shows a count for multiple tasks and defers links to the expanded list", () => {
    const tasks = [
      task({ taskId: "t1", sessionId: "s1" }),
      task({ taskId: "t2", sessionId: "s2" }),
    ];
    const html = wrap(<ComputerLivePillView workspaceId="ws-1" tasks={tasks} />);
    expect(html).toContain("2");
    expect(html).toContain(en.computer.livePill.active);
    // Collapsed: a toggle button, no direct task links yet.
    expect(html).not.toContain("/w/ws-1/computer/");
  });
});
