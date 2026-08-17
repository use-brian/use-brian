// @vitest-environment jsdom

/** [COMP:app-web/task-suggestions] Suggestion-first review view. */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { TaskCandidate } from "@/lib/api/task-guardrails";
import type { TaskRow } from "@/lib/api/tasks";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const guardrailApi = vi.hoisted(() => ({
  loadTaskCandidates: vi.fn(),
  acceptTaskCandidate: vi.fn(),
  dismissTaskCandidate: vi.fn(),
}));

const dialogs = vi.hoisted(() => ({ promptDialog: vi.fn() }));
const surfaceChat = vi.hoisted(() => ({ requestSurfaceChatSeed: vi.fn() }));

vi.mock("@/lib/api/task-guardrails", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/api/task-guardrails")>();
  return { ...actual, ...guardrailApi };
});

vi.mock("@/components/ui/prompt-dialog", () => ({
  promptDialog: dialogs.promptDialog,
}));

vi.mock("@/lib/surface-chat-seed", () => ({
  requestSurfaceChatSeed: surfaceChat.requestSurfaceChatSeed,
}));

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

const createdTask: TaskRow = {
  id: "task-created",
  title: candidate.title,
  status: "todo",
  assigneeId: null,
  due: null,
  tags: [],
  parentId: null,
  attributes: {},
  updatedAt: "2026-08-05T00:00:00.000Z",
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
    task: createdTask,
    allowRuleId: null,
  });
  guardrailApi.dismissTaskCandidate.mockReset();
  dialogs.promptDialog.mockReset().mockResolvedValue(null);
  surfaceChat.requestSurfaceChatSeed.mockReset();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

async function renderView(
  onCountChange?: (count: number) => void,
  onAccepted?: (task: TaskRow, openEditor: boolean) => void,
) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <TaskSuggestionsView
          workspaceId="workspace-1"
          onCountChange={onCountChange}
          onAccepted={onAccepted}
        />
      </I18nProvider>,
    );
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function openAddMenu() {
  const trigger = container!.querySelector<HTMLButtonElement>(
    'button[aria-label="More ways to add"]',
  );
  expect(trigger).toBeTruthy();
  await act(async () => {
    trigger!.click();
    await Promise.resolve();
  });
}

function menuItemContaining(label: string): HTMLElement {
  const item = Array.from(
    document.body.querySelectorAll<HTMLElement>('[data-slot="dropdown-menu-item"]'),
  ).find((node) => node.textContent?.includes(label));
  if (!item) throw new Error(`Menu item not found: ${label}`);
  return item;
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

  it("uses the full review canvas instead of the old narrow prose column", async () => {
    await renderView();

    const canvas = container!.querySelector('[data-testid="task-suggestions-canvas"]');
    expect(canvas?.className).toContain("w-full");
    expect(canvas?.className).not.toContain("max-w-3xl");
  });

  it("adds quickly through the primary action", async () => {
    const onAccepted = vi.fn();
    await renderView(undefined, onAccepted);

    const add = Array.from(container!.querySelectorAll("button")).find(
      (button) => button.textContent?.trim() === "Add it",
    );
    expect(add).toBeTruthy();
    await act(async () => {
      add!.click();
      await Promise.resolve();
    });

    expect(guardrailApi.acceptTaskCandidate).toHaveBeenCalledWith(
      "workspace-1",
      "candidate-1",
      { title: undefined, always: undefined },
    );
    expect(onAccepted).toHaveBeenCalledWith(createdTask, false);
  });

  it("creates and opens the canonical editor from Add and edit", async () => {
    const onAccepted = vi.fn();
    await renderView(undefined, onAccepted);
    await openAddMenu();

    await act(async () => {
      menuItemContaining("Add and edit").click();
      await Promise.resolve();
    });

    expect(onAccepted).toHaveBeenCalledWith(createdTask, true);
  });

  it("creates first and auto-sends the confirmed assistant instruction", async () => {
    dialogs.promptDialog.mockResolvedValue(
      "Assign it to me and add acceptance criteria.",
    );
    await renderView();
    await openAddMenu();

    await act(async () => {
      menuItemContaining("Add with instructions").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(surfaceChat.requestSurfaceChatSeed).toHaveBeenCalledWith({
      prefill: expect.stringContaining("task-created"),
      autoSend: true,
    });
    expect(surfaceChat.requestSurfaceChatSeed.mock.calls[0][0].prefill).toContain(
      "Assign it to me and add acceptance criteria.",
    );
  });

  it("approves with Always through the split-action menu", async () => {
    await renderView();
    await openAddMenu();
    await act(async () => {
      menuItemContaining("Always add similar").click();
      await Promise.resolve();
    });

    expect(guardrailApi.acceptTaskCandidate).toHaveBeenCalledWith(
      "workspace-1",
      "candidate-1",
      { title: undefined, always: true },
    );
  });
});
