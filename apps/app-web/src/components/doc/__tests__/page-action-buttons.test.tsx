// @vitest-environment jsdom
/**
 * [COMP:app-web/page-action-buttons] Page-header action buttons.
 *
 * The stateful strip: renders nothing until the resolve fetch returns
 * bindings; a click routes through confirmDialog (cost framing) and only
 * invokes on confirm; a workflow result nudges the runs chip refresh and
 * shows the transient result pill; a declined confirm never invokes.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import type { PageActionRow } from "@/lib/api/page-actions";

const listPageActions = vi.fn();
const invokePageAction = vi.fn();
vi.mock("@/lib/api/page-actions", () => ({
  listPageActions: (...a: unknown[]) => listPageActions(...a),
  invokePageAction: (...a: unknown[]) => invokePageAction(...a),
}));

const confirmDialog = vi.fn();
vi.mock("@/components/ui/confirm-dialog", () => ({
  confirmDialog: (...a: unknown[]) => confirmDialog(...a),
}));

const requestWorkflowRefresh = vi.fn();
vi.mock("@/lib/workflow-events", () => ({
  requestWorkflowRefresh: (...a: unknown[]) => requestWorkflowRefresh(...a),
}));

import { PageActionButtons } from "../page-action-buttons";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const dict = en as unknown as Dictionary;

function binding(over: Partial<PageActionRow> = {}): PageActionRow {
  return {
    id: "pa-1",
    workspaceId: "ws-1",
    blueprintId: "bp-1",
    pageId: null,
    label: "Send",
    icon: null,
    confirmCopy: null,
    action: { kind: "workflow", workflowId: "wf-1" },
    enabled: true,
    position: 0,
    updatedAt: "2026-07-11T00:00:00Z",
    ...over,
  };
}

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function mount() {
  await act(async () => {
    root.render(
      <I18nProvider locale="en" dict={dict}>
        <PageActionButtons pageId="page-1" workspaceId="ws-1" />
      </I18nProvider>,
    );
  });
}

describe("[COMP:app-web/page-action-buttons] PageActionButtons", () => {
  it("renders nothing when no binding resolves for the page", async () => {
    listPageActions.mockResolvedValue([]);
    await mount();
    expect(container.textContent).toBe("");
  });

  it("renders resolved buttons and invokes only after confirm", async () => {
    listPageActions.mockResolvedValue([binding()]);
    confirmDialog.mockResolvedValue(true);
    invokePageAction.mockResolvedValue({
      ok: true,
      result: { kind: "workflow", runId: "run-1", workflowId: "wf-1", status: "completed", finalOutput: null, error: null },
    });
    await mount();

    const button = container.querySelector("button");
    expect(button?.textContent).toContain("Send");

    await act(async () => {
      button!.click();
    });
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("runs the linked workflow") }),
    );
    expect(invokePageAction).toHaveBeenCalledWith("page-1", "pa-1");
    expect(requestWorkflowRefresh).toHaveBeenCalledWith("ws-1");
    expect(container.textContent).toContain(dict.docPage.pageActions.done);
  });

  it("never invokes when the confirm is declined", async () => {
    listPageActions.mockResolvedValue([binding()]);
    confirmDialog.mockResolvedValue(false);
    await mount();
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(invokePageAction).not.toHaveBeenCalled();
  });

  it("frames a goal button with the credit-spending copy and reports the goal start", async () => {
    listPageActions.mockResolvedValue([binding({ action: { kind: "goal" }, label: "Work on this" })]);
    confirmDialog.mockResolvedValue(true);
    invokePageAction.mockResolvedValue({
      ok: true,
      result: { kind: "goal", goalId: "g-1", outcome: "Do it" },
    });
    await mount();
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(confirmDialog).toHaveBeenCalledWith(
      expect.objectContaining({ description: expect.stringContaining("spends workspace credits") }),
    );
    expect(container.textContent).toContain(dict.docPage.pageActions.goalStarted);
    expect(requestWorkflowRefresh).not.toHaveBeenCalled();
  });

  it("surfaces a failed workflow invoke as the error pill", async () => {
    listPageActions.mockResolvedValue([binding()]);
    confirmDialog.mockResolvedValue(true);
    invokePageAction.mockResolvedValue({
      ok: true,
      result: {
        kind: "workflow",
        runId: "run-1",
        workflowId: "wf-1",
        status: "failed",
        finalOutput: null,
        error: { message: "Gmail is not connected for this user.", reason: "gmail_not_connected" },
      },
    });
    await mount();
    await act(async () => {
      container.querySelector("button")!.click();
    });
    expect(container.textContent).toContain("Gmail is not connected");
  });
});
