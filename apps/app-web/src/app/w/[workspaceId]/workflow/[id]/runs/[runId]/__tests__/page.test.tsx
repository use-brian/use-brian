// @vitest-environment jsdom
/**
 * [COMP:app-web/workflow-detail-cache] The run drill-down paints from the
 * cache (instant-navigation contract N1-N4, N7).
 *
 * Two slots, fetched in parallel: the run (`workflow-run:<wid>:…:<runId>`)
 * and the workflow row (`workflow-detail:<wid>:…:<id>`, the SAME slot the
 * detail page fills, so detail -> run paints the header on the first frame).
 * A warmed pair renders the page with no fetch; a cold entry paints the
 * run-shaped skeleton, never the old "Loading run…" sentence; a spine
 * mark-stale repaints behind the rows instead of blanking them.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { workflowDetailCacheKey, workflowRunCacheKey } from "@/lib/surface-prefetch";
import type { WorkflowFull, WorkflowRunDetail } from "@/lib/api/workflow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/link", () => ({
  default: ({
    href,
    children,
    ...props
  }: {
    href: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={href} {...props}>
      {children}
    </a>
  ),
}));

vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "n", email: "e" }),
}));

vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));

const openWorkspaceSettings = vi.hoisted(() => vi.fn());
vi.mock("@/lib/workspace-settings-events", () => ({ openWorkspaceSettings }));

const api = vi.hoisted(() => ({
  getWorkflowRun: vi.fn<() => Promise<WorkflowRunDetail | null>>(),
  getWorkflowFull: vi.fn<() => Promise<WorkflowFull | null>>(),
}));

vi.mock("@/lib/api/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/workflow")>()),
  getWorkflowRun: api.getWorkflowRun,
  getWorkflowFull: api.getWorkflowFull,
}));

import WorkflowRunDetailPage from "../page";

const WF = {
  id: "wf-1",
  workspaceId: "w1",
  createdBy: "u1",
  name: "Morning digest",
  description: "Summarise overnight mail",
  definition: {
    startStepId: "step_1",
    steps: [
      { id: "step_1", type: "assistant_call", target: { assistantId: "primary" }, prompt: "Go" },
    ],
  },
  enabled: true,
  trigger: { kind: "manual" },
  webhookSlug: null,
  webhookSecret: null,
  modelAlias: "pro",
  maxTurns: null,
  researchMode: false,
  createdAt: "2026-09-01T00:00:00.000Z",
  updatedAt: "2026-09-01T00:00:00.000Z",
} as unknown as WorkflowFull;

const RUN = {
  id: "run-1234567890",
  workflowId: "wf-1",
  status: "completed",
  triggerKind: "manual",
  startedAt: "2026-09-01T09:00:00.000Z",
  finishedAt: "2026-09-01T09:00:05.000Z",
  error: null,
  input: {},
  vars: {},
  steps: [
    {
      id: "sr-1",
      stepId: "step_1",
      type: "assistant_call",
      status: "completed",
      startedAt: "2026-09-01T09:00:00.000Z",
      finishedAt: "2026-09-01T09:00:05.000Z",
      input: {},
      output: { text: "done" },
      error: null,
    },
  ],
} as unknown as WorkflowRunDetail;

/** React 19 `use()` reads a settled thenable synchronously when it carries `status`. */
function settledParams<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}
const PARAMS = settledParams({ workspaceId: "w1", id: "wf-1", runId: "run-1234567890" });

const pending = <T,>() => new Promise<T>(() => {});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () => {
    root.render(<WorkflowRunDetailPage params={PARAMS} />);
  });
}

beforeEach(() => {
  resetSurfaceCache();
  openWorkspaceSettings.mockReset();
  api.getWorkflowRun.mockReset();
  api.getWorkflowFull.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe("[COMP:app-web/workflow-detail-cache] run page", () => {
  it("revalidates completed history and removes details after access loss", async () => {
    vi.useFakeTimers();
    await loadSurfaceCache(workflowRunCacheKey("w1", RUN.id), async () => RUN);
    await loadSurfaceCache(workflowDetailCacheKey("w1", WF.id), async () => WF);
    api.getWorkflowRun.mockResolvedValue(null);
    await render();
    expect(container.textContent).toContain("step_1");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(api.getWorkflowRun).toHaveBeenCalledOnce();
    expect(container.textContent).toContain(en.workflowPage.builder.runDetail.notFound);
    expect(container.textContent).not.toContain("step_1");
    expect(container.querySelector('a[href="/w/w1/workflow/wf-1"]')?.textContent).toContain(en.workflowPage.builder.runDetail.backLink);
    expect(container.textContent).not.toContain(en.workflowPage.builder.runNowBtn);
  });

  it("expires warmed history during a hung refresh and ignores its late response", async () => {
    vi.useFakeTimers();
    await loadSurfaceCache(workflowRunCacheKey("w1", RUN.id), async () => RUN);
    await loadSurfaceCache(workflowDetailCacheKey("w1", WF.id), async () => WF);
    let resolve!: (value: WorkflowRunDetail) => void;
    api.getWorkflowRun.mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockImplementation(pending);
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(30_001); });
    expect(container.textContent).not.toContain("step_1");
    await act(async () => { resolve(RUN); });
    expect(container.textContent).not.toContain("step_1");
  });

  it("does not extend the display lifetime when refreshes fail", async () => {
    vi.useFakeTimers();
    await loadSurfaceCache(workflowRunCacheKey("w1", RUN.id), async () => RUN);
    await loadSurfaceCache(workflowDetailCacheKey("w1", WF.id), async () => WF);
    api.getWorkflowRun.mockRejectedValue(new Error("offline"));
    await render();
    await act(async () => { await vi.advanceTimersByTimeAsync(15_001); });
    expect(container.textContent).toContain("step_1");
    await act(async () => { await vi.advanceTimersByTimeAsync(15_000); });
    expect(container.textContent).not.toContain("step_1");
  });

  it("renews completed history when the tab becomes visible", async () => {
    await loadSurfaceCache(workflowRunCacheKey("w1", RUN.id), async () => RUN);
    await loadSurfaceCache(workflowDetailCacheKey("w1", WF.id), async () => WF);
    api.getWorkflowRun.mockResolvedValue(null);
    await render();
    await act(async () => { document.dispatchEvent(new Event("visibilitychange")); });
    expect(api.getWorkflowRun).toHaveBeenCalledOnce();
    expect(container.textContent).not.toContain("step_1");
  });

  it("links a waiting tool step to the workspace approval queue", async () => {
    await loadSurfaceCache(workflowRunCacheKey("w1", RUN.id), async () => ({ ...RUN, status: "awaiting_input", steps: [{ ...RUN.steps[0], type: "tool_call", status: "running" }] }));
    await loadSurfaceCache(workflowDetailCacheKey("w1", WF.id), async () => WF);
    await render();
    expect(container.querySelector('a[href="/w/w1/p?panel=approvals"]')?.textContent).toBe(en.workflowPage.builder.runDetail.openApprovals);
  });

  it.each(["authority_changed", "workflow_authority_unavailable", "caller_authority_changed", "caller_evidence_unavailable"])("opens department access for %s without retrying the run", async (reason) => {
    await loadSurfaceCache(workflowRunCacheKey("w1", RUN.id), async () => ({ ...RUN, status: "failed", error: { reason, message: "Internal diagnostic" } }));
    await loadSurfaceCache(workflowDetailCacheKey("w1", WF.id), async () => WF);
    api.getWorkflowRun.mockImplementation(pending);
    api.getWorkflowFull.mockImplementation(pending);
    await render();
    expect(container.textContent).toContain(en.workflowPage.builder.runDetail.sourceAccessChanged);
    expect(container.textContent).not.toContain("Internal diagnostic");
    const action = [...container.querySelectorAll("button")].find(button => button.textContent === en.workflowPage.builder.runDetail.reviewDepartmentAccess)!;
    expect(action).toBeTruthy();
    act(() => action.click());
    expect(openWorkspaceSettings).toHaveBeenCalledExactlyOnceWith("ws-access");
    expect(api.getWorkflowRun).not.toHaveBeenCalled();
  });
  it("paints the run and the workflow header from warmed keys while both fetches are still pending", async () => {
    await loadSurfaceCache(workflowRunCacheKey("w1", "run-1234567890"), async () => RUN);
    await loadSurfaceCache(workflowDetailCacheKey("w1", "wf-1"), async () => WF);
    api.getWorkflowRun.mockImplementation(pending);
    api.getWorkflowFull.mockImplementation(pending);

    await render();

    expect(container.querySelector("h1")?.textContent).toBe("Morning digest");
    expect(container.textContent).toContain("step_1");
    expect(container.textContent).toContain(en.workflowPage.builder.runStatus.completed);
    expect(container.querySelector('[data-testid="workflow-run-entry"]')).toBeNull();
    expect(container.textContent).not.toContain(en.workflowPage.builder.runDetail.loading);
    // Fresh keys: no request of the page's own.
    expect(api.getWorkflowRun).not.toHaveBeenCalled();
    expect(api.getWorkflowFull).not.toHaveBeenCalled();
  });

  it("paints the run-shaped skeleton on a cold entry, with the workflow name when only that slot is warm", async () => {
    await loadSurfaceCache(workflowDetailCacheKey("w1", "wf-1"), async () => WF);
    api.getWorkflowRun.mockImplementation(pending);
    api.getWorkflowFull.mockImplementation(pending);

    await render();

    const frame = container.querySelector('[data-testid="workflow-run-entry"]');
    expect(frame).not.toBeNull();
    // The header the detail page already fetched is real; the rest is shape.
    expect(frame?.querySelector("h1")?.textContent).toBe("Morning digest");
    expect(container.textContent).not.toContain(en.workflowPage.builder.runDetail.loading);
    expect(container.textContent).not.toContain("…");
    // Both fetches went out together (N7), not run-then-workflow.
    expect(api.getWorkflowRun).toHaveBeenCalledTimes(1);
  });

  it("keeps the run on screen through a spine mark-stale and swaps in the revalidated status", async () => {
    await loadSurfaceCache(
      workflowRunCacheKey("w1", "run-1234567890"),
      async () => ({ ...RUN, status: "running", finishedAt: null }) as WorkflowRunDetail,
    );
    await loadSurfaceCache(workflowDetailCacheKey("w1", "wf-1"), async () => WF);
    api.getWorkflowFull.mockResolvedValue(WF);
    let resolve!: (run: WorkflowRunDetail | null) => void;
    api.getWorkflowRun.mockImplementation(
      () => new Promise<WorkflowRunDetail | null>((r) => { resolve = r; }),
    );
    await render();
    expect(container.textContent).toContain(en.workflowPage.builder.runStatus.running);

    await act(async () => { markSurfaceCacheStale("workflow-run:w1:"); });
    // Stale, not gone: the trail is still on screen while the refetch runs.
    expect(container.querySelector('[data-testid="workflow-run-entry"]')).toBeNull();
    expect(container.textContent).toContain("step_1");
    expect(api.getWorkflowRun).toHaveBeenCalledTimes(1);

    await act(async () => { resolve(RUN); });
    await settle();
    expect(container.textContent).toContain(en.workflowPage.builder.runStatus.completed);
  });
});


describe("[COMP:app-web/workflow] delivery outcomes", () => {
  const copy = en.workflowPage.builder.deliveryFeedback;
  it.each([
    [{ status: "delivered", channelType: "slack", channelId: "fictional" }, "delivered"],
    [{ status: "skipped", channelType: "slack", reason: "delivery_audience_unverified" }, "skipped"],
    [{ status: "skipped", channelType: "slack", reason: "private_reason" }, "skipped"],
    [{ status: "failed", channelType: "slack", error: "private_error" }, "failed"],
    [null, "unknown"], [[], "unknown"], ["delivered", "unknown"],
    [{ status: "future" }, "unknown"], [{ status: {}, channelType: "slack" }, "unknown"], [{ status: "delivered" }, "unknown"],
    [{ status: "skipped", channelType: "slack", reason: {} }, "unknown"],
  ] as const)("shows safe feedback for %j outside raw output", async (outcome, status) => {
    const output = { text: "generated", __delivery: outcome };
    await loadSurfaceCache(workflowRunCacheKey("w1", RUN.id), async () => ({ ...RUN, steps: [{ ...RUN.steps[0], output }] }));
    await loadSurfaceCache(workflowDetailCacheKey("w1", WF.id), async () => WF);
    await render();
    const row = container.querySelector("ol li")!;
    expect(row.textContent).toContain(copy[status]);
    const raw = [...row.querySelectorAll("details")].find(d => d.textContent?.includes("__delivery"))!;
    expect(raw.open).toBe(false);
    expect(raw.textContent).toContain("__delivery");
    expect(raw.querySelector("pre")?.textContent).toBe(JSON.stringify(output, null, 2));
    const visible = row.cloneNode(true) as HTMLElement;
    visible.querySelectorAll("details").forEach(d => d.remove());
    expect(visible.textContent).toContain(copy[status]);
    expect(visible.textContent).toContain(copy.generationNote);
    expect(visible.textContent).not.toContain("private_reason");
    expect(visible.textContent).not.toContain("private_error");
    const unverified = outcome && typeof outcome === "object" && "reason" in outcome && outcome.reason === "delivery_audience_unverified";
    expect(visible.textContent?.includes(copy.unverified)).toBe(!!unverified);
    expect(visible.querySelector('a[href="/w/w1/studio/channels"]') !== null).toBe(!!unverified);
  });
  it.each([null, [], "generated", { text: "done" }])("does not infer delivery from completed generation with output %j", async (output) => {
    await loadSurfaceCache(workflowRunCacheKey("w1", RUN.id), async () => ({ ...RUN, steps: [{ ...RUN.steps[0], output }] }));
    await loadSurfaceCache(workflowDetailCacheKey("w1", WF.id), async () => WF);
    await render();
    expect(container.textContent).not.toContain(copy.delivered);
    expect(container.textContent).not.toContain(copy.unknown);
  });
});
