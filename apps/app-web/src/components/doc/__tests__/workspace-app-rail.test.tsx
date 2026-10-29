// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { PopoverTrigger } from "@/components/ui/popover";
import { miniAppPinsKey, miniAppMenuOrderKey } from "@/lib/workspace-apps";
import type { WorkspaceSurface } from "@/lib/doc-page-url";
import type { HomeAppEntry } from "@/lib/operator-apps";
import type { CustomHomeApp } from "@/lib/api/home-apps";
import { WorkspaceAppRail, WorkspaceAppCatalogue } from "../workspace-app-rail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ pathname: "/w/workspace-a/tasks", user: { id: "person-a", name: "Test person", email: "person@example.test" } }));
vi.mock("next/navigation", () => ({ usePathname: () => state.pathname }));
vi.mock("next/link", () => ({ default: ({ href, children, onClick, ...props }: React.AnchorHTMLAttributes<HTMLAnchorElement>) => <a href={href} {...props} onClick={(event) => { event.preventDefault(); onClick?.(event); }}>{children}</a> }));
vi.mock("@/lib/surface-prefetch", () => ({ useIntentPrefetch: () => () => ({}) }));
vi.mock("@/lib/user", () => ({ getUserInfo: () => state.user, subscribeUserInfo: () => () => {} }));
vi.mock("@/lib/runtime-public-config", () => ({ publicRuntimeConfig: () => ({ apiUrl: "https://api.example.test" }) }));

describe("[COMP:app-web/workspace-app-rail] Chat Home and App store", () => {
  let container: HTMLDivElement;
  let root: Root;
  let customApps: CustomHomeApp[];
  let workspaceId: string;
  let homeApps: HomeAppEntry[];
  beforeEach(() => {
    localStorage.clear();
    workspaceId = "workspace-a";
    customApps = [];
    homeApps = ["chat", "tasks", "page", "crm", "office"];
    state.pathname = "/w/workspace-a/tasks";
    state.user.id = "person-a";
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    vi.stubGlobal("ResizeObserver", class { observe() {} unobserve() {} disconnect() {} });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });
  async function render(mobile = false, activeSurface: WorkspaceSurface = "tasks", liveCount = 0) {
    await act(async () => root.render(<I18nProvider locale="en" dict={en}><WorkspaceAppRail workspaceId={workspaceId} activeSurface={activeSurface} activeApp="tasks" homeApps={homeApps} customApps={customApps} liveCount={liveCount} studioNudge={false} onDismissStudioNudge={() => {}} mobile={mobile} /></I18nProvider>));
  }
  const button = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  const railLink = (name: string) => container.querySelector<HTMLAnchorElement>(`a[aria-label="${name}"]`);
  async function click(element: HTMLElement) { await act(async () => element.click()); }

  it.each([false, true])("keeps Live counts and navigation accessible through the capped badge (mobile: %s)", async (mobile) => {
    const close = vi.fn(); window.addEventListener("doc:sidebar-close", close);
    try {
      for (const count of [1, 99, 100]) {
        await render(mobile, "tasks", count);
        const live = container.querySelector<HTMLAnchorElement>('a[href="/w/workspace-a/live"]')!;
        const badge = live.querySelector('[data-live-active-count]')!;
        expect(badge.textContent).toBe(count > 99 ? "99+" : String(count));
        expect(badge.getAttribute("data-live-active-count")).toBe(String(count));
        expect(live.getAttribute("aria-label")).toBe(badge.getAttribute("aria-label"));
        expect(live.getAttribute("aria-label")).toContain(String(count));
        await click(live);
      }
      expect(close).toHaveBeenCalledTimes(3);
      await render(mobile);
      expect(container.querySelector('[data-live-active-count]')).toBeNull();
    } finally { window.removeEventListener("doc:sidebar-close", close); }
  });

  it("reveals a rail item's name after 100ms of hover", async () => {
    vi.useFakeTimers();
    await render();
    const projects = railLink(en.workspaceNav.projectsAndOrganization)!;
    const pointerEnter = new Event("pointerover", { bubbles: true });
    Object.defineProperty(pointerEnter, "pointerType", { value: "mouse" });
    await act(async () => {
      projects.dispatchEvent(pointerEnter);
      projects.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
      projects.dispatchEvent(new MouseEvent("mousemove", { bubbles: true }));
    });
    await act(async () => { await vi.advanceTimersByTimeAsync(99); });
    expect(document.querySelector('[data-app-tooltip][data-open]')).toBeNull();
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(document.querySelector('[data-app-tooltip][data-open]')?.textContent).toBe(en.workspaceNav.projectsAndOrganization);
  });

  it("reveals names on keyboard focus without waiting for the hover delay", async () => {
    vi.useFakeTimers();
    await render();
    await act(async () => {
      document.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", bubbles: true }));
      railLink(en.workspaceNav.projectsAndOrganization)!.focus();
    });
    expect(document.querySelector('[data-app-tooltip][data-open]')?.textContent).toBe(en.workspaceNav.projectsAndOrganization);
  });

  it("reserves the workspace menu above Home without a duplicate panel toggle", async () => {
    await render();
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe(en.workspaceNav.homeAria);
    const workspaceSlot = container.querySelector('[data-workspace-menu-slot]')!;
    // Exclude the overlaid menu button and the rail gutters from native dragging.
    expect(workspaceSlot.hasAttribute("data-no-drag")).toBe(true);
    expect(workspaceSlot.classList.contains("w-14")).toBe(true);
    expect(workspaceSlot.classList.contains("h-16")).toBe(true);
    expect(workspaceSlot.compareDocumentPosition(railLink(en.workspaceNav.homeAria)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('[data-workspace-sidebar-toggle]')).toBeNull();
    const more = button(en.workspaceNav.more);
    const divider = container.querySelector('[data-workspace-added-apps-divider]')!;
    expect(more.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it.each([false, true])("groups both setup views once above Studio outside the scrolling usage apps (mobile: %s)", async (mobile) => {
    const close = vi.fn(); window.addEventListener("doc:sidebar-close", close);
    try {
      for (const surface of ["projects", "organization"] as const) {
        state.pathname = `/w/${workspaceId}/${surface}`;
        await render(mobile, surface);
        const entry = railLink(en.workspaceNav.projectsAndOrganization)!;
        expect(entry.getAttribute("href")).toBe("/w/workspace-a/projects");
        expect(entry.getAttribute("aria-current")).toBe("page");
        expect(container.querySelectorAll("[data-workspace-structure-entry]")).toHaveLength(1);
        expect(container.querySelector('[data-workspace-app-rail-scroll]')!.contains(entry)).toBe(false);
        expect(entry.compareDocumentPosition(railLink(en.docPage.iconStudio)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
        expect(railLink(en.contextScope.projectsTitle)).toBeNull();
        expect(railLink(en.organization.title)).toBeNull();
        await click(entry);
      }
      expect(close).toHaveBeenCalledTimes(2);
      await render(mobile, "tasks");
      expect(railLink(en.workspaceNav.projectsAndOrganization)?.hasAttribute("aria-current")).toBe(false);
    } finally { window.removeEventListener("doc:sidebar-close", close); }
  });

  it.each([false, true])("keeps Chat only in Home while another mini-app is active (mobile: %s)", async (mobile) => {
    localStorage.setItem("doc:operator-app:workspace-a", "tasks");
    await render(mobile);
    expect(railLink(en.workspaceNav.homeAria)?.getAttribute("href")).toBe("/w/workspace-a/chat");
    expect(railLink(en.workspaceNav.homeAria)?.hasAttribute("aria-current")).toBe(false);
    await click(button(en.workspaceNav.more));
    expect(document.querySelector('a[aria-label="Open Chat"]')).toBeNull();
    expect(document.querySelector('button[aria-label="Pin Chat"]')).toBeNull();
    expect(document.querySelector('a[aria-label="Open Workflow"]')).toBeNull();
    expect(document.querySelector('a[aria-label="Open Organization"]')).toBeNull();
    await click(textButton(en.workspaceNav.reorderMenu));
    expect(menuIds()).toEqual(["tasks", "page", "crm", "office"]);
    expect(document.querySelector('button[aria-label="Move Chat up"]')).toBeNull();
    expect(button("Move Tasks up").disabled).toBe(true);
  });

  it.each([false, true])("pins every selected app, restores them after reload and unpins independently (mobile: %s)", async (mobile) => {
    await render(mobile);
    await click(button(en.workspaceNav.more));
    await click(button("Pin Tasks"));
    await click(button("Pin CRM"));
    expect(railLink("Tasks")?.getAttribute("href")).toBe("/w/workspace-a/tasks");
    expect(railLink("Tasks")?.getAttribute("aria-current")).toBe("page");
    expect(railLink("Tasks")?.closest("[data-workspace-added-apps]")).not.toBeNull();
    expect(button("Pin Office").disabled).toBe(false);
    expect(document.querySelector('[aria-live="polite"]')?.textContent).toBe(en.workspaceNav.caption);
    await click(button("Pin Office"));
    await click(button("Pin Page"));
    const key = miniAppPinsKey("https://api.example.test", "person-a", workspaceId);
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(["tasks", "crm", "office", "page"]);
    await act(async () => root.unmount());
    root = createRoot(container);
    await render(mobile);
    for (const name of ["Tasks", "CRM", "Office", "Page"]) expect(railLink(name)).not.toBeNull();
    await click(button(en.workspaceNav.more));
    await click(button("Unpin Tasks"));
    expect(railLink("Tasks")).toBeNull();
    expect(JSON.parse(localStorage.getItem(key)!)).toEqual(["crm", "office", "page"]);
    expect(railLink("Office")).not.toBeNull();
    expect(button("Pin Tasks").disabled).toBe(false);
  });

  it("restores a large saved pin list without a replacement count limit", async () => {
    customApps = Array.from({ length: 70 }, (_, index) => ({
      id: `app-${index}`, name: `Dashboard ${index}`, status: "active", renderable: true,
    } as CustomHomeApp));
    const ids = customApps.map(app => `custom:${app.id}` as const);
    homeApps = ["chat", ...ids];
    localStorage.setItem(miniAppPinsKey("https://api.example.test", "person-a", workspaceId), JSON.stringify(ids));
    await render();
    expect(container.querySelectorAll('[data-workspace-added-apps] a')).toHaveLength(70);
    expect(railLink("Dashboard 69")).not.toBeNull();
    const scroll = container.querySelector('[data-workspace-app-rail-scroll]')!;
    expect(scroll.contains(railLink("Dashboard 69"))).toBe(true);
    expect(scroll.contains(railLink(en.docPage.iconStudio))).toBe(false);
    expect(scroll.contains(button(en.workspaceNav.account))).toBe(false);
  });

  it("removes revoked custom apps and visible pins without restoring their grants", async () => {
    customApps = [{ id: "app-a", name: "Team dashboard", description: "Work overview", status: "active", renderable: true } as CustomHomeApp];
    homeApps.push("custom:app-a");
    await render();
    await click(button(en.workspaceNav.more));
    await click(button("Pin Team dashboard"));
    expect(railLink("Team dashboard")).not.toBeNull();
    customApps = [{ ...customApps[0], status: "needs_consent", renderable: false }];
    await render();
    expect(railLink("Team dashboard")).toBeNull();
    expect(document.querySelector('a[aria-label="Open Team dashboard"]')).toBeNull();
  });

  it("isolates workspace pins and handles corrupt saved data", async () => {
    localStorage.setItem(miniAppPinsKey("https://api.example.test", "person-a", "workspace-a"), '["tasks"]');
    await render();
    expect(railLink("Tasks")).not.toBeNull();
    workspaceId = "workspace-b";
    localStorage.setItem(miniAppPinsKey("https://api.example.test", "person-a", workspaceId), '{broken');
    await render();
    expect(railLink("Tasks")).toBeNull();
  });

  it("refreshes pins from another tab while rejecting arbitrary saved destinations", async () => {
    await render();
    const key = miniAppPinsKey("https://api.example.test", "person-a", workspaceId);
    await act(async () => {
      localStorage.setItem(key, '["https://outside.example.test", "tasks", "crm", "office", "page", "office", "chat"]');
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(railLink("Office")?.getAttribute("href")).toBe("/w/workspace-a/office");
    expect(container.querySelectorAll('[data-workspace-added-apps] a')).toHaveLength(4);
    expect(railLink("Page")).not.toBeNull();
    expect(container.querySelector('a[href="https://outside.example.test"]')).toBeNull();
  });

  it("does not read or persist personal pins before viewer identity is available", async () => {
    state.user.id = "";
    await render();
    await click(button(en.workspaceNav.more));
    expect(button("Pin Tasks").disabled).toBe(true);
    expect([...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === en.workspaceNav.reorderMenu)?.disabled).toBe(true);
    expect(railLink("Tasks")).toBeNull();
  });

  it("retains labelled phone actions and closes the drawer when an app opens", async () => {
    const close = vi.fn();
    window.addEventListener("doc:sidebar-close", close);
    await render(true);
    expect(container.textContent).toContain(en.docPage.iconHome);
    expect(container.textContent).toContain(en.workspaceNav.more);
    await click(button(en.workspaceNav.more));
    const link = document.querySelector<HTMLAnchorElement>('a[aria-label="Open Tasks"]')!;
    await click(link);
    expect(button(en.workspaceNav.more).getAttribute("aria-expanded")).toBe("false");
    expect(close).toHaveBeenCalledOnce();
    window.removeEventListener("doc:sidebar-close", close);
  });

  const menuIds = () => [...document.querySelectorAll<HTMLElement>('[data-menu-app]')].map(row => row.dataset.menuApp);
  const textButton = (text: string) => [...document.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === text)!;

  it("keeps the default menu compact and routes Explore more into Studio, closing the drawer", async () => {
    homeApps = ["chat", "page", "browsers"];
    const close = vi.fn(); window.addEventListener("doc:sidebar-close", close);
    try {
      await render(true); await click(button(en.workspaceNav.more));
      expect(menuIds()).toEqual(["page", "browsers"]);
      expect(document.querySelector('[aria-label="Open Tasks"]')).toBeNull();
      const explore = [...document.querySelectorAll<HTMLAnchorElement>('a')].find(link => link.textContent?.includes(en.workspaceNav.exploreMore))!;
      expect(explore.getAttribute('href')).toBe('/w/workspace-a/studio/mini-apps');
      await click(explore);
      expect(close).toHaveBeenCalledOnce();
      expect(button(en.workspaceNav.more).getAttribute('aria-expanded')).toBe('false');
    } finally { window.removeEventListener("doc:sidebar-close", close); }
  });

  it("moves menu items personally, updates pinned order, and resets without navigation", async () => {
    homeApps = ["chat", "tasks", "crm"];
    await render(); await click(button(en.workspaceNav.more));
    await click(button('Pin Tasks')); await click(button('Pin CRM'));
    const close = vi.fn(); window.addEventListener("doc:sidebar-close", close);
    try {
      await click(textButton(en.workspaceNav.reorderMenu));
      expect(button('Move Tasks up').disabled).toBe(true);
      expect(button('Move CRM down').disabled).toBe(true);
      await click(button('Move CRM up'));
      expect(menuIds()).toEqual(['crm', 'tasks']);
      expect(JSON.parse(localStorage.getItem(miniAppMenuOrderKey('https://api.example.test', 'person-a', workspaceId))!)).toEqual(['crm', 'tasks']);
      expect([...container.querySelectorAll('a')].filter(link => ['CRM', 'Tasks'].includes(link.getAttribute('aria-label') ?? '')).map(link => link.getAttribute('aria-label'))).toEqual(['CRM', 'Tasks']);
      expect(close).not.toHaveBeenCalled();
      await click(textButton(en.workspaceNav.done));
      await click(textButton(en.workspaceNav.reorderMenu));
      await click(textButton(en.workspaceNav.useWorkspaceOrder));
      expect(menuIds()).toEqual(['tasks', 'crm']);
      expect(localStorage.getItem(miniAppMenuOrderKey('https://api.example.test', 'person-a', workspaceId))).toBeNull();
    } finally { window.removeEventListener("doc:sidebar-close", close); }
  });

  it("restores stored order, appends newly selected apps and removes unavailable apps immediately", async () => {
    const key = miniAppMenuOrderKey('https://api.example.test', 'person-a', workspaceId);
    localStorage.setItem(key, '["https://outside.example.test", "crm", "chat", "crm", "tasks"]');
    homeApps = ['chat', 'tasks', 'crm'];
    await render(); await click(button(en.workspaceNav.more));
    expect(menuIds()).toEqual(['crm', 'tasks']);
    homeApps = ['chat', 'tasks', 'page']; await render();
    expect(menuIds()).toEqual(['tasks', 'page']);
    await act(async () => { localStorage.setItem(key, '["page","chat"]'); window.dispatchEvent(new StorageEvent('storage', { key })); });
    expect(menuIds()).toEqual(['page', 'tasks']);
    expect(document.querySelector('a[href="https://outside.example.test"]')).toBeNull();
  });

  it("does not leak menu order across viewers/workspaces and tolerates corrupt preferences", async () => {
    localStorage.setItem(miniAppMenuOrderKey('https://api.example.test', 'person-a', workspaceId), '["crm", "chat"]');
    await render(); await click(button(en.workspaceNav.more));
    expect(menuIds()[0]).toBe('crm');
    workspaceId = 'workspace-b'; await render(); await click(button(en.workspaceNav.more));
    expect(menuIds()[0]).toBe('tasks');
    state.user.id = 'person-b';
    await act(async () => root.unmount()); root = createRoot(container);
    localStorage.setItem(miniAppMenuOrderKey('https://api.example.test', 'person-b', workspaceId), '{broken');
    await render(); await click(button(en.workspaceNav.more));
    expect(menuIds()[0]).toBe('tasks');
  });
});


describe("[COMP:app-web/workspace-app-catalogue] ellipsis catalogue", () => {
  it("reuses the grant-aware destinations and personal pin contract", async () => {
    localStorage.clear(); state.user.id = "person-a";
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host), workspaceId = "workspace-a";
    const customApps = [{ id: "app-a", name: "Team dashboard", description: "Work overview", status: "needs_consent", renderable: false } as CustomHomeApp];
    try {
      await act(async () => root.render(<I18nProvider locale="en" dict={en}><WorkspaceAppCatalogue workspaceId={workspaceId} homeApps={["tasks"]} customApps={customApps}><PopoverTrigger aria-label="App menu">Open apps</PopoverTrigger></WorkspaceAppCatalogue></I18nProvider>));
      await act(async () => host.querySelector<HTMLButtonElement>('button[aria-label="App menu"]')!.click());
      expect(document.querySelector('a[aria-label="Open Tasks"]')?.getAttribute('href')).toBe('/w/workspace-a/tasks');
      expect(document.querySelector('a[aria-label="Open Team dashboard"]')).toBeNull();
      await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Pin Tasks"]')!.click());
      expect(JSON.parse(localStorage.getItem(miniAppPinsKey("https://api.example.test", "person-a", workspaceId))!)).toEqual(["tasks"]);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
