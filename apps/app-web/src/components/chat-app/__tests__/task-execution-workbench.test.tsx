// @vitest-environment jsdom
/**
 * Task execution workbench (chat-app.md -> "Task execution workbench"): plan,
 * readiness, allowance and external freshness; controls carrying the displayed
 * revision and a fresh intervention id; disclosed renewal; stale / denied /
 * revoked handling; view-only for an actor who cannot control; live
 * revalidation through the event spine; phone targets. HTTP is mocked; the
 * component state, surface cache and spine mapping are real.
 */
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TaskExecution } from "@/lib/api/task-execution";

const api = vi.hoisted(() => ({ fetchTaskExecution: vi.fn(), controlTaskExecution: vi.fn(), requestBrainRefresh: vi.fn() }));
vi.mock("@/lib/api/task-execution", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/task-execution")>()),
  fetchTaskExecution: api.fetchTaskExecution, controlTaskExecution: api.controlTaskExecution,
}));
vi.mock("@/lib/brain-events", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/brain-events")>()), requestBrainRefresh: api.requestBrainRefresh,
}));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  return { useT: () => en, useLocale: () => "en", format: (text: string, vars: Record<string, string>) => text.replace(/\{(\w+)\}/g, (_m, key) => String(vars[key] ?? "")) };
});
import { en } from "@/lib/i18n/dictionaries/en";
import { markSurfaceCacheStale, resetSurfaceCache } from "@/lib/surface-cache";
import { staleMarksFor } from "@/lib/surface-cache-invalidation";
import { BRAIN_REFRESH_EVENT } from "@/lib/brain-events";
import { TaskExecutionError } from "@/lib/api/task-execution";
import { TaskExecutionWorkbench } from "../task-execution-workbench";

const t = en.chatApp.taskExecution;
let host: HTMLDivElement, root: Root;
const render = async (node: React.ReactNode) => { await act(async () => root.render(node)); };
const flush = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
const button = (label: string) => Array.from(host.querySelectorAll("button")).find((b) => b.textContent === label);
const click = async (label: string) => { const b = button(label); if (!b) throw new Error(`no button ${label}`); await act(async () => b.click()); await flush(); };
const workbench = () => host.querySelector("[data-testid=task-execution-workbench]");

function execution(over: Partial<TaskExecution> = {}): TaskExecution {
  return {
    id: "e-1", taskId: "t-1", goalId: "g-1", phase: "running", controlRevision: 3,
    executor: { kind: "assistant", id: "a1b2c3d4-0000-4000-8000-000000000000" },
    plan: { outcome: "Fictional vendor summary", steps: [{ title: "Collect quotes", contribution: "inputs" }],
      completionEvidence: ["summary page published"], nextStep: "Collect quotes",
      readiness: { state: "ready", reasons: [] }, sourceBasis: [{ kind: "brief", id: "b", label: "Atlas Brief" }] },
    blocker: null, checkpoint: { summary: "", artifacts: [{ kind: "page", ref: "draft-1" }], uncertainEffects: [{ operation: "send_email", ref: "m-1" }], checkedResults: [], nextStep: null, questions: [] },
    steering: [], canControl: true,
    allowance: { maxSpend: 5, maxIterations: 30, activeSegment: 1, segment: { spent: 1, iterations: 4, reservedSpend: 0.5, reservedIterations: 1 }, lifetime: { spent: 1, iterations: 4 } },
    children: [{ id: "c-1", childKey: "north", phase: "paused", nextStep: null, questions: [], blocker: null }],
    external: [{ id: "x", externalExecutionId: "coding-session-1", harness: "codex", phase: "running", freshness: "stale", lastReportedAt: null }],
    lastControl: { kind: "steer", actorId: "u-1", revision: 3, at: "2026-10-13T00:00:00Z" },
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  resetSurfaceCache();
  host = document.createElement("div");
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("[COMP:app-web/task-execution-workbench] task execution workbench", () => {
  it("shows plan, sources, WIP, branches, allowance and external freshness without sending anything", async () => {
    api.fetchTaskExecution.mockResolvedValue(execution());
    await render(<TaskExecutionWorkbench workspaceId="w-1" taskId="t-1" />);
    await flush();
    const text = workbench()?.textContent ?? "";
    expect(text).toContain("Collect quotes");
    expect(text).toContain("summary page published");
    expect(text).toContain("Atlas Brief");
    expect(text).toContain("Not confirmed yet: send_email m-1");
    expect(text).toContain("north: Paused");
    expect(host.querySelector("[data-testid=task-execution-allowance]")?.textContent)
      .toBe("25 iterations left in this allowance, $3.50 left. Used so far: 4 iterations, $1.00.");
    expect(host.querySelector("[data-freshness=stale]")?.textContent).toContain("coding-session-1");
    expect(text).toContain(t.renewalNotice);
    expect(api.controlTaskExecution).not.toHaveBeenCalled();
  });

  it("sends controls with the displayed revision and a fresh intervention id", async () => {
    api.fetchTaskExecution.mockResolvedValue(execution());
    api.controlTaskExecution.mockResolvedValue({ outcome: "applied", receipt: { reason: null, resultRevision: 4, renewedSegment: null }, execution: execution({ phase: "paused", controlRevision: 4 }) });
    await render(<TaskExecutionWorkbench workspaceId="w-1" taskId="t-1" />);
    await flush();
    await click(t.pause);
    expect(api.controlTaskExecution).toHaveBeenCalledWith("w-1", "e-1", expect.objectContaining({ action: "pause", expectedRevision: 3, instruction: undefined }));
    expect(workbench()?.getAttribute("data-phase")).toBe("paused");
    expect(api.requestBrainRefresh).toHaveBeenCalledWith("w-1");

    api.controlTaskExecution.mockResolvedValue({ outcome: "applied", receipt: { reason: null, resultRevision: 5, renewedSegment: 2 }, execution: execution({ phase: "ready", controlRevision: 5 }) });
    const textarea = host.querySelector("textarea")!;
    expect(textarea.className).toContain("text-[16px]");
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
      setter.call(textarea, "Only the fictional north region");
      textarea.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await click(t.send);
    const [first, second] = api.controlTaskExecution.mock.calls.map((c) => c[2] as { interventionId: string });
    expect(second).toMatchObject({ action: "steer", expectedRevision: 4, instruction: "Only the fictional north region" });
    expect(second.interventionId).not.toBe(first.interventionId);
    expect(button(t.pause)?.className).toContain("max-sm:min-h-11");
  });

  it("reloads on a stale receipt and reports a refusal or a denial", async () => {
    api.fetchTaskExecution.mockResolvedValue(execution({ phase: "paused" }));
    api.controlTaskExecution.mockResolvedValueOnce({ outcome: "stale", receipt: { reason: null, resultRevision: 9, renewedSegment: null }, execution: execution({ phase: "paused", controlRevision: 9 }) });
    await render(<TaskExecutionWorkbench workspaceId="w-1" taskId="t-1" />);
    await flush();
    await click(t.continue);
    expect(host.querySelector("[data-testid=task-execution-notice]")?.textContent).toBe(t.stale);
    expect(workbench()?.getAttribute("data-revision")).toBe("9");
    api.controlTaskExecution.mockResolvedValueOnce({ outcome: "blocked", receipt: { reason: "blocker_unresolved", resultRevision: 9, renewedSegment: null }, execution: execution({ phase: "paused", controlRevision: 9 }) });
    await click(t.continue);
    expect(host.querySelector("[data-testid=task-execution-notice]")?.textContent).toBe("Not applied: blocker_unresolved");
    api.controlTaskExecution.mockRejectedValueOnce(new TaskExecutionError("execution_control_denied", 403));
    await click(t.continue);
    expect(host.querySelector("[data-testid=task-execution-notice]")?.textContent).toBe(t.denied);
  });

  it("is view-only for a reader who cannot control, and offers nothing on a finished execution", async () => {
    api.fetchTaskExecution.mockResolvedValue(execution({ canControl: false }));
    await render(<TaskExecutionWorkbench workspaceId="w-1" taskId="t-1" />);
    await flush();
    expect(host.textContent).toContain(t.viewOnly);
    expect(host.querySelector("textarea")).toBeNull();
    resetSurfaceCache();
    api.fetchTaskExecution.mockResolvedValue(execution({ phase: "done" }));
    await render(<TaskExecutionWorkbench workspaceId="w-1" taskId="t-2" />);
    await flush();
    expect(button(t.pause)).toBeUndefined();
  });

  it("revalidates on the event spine and replaces revoked data instead of keeping it", async () => {
    expect(staleMarksFor(BRAIN_REFRESH_EVENT, "w-1")).toContain("task-execution:w-1");
    api.fetchTaskExecution.mockResolvedValueOnce(execution());
    await render(<TaskExecutionWorkbench workspaceId="w-1" taskId="t-1" />);
    await flush();
    expect(workbench()).not.toBeNull();
    api.fetchTaskExecution.mockRejectedValueOnce(new TaskExecutionError("execution_not_found", 404));
    await act(async () => markSurfaceCacheStale("task-execution:w-1"));
    await flush();
    expect(workbench()).toBeNull();
    expect(host.querySelector("[data-testid=task-execution-none]")?.textContent).toBe(t.notAvailable);
    expect(host.textContent).not.toContain("Atlas Brief");
    expect(api.fetchTaskExecution).toHaveBeenCalledTimes(2);
  });

  it("distinguishes an unavailable read from an empty one", async () => {
    api.fetchTaskExecution.mockRejectedValue(new TaskExecutionError("execution_unavailable", 503));
    await render(<TaskExecutionWorkbench workspaceId="w-1" taskId="t-1" />);
    await flush();
    expect(host.querySelector("[data-testid=task-execution-unavailable]")?.textContent).toContain(t.unavailable);
    expect(host.querySelector("[data-testid=task-execution-none]")).toBeNull();
  });
});
