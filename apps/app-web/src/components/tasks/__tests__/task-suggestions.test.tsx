// @vitest-environment jsdom

/** [COMP:app-web/task-suggestions] Suggestion-first review view. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { TaskCandidate } from "@/lib/api/task-guardrails";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const guardrailApi = vi.hoisted(() => ({
  loadTaskCandidates: vi.fn(),
  acceptTaskCandidate: vi.fn(),
  dismissTaskCandidate: vi.fn(),
}));

vi.mock("@/lib/api/task-guardrails", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/task-guardrails")>();
  return { ...actual, ...guardrailApi };
});

import { TaskSuggestionsView } from "../task-suggestions";

const candidate: TaskCandidate = {
  id: "candidate-1",
  title: "Pull a group",
  due: null,
  sourceKind: "slack_thread",
  channelRef: "C123",
  lane: "extracted",
  sourceEpisodeId: "episode-1",
  status: "pending",
  reasonCode: "needs_spec",
  matchedTaskId: null,
  matchedTaskTitle: null,
  matchedRuleId: null,
  matchedRuleClause: null,
  similarity: null,
  quality: {
    classification: "needs_spec",
    evidenceQuote: "pull a group",
    evidenceVerified: true,
    commitment: "explicit",
    objective: "Pull a group",
    target: null,
    description: null,
    startingPointKind: "missing",
    startingPoint: null,
    completionSignal: null,
    missing: ["target", "completion_signal"],
    explanation: "The target and completion condition are missing.",
  },
  createdTaskId: null,
  createdAt: "2026-08-05T00:00:00.000Z",
  expiresAt: "2026-08-19T00:00:00.000Z",
};

const autoAccepted: TaskCandidate = {
  ...candidate,
  id: "candidate-2",
  title: "Ship the pricing doc",
  status: "auto_accepted",
  reasonCode: "auto_rule",
  matchedRuleId: "rule-1",
  matchedRuleClause: "Automatically create ready task suggestions from slack_thread.",
  createdTaskId: "task-9",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  guardrailApi.loadTaskCandidates
    .mockReset()
    .mockImplementation(
      async (_workspaceId: string, status?: "pending" | "auto_accepted") =>
        status === "auto_accepted" ? [autoAccepted] : [candidate],
    );
  guardrailApi.acceptTaskCandidate.mockReset().mockResolvedValue({
    allowRuleId: null,
  });
  guardrailApi.dismissTaskCandidate.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderView(onCountChange?: (count: number) => void) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <TaskSuggestionsView
          workspaceId="workspace-1"
          onCountChange={onCountChange}
        />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe("[COMP:app-web/task-suggestions] Task suggestions view", () => {
  it("shows which agent-readiness facts are missing", async () => {
    await renderView();

    expect(container!.textContent).toContain("Pull a group");
    expect(container!.textContent).toContain(
      "Needs more detail: target or context, completion signal",
    );
    expect(container!.textContent).toContain("From slack_thread");
  });

  it("reports the pending count and lists rule auto-creations", async () => {
    const onCountChange = vi.fn();
    await renderView(onCountChange);

    expect(onCountChange).toHaveBeenCalledWith(1);
    // The auto-created audit section is collapsed behind a disclosure.
    expect(container!.textContent).toContain("Auto-created by your rules (1)");
  });

  it("approves with Always through the accept endpoint", async () => {
    await renderView();

    const always = Array.from(container!.querySelectorAll("button")).find(
      (b) => b.textContent === "Always",
    );
    expect(always).toBeTruthy();
    await act(async () => {
      always!.click();
      await Promise.resolve();
    });

    expect(guardrailApi.acceptTaskCandidate).toHaveBeenCalledWith(
      "workspace-1",
      "candidate-1",
      { title: undefined, always: true },
    );
  });
});
