// @vitest-environment jsdom
import { act, useEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceStatus } from "../chrome/workspace-status";
import { AppSessionProvider, SessionRouteBoundary } from "../app-session";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { notifySessionRequired, notifySessionLogout } from "@/lib/session-events";
import type { SessionAdapter } from "@/lib/app-session";
const route = vi.hoisted(() => ({ path: "/w/workspace-one/chat", push: vi.fn() }));
vi.mock("next/navigation", () => ({ usePathname: () => route.path, useRouter: () => ({ push: route.push }) }));
vi.mock("@/components/desktop-accounts", () => ({ DesktopAccounts: () => null }));
let host: HTMLDivElement, root: Root, mounts: number, cleanups: number, adapter: SessionAdapter;
const workspace = { id: "workspace-one", name: "Private workspace", role: "owner", me: { id: "user-one" } };
function Private() { useEffect(() => { mounts++; return () => { cleanups++; }; }, []); return <button>Private draft</button>; }
async function render() { await act(async () => root.render(<I18nProvider locale="en" dict={en}>
  <AppSessionProvider adapter={adapter}><SessionRouteBoundary><Private /></SessionRouteBoundary></AppSessionProvider>
</I18nProvider>)); }
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  mounts = 0; cleanups = 0; route.path = "/w/workspace-one/chat"; route.push.mockReset();
  adapter = { identity: () => "deployment/user-one", hasCredential: () => true,
    session: vi.fn().mockResolvedValue({ status: 200, data: { workspaces: [workspace] } }),
    workspace: vi.fn().mockResolvedValue({ status: 200, data: workspace }), read: vi.fn(async () => null), write: vi.fn(async () => {}),
  };
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); delete window.usebrianDesktop; });
describe("[COMP:app-web/app-session] every protected route uses admission", () => {
  it.each(["/w/workspace-one/chat", "/desktop/chat/workspace-one"])("does not mount protected consumers at %s before admission", async path => {
    route.path = path;
    let accept!: (value: unknown) => void;
    adapter.workspace = vi.fn(() => new Promise(resolve => { accept = resolve; })) as SessionAdapter["workspace"];
    await render(); expect(mounts).toBe(0); expect(host.textContent).not.toContain("Private draft");
    await act(async () => accept({ status: 200, data: workspace }));
    expect(mounts).toBe(1); expect(host.textContent).toContain("Private draft");
  });
  it("unmounts protected consumers on rejection and does not open browser OAuth", async () => {
    const signIn = vi.fn(); window.usebrianDesktop = { signIn };
    await render(); expect(mounts).toBe(1);
    await act(async () => { notifySessionRequired("deployment/user-one"); });
    expect(cleanups).toBe(1); expect(host.textContent).not.toContain("Private draft");
    expect(host.textContent).toContain(en.desktopSession.reconnectDescription); expect(signIn).not.toHaveBeenCalled();
  });
  it.each([403, 404, 503])("shows a scoped HTTP %s outcome without redirecting to login", async status => {
    adapter.workspace = vi.fn().mockResolvedValue({ status });
    await render(); expect(mounts).toBe(0);
    expect(host.textContent).toContain(status === 403 ? en.desktopSession.denied : status === 404 ? en.desktopSession.missing : en.desktopSession.unavailable);
    expect(adapter.session).toHaveBeenCalledOnce();
  });
  it("handles fresh install without exposing cached content", async () => {
    adapter.identity = () => null; adapter.session = vi.fn().mockResolvedValue({ status: 401 });
    await render(); expect(mounts).toBe(0); expect(host.textContent).toContain(en.desktopSession.description);
    expect(adapter.workspace).not.toHaveBeenCalled();
  });
  it("withholds application consent until the session is admitted", async () => {
    route.path = "/oauth/authorize";
    let accept!: (value: unknown) => void;
    adapter.session = vi.fn(() => new Promise(resolve => { accept = resolve; })) as SessionAdapter["session"];
    await render(); expect(mounts).toBe(0);
    await act(async () => accept({ status: 200, data: { workspaces: [workspace] } }));
    expect(mounts).toBe(1); expect(adapter.workspace).not.toHaveBeenCalled();
  });
  it("does not guard public authentication callbacks or native recording overlays as workspaces", async () => {
    route.path = "/recorder-overlay"; await render(); expect(adapter.session).not.toHaveBeenCalled(); expect(mounts).toBe(1);
  });
  it("shows offline admission in the existing status control even when the browser reports online", async () => {
    adapter.session = vi.fn().mockRejectedValue(new TypeError("unreachable"));
    adapter.workspace = vi.fn().mockRejectedValue(new TypeError("unreachable"));
    adapter.read = vi.fn().mockResolvedValue({ identity: "deployment/user-one", workspaces: [workspace],
      contexts: { [workspace.id]: { ...workspace, workspaceId: workspace.id } },
    });
    await act(async () => root.render(<I18nProvider locale="en" dict={en}><AppSessionProvider adapter={adapter}>
      <SessionRouteBoundary><WorkspaceStatus sidebarOpen offlineState={{ connectivity: "online", offline: false, pending: 0, paused: 0, reconnecting: false }} /></SessionRouteBoundary>
    </AppSessionProvider></I18nProvider>));
    expect(host.querySelector('[data-workspace-status]')?.getAttribute('data-workspace-status')).toBe('attention');
    expect(host.querySelector('[role="status"]')?.textContent).toContain(en.docPage.offlineBannerTitle);
  });
  it("readmits the current Chat route after another window completes native reauthentication", async () => {
    route.path = "/desktop/chat/workspace-one";
    let restored!: () => void;
    window.usebrianDesktop = { signIn: vi.fn(), onSessionRestored: callback => { restored = callback; return () => {}; } };
    await render();
    await act(async () => { notifySessionRequired("deployment/user-one"); });
    expect(host.textContent).not.toContain("Private draft");
    await act(async () => { restored(); });
    expect(host.textContent).toContain("Private draft"); expect(adapter.workspace).toHaveBeenCalledTimes(2);
  });
  it("removes active UI immediately on explicit logout", async () => {
    await render(); await act(async () => { notifySessionLogout(); });
    expect(host.textContent).not.toContain("Private draft"); expect(cleanups).toBe(1);
  });
});
