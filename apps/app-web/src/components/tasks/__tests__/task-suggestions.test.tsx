// @vitest-environment jsdom

/** [COMP:app-web/task-suggestions] Readiness-aware held-candidate tray. */

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

import { TaskSuggestions } from "../task-suggestions";

const candidate: TaskCandidate = {
  id: "candidate-1",
  title: "Pull a group",
  due: null,
  sourceKind: "slack_thread",
  lane: "extracted",
  sourceEpisodeId: "episode-1",
  status: "pending",
  reasonCode: "needs_spec",
  matchedTaskId: null,
  matchedTaskTitle: null,
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
  createdAt: "2026-08-05T00:00:00.000Z",
  expiresAt: "2026-08-19T00:00:00.000Z",
};

let container: HTMLDivElement | null = null;
let root: Root | null = null;

beforeEach(() => {
  guardrailApi.loadTaskCandidates.mockReset().mockResolvedValue([candidate]);
  guardrailApi.acceptTaskCandidate.mockReset();
  guardrailApi.dismissTaskCandidate.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/task-suggestions] Task readiness suggestions", () => {
  it("shows which agent-readiness facts are missing", async () => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root!.render(
        <I18nProvider locale="en" dict={en}>
          <TaskSuggestions workspaceId="workspace-1" />
        </I18nProvider>,
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container.textContent).toContain("Pull a group");
    expect(container.textContent).toContain(
      "Needs more detail: target or context, completion signal",
    );
    expect(container.textContent).toContain("From slack_thread");
  });
});
