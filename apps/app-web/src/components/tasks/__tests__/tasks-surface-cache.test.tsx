// @vitest-environment jsdom

/**
 * [COMP:app-web/tasks-surface] Instant-navigation contract on the Tasks
 * surface (N1 / N3 / N4) plus the phone row shape (responsive contract M1).
 *
 * Pinned: a warmed `tasks:<wid>` key paints the rows on the first frame with
 * the fetch still pending (no skeleton, no "Loading" sentence); the spine's
 * mark-stale repaints without a blank frame; a cold cache paints the
 * geometry-matched row skeleton, never a sentence; below `md` the rows are
 * stacked cards with a visible checkbox.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { TaskRow } from "@/lib/api/tasks";
import {
  loadSurfaceCache,
  evictSurfaceCacheKey,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { surfaceDataKey, workspaceMemberDirectoryCacheKey } from "@/lib/surface-prefetch";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  usePathname: () => "/w/workspace-1/tasks",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
  useSearchParams: () => new URLSearchParams(""),
}));

const taskApi = vi.hoisted(() => ({
  fetchWorkspaceTasks: vi.fn(),
  bulkTasks: vi.fn(),
}));
vi.mock("@/lib/api/tasks", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/tasks")>()),
  fetchWorkspaceTasks: taskApi.fetchWorkspaceTasks,
  bulkTasks: taskApi.bulkTasks,
}));
vi.mock("@/lib/api/brain-inbox", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/brain-inbox")>()),
  deleteBrainRow: vi.fn(),
}));
vi.mock("@/components/ui/prompt-dialog", () => ({ promptDialog: vi.fn() }));
vi.mock("@/lib/api/context-scopes", () => ({
  listContextProjects: vi.fn().mockResolvedValue([]),
  reclassifyContext: vi.fn(),
}));
const memberApi = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: (...args: unknown[]) => memberApi.fetch(...args) }));
vi.mock("@/lib/user", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/user")>()),
  getUserInfo: () => ({ id: "viewer-a" }),
  subscribeUserInfo: () => () => {},
}));
vi.mock("@/lib/api/task-guardrails", () => ({
  loadTaskCandidates: vi.fn().mockResolvedValue([]),
  acceptTaskCandidate: vi.fn(),
  dismissTaskCandidate: vi.fn(),
  loadTaskRules: vi.fn().mockResolvedValue([]),
  loadTaskTombstones: vi.fn().mockResolvedValue([]),
  setTaskRuleStatus: vi.fn(),
  deleteTaskRule: vi.fn(),
  deleteTaskTombstone: vi.fn(),
  describeTaskRulePredicate: vi.fn(() => ""),
}));
vi.mock("@/components/operator/operator-topbar", () => ({
  OperatorTopbar: ({ right }: { right?: React.ReactNode }) => <div>{right}</div>,
}));
vi.mock("@/components/operator/filter-bar", () => ({
  FilterBar: () => <div data-testid="filter-bar" />,
  ViewOptionRow: () => null,
  ViewOptionSection: ({ children }: { children?: React.ReactNode }) => <>{children}</>,
}));
vi.mock("../task-cells", () => ({
  AssigneeCell: ({ roster }: { roster: { id: string; userName: string }[] | null }) => <div data-assignee-options>{roster?.map(member => <span key={member.id} data-member-id={member.id}>{member.userName}</span>)}</div>,
  DueCell: () => null,
  PriorityCell: () => null,
  ProjectCell: () => null,
  StatusCell: () => <div data-testid="status-cell" />,
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
    id: "task-a",
    title: "Write the launch note",
    status: "todo",
    assigneeId: null,
    due: null,
    tags: [],
    parentId: null,
    attributes: {},
    updatedAt: "2026-09-09T09:00:00.000Z",
  },
  {
    id: "task-b",
    title: "Review the pricing page",
    status: "in_progress",
    assigneeId: null,
    due: null,
    tags: [],
    parentId: null,
    attributes: {},
    updatedAt: "2026-09-09T08:00:00.000Z",
  },
];

const key = surfaceDataKey("tasks", "workspace-1")!;

let container: HTMLDivElement | null = null;
let root: Root | null = null;

async function renderSurface() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root!.render(
      <I18nProvider locale="en" dict={en}>
        <TasksSurface workspaceId="workspace-1" />
      </I18nProvider>,
    );
    await Promise.resolve();
  });
}

const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });
const skeleton = () => container!.querySelector("[data-operator-skeleton]");

const originalMatchMedia = window.matchMedia;

beforeEach(() => {
  resetSurfaceCache();
  taskApi.fetchWorkspaceTasks.mockReset();
  memberApi.fetch.mockReset().mockResolvedValue(new Response(JSON.stringify({
    workspaceId: "workspace-1", viewerId: "viewer-a", validForMs: 30_000, members: [],
  })));
  window.history.replaceState(null, "", "/w/workspace-1/tasks");
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  window.matchMedia = originalMatchMedia;
});

describe("[COMP:app-web/tasks-surface] instant navigation", () => {
  it("paints the rows from a warmed key on the first frame with the fetch still pending", async () => {
    await loadSurfaceCache(key, async () => rows);
    taskApi.fetchWorkspaceTasks.mockReturnValue(new Promise<TaskRow[]>(() => {}));

    await renderSurface();

    expect(container!.textContent).toContain("Write the launch note");
    expect(container!.textContent).toContain("Review the pricing page");
    expect(skeleton()).toBeNull();
    expect(container!.textContent).not.toContain(en.tasksPage.loading);
    expect(taskApi.fetchWorkspaceTasks).not.toHaveBeenCalled();
  });

  it("repaints through a spine mark-stale without a blank frame", async () => {
    await loadSurfaceCache(key, async () => rows);
    let resolve!: (value: TaskRow[]) => void;
    taskApi.fetchWorkspaceTasks.mockReturnValue(new Promise<TaskRow[]>((r) => { resolve = r; }));
    await renderSurface();

    await act(async () => {
      markSurfaceCacheStale("tasks:workspace-1");
    });
    await settle();

    expect(container!.textContent).toContain("Write the launch note");
    expect(skeleton()).toBeNull();
    expect(taskApi.fetchWorkspaceTasks).toHaveBeenCalledTimes(1);

    await act(async () => {
      resolve([rows[0]!, { ...rows[1]!, title: "Review the pricing page (v2)" }]);
    });
    await settle();
    expect(container!.textContent).toContain("Review the pricing page (v2)");
  });

  it("paints the row skeleton, never a sentence, while a cold cache loads", async () => {
    taskApi.fetchWorkspaceTasks.mockReturnValue(new Promise<TaskRow[]>(() => {}));

    await renderSurface();

    expect(skeleton()?.getAttribute("data-operator-skeleton")).toBe("rows");
    expect(container!.textContent).not.toContain(en.tasksPage.loading);
  });
});

describe("[COMP:app-web/tasks-surface] phone row shape", () => {
  it("stacks each row into a card with a visible checkbox and an inline status select below md", async () => {
    window.matchMedia = ((query: string) => ({
      matches: query.includes("max-width"),
      media: query,
      onchange: null,
      addEventListener: () => {},
      removeEventListener: () => {},
      addListener: () => {},
      removeListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    await loadSurfaceCache(key, async () => rows);
    taskApi.fetchWorkspaceTasks.mockReturnValue(new Promise<TaskRow[]>(() => {}));

    await renderSurface();

    const cards = container!.querySelectorAll("[data-task-card-row]");
    expect(cards.length).toBe(2);
    expect(cards[0]!.querySelector('[role="checkbox"]')?.className).toContain("size-5");
    expect(cards[0]!.querySelector('[data-testid="status-cell"]')).toBeTruthy();
    expect(container!.querySelector(".md\\:min-w-\\[640px\\]")).toBeTruthy();
  });

  it("keeps the dense grid from md", async () => {
    await loadSurfaceCache(key, async () => rows);
    taskApi.fetchWorkspaceTasks.mockReturnValue(new Promise<TaskRow[]>(() => {}));

    await renderSurface();

    expect(container!.querySelectorAll("[data-task-card-row]").length).toBe(0);
    expect(container!.querySelector(".group\\/task")).toBeTruthy();
  });
});


describe("[COMP:app-web/tasks-surface] member directory recovery", () => {
  it("shows Retry after a failed roster read and populates choices without remounting", async () => {
    await loadSurfaceCache(key, async () => rows);
    memberApi.fetch.mockRejectedValueOnce(new Error("offline")).mockResolvedValue(new Response(JSON.stringify({
      workspaceId: "workspace-1", viewerId: "viewer-a", validForMs: 30_000,
      members: [{ memberId: "member-a", userId: "person-a", name: "Ari Example", email: "ari@example.com", avatarUrl: null, role: "member", canDraft: true }],
    })));
    await renderSurface();
    await settle();
    expect(container!.querySelector('[role="alert"]')?.textContent).toContain(en.tasksPage.membersUnavailable);
    const retry = Array.from(container!.querySelectorAll('button')).find(button => button.textContent === en.tasksPage.retryMembers)!;
    await act(async () => { retry.click(); await Promise.resolve(); });
    await settle();
    expect(container!.querySelector('[role="alert"]')).toBeNull();
    expect(container!.querySelector('[data-member-id="member-a"]')?.textContent).toBe('Ari Example');
    expect(memberApi.fetch).toHaveBeenCalledTimes(2);
  });
});


describe("[COMP:app-web/tasks-surface] bulk assignment directory lifetime", () => {
  it("disables an already-open bulk menu when its member directory disappears", async () => {
    await loadSurfaceCache(key, async () => rows);
    await renderSurface();
    await settle();
    const named = (label: string) => Array.from(document.querySelectorAll('button')).find(button => button.textContent?.trim() === label)!;
    await act(async () => { named('Select all 2 matching').click(); });
    await act(async () => { named(en.tasksPage.bulkAssign).click(); });
    await settle();
    expect(document.querySelector('[role="menuitem"]')).not.toBeNull();
    memberApi.fetch.mockReturnValue(new Promise<Response>(() => {}));
    await act(async () => { evictSurfaceCacheKey(workspaceMemberDirectoryCacheKey('workspace-1', 'viewer-a')); });
    await settle();
    const option = Array.from(document.querySelectorAll('[role="menuitem"]')).find(item => item.textContent?.trim() === en.tasksPage.unassignedOption);
    expect(option?.getAttribute('aria-disabled')).toBe('true');
  });
});
