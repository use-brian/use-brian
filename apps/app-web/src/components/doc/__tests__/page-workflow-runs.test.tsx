// @vitest-environment jsdom
/**
 * [COMP:app-web/page-workflow-runs] Page-header workflow-runs chip.
 *
 * Two surfaces:
 *   1. The pure `<WorkflowRunsList>` — row hrefs (board + run-detail), the
 *      outcome summary showing only once present, and the status label. Driven
 *      via SSR (renderToString) so the rows are asserted without the floating
 *      dropdown, mirroring comment-history's `HistoryList` approach.
 *   2. The stateful `<PageWorkflowRuns>` — renders nothing until the initial
 *      fetch resolves with runs, shows the count, polls while a run is still in
 *      flight, and stops polling once every run is terminal.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { type ReactNode } from "react";
import { renderToString } from "react-dom/server";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { PageWorkflowRunSummary } from "@/lib/api/workflow";

const listPageWorkflowRuns = vi.fn();
vi.mock("@/lib/api/workflow", () => ({
  listPageWorkflowRuns: (...a: unknown[]) => listPageWorkflowRuns(...a),
}));

import { PageWorkflowRuns, WorkflowRunsList } from "../page-workflow-runs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;
const WS = "ws-1";

function run(over: Partial<PageWorkflowRunSummary> = {}): PageWorkflowRunSummary {
  return {
    runId: "run-1",
    workflowId: "wf-1",
    workflowName: "Triage inbox",
    status: "completed",
    startedAt: "2026-06-29T00:00:00.000Z",
    finishedAt: "2026-06-29T00:01:00.000Z",
    outcomeSummary: "Filed under Q3.",
    ...over,
  };
}

describe("[COMP:app-web/page-workflow-runs] WorkflowRunsList", () => {
  function wrap(node: ReactNode): string {
    return renderToString(
      <I18nProvider locale="en" dict={dict}>
        {node}
      </I18nProvider>,
    );
  }

  it("links each row to the workflow board and the run detail, and shows the outcome", () => {
    const html = wrap(
      <WorkflowRunsList
        runs={[run()]}
        workspaceId={WS}
        t={dict.docPage.workflowRuns}
        statusLabel={dict.workflowPage.builder.runStatus}
        locale="en"
      />,
    );
    expect(html).toContain(`href="/w/${WS}/workflow/wf-1"`);
    expect(html).toContain(`href="/w/${WS}/workflow/wf-1/runs/run-1"`);
    expect(html).toContain("Triage inbox");
    expect(html).toContain("Filed under Q3.");
    expect(html).toContain(dict.workflowPage.builder.runStatus.completed);
  });

  it("omits the outcome line for a run with no summary yet", () => {
    const html = wrap(
      <WorkflowRunsList
        runs={[run({ status: "running", finishedAt: null, outcomeSummary: null })]}
        workspaceId={WS}
        t={dict.docPage.workflowRuns}
        statusLabel={dict.workflowPage.builder.runStatus}
        locale="en"
      />,
    );
    expect(html).not.toContain("Filed under Q3.");
    expect(html).toContain(dict.workflowPage.builder.runStatus.running);
  });
});

describe("[COMP:app-web/page-workflow-runs] PageWorkflowRuns", () => {
  let root: Root | null = null;
  let container: HTMLDivElement | null = null;

  async function mount(node: ReactNode) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(<I18nProvider locale="en" dict={dict}>{node}</I18nProvider>);
    });
  }

  beforeEach(() => {
    listPageWorkflowRuns.mockReset();
    vi.useFakeTimers();
  });

  afterEach(() => {
    if (root) act(() => root!.unmount());
    root = null;
    container?.remove();
    vi.useRealTimers();
  });

  it("renders nothing when the page triggered no runs", async () => {
    listPageWorkflowRuns.mockResolvedValue([]);
    await mount(<PageWorkflowRuns pageId="p-1" workspaceId={WS} />);
    expect(container!.querySelector("button")).toBeNull();
  });

  it("renders the chip with a count once runs resolve", async () => {
    listPageWorkflowRuns.mockResolvedValue([run(), run({ runId: "run-2" })]);
    await mount(<PageWorkflowRuns pageId="p-1" workspaceId={WS} />);
    const btn = container!.querySelector("button");
    expect(btn).not.toBeNull();
    expect(btn!.textContent).toContain("2");
  });

  it("polls while a run is in flight and stops once all are terminal", async () => {
    listPageWorkflowRuns.mockResolvedValueOnce([run({ status: "running", outcomeSummary: null })]);
    await mount(<PageWorkflowRuns pageId="p-1" workspaceId={WS} />);
    expect(listPageWorkflowRuns).toHaveBeenCalledTimes(1);

    // Second fetch (the first poll tick) returns a terminal run → polling stops.
    listPageWorkflowRuns.mockResolvedValueOnce([run({ status: "completed" })]);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(listPageWorkflowRuns).toHaveBeenCalledTimes(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(listPageWorkflowRuns).toHaveBeenCalledTimes(2);
  });
});
