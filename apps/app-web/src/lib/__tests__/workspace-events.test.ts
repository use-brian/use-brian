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
import {
  allDomainDispatches,
  createRefreshFolder,
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
