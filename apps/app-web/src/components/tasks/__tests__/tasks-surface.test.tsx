// @vitest-environment jsdom

/**
 * [COMP:app-web/tasks-surface] Filter-scoped selection.
 *
 * The Tasks surface owns the full client-side result set, so "Select all
 * matching" must select every row in the active URL filter (not every task in
 * the workspace). The action must also be reachable from board view, where
 * there are no row checkboxes.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { TaskRow } from "@/lib/api/tasks";
import { resetSurfaceCache } from "@/lib/surface-cache";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({
  search: "",
  replace: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/workspace-1/tasks",
  useRouter: () => ({ replace: navigation.replace }),
  useSearchParams: () => new URLSearchParams(navigation.search),
}));

const taskApi = vi.hoisted(() => ({
  fetchWorkspaceTasks: vi.fn(),
  bulkTasks: vi.fn(),
}));

const brainApi = vi.hoisted(() => ({
  deleteBrainRow: vi.fn(),
}));

const dialogs = vi.hoisted(() => ({
  promptDialog: vi.fn(),
}));

const guardrailApi = vi.hoisted(() => ({
  loadTaskCandidates: vi.fn(),
  acceptTaskCandidate: vi.fn(),
  dismissTaskCandidate: vi.fn(),
  loadTaskRules: vi.fn(),
  loadTaskTombstones: vi.fn(),
  setTaskRuleStatus: vi.fn(),
  deleteTaskRule: vi.fn(),
  deleteTaskTombstone: vi.fn(),
}));

vi.mock("@/lib/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
  return {
    ...actual,
    fetchWorkspaceTasks: taskApi.fetchWorkspaceTasks,
    bulkTasks: taskApi.bulkTasks,
  };
});

vi.mock("@/lib/api/brain-inbox", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/brain-inbox")>();
  return { ...actual, deleteBrainRow: brainApi.deleteBrainRow };
});

vi.mock("@/components/ui/prompt-dialog", () => ({
  promptDialog: dialogs.promptDialog,
}));

vi.mock("@/lib/api/workspace-roster", () => ({
  loadWorkspaceRoster: vi.fn().mockResolvedValue([]),
}));

// The suggestions tray ([COMP:app-web/task-suggestions]) mounts alongside the
// table and fetches its own candidates. Stub it empty — this file is about
// filter-scoped selection, and an unstubbed tray would put a real network call
// inside `act`.
vi.mock("@/lib/api/task-guardrails", () => ({
  ...guardrailApi,
  describeTaskRulePredicate: vi.fn(() => ""),
}));

vi.mock("@/components/operator/operator-topbar", () => ({
  OperatorTopbar: ({ right }: { right?: React.ReactNode }) => <div>{right}</div>,
}));

vi.mock("@/components/operator/filter-bar", () => ({
  FilterBar: () => <div data-testid="filter-bar" />,
  ViewOptionRow: () => null,
  ViewOptionSection: ({ children }: { children?: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../task-cells", () => ({
  AssigneeCell: () => null,
  DueCell: () => null,
  PriorityCell: () => null,
  ProjectCell: () => null,
  StatusCell: () => null,
  STATUS_DOT: {},
}));

vi.mock("../task-board", () => ({
  TaskBoard: () => <div data-testid="task-board" />,
}));

vi.mock("../task-record-detail", () => ({
  TaskRecordDetail: () => null,
}));

import { TasksSurface } from "../tasks-surface";

const rows: TaskRow[] = [
  {
    id: "task-unassigned",
    title: "Unassigned task",
    status: "todo",
    assigneeId: null,
    due: null,
    tags: [],
    parentId: null,
    attributes: { icon: "🚀" },
    updatedAt: "2026-07-26T09:00:00.000Z",
  },
  {
    id: "task-assigned",
    title: "Assigned task",
    status: "todo",
    assigneeId: "member-1",
    due: null,
    tags: [],
    parentId: null,
    attributes: {},
    updatedAt: "2026-07-26T08:00:00.000Z",
  },
];

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderSurface() {
  if (!container) {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  }
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <TasksSurface workspaceId="workspace-1" />
      </I18nProvider>,
    );
    await Promise.resolve();
  });
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...container!.querySelectorAll("button")].find(
    (candidate) => candidate.textContent?.trim() === name,
  );
  if (!button) throw new Error(`Button not found: ${name}`);
  return button;
}

beforeEach(() => {
  navigation.search = "";
  navigation.replace.mockReset();
  taskApi.fetchWorkspaceTasks.mockReset();
  taskApi.fetchWorkspaceTasks.mockResolvedValue(rows);
  taskApi.bulkTasks.mockReset();
  taskApi.bulkTasks.mockImplementation(
    async (_workspaceId: string, body: { ids: string[] }) => ({
      ok: true,
      results: body.ids.map((id) => ({ id, ok: true })),
    }),
  );
  brainApi.deleteBrainRow.mockReset().mockResolvedValue({ ok: true });
  dialogs.promptDialog.mockReset().mockResolvedValue(null);
  guardrailApi.loadTaskCandidates.mockReset().mockResolvedValue([]);
  guardrailApi.loadTaskRules.mockReset().mockResolvedValue([]);
  guardrailApi.loadTaskTombstones.mockReset().mockResolvedValue([]);
  // The surface reads its list through the module-level surface cache
  // ([COMP:app-web/surface-cache]), which deliberately OUTLIVES a mount so a
  // revisit paints instantly. That means one case's rows would still be cached
  // and fresh when the next mounts, and its `mockResolvedValue` would never be
  // consulted. Clear it between cases.
  resetSurfaceCache();
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/tasks-surface] current-filter select all", () => {
  it("renders an assigned icon immediately before the task title", async () => {
    await renderSurface();

    const titleButton = container!.querySelector(
      'button[title="Open task"]',
    );
    expect(titleButton?.textContent).toBe("🚀Unassigned task");
  });

  it("opens task rules from the Tasks top bar", async () => {
    await renderSurface();

    await act(async () => {
      buttonNamed("Task rules").click();
    });
    expect(navigation.replace).toHaveBeenCalledWith(
      "/w/workspace-1/tasks?task-settings=rules",
      { scroll: false },
    );

    navigation.search = "task-settings=rules";
    await renderSurface();
    expect(container!.querySelector('aside[aria-label="Task rules"]')).toBeTruthy();
  });

  it("selects only tasks matching the active URL filter", async () => {
    navigation.search = "assignee=none";
    await renderSurface();

    expect(container!.textContent).toContain("Select all 1 matching");
    await act(async () => {
      buttonNamed("Select all 1 matching").click();
    });

    expect(container!.textContent).toContain("1 selected");
    expect(container!.textContent).not.toContain("2 selected");
  });

  it("is available in board view, where row checkboxes are absent", async () => {
    navigation.search = "assignee=none&view=board";
    await renderSurface();

    expect(container!.querySelector('[data-testid="task-board"]')).toBeTruthy();
    await act(async () => {
      buttonNamed("Select all 1 matching").click();
    });

    expect(container!.textContent).toContain("1 selected");
  });

  it("promotes a partial row selection to every matching task", async () => {
    await renderSurface();

    const firstRowCheckbox = container!.querySelector(
      '[aria-label="Select task: Unassigned task"]',
    ) as HTMLElement;
    await act(async () => {
      firstRowCheckbox.click();
    });

    expect(container!.textContent).toContain("1 selected");
    await act(async () => {
      buttonNamed("Select all 2 matching").click();
    });
    expect(container!.textContent).toContain("2 selected");
  });

  it("does not resurrect a selected task after it leaves the filter", async () => {
    await renderSurface();

    const assignedCheckbox = container!.querySelector(
      '[aria-label="Select task: Assigned task"]',
    ) as HTMLElement;
    await act(async () => {
      assignedCheckbox.click();
    });
    expect(container!.textContent).toContain("1 selected");

    navigation.search = "assignee=none";
    await renderSurface();
    expect(container!.textContent).not.toContain("1 selected");

    navigation.search = "";
    await renderSurface();
    expect(container!.textContent).not.toContain("1 selected");
    expect(container!.textContent).toContain("Select all 2 matching");
  });

  it("batches a large filtered selection within the server's 200-id cap", async () => {
    const manyRows = Array.from({ length: 201 }, (_, index) => ({
      ...rows[0]!,
      id: `task-${index}`,
      title: `Task ${index}`,
    }));
    taskApi.fetchWorkspaceTasks.mockResolvedValue(manyRows);
    taskApi.bulkTasks.mockImplementation(
      async (_workspaceId: string, body: { ids: string[] }) => ({
        ok: true,
        results: body.ids.map((id) => ({ id, ok: true })),
      }),
    );
    // The batch contract is independent of table rendering. Exercise it from
    // board view so this test does not build 201 irrelevant table rows while
    // the full app-web suite is competing for CPU in CI.
    navigation.search = "view=board";
    await renderSurface();

    await act(async () => {
      buttonNamed("Select all 201 matching").click();
    });
    await act(async () => {
      buttonNamed("Archive").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(taskApi.bulkTasks).toHaveBeenCalledTimes(2);
    expect(taskApi.bulkTasks.mock.calls.map((call) => call[1].ids.length)).toEqual([
      200,
      1,
    ]);
  });

  it("requires one reason and teaches from every task in a bulk delete", async () => {
    dialogs.promptDialog.mockResolvedValue(
      "Slack discussion about existing work is not a new task.",
    );
    await renderSurface();

    await act(async () => {
      buttonNamed("Select all 2 matching").click();
    });
    await act(async () => {
      buttonNamed("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(dialogs.promptDialog).toHaveBeenCalledWith({
      title: "Delete tasks and teach Brian",
      description:
        "Tell Brian why these 2 tasks should not exist. They will be deleted, and each task will add its own narrow active rule. Leave it blank to just delete them.",
      placeholder:
        "Example: Discussion about an existing task is context, not a new commitment.",
      confirmLabel: "Delete and add rules",
      emptyConfirmLabel: "Delete 2 tasks",
      cancelLabel: "Cancel",
      multiline: true,
      allowEmpty: true,
    });
    expect(taskApi.bulkTasks).toHaveBeenCalledOnce();
    expect(taskApi.bulkTasks).toHaveBeenCalledWith("workspace-1", {
      action: "delete",
      ids: ["task-unassigned", "task-assigned"],
      reason: "Slack discussion about existing work is not a new task.",
      create_rule: true,
    });
    expect(brainApi.deleteBrainRow).not.toHaveBeenCalled();
  });

  it("removes the complete selection in one paint before the bulk request settles", async () => {
    let resolveBulk!: (value: {
      ok: boolean;
      results: { id: string; ok: boolean }[];
    }) => void;
    taskApi.bulkTasks.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveBulk = resolve;
        }),
    );
    dialogs.promptDialog.mockResolvedValue("");
    await renderSurface();

    await act(async () => {
      buttonNamed("Select all 2 matching").click();
    });
    await act(async () => {
      buttonNamed("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(taskApi.bulkTasks).toHaveBeenCalledOnce();
    expect(container!.textContent).not.toContain("Unassigned task");
    expect(container!.textContent).not.toContain("Assigned task");

    await act(async () => {
      resolveBulk({
        ok: true,
        results: rows.map((row) => ({ id: row.id, ok: true })),
      });
      await Promise.resolve();
    });
  });

  it("sends the shared reason through the large-selection server lane", async () => {
    const manyRows = Array.from({ length: 51 }, (_, index) => ({
      ...rows[0]!,
      id: `task-${index}`,
      title: `Task ${index}`,
    }));
    taskApi.fetchWorkspaceTasks.mockResolvedValue(manyRows);
    taskApi.bulkTasks.mockImplementation(
      async (_workspaceId: string, body: { ids: string[] }) => ({
        ok: true,
        results: body.ids.map((id) => ({ id, ok: true })),
      }),
    );
    dialogs.promptDialog.mockResolvedValue("This is recurring Slack discussion.");
    navigation.search = "view=board";
    await renderSurface();

    await act(async () => {
      buttonNamed("Select all 51 matching").click();
    });
    await act(async () => {
      buttonNamed("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(taskApi.bulkTasks).toHaveBeenCalledWith("workspace-1", {
      action: "delete",
      ids: manyRows.map((row) => row.id),
      reason: "This is recurring Slack discussion.",
      create_rule: true,
    });
    expect(brainApi.deleteBrainRow).not.toHaveBeenCalled();
  });

  it("restores only the unconfirmed tail when a later delete batch loses transport", async () => {
    const manyRows = Array.from({ length: 201 }, (_, index) => ({
      ...rows[0]!,
      id: `task-${index}`,
      title: `Task ${index}`,
    }));
    taskApi.fetchWorkspaceTasks.mockResolvedValue(manyRows);
    taskApi.bulkTasks
      .mockResolvedValueOnce({
        ok: true,
        results: manyRows
          .slice(0, 200)
          .map((row) => ({ id: row.id, ok: true })),
      })
      .mockRejectedValueOnce(new Error("network lost"));
    dialogs.promptDialog.mockResolvedValue("");
    navigation.search = "view=board";
    await renderSurface();

    await act(async () => {
      buttonNamed("Select all 201 matching").click();
    });
    await act(async () => {
      buttonNamed("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(taskApi.bulkTasks).toHaveBeenCalledTimes(2);
    expect(container!.textContent).toContain("1 selected");
    expect(container!.textContent).toContain(
      "1 of 201 changes failed. The failed rows stay selected so you can retry.",
    );
  });

  it("deletes without a tombstone or rule when the reason is left blank", async () => {
    dialogs.promptDialog.mockResolvedValue("");
    await renderSurface();

    await act(async () => {
      buttonNamed("Select all 2 matching").click();
    });
    await act(async () => {
      buttonNamed("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(taskApi.bulkTasks).toHaveBeenCalledWith("workspace-1", {
      action: "delete",
      ids: ["task-unassigned", "task-assigned"],
    });
    expect(brainApi.deleteBrainRow).not.toHaveBeenCalled();
    expect(container!.textContent).not.toContain("Enter at least 3 characters.");
  });

  it("restores and reselects only failed bulk-delete rows", async () => {
    dialogs.promptDialog.mockResolvedValue("");
    taskApi.fetchWorkspaceTasks
      .mockReset()
      .mockResolvedValueOnce(rows)
      .mockResolvedValue([rows[1]!]);
    taskApi.bulkTasks.mockResolvedValue({
      ok: false,
      // A missing per-id outcome is treated as failure, not silent success.
      results: [{ id: "task-unassigned", ok: true }],
    });
    await renderSurface();

    await act(async () => {
      buttonNamed("Select all 2 matching").click();
    });
    await act(async () => {
      buttonNamed("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(container!.textContent).not.toContain("Unassigned task");
    expect(container!.textContent).toContain("Assigned task");
    expect(container!.textContent).toContain("1 selected");
  });

  it("omits reason and create_rule on the server lane for a blank reason", async () => {
    const manyRows = Array.from({ length: 51 }, (_, index) => ({
      ...rows[0]!,
      id: `task-${index}`,
      title: `Task ${index}`,
    }));
    taskApi.fetchWorkspaceTasks.mockResolvedValue(manyRows);
    taskApi.bulkTasks.mockImplementation(
      async (_workspaceId: string, body: { ids: string[] }) => ({
        ok: true,
        results: body.ids.map((id) => ({ id, ok: true })),
      }),
    );
    dialogs.promptDialog.mockResolvedValue("");
    navigation.search = "view=board";
    await renderSurface();

    await act(async () => {
      buttonNamed("Select all 51 matching").click();
    });
    await act(async () => {
      buttonNamed("Delete").click();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(taskApi.bulkTasks).toHaveBeenCalledWith("workspace-1", {
      action: "delete",
      ids: manyRows.map((row) => row.id),
    });
  });

  it("keeps the selection when a bulk-delete reason is too short", async () => {
    dialogs.promptDialog.mockResolvedValue("no");
    await renderSurface();

    await act(async () => {
      buttonNamed("Select all 2 matching").click();
    });
    await act(async () => {
      buttonNamed("Delete").click();
      await Promise.resolve();
    });

    expect(brainApi.deleteBrainRow).not.toHaveBeenCalled();
    expect(taskApi.bulkTasks).not.toHaveBeenCalled();
    expect(container!.textContent).toContain("2 selected");
    expect(container!.textContent).toContain("Enter at least 3 characters.");
  });
});
