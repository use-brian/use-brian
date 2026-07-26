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

vi.mock("@/lib/api/tasks", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api/tasks")>();
  return {
    ...actual,
    fetchWorkspaceTasks: taskApi.fetchWorkspaceTasks,
    bulkTasks: taskApi.bulkTasks,
  };
});

vi.mock("@/lib/api/workspace-roster", () => ({
  loadWorkspaceRoster: vi.fn().mockResolvedValue([]),
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
    attributes: {},
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
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/tasks-surface] current-filter select all", () => {
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
});
