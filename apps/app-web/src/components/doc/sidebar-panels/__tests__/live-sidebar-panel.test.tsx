/**
 * [COMP:app-web/live-app] Live's persistent-sidebar roster. The effectful
 * loader is outside this render seam; SSR pins the section hierarchy, Inbox
 * nesting, URL focus, active row, and presence-row negative affordance.
 */

import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { LiveSessionItem, LiveWorkflowRunItem } from "@/lib/api/live";
import { LiveRosterList } from "../live-sidebar-panel";

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
    assistantIconSeed: 42,
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
    state: "settled",
    startedAt: "2026-08-30T00:00:00.000Z",
    lastActiveAt: "2026-08-30T00:00:00.000Z",
    ...overrides,
  };
}

describe("[COMP:app-web/live-app] Live sidebar panel", () => {
  it("leads with Overview, then Inbox and the two roster sections", () => {
    const html = wrap(
      <LiveRosterList
        workspaceId="ws-1"
        items={[]}
        loaded
        error={false}
        activeFocus={null}
        inboxOpen={false}
        inboxCount={4}
        onToggleInbox={vi.fn()}
      />,
    );
    expect(html.indexOf(en.liveApp.overview)).toBeLessThan(
      html.indexOf(en.docPage.iconInbox),
    );
    expect(html.indexOf(en.docPage.iconInbox)).toBeLessThan(
      html.indexOf(en.liveApp.workingNow),
    );
    expect(html.indexOf(en.liveApp.workingNow)).toBeLessThan(
      html.indexOf(en.liveApp.justFinished),
    );
    expect(html).toContain("4");
    expect(html).toContain('href="/w/ws-1/live"');
    expect(html).toContain('aria-current="page"');
    expect(html).toContain(en.liveApp.emptyWorking);
    expect(html).toContain(en.liveApp.emptyFinished);
  });

  it("keeps shared suggestions above workspace navigation and the Live-local body", () => {
    const source = readFileSync(new URL("../../doc-sidebar.tsx", import.meta.url), "utf8");
    const dock = source.indexOf("<HomeDock workspaceId={workspaceId} />");
    const contextNav = source.indexOf("data-workspace-context-nav");
    const body = source.indexOf('className="doc-sidebar-scroll');
    const live = source.indexOf("<LiveSidebarPanel");
    for (const position of [dock, contextNav, body, live]) {
      expect(position).toBeGreaterThanOrEqual(0);
    }
    expect(source.match(/<HomeDock\b/g)).toHaveLength(1);
    expect(dock).toBeLessThan(contextNav);
    expect(contextNav).toBeLessThan(body);
    expect(body).toBeLessThan(live);
  });

  it("links watchable rows through the focus query and marks the active one", () => {
    const html = wrap(
      <LiveRosterList
        workspaceId="ws-1"
        items={[session(), run()]}
        loaded
        error={false}
        activeFocus="session:session-1"
        inboxOpen={false}
        inboxCount={0}
        onToggleInbox={vi.fn()}
      />,
    );
    expect(html).toContain('aria-current="page"');
    expect(html).toContain('href="/w/ws-1/live"');
    expect(html).toContain("/w/ws-1/live?focus=workflow_run%3Arun-1");
    expect(html).toContain("Daily digest");
    expect(html).toContain('aria-label="Brian"');
  });

  it("shows presence without an open affordance", () => {
    const html = wrap(
      <LiveRosterList
        workspaceId="ws-1"
        items={[session({ id: "private-1", tier: "presence", title: undefined })]}
        loaded
        error={false}
        activeFocus={null}
        inboxOpen={false}
        inboxCount={0}
        onToggleInbox={vi.fn()}
      />,
    );
    expect(html).toContain('aria-disabled="true"');
    expect(html).not.toContain("focus=session%3Aprivate-1");
    expect(html).toContain(en.liveApp.presenceHint);
  });
});
