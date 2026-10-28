// @vitest-environment jsdom
/** [COMP:app-web/sidebar-drawer-close] Mounted dismissal and ownership regressions.
 * Tab containment is intentionally not claimed by this dismissal-only repair.
 */
import { act, useEffect, useState, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { Dialog } from "@base-ui/react/dialog";
import { Popover } from "@base-ui/react/popover";
import { Select } from "@base-ui/react/select";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { en } from "@/lib/i18n/dictionaries/en";
import { requestSidebarClose } from "@/lib/sidebar-close";
import { Tooltip } from "@/components/ui/tooltip";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const state = vi.hoisted(() => ({ phone: true, tooltips: false, sidebarMounts: 0, footerMounts: 0,
  pathname: "/w/workspace-1/p", search: new URLSearchParams("panel=recordings"),
  router: { push: vi.fn(), replace: vi.fn() } }));
vi.mock("next/navigation", () => ({ useRouter: () => state.router,
  usePathname: () => state.pathname, useSearchParams: () => state.search }));
vi.mock("@/lib/i18n/client", () => ({ useT: () => en }));
vi.mock("@/lib/offline/use-offline-sync", () => ({ useOfflineSync: () => ({ offline: false, pending: 0, paused: 0, reconnecting: false }) }));
vi.mock("@/lib/workspace-events", () => ({ useWorkspaceEvents: () => {} }));
vi.mock("@/lib/surface-cache-invalidation", () => ({ useSurfaceCacheInvalidation: () => {} }));
vi.mock("@/lib/doc-chat-relay", () => ({ useDocChatOthersRun: () => null }));
vi.mock("@/lib/chat-dock-suppress", () => ({ useChatDockSuppressed: () => false, workspaceChatDockSuppressed: () => false }));
vi.mock("@/contexts/primary-assistant", () => ({ usePrimaryAssistant: () => ({ assistantId: null }) }));
vi.mock("@/lib/desktop-auth-source", () => ({ desktopBridge: () => null, onDesktopUseBrian: () => {}, onDesktopMessageBrian: () => {}, acknowledgeDesktopMessageBrian: () => {} }));
vi.mock("@/lib/route-progress", () => ({ routeProgress: { start: () => {} } }));
vi.mock("@/components/doc/workspace-sidebar-resize", () => ({
  useWorkspaceSidebarResize: () => ({ containerRef: { current: null }, style: {}, resizing: false, handleProps: {} }), WorkspaceSidebarResizeHandle: () => null,
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({ useSidebarData: () => {
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [inboxOpen, setInboxOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  return { sidebarOpen, setSidebarOpen, inboxOpen, setInboxOpen, sidebarCollapsed, setSidebarCollapsed,
    saved: [], drafts: [], teamspaces: [], draftPruneByid: {}, homeApps: [], customApps: [], dock: [], studioSetupIncomplete: null };
} }));
vi.mock("@/components/workspace-search/workspace-search-provider", () => ({
  WorkspaceSearchProvider: ({ children }: { children: ReactNode }) => children, WorkspaceSearchFallback: () => null,
}));
vi.mock("@/components/chrome/workspace-topbar", () => ({
  WorkspaceTopbarProvider: ({ children }: { children: ReactNode }) => children, WorkspaceTopbarHost: () => null,
}));
vi.mock("@/components/chrome/surface-transition", () => ({ SurfaceTransition: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/doc/workspace-file-drop", () => ({ WorkspaceFileDropBoundary: ({ children }: { children: ReactNode }) => <Dialog.Root open={false}>{children}</Dialog.Root> }));
vi.mock("@/components/computer/desktop-browser-coordinator", () => ({ DesktopBrowserCoordinator: () => null }));
vi.mock("@/components/chrome/brain-intake-tray", () => ({ BrainIntakeTray: () => null }));
vi.mock("@/components/chrome/floating-chat", () => ({ FloatingChat: () => null }));
vi.mock("@/components/chrome/dock-recorder", () => ({ FloatingRecorderHost: () => null }));
vi.mock("@/components/doc/mobile-chat-drawer", () => ({ MobileChatDrawer: () => null }));
vi.mock("@/components/doc/teamspace-settings-modal", () => ({ TeamspaceCreateDialog: () => null, TeamspaceSettingsModal: () => null }));
vi.mock("@/components/chrome/workspace-status", () => ({ WorkspaceStatus: () => <span>Sync ready</span> }));

// Replace network-backed sidebar data with an owner that still retains state,
// real portaled Base UI popups, and the same drawer-close handoff signal.
vi.mock("@/components/doc/doc-sidebar", () => ({ WORKSPACE_STATUS_ROW_HEIGHT_CLASS: "h-8", DocSidebar: ({ onToggleInbox }: { onToggleInbox: () => void }) => {
  const [count, setCount] = useState(0), [settings, setSettings] = useState(false);
  useEffect(() => { state.sidebarMounts++; }, []);
  return <aside data-fixture-sidebar>
    <button onClick={() => setCount(value => value + 1)}>Count {count}</button>
    <Popover.Root>{state.tooltips ? <Tooltip label="Workspace menu hint" delay={0}><Popover.Trigger>Workspace menu</Popover.Trigger></Tooltip> : <Popover.Trigger>Workspace menu</Popover.Trigger>}<Popover.Portal><Popover.Positioner><Popover.Popup aria-label="Workspace menu">
      <button onClick={() => { requestSidebarClose(); setSettings(true); }}>Open settings</button>
    </Popover.Popup></Popover.Positioner></Popover.Portal></Popover.Root>
    <button onClick={onToggleInbox}>Open inbox</button>
    <Dialog.Root open={settings} onOpenChange={setSettings}><Dialog.Portal><Dialog.Backdrop /><Dialog.Popup aria-label="Fixture settings"><Dialog.Close>Close settings</Dialog.Close></Dialog.Popup></Dialog.Portal></Dialog.Root>
  </aside>;
} }));
vi.mock("@/components/doc/workspace-theme-picker", () => ({ WorkspaceThemePicker: () => {
  useEffect(() => { state.footerMounts++; }, []);
  return <Select.Root items={{ light: "Light", dark: "Dark" }} defaultValue="light"><Select.Trigger aria-label="Theme"><Select.Value /></Select.Trigger><Select.Portal><Select.Positioner><Select.Popup><Select.Item value="light"><Select.ItemText>Light</Select.ItemText></Select.Item><Select.Item value="dark"><Select.ItemText>Dark</Select.ItemText></Select.Item></Select.Popup></Select.Positioner></Select.Portal></Select.Root>;
} }));
vi.mock("@/components/doc/inbox-panel", () => ({ InboxPanel: ({ open, onClose }: { open: boolean; onClose: () => void }) => <Dialog.Root open={open} onOpenChange={next => { if (!next) onClose(); }}><Dialog.Portal><Dialog.Backdrop /><Dialog.Popup aria-label="Fixture inbox"><Dialog.Close>Close inbox</Dialog.Close></Dialog.Popup></Dialog.Portal></Dialog.Root> }));

import { WorkspaceChrome } from "../workspace-chrome";

let root: Root, host: HTMLDivElement;
const settle = async () => { await act(async () => { await new Promise(resolve => requestAnimationFrame(resolve)); }); };
const chrome = () => <WorkspaceChrome workspaceId="workspace-1"><input aria-label="Search recordings" /></WorkspaceChrome>;
const menu = () => host.querySelector<HTMLButtonElement>("[data-doc-mobile-menu]")!;
const isDrawerOpen = () => host.querySelector(`button[aria-label="${en.docPage.sidebarCloseAria}"]:not([data-doc-mobile-menu-close])`) !== null;
const button = (text: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === text)!;
async function click(element: HTMLElement) { await act(async () => element.click()); await settle(); }
async function escape(element: HTMLElement = document.activeElement as HTMLElement, init: KeyboardEventInit = {}) {
  await act(async () => { element.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true, ...init })); }); await settle();
}
async function render() { await act(async () => root.render(chrome())); await settle(); }
async function open() { menu().focus(); await click(menu()); }

beforeEach(() => {
  state.phone = true; state.tooltips = false; state.sidebarMounts = 0; state.footerMounts = 0; state.pathname = "/w/workspace-1/p";
  state.search = new URLSearchParams("panel=recordings");
  vi.stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("max-width") ? state.phone : !state.phone, media: query, addEventListener() {}, removeEventListener() {} }));
  vi.spyOn(HTMLElement.prototype, "getClientRects").mockImplementation(() => [new DOMRect(0, 0, 44, 44)] as unknown as DOMRectList);
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe("[COMP:app-web/sidebar-drawer-close] phone dismissal without modal containment", () => {
  it("preserves sidebar and footer in server markup", () => {
    const html = renderToString(chrome());
    expect(html).toContain("data-fixture-sidebar"); expect(html).toContain("data-workspace-footer"); expect(html).toContain("Sync ready");
    expect(html.match(/data-fixture-sidebar/g)).toHaveLength(1);
  });
  it("dismisses Escape from the leaked background focus and restores the hamburger", async () => {
    await render(); await open();
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search recordings"]')!; input.focus();
    await escape(input);
    expect(isDrawerOpen()).toBe(false); expect(document.activeElement).toBe(menu());
    expect(menu().getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById(menu().getAttribute("aria-controls")!)).not.toBeNull();
  });
  it("provides an explicit Close and backdrop with the same user-dismiss focus recovery", async () => {
    await render(); await open();
    const close = host.querySelector<HTMLButtonElement>("[data-doc-mobile-menu-close]")!;
    expect(close).not.toBeNull(); expect(close.getAttribute("aria-label")).toBe(en.docPage.sidebarCloseAria);
    await click(close); expect(isDrawerOpen()).toBe(false); expect(document.activeElement).toBe(menu());
    await open(); const backdrop = host.querySelector<HTMLButtonElement>(`button[aria-label="${en.docPage.sidebarCloseAria}"]:not([data-doc-mobile-menu-close])`)!;
    backdrop.focus(); await click(backdrop); expect(isDrawerOpen()).toBe(false); expect(document.activeElement).toBe(menu());
  });
  it.each(["Workspace menu", "Theme"])("lets the real nested %s consume Escape before the drawer", async label => {
    await render(); await open();
    const trigger = label === "Theme" ? host.querySelector<HTMLButtonElement>('[aria-label="Theme"]')! : button(label);
    await click(trigger);
    const popup = label === "Theme" ? document.querySelector<HTMLElement>('[role="listbox"]')! : document.querySelector<HTMLElement>('[aria-label="Workspace menu"]')!;
    expect(popup).not.toBeNull();
    await escape(popup); expect(isDrawerOpen()).toBe(true); expect(popup.isConnected).toBe(false);
    await escape(trigger); expect(isDrawerOpen()).toBe(false); expect(document.activeElement).toBe(menu());
  });
  it("ignores composing and consumed Escape, and disables dismissal on desktop", async () => {
    await render(); await open();
    await escape(menu(), { isComposing: true }); expect(isDrawerOpen()).toBe(true);
    const consume = (event: Event) => event.preventDefault(); menu().addEventListener("keydown", consume);
    await escape(menu()); expect(isDrawerOpen()).toBe(true); menu().removeEventListener("keydown", consume);
    state.phone = false; await act(async () => { window.dispatchEvent(new Event("resize")); }); await settle();
    await escape(menu()); expect(isDrawerOpen()).toBe(true);
  });
  it("lets the restored trigger's real Tooltip consume Escape before dismissing navigation", async () => {
    state.tooltips = true; await render(); await open(); await click(button("Workspace menu"));
    await escape(document.querySelector<HTMLElement>('[aria-label="Workspace menu"]')!);
    expect(isDrawerOpen()).toBe(true);
    await vi.waitFor(() => expect(document.querySelector("[data-app-tooltip]")?.textContent).toBe("Workspace menu hint"));
    await escape(button("Workspace menu")); expect(isDrawerOpen()).toBe(true);
    await vi.waitFor(() => expect(document.querySelector("[data-app-tooltip]")).toBeNull());
    await escape(button("Workspace menu")); expect(isDrawerOpen()).toBe(false); expect(document.activeElement).toBe(menu());
  });
  it.each(["settings", "inbox"])("keeps the portaled %s handoff focused while closing navigation", async destination => {
    await render(); await open();
    if (destination === "settings") await click(button("Workspace menu"));
    await click(button(destination === "settings" ? "Open settings" : "Open inbox"));
    const popup = document.querySelector<HTMLElement>(`[role="dialog"][aria-label="Fixture ${destination}"]`)!;
    expect(popup).not.toBeNull(); expect(isDrawerOpen()).toBe(false);
    await settle(); expect(popup.contains(document.activeElement)).toBe(true);
  });
  it("closes after navigation without restoring over the destination focus", async () => {
    await render(); await open();
    const input = host.querySelector<HTMLInputElement>("input")!; input.focus();
    state.search = new URLSearchParams("panel=tasks"); await render();
    expect(isDrawerOpen()).toBe(false); expect(document.activeElement).toBe(input);
    expect(state.sidebarMounts).toBe(1); expect(state.footerMounts).toBe(1);
  });
  it("keeps each owner mounted and its state across dismissal and viewport changes", async () => {
    await render(); await open(); await click(button("Count 0")); await escape(button("Count 1")); await open();
    state.phone = false; await act(async () => { window.dispatchEvent(new Event("resize")); }); await settle();
    state.phone = true; await act(async () => { window.dispatchEvent(new Event("resize")); }); await settle();
    expect(button("Count 1")).toBeDefined(); expect(state.sidebarMounts).toBe(1); expect(state.footerMounts).toBe(1);
    expect(host.querySelectorAll("[data-workspace-footer]")).toHaveLength(1);
  });
});
