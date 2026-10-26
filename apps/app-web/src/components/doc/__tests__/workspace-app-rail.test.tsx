// @vitest-environment jsdom
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { PopoverTrigger } from "@/components/ui/popover";
import { miniAppPinsKey, miniAppMenuOrderKey } from "@/lib/workspace-apps";
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
    vi.unstubAllGlobals();
  });
  async function render(mobile = false) {
    await act(async () => root.render(<I18nProvider locale="en" dict={en}><WorkspaceAppRail workspaceId={workspaceId} activeSurface="tasks" activeApp="tasks" homeApps={homeApps} customApps={customApps} liveCount={0} studioNudge={false} onDismissStudioNudge={() => {}} mobile={mobile} /></I18nProvider>));
  }
  const button = (name: string) => document.querySelector<HTMLButtonElement>(`button[aria-label="${name}"]`)!;
  const railLink = (name: string) => container.querySelector<HTMLAnchorElement>(`a[aria-label="${name}"]`);
  async function click(element: HTMLElement) { await act(async () => element.click()); }

  it("reserves the workspace menu above Home without a duplicate panel toggle", async () => {
    await render();
    expect(container.querySelector('a')?.getAttribute('aria-label')).toBe(en.workspaceNav.homeAria);
    const workspaceSlot = container.querySelector('[data-workspace-menu-slot]')!;
    expect(workspaceSlot.compareDocumentPosition(railLink(en.workspaceNav.homeAria)!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(container.querySelector('[data-workspace-sidebar-toggle]')).toBeNull();
    const more = button(en.workspaceNav.more);
    const divider = container.querySelector('[data-workspace-added-apps-divider]')!;
    expect(more.compareDocumentPosition(divider) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("keeps Home on Chat while another mini-app is active", async () => {
    localStorage.setItem("doc:operator-app:workspace-a", "tasks");
    await render();
    expect(railLink(en.workspaceNav.homeAria)?.getAttribute("href")).toBe("/w/workspace-a/chat");
    expect(railLink(en.workspaceNav.homeAria)?.hasAttribute("aria-current")).toBe(false);
    await click(button(en.workspaceNav.more));
    expect(document.querySelector('a[aria-label="Open Chat"]')?.getAttribute("href")).toBe("/w/workspace-a/chat");
    expect(document.querySelector('button[aria-label="Pin Chat"]')).toBeNull();
    expect(document.querySelector('a[aria-label="Open Workflow"]')).toBeNull();
    expect(document.querySelector('a[aria-label="Open Organization"]')).toBeNull();
  });

  it("persists two personal pins and requires unpinning before a third", async () => {
    await render();
    await click(button(en.workspaceNav.more));
    await click(button("Pin Tasks"));
    await click(button("Pin CRM"));
    expect(railLink("Tasks")?.getAttribute("href")).toBe("/w/workspace-a/tasks");
    expect(railLink("Tasks")?.getAttribute("aria-current")).toBe("page");
    expect(railLink("Tasks")?.closest("[data-workspace-added-apps]")).not.toBeNull();
    expect(button("Pin Office").disabled).toBe(true);
    expect(JSON.parse(localStorage.getItem(miniAppPinsKey("https://api.example.test", "person-a", workspaceId))!)).toEqual(["tasks", "crm"]);
    await click(button("Unpin Tasks"));
    expect(railLink("Tasks")).toBeNull();
    expect(button("Pin Office").disabled).toBe(false);
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
      localStorage.setItem(key, '["https://outside.example.test", "office"]');
      window.dispatchEvent(new StorageEvent("storage", { key }));
    });
    expect(railLink("Office")?.getAttribute("href")).toBe("/w/workspace-a/office");
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
      expect(menuIds()).toEqual(["chat", "page", "browsers"]);
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
      expect(button('Move Chat up').disabled).toBe(true);
      expect(button('Move CRM down').disabled).toBe(true);
      await click(button('Move CRM up'));
      expect(menuIds()).toEqual(['chat', 'crm', 'tasks']);
      expect(JSON.parse(localStorage.getItem(miniAppMenuOrderKey('https://api.example.test', 'person-a', workspaceId))!)).toEqual(['chat', 'crm', 'tasks']);
      expect([...container.querySelectorAll('a')].filter(link => ['CRM', 'Tasks'].includes(link.getAttribute('aria-label') ?? '')).map(link => link.getAttribute('aria-label'))).toEqual(['CRM', 'Tasks']);
      expect(close).not.toHaveBeenCalled();
      await click(textButton(en.workspaceNav.done));
      await click(textButton(en.workspaceNav.reorderMenu));
      await click(textButton(en.workspaceNav.useWorkspaceOrder));
      expect(menuIds()).toEqual(['chat', 'tasks', 'crm']);
      expect(localStorage.getItem(miniAppMenuOrderKey('https://api.example.test', 'person-a', workspaceId))).toBeNull();
    } finally { window.removeEventListener("doc:sidebar-close", close); }
  });

  it("restores stored order, appends newly selected apps and removes unavailable apps immediately", async () => {
    const key = miniAppMenuOrderKey('https://api.example.test', 'person-a', workspaceId);
    localStorage.setItem(key, '["https://outside.example.test", "crm", "chat", "crm", "tasks"]');
    homeApps = ['chat', 'tasks', 'crm'];
    await render(); await click(button(en.workspaceNav.more));
    expect(menuIds()).toEqual(['crm', 'chat', 'tasks']);
    homeApps = ['chat', 'tasks', 'page']; await render();
    expect(menuIds()).toEqual(['chat', 'tasks', 'page']);
    await act(async () => { localStorage.setItem(key, '["page","chat"]'); window.dispatchEvent(new StorageEvent('storage', { key })); });
    expect(menuIds()).toEqual(['page', 'chat', 'tasks']);
    expect(document.querySelector('a[href="https://outside.example.test"]')).toBeNull();
  });

  it("does not leak menu order across viewers/workspaces and tolerates corrupt preferences", async () => {
    localStorage.setItem(miniAppMenuOrderKey('https://api.example.test', 'person-a', workspaceId), '["crm", "chat"]');
    await render(); await click(button(en.workspaceNav.more));
    expect(menuIds()[0]).toBe('crm');
    workspaceId = 'workspace-b'; await render(); await click(button(en.workspaceNav.more));
    expect(menuIds()[0]).toBe('chat');
    state.user.id = 'person-b';
    await act(async () => root.unmount()); root = createRoot(container);
    localStorage.setItem(miniAppMenuOrderKey('https://api.example.test', 'person-b', workspaceId), '{broken');
    await render(); await click(button(en.workspaceNav.more));
    expect(menuIds()[0]).toBe('chat');
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
