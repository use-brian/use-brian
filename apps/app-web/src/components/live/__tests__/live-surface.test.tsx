/**
 * [COMP:app-web/live-app] / [COMP:app-web/live-watch-pane] visual structure.
 * SSR pins the roster-backed graph, reduced-motion contract, run card, and
 * wide activity rail without starting a browser stream.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { LiveSessionItem, LiveWorkflowRunItem } from "@/lib/api/live";
import { LiveOverview, LiveRunOverview } from "../live-surface";
import { LiveWatchPane } from "../live-watch-pane";
import { LiveActiveBadge } from "../live-active-badge";

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

function session(overrides: Partial<LiveSessionItem> = {}): LiveSessionItem {
  return {
    kind: "session",
    tier: "full",
    id: "session-1",
    assistantId: "assistant-1",
    assistantName: "Brian",
    ownerUserId: "user-1",
    ownerName: "Owner",
    channelType: "web",
    state: "working",
    startedAt: "2026-08-30T00:00:00.000Z",
    lastActiveAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

function run(overrides: Partial<LiveWorkflowRunItem> = {}): LiveWorkflowRunItem {
  return {
    kind: "workflow_run",
    id: "run-1",
    workflowId: "workflow-1",
    workflowName: "Daily digest",
    assistantId: null,
    assistantName: null,
    trigger: "scheduled",
    state: "waiting",
    stepSummary: "Review output",
    startedAt: "2026-08-30T00:00:00.000Z",
    lastActiveAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("[COMP:app-web/live-app] visual overview", () => {
  it("shows the active-work count with the former Inbox badge grammar", () => {
    const visible = wrap(<LiveActiveBadge count={7} label="Live, active work: 7" />);
    expect(visible).toContain('data-live-active-count="7"');
    expect(visible).toContain('aria-label="Live, active work: 7"');
    expect(visible).toContain(">7</span>");
    expect(visible).toContain("motion-safe:animate-pulse");
    expect(visible).toContain("motion-reduce:animate-none");
    expect(wrap(<LiveActiveBadge count={0} label="Active work: 0" />)).toBe("");
    expect(wrap(<LiveActiveBadge count={112} label="Active work: 112" />)).toContain(
      "99+",
    );
  });

  it("draws a roster-backed pulse graph with real state counts and reduced-motion fallbacks", () => {
    const html = wrap(
      <LiveOverview
        items={[
          session(),
          session({ id: "stalled", state: "stalled" }),
          run(),
          run({ id: "done", state: "settled" }),
        ]}
      />,
    );
    expect(html).toContain("data-live-activity-graph");
    expect(html).toContain(`${en.liveApp.stateWorking}: 1`);
    expect(html).toContain(`${en.liveApp.stateWaiting}: 1`);
    expect(html).toContain(`${en.liveApp.stateStalled}: 1`);
    expect(html).toContain(`${en.liveApp.stateSettled}: 1`);
    expect(html).toContain("motion-safe:animate-ping");
    expect(html).toContain("motion-reduce:animate-none");
  });

  it("uses the same compact visual language for a focused workflow run", () => {
    const html = wrap(<LiveRunOverview item={run()} />);
    expect(html).toContain("data-live-run-overview");
    expect(html).toContain(en.liveApp.stateWaiting);
    expect(html).toContain("Review output");
  });
});

describe("[COMP:app-web/live-watch-pane] visual structure", () => {
  it("reserves a real activity rail beside the transcript", () => {
    const html = wrap(<LiveWatchPane sessionId="session-1" />);
    expect(html).toContain("data-live-activity-rail");
    expect(html).toContain(en.liveApp.activity);
  });
});
