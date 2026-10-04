// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { loadSurfaceCache, resetSurfaceCache } from "@/lib/surface-cache";
import { surfaceDataKey } from "@/lib/surface-prefetch";
import { ProjectsBrowser } from "../projects-browser";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), archive: vi.fn(), update: vi.fn(), confirm: vi.fn(), role: "owner", workspaceId: "workspace-1" }));
vi.mock("@/lib/api/context-scopes", () => ({ listContextProjects: mocks.list, createContextProject: mocks.create, archiveContextProject: mocks.archive, updateContextProject: mocks.update }));
vi.mock("@/lib/workspace-context", () => ({ useWorkspaceContext: () => ({ workspaceId: mocks.workspaceId, role: mocks.role }) }));
vi.mock("@/lib/surface-prefetch", async original => ({ ...await original<typeof import("@/lib/surface-prefetch")>(), useIntentPrefetch: () => () => ({}) }));
vi.mock("@/components/ui/confirm-dialog", () => ({ confirmDialog: mocks.confirm }));
vi.mock("next/link", () => ({ default: ({ href, children, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props}>{children}</a> }));
const project = (id: string, name: string, status = "active") => ({ id, name, status, description: "Launch work", icon: null });
let host: HTMLDivElement, root: Root;
const render = () => act(async () => { root.render(<I18nProvider locale="en" dict={en}><ProjectsBrowser /></I18nProvider>); });
const button = (label: string) => [...host.querySelectorAll("button")].find(node => node.textContent === label)!;
async function fill(label: string, value: string) {
  const input = host.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`)!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value); input.dispatchEvent(new Event("input", { bubbles: true })); });
}
beforeEach(() => {
  vi.clearAllMocks(); resetSurfaceCache(); mocks.role = "owner"; mocks.workspaceId = "workspace-1";
  mocks.list.mockResolvedValue([project("p1", "Atlas"), project("p2", "Beacon", "archived")]);
  mocks.confirm.mockResolvedValue(true);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe("[COMP:app-web/projects-browser] workspace projects", () => {
  it("separates active and archived projects and searches without an access-readiness request", async () => {
    await render();
    expect(host.querySelector('a[href="/w/workspace-1/projects/p1"]')?.textContent).toContain("Atlas");
    expect(host.textContent).not.toContain("Beacon");
    expect(mocks.list).toHaveBeenCalledWith("workspace-1", true);
    expect(host.textContent).not.toContain(en.contextScope.notReady);
    await fill(en.contextScope.searchProjects, "missing");
    expect(host.textContent).toContain(en.contextScope.noMatchingProjects);
    await fill(en.contextScope.searchProjects, "");
    await act(async () => button(en.contextScope.archived).click());
    expect(host.textContent).toContain("Beacon");
    expect(host.textContent).not.toContain("Atlas");
    await act(async () => button(en.contextScope.restoreProject).click());
    expect(mocks.update).toHaveBeenCalledWith("workspace-1", "p2", { status: "active" });
  });
  it("creates a project and confirms archival through the existing API", async () => {
    await render(); await fill(en.contextScope.projectNameLabel, "  Launch  ");
    await act(async () => host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })));
    expect(mocks.create).toHaveBeenCalledWith("workspace-1", { name: "Launch" });
    mocks.confirm.mockResolvedValueOnce(false);
    await act(async () => button(en.contextScope.archiveProject).click());
    expect(mocks.archive).not.toHaveBeenCalled();
    await act(async () => button(en.contextScope.archiveProject).click());
    expect(mocks.archive).toHaveBeenCalledWith("workspace-1", "p1");
  });
  it("lets members browse without management actions", async () => {
    mocks.role = "member"; await render();
    expect(host.textContent).toContain("Atlas");
    expect(host.querySelector("form")).toBeNull();
    expect(button(en.contextScope.archiveProject)).toBeUndefined();
  });
  it("paints cached rows immediately and resets inputs when switching workspace", async () => {
    await loadSurfaceCache(surfaceDataKey("projects", "workspace-1")!, async () => [project("cached", "Cached initiative")]);
    mocks.list.mockImplementation(() => new Promise(() => {}));
    await render(); expect(host.textContent).toContain("Cached initiative");
    expect(host.querySelector('[aria-busy="true"]')).toBeNull();
    await fill(en.contextScope.searchProjects, "old query");
    mocks.workspaceId = "workspace-2"; await render();
    expect(host.textContent).not.toContain("Cached initiative");
    expect(host.querySelector<HTMLInputElement>(`input[aria-label="${en.contextScope.searchProjects}"]`)?.value).toBe("");
    expect(host.querySelector('[aria-busy="true"]')).not.toBeNull();
  });
  it("shows a failed fetch without pretending the workspace has no projects and permits retry", async () => {
    mocks.list.mockRejectedValueOnce(new Error("Unavailable")); await render();
    expect(host.querySelector('[role="alert"]')?.textContent).toContain(en.contextScope.loadFailed);
    expect(host.textContent).not.toContain(en.contextScope.noProjects);
    mocks.list.mockResolvedValue([project("p1", "Recovered")]);
    await act(async () => button(en.contextScope.retryProjects).click());
    expect(host.textContent).toContain("Recovered");
  });
});
