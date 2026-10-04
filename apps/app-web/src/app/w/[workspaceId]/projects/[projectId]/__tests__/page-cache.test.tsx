// @vitest-environment jsdom
/**
 * [COMP:app-web/surface-cache-tail] The Project page paints from the surface
 * cache (instant-navigation contract N1 / N3 / N4 / N7).
 *
 * (a) A warmed `project:<wid>:<viewer>:<id>` key (+ the shared
 * `assistants:<wid>` slot) paints the page on the FIRST frame while both
 * fetches are still pending - no skeleton, no "Loading context..." sentence.
 * (b) A mark-stale repaints behind the paint: the page stays up while the
 * revalidation runs, then updates.
 */

import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  getProject: vi.fn(),
  authFetch: vi.fn(),
  listAssistants: vi.fn(),
}));

vi.mock("@/lib/api/context-scopes", () => ({
  getContextProject: (...args: unknown[]) => api.getProject(...args),
  updateContextProject: vi.fn(),
  setContextProjectMember: vi.fn(),
  setContextProjectAssistant: vi.fn(),
}));
// The content panel has its own cache/router tests; this suite exercises the page bundle.
vi.mock("@/components/projects/project-content", () => ({ ProjectContent: () => <section data-testid="project-content" /> }));
vi.mock("@/lib/api/studio", () => ({
  listAssistants: (...args: unknown[]) => api.listAssistants(...args),
}));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: (...args: unknown[]) => api.authFetch(...args) }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => ({ role: "admin" }) }));
vi.mock("@/lib/i18n/client", () => ({
  useT: () => ({ contextScope: new Proxy({}, { get: (_target, key) => String(key) }) }),
}));
vi.mock("@/components/ui/back-button", () => ({ BackButton: () => <div data-testid="back" /> }));
vi.mock("@/components/ui/checkbox", () => ({
  Checkbox: ({ checked }: { checked?: boolean }) => <span data-checked={checked ? "true" : "false"} />,
}));

import ProjectDetailPage from "../page";
import { assistantsCacheKey, projectDetailCacheKey } from "@/lib/surface-prefetch";
import { loadSurfaceCache, markSurfaceCacheStale, resetSurfaceCache } from "@/lib/surface-cache";

const PROJECT = {
  id: "project-1",
  workspaceId: "workspace-1",
  name: "Atlas",
  normalizedName: "atlas",
  description: "Launch work",
  icon: "🚀",
  status: "active" as const,
  entityId: null,
  members: [{ userId: "user-1", role: "lead" as const, name: "Ari", email: null }],
  assistantIds: ["assistant-1"],
  aggregates: { tasks: 4, pages: 2, workflows: 1 },
};
const BUNDLE = { project: PROJECT, members: [{ userId: "user-1", userName: "Ari" }] };
const ASSISTANTS = [{ id: "assistant-1", name: "Brian", workspaceId: "workspace-1", channels: [] }];

const KEY = projectDetailCacheKey("workspace-1", "project-1");
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const pending = () => new Promise<never>(() => {});

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const params = Promise.resolve({ workspaceId: "workspace-1", projectId: "project-1" });

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => {
    root?.render(<ProjectDetailPage params={params} />);
    await settle();
  });
}

const skeleton = () => container!.querySelector('[data-testid="project-skeleton"]');

beforeEach(() => {
  resetSurfaceCache();
  vi.clearAllMocks();
  api.getProject.mockImplementation(pending);
  api.authFetch.mockImplementation(pending);
  api.listAssistants.mockImplementation(pending);
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/surface-cache-tail] Project page from the surface cache", () => {
  it("paints a cold entry as the page skeleton, never the loading sentence", async () => {
    await mount();
    expect(skeleton()).not.toBeNull();
    expect(container!.textContent).not.toContain("loading");
  });

  it("first paint from warmed keys renders the project and its assistants while both fetches are pending", async () => {
    await loadSurfaceCache(KEY, async () => BUNDLE);
    await loadSurfaceCache(assistantsCacheKey("workspace-1"), async () => ASSISTANTS);
    markSurfaceCacheStale(KEY);
    await mount();
    expect(api.getProject).toHaveBeenCalledTimes(1);
    expect(skeleton()).toBeNull();
    expect(container!.textContent).toContain("Atlas");
    expect(container!.textContent).toContain("Ari");
    expect(container!.textContent).toContain("Brian");
    // The edit drafts seed from the cached row too.
    expect(container!.querySelector('input[value="Atlas"]')).toBeTruthy();
  });

  it("a mark-stale repaints behind the paint: the page stays up, then updates", async () => {
    await loadSurfaceCache(KEY, async () => BUNDLE);
    await loadSurfaceCache(assistantsCacheKey("workspace-1"), async () => ASSISTANTS);
    let release: (value: typeof BUNDLE) => void = () => {};
    api.getProject.mockImplementation(
      () => new Promise<typeof PROJECT>((resolve) => { release = (bundle) => resolve(bundle.project); }),
    );
    api.authFetch.mockResolvedValue(new Response(JSON.stringify({ members: BUNDLE.members })));
    await mount();
    expect(api.getProject).not.toHaveBeenCalled();

    await act(async () => {
      markSurfaceCacheStale("project:workspace-1");
      await settle();
    });
    expect(api.getProject).toHaveBeenCalledTimes(1);
    expect(container!.textContent).toContain("Atlas");
    expect(skeleton()).toBeNull();

    await act(async () => {
      release({ ...BUNDLE, project: { ...PROJECT, name: "Atlas v2" } });
      await settle();
    });
    expect(container!.textContent).toContain("Atlas v2");
  });
});
