// @vitest-environment jsdom
/** [COMP:app-web/project-detail] Project aggregation and registry controls. */
import React, { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createRoot, type Root } from "react-dom/client";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({
  getProject: vi.fn(),
  updateProject: vi.fn(),
  setMember: vi.fn(),
  setAssistant: vi.fn(),
  authFetch: vi.fn(),
}));

vi.mock("@/lib/api/context-scopes", () => ({
  getContextProject: (...args: unknown[]) => api.getProject(...args),
  updateContextProject: (...args: unknown[]) => api.updateProject(...args),
  setContextProjectMember: (...args: unknown[]) => api.setMember(...args),
  setContextProjectAssistant: (...args: unknown[]) => api.setAssistant(...args),
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

let root: Root | null = null;
let container: HTMLDivElement | null = null;
const params = Promise.resolve({ workspaceId: "workspace-1", projectId: "project-1" });

async function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root?.render(<ProjectDetailPage params={params} />));
}

beforeEach(() => {
  vi.clearAllMocks();
  api.getProject.mockResolvedValue(PROJECT);
  api.authFetch
    .mockResolvedValueOnce(new Response(JSON.stringify({ members: [{ userId: "user-1", userName: "Ari" }] })))
    .mockResolvedValueOnce(new Response(JSON.stringify({ assistants: [{ id: "assistant-1", name: "Brian" }] })));
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

describe("[COMP:app-web/project-detail] Project detail", () => {
  it("aggregates existing scoped stores without copying their records", async () => {
    await mount();
    expect(container?.textContent).toContain("Atlas");
    expect(container?.textContent).toContain("Launch work");
    expect(container?.textContent).toContain("4");
    expect(container?.textContent).toContain("2");
    expect(container?.textContent).toContain("1");
  });

  it("shows participant, assistant, and editable registry controls to an admin", async () => {
    await mount();
    expect(container?.textContent).toContain("Ari");
    expect(container?.textContent).toContain("Brian");
    expect(container?.querySelector('input[value="Atlas"]')).toBeTruthy();
    expect(container?.textContent).toContain("saveProjectDetails");
  });
});
