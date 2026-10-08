// @vitest-environment jsdom
/**
 * [COMP:app-web/workflow-detail-cache] The workflow detail page paints from
 * the cache and never clobbers an edit (instant-navigation contract N1-N4;
 * realtime-sync.md -> "Editable-draft surfaces").
 *
 * Four things pinned: a warmed `workflow-detail:` key renders the board on
 * the first frame with no fetch; a cold entry seeds the header from the
 * `workflow:<wid>` list row the user came from and paints a board skeleton,
 * never "…"; a spine mark-stale that lands while the draft is DIRTY leaves
 * the edit exactly as typed; the same mark-stale on a CLEAN draft adopts the
 * revalidated row.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { format } from "@/lib/i18n";
import {
  loadSurfaceCache,
  markSurfaceCacheStale,
  resetSurfaceCache,
} from "@/lib/surface-cache";
import { surfaceDataKey, workflowDetailCacheKey } from "@/lib/surface-prefetch";
import type { WorkflowFull, WorkflowSummary } from "@/lib/api/workflow";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), prefetch: vi.fn() }),
  usePathname: () => "/w/w1/workflow/wf-1",
}));

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

vi.mock("@/lib/i18n/client", () => ({
  useT: () => en,
  useLocale: () => "en",
  format,
}));

vi.mock("@/contexts/workspace-context", () => ({
  useWorkspaces: () => ({ workspaces: [], activeId: "w1", active: null, setActive: vi.fn() }),
}));

// Publication authority has its own component tests; keep this cache test offline.
vi.mock("@/components/workflow/publication-consent", () => ({ WorkflowPublicationConsent: () => null }));

vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: vi.fn() }));
vi.mock("@/components/context/context-scope-picker", () => ({
  ContextScopePicker: () => <div data-testid="context-scope" />,
}));

const api = vi.hoisted(() => ({
  getWorkflowFull: vi.fn<() => Promise<WorkflowFull | null>>(),
  runWorkflowNow: vi.fn(),
}));

vi.mock("@/lib/api/workflow", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/workflow")>()),
  getWorkflowFull: api.getWorkflowFull,
  runWorkflowNow: api.runWorkflowNow,
  listChannelDestinations: async () => [],
  listWorkspaceChannelOptions: async () => [],
  listWorkspaceSlackChannels: async () => [],
  listConnectedWorkflowToolSources: async () => [],
}));
vi.mock("@/lib/api/studio", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/studio")>()),
  listAssistants: async () => [],
}));
vi.mock("@/lib/api/views", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/views")>()),
  listViews: async () => [],
  listCustomPageTemplates: async () => [],
}));
vi.mock("@/lib/api/skills", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/skills")>()),
  listWorkspaceSkills: async () => [],
}));
vi.mock("@/lib/api/context-scopes", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/api/context-scopes")>()),
  listContextTeams: async () => [],
  listContextProjects: async () => [],
}));
// The live-run poller is not under test; the pure helpers stay real.
vi.mock("@/lib/workflow-live-run", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/workflow-live-run")>()),
  useWorkflowLiveRun: () => ({ runs: [], liveRun: null, liveView: null, pollNow: vi.fn() }),
}));

import WorkflowDetailPage from "../page";

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

const LIST_ROW: WorkflowSummary = {
  id: "wf-1",
  workspaceId: "w1",
  name: "Morning digest",
  description: "Summarise overnight mail",
  enabled: false,
  trigger: { kind: "manual" },
  stepCount: 1,
  updatedAt: "2026-09-01T00:00:00.000Z",
};

function settledParams<T>(value: T): Promise<T> {
  return Object.assign(Promise.resolve(value), { status: "fulfilled", value });
}
const PARAMS = settledParams({ workspaceId: "w1", id: "wf-1" });

const pending = <T,>() => new Promise<T>(() => {});
const settle = () => act(async () => { await new Promise((r) => setTimeout(r, 0)); });

let root: Root;
let container: HTMLDivElement;

async function render() {
  await act(async () => {
    root.render(<WorkflowDetailPage params={PARAMS} />);
  });
  await settle();
}

/** Open the in-place name field and type into it the way a user would. */
async function typeName(next: string) {
  const edit = container.querySelector<HTMLButtonElement>(
    `button[aria-label="${en.workflowPage.builder.editNameAction}"]`,
  );
  expect(edit).not.toBeNull();
  await act(async () => { edit!.click(); });
  const input = container.querySelector<HTMLInputElement>('input[maxlength="120"]');
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    setter.call(input, next);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return input!;
}

beforeEach(() => {
  resetSurfaceCache();
  api.getWorkflowFull.mockReset();
  api.runWorkflowNow.mockReset();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe("[COMP:app-web/workflow-detail-cache] detail page", () => {
  it("warns to check history without retrying when a completed result loses access", async () => {
    await loadSurfaceCache(workflowDetailCacheKey("w1", "wf-1"), async () => WF);
    api.getWorkflowFull.mockImplementation(pending);
    api.runWorkflowNow.mockResolvedValue({ unavailable: true, operationMayHaveExecuted: true });
    await render();
    const button = [...container.querySelectorAll("button")].find(node => node.textContent === en.workflowPage.builder.runNowBtn);
    expect(button).toBeDefined();
    await act(async () => { button!.click(); });
    await settle();
    expect(container.textContent).toContain(en.workflowPage.builder.runResultUnavailable);
    expect(container.textContent).not.toContain(en.workflowPage.builder.runFail);
    expect(api.runWorkflowNow).toHaveBeenCalledTimes(1);
  });
  it("renders the board from a warmed key while the fetch is still pending (no fetch of its own)", async () => {
    await loadSurfaceCache(workflowDetailCacheKey("w1", "wf-1"), async () => WF);
    api.getWorkflowFull.mockImplementation(pending);

    await render();

    expect(container.textContent).toContain("Morning digest");
    // The board painted: its trigger node is on screen.
    expect(container.querySelector('[data-node-key="__trigger"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="workflow-detail-entry"]')).toBeNull();
    expect(container.textContent).not.toContain("…");
    expect(api.getWorkflowFull).not.toHaveBeenCalled();
  });

  it("seeds the header from the list row on a cold entry and paints a board skeleton, never a sentence", async () => {
    await loadSurfaceCache(surfaceDataKey("workflow", "w1")!, async () => [LIST_ROW]);
    api.getWorkflowFull.mockImplementation(pending);

    await render();

    const frame = container.querySelector('[data-testid="workflow-detail-entry"]');
    expect(frame).not.toBeNull();
    expect(frame?.querySelector("h1")?.textContent).toBe("Morning digest");
    expect(frame?.textContent).toContain("Summarise overnight mail");
    // The list row said disabled, so the badge is already right.
    expect(frame?.textContent).toContain(en.workflowPage.builder.disabledLabel);
    expect(container.textContent).not.toContain("…");
    expect(container.textContent).not.toMatch(/loading/i);
    expect(api.getWorkflowFull).toHaveBeenCalledTimes(1);
  });

  it("a spine mark-stale never clobbers a dirty draft", async () => {
    await loadSurfaceCache(workflowDetailCacheKey("w1", "wf-1"), async () => WF);
    api.getWorkflowFull.mockResolvedValue({
      ...WF,
      name: "Renamed elsewhere",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    await render();

    const input = await typeName("Morning digest (draft)");
    expect(container.textContent).toContain(en.workflowPage.builder.unsavedChanges);

    // Another tab / lane saved the workflow: the spine marks the row stale
    // and the page revalidates behind the paint...
    await act(async () => { markSurfaceCacheStale("workflow-detail:w1:"); });
    await settle();
    expect(api.getWorkflowFull).toHaveBeenCalledTimes(1);

    // ...but the draft is dirty, so the edit is exactly what was typed.
    expect(input.value).toBe("Morning digest (draft)");
    expect(container.textContent).not.toContain("Renamed elsewhere");
    expect(container.textContent).toContain(en.workflowPage.builder.unsavedChanges);
  });

  it("the same mark-stale on a clean draft adopts the revalidated row", async () => {
    await loadSurfaceCache(workflowDetailCacheKey("w1", "wf-1"), async () => WF);
    api.getWorkflowFull.mockResolvedValue({
      ...WF,
      name: "Renamed elsewhere",
      updatedAt: "2026-09-02T00:00:00.000Z",
    });
    await render();
    expect(container.textContent).toContain("Morning digest");

    await act(async () => { markSurfaceCacheStale("workflow-detail:w1:"); });
    await settle();

    // Repainted behind the rows: no skeleton frame at any point, new name in.
    expect(container.querySelector('[data-testid="workflow-detail-entry"]')).toBeNull();
    expect(container.textContent).toContain("Renamed elsewhere");
    expect(container.textContent).not.toContain(en.workflowPage.builder.unsavedChanges);
  });
});
