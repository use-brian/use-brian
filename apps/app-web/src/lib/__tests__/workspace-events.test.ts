/**
 * Pure-core tests for the workspace realtime events client.
 * [COMP:app-web/workspace-events]
 *
 * `routeWorkspaceChange` (primitive → domain CustomEvent) and
 * `createRefreshFolder` (leading+trailing fold) are IO-free by design —
 * mirroring `build-events.ts` — so the node-only vitest can pin them
 * without a DOM or an EventSource.
 */

import { describe, expect, it, vi } from "vitest";

import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";
import { APPROVALS_REFRESH_EVENT } from "@/lib/approvals-events";
import { WORKFLOW_REFRESH_EVENT } from "@/lib/workflow-events";
import { HOME_APPS_REFRESH_EVENT } from "@/lib/home-apps-events";
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from "@/lib/workspace-identity-events";
import { INBOX_REFRESH_EVENT } from "@/lib/inbox-refresh-events";
import {
  allDomainDispatches,
  createRefreshFolder,
  createVisibilityGate,
  LIVE_REFRESH_EVENT,
  reconnectDelayMs,
  routeWorkspaceChange,
  SCHEDULED_JOB_REFRESH_EVENT,
  SKILL_REFRESH_EVENT,
  type DomainDispatch,
  type WorkspaceChangePayload,
} from "@/lib/workspace-events";

function payload(
  primitive: WorkspaceChangePayload["primitive"],
  overrides?: Partial<WorkspaceChangePayload>,
): WorkspaceChangePayload {
  return { workspaceId: "ws-1", primitive, action: "update", ...overrides };
}

describe("[COMP:app-web/workspace-events] routeWorkspaceChange", () => {
  it("routes every brain primitive to BRAIN_REFRESH_EVENT with the workspace id", () => {
    const brain = [
      "memory",
      "task",
      "contact",
      "company",
      "deal",
      "file",
      "entity",
      "edge",
      "kb_chunk",
    ] as const;
    for (const primitive of brain) {
      expect(routeWorkspaceChange(payload(primitive))).toEqual([
        { event: BRAIN_REFRESH_EVENT, detail: { workspaceId: "ws-1" } },
      ]);
    }
  });

  it("routes workflow and workflow_run to the workflow bus with primitive + rowId", () => {
    expect(
      routeWorkspaceChange(payload("workflow", { rowId: "wf-1", action: "create" })),
    ).toEqual([
      {
        event: WORKFLOW_REFRESH_EVENT,
        detail: { workspaceId: "ws-1", primitive: "workflow", rowId: "wf-1" },
      },
    ]);
    expect(routeWorkspaceChange(payload("workflow_run", { rowId: "run-9" }))).toEqual([
      {
        event: WORKFLOW_REFRESH_EVENT,
        detail: { workspaceId: "ws-1", primitive: "workflow_run", rowId: "run-9" },
      },
    ]);
  });

  it("routes approval / skill / scheduled_job to their domain events", () => {
    expect(routeWorkspaceChange(payload("approval"))[0].event).toBe(
      APPROVALS_REFRESH_EVENT,
    );
    expect(routeWorkspaceChange(payload("skill", { rowId: "sk-1" }))[0]).toEqual({
      event: SKILL_REFRESH_EVENT,
      detail: { workspaceId: "ws-1", rowId: "sk-1" },
    });
    expect(routeWorkspaceChange(payload("scheduled_job"))[0].event).toBe(
      SCHEDULED_JOB_REFRESH_EVENT,
    );
  });

  // Regression: creating an assistant left every persistent surface stale —
  // the FloatingChat dock's switcher only re-reads on `[workspaceId]`, which
  // never changes during SPA navigation, so a new assistant stayed invisible
  // until a full app restart.
  it("routes assistant changes to the assistant bus with rowId", () => {
    expect(
      routeWorkspaceChange(payload("assistant", { rowId: "a-1", action: "create" })),
    ).toEqual([
      {
        event: "sidan:assistant-refresh",
        detail: { workspaceId: "ws-1", rowId: "a-1" },
      },
    ]);
  });

  // Same class of bug as the assistant roster: the Home app-bar renders inside
  // the never-unmounting workspace layout, so a config change has to arrive as
  // a signal or the strip stays stale until a full reload.
  it("routes workspace_config to the home-app and workspace-identity buses", () => {
    expect(routeWorkspaceChange(payload("workspace_config"))).toEqual([
      { event: HOME_APPS_REFRESH_EVENT, detail: { workspaceId: "ws-1" } },
      {
        event: WORKSPACE_IDENTITY_REFRESH_EVENT,
        detail: { workspaceId: "ws-1" },
      },
    ]);
  });

  // Regression-shaped like the assistant/workspace_config cases: InboxPanel +
  // the sidebar unread badge (doc-sidebar.tsx) are both mounted by the
  // never-unmounting workspace layout, so a room `@mention` recorded while
  // the recipient is elsewhere needs a signal, not a mount effect.
  it("routes inbox changes to the inbox-refresh bus (T-H8)", () => {
    expect(routeWorkspaceChange(payload("inbox"))).toEqual([
      { event: INBOX_REFRESH_EVENT, detail: { workspaceId: "ws-1" } },
    ]);
  });

  // Live roster liveness (live-work.md §4): a session's turn lifecycle
  // change rides the spine as a signal; the Live page refetches its tiered
  // roster, so the payload can never leak content past a tier.
  it("routes session changes to the live-refresh bus with rowId", () => {
    expect(routeWorkspaceChange(payload("session", { rowId: "s-1" }))).toEqual([
      {
        event: LIVE_REFRESH_EVENT,
        detail: { workspaceId: "ws-1", rowId: "s-1" },
      },
    ]);
  });

  it("ignores unknown primitives — a newer server must never break an older client", () => {
    expect(
      routeWorkspaceChange(
        payload("page" as WorkspaceChangePayload["primitive"]),
      ),
    ).toEqual([]);
  });

  it("catch-up covers every domain event exactly once", () => {
    const events = allDomainDispatches("ws-1").map((d) => d.event);
    expect(new Set(events).size).toBe(events.length);
    expect(events).toContain(BRAIN_REFRESH_EVENT);
    expect(events).toContain(APPROVALS_REFRESH_EVENT);
    expect(events).toContain(WORKFLOW_REFRESH_EVENT);
    expect(events).toContain(SKILL_REFRESH_EVENT);
    expect(events).toContain(SCHEDULED_JOB_REFRESH_EVENT);
    // Catch-up must cover the roster too: a create that lands while the tab is
    // asleep or the stream is down still has to reach the never-unmounting
    // chrome on reconnect.
    expect(events).toContain("sidan:assistant-refresh");
    // ...and the app-bar config, for the same reason.
    expect(events).toContain(HOME_APPS_REFRESH_EVENT);
    expect(events).toContain(WORKSPACE_IDENTITY_REFRESH_EVENT);
    // ...and the Inbox badge, same reasoning (T-H8).
    expect(events).toContain(INBOX_REFRESH_EVENT);
    // ...and the Live roster (live-work.md §4).
    expect(events).toContain(LIVE_REFRESH_EVENT);
  });
});

describe("[COMP:app-web/workspace-events] createRefreshFolder", () => {
  function harness(windowMs = 300) {
    const emitted: DomainDispatch[] = [];
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const folder = createRefreshFolder({
      windowMs,
      emit: (d) => emitted.push(d),
      setTimer: (fn, ms) => {
        const h = { fn, ms, cleared: false };
        timers.push(h);
        return h;
      },
      clearTimer: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    });
    const fireTimers = () => {
      for (const t of timers.splice(0)) if (!t.cleared) t.fn();
    };
    return { folder, emitted, fireTimers, timers };
  }

  const dispatch = (event: string, n = 0): DomainDispatch => ({
    event,
    detail: { seq: n },
  });

  it("emits the first dispatch immediately (leading edge)", () => {
    const { folder, emitted } = harness();
    folder.fold(dispatch("a"));
    expect(emitted).toHaveLength(1);
  });

  it("collapses a burst to one trailing emit carrying the last dispatch", () => {
    const { folder, emitted, fireTimers } = harness();
    folder.fold(dispatch("a", 1));
    folder.fold(dispatch("a", 2));
    folder.fold(dispatch("a", 3));
    expect(emitted).toHaveLength(1);
    fireTimers();
    expect(emitted).toHaveLength(2);
    expect(emitted[1].detail).toEqual({ seq: 3 });
  });

  it("keys the window by event name — no cross-domain folding", () => {
    const { folder, emitted } = harness();
    folder.fold(dispatch("a"));
    folder.fold(dispatch("b"));
    expect(emitted).toHaveLength(2);
  });

  it("a quiet window re-opens the leading edge", () => {
    const { folder, emitted, fireTimers } = harness();
    folder.fold(dispatch("a", 1));
    fireTimers(); // window expires with nothing pending
    folder.fold(dispatch("a", 2));
    expect(emitted).toHaveLength(2);
  });

  it("dispose clears pending windows without emitting", () => {
    const { folder, emitted, fireTimers, timers } = harness();
    folder.fold(dispatch("a", 1));
    folder.fold(dispatch("a", 2));
    folder.dispose();
    expect(timers.every((t) => t.cleared)).toBe(true);
    fireTimers();
    expect(emitted).toHaveLength(1);
  });
});

// Every open EventSource holds one of the API's per-instance request slots;
// restored browser sessions held one stream per BACKGROUND tab and saturated
// the slot budget (2026-08-27 outage). The gate releases a hidden tab's
// stream after a grace window and reconnects on visible — lossless, because
// reconnect re-runs catch-up on `open`.
describe("[COMP:app-web/workspace-events] createVisibilityGate", () => {
  function harness(graceMs = 60_000) {
    const calls: string[] = [];
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const gate = createVisibilityGate({
      graceMs,
      connect: () => calls.push("connect"),
      disconnect: () => calls.push("disconnect"),
      setTimer: (fn, ms) => {
        const h = { fn, ms, cleared: false };
        timers.push(h);
        return h;
      },
      clearTimer: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
    });
    const fireTimers = () => {
      for (const t of timers.splice(0)) if (!t.cleared) t.fn();
    };
    return { gate, calls, timers, fireTimers };
  }

  it("releases the stream only after the grace window elapses hidden", () => {
    const { gate, calls, timers, fireTimers } = harness();
    gate.onVisibility("hidden");
    expect(calls).toEqual([]); // grace armed, nothing released yet
    expect(timers[0].ms).toBe(60_000);
    fireTimers();
    expect(calls).toEqual(["disconnect"]);
  });

  it("a quick tab switch never drops the connection", () => {
    const { gate, calls, timers, fireTimers } = harness();
    gate.onVisibility("hidden");
    gate.onVisibility("visible"); // back before the grace expires
    expect(timers[0].cleared).toBe(true);
    fireTimers();
    expect(calls).toEqual(["connect"]); // reconnect attempt only; no release
  });

  it("visible after a release reconnects", () => {
    const { gate, calls, fireTimers } = harness();
    gate.onVisibility("hidden");
    fireTimers();
    gate.onVisibility("visible");
    expect(calls).toEqual(["disconnect", "connect"]);
  });

  it("repeated hidden events arm a single grace timer", () => {
    const { gate, timers } = harness();
    gate.onVisibility("hidden");
    gate.onVisibility("hidden");
    expect(timers).toHaveLength(1);
  });

  it("dispose clears a pending release without firing it", () => {
    const { gate, calls, timers, fireTimers } = harness();
    gate.onVisibility("hidden");
    gate.dispose();
    expect(timers[0].cleared).toBe(true);
    fireTimers();
    expect(calls).toEqual([]);
  });
});

// A non-200 reconnect response (expired token, 429 shed, 5xx mid-deploy) is
// FATAL to an EventSource per spec — the browser stops retrying — so the
// stream's error handler schedules its own reconnect. The delay backs off
// exponentially with full jitter so tabs stranded by one outage don't all
// retry in lockstep.
describe("[COMP:app-web/workspace-events] reconnectDelayMs", () => {
  it("backs off exponentially from 1s and caps at 30s", () => {
    expect(reconnectDelayMs(0, () => 0)).toBe(500);
    expect(reconnectDelayMs(0, () => 1)).toBe(1_000);
    expect(reconnectDelayMs(3, () => 1)).toBe(8_000);
    expect(reconnectDelayMs(5, () => 1)).toBe(30_000);
    expect(reconnectDelayMs(50, () => 1)).toBe(30_000); // attempt clamped, no overflow
  });

  it("jitters across the top half of the window", () => {
    expect(reconnectDelayMs(2, () => 0.5)).toBe(3_000); // base 4s → 2s + 0.5*2s
  });
});
