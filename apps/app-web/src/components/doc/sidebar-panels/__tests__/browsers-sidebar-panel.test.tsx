/**
 * [COMP:app-web/browsers-surface] Browsers operator surface — the live-session
 * list that lives in the persistent left sidebar (`BrowsersSidebarPanel`).
 *
 * Node-only vitest (no jsdom): the list renders via `renderToString` (the
 * live-pill / operator-topbar pattern). The polling wrapper isn't exercised
 * here (no effects in SSR); the contract under test is the presentational
 * list (rows link into the Take-Over view, the active row is marked, the empty
 * state shows) plus the pure `sessionIdFromPathname` route reader.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { ComputerTaskSummary } from "@/lib/api/computer";
import {
  BrowsersSessionList,
  sessionIdFromPathname,
} from "../browsers-sidebar-panel";

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

describe("[COMP:app-web/browsers-surface] Live-session sidebar panel", () => {
  it("reads the active session id off a /computer/<id> path (null at the index)", () => {
    expect(sessionIdFromPathname("/w/ws-1/computer/sess-1")).toBe("sess-1");
    expect(sessionIdFromPathname("/w/ws-1/computer")).toBeNull();
    expect(sessionIdFromPathname("/w/ws-1/p")).toBeNull();
    expect(sessionIdFromPathname(null)).toBeNull();
    // Encoded segments decode back to the raw session id for comparison.
    expect(sessionIdFromPathname("/w/ws-1/computer/a%2Fb?x=1")).toBe("a/b");
  });

  it("shows the empty state when no session is live", () => {
    const html = wrap(
      <BrowsersSessionList workspaceId="ws-1" tasks={[]} activeSessionId={null} />,
    );
    expect(html).toContain(en.computer.sessions.railTitle);
    expect(html).toContain(en.computer.sessions.railEmpty);
  });

  it("lists each live session, labelled by site with a status line", () => {
    const tasks = [
      task({ taskId: "t1", sessionId: "s1", injectedSite: "github.com" }),
      task({ taskId: "t2", sessionId: "s2", status: "paused", injectedSite: null }),
    ];
    const html = wrap(
      <BrowsersSessionList workspaceId="ws-1" tasks={tasks} activeSessionId="s1" />,
    );
    // Rows link into the Take-Over live view.
    expect(html).toContain("/w/ws-1/computer/s1");
    expect(html).toContain("/w/ws-1/computer/s2");
    // Site name (or the unnamed fallback) + status labels.
    expect(html).toContain("github.com");
    expect(html).toContain(en.computer.sessions.unnamed);
    expect(html).toContain(en.computer.sessions.statusRunning);
    expect(html).toContain(en.computer.sessions.statusPaused);
    // The active row is marked for the current selection.
    expect(html).toContain('aria-current="page"');
  });
});
