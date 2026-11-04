// @vitest-environment jsdom
vi.mock("next/navigation", async () => await import("../shims/next-navigation"));
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimePublicConfig } from "@/lib/runtime-public-config";
import { en } from "@/lib/i18n/dictionaries/en";
import { App } from "../app";

// Exercise the real HashRouter and route table. Network-loaded workspace
// chrome and page contents are boundaries; no routing or edition logic is mocked.
const auth = vi.hoisted(() => ({ token: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ getAccessToken: () => null, getValidAccessToken: auth.token, authFetch: auth.fetch }));
vi.mock("@/lib/offline/idb", () => ({
  idbGet: async () => [{ id: "cached-workspace", name: "Private cached workspace" }], idbSet: async () => {},
}));
vi.mock("@/lib/theme", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/workspace-context", () => ({ WorkspaceContextProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/custom-themes", () => ({ CustomThemesProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  DocSidebarDataProvider: ({ children }: { children: ReactNode }) => children,
  useSidebarData: () => ({ homeApps: ["feed", "page"], homeAppsLoading: false }),
}));
vi.mock("@/components/chat-app/chat-surface", () => ({
  ChatSurface: () => <main data-chat>Chat</main>,
}));
vi.mock("@/contexts/brain-surface-context", () => ({ BrainSurfaceProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/primary-assistant", () => ({ PrimaryAssistantProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/ui/confirm-dialog", () => ({ ConfirmDialogProvider: () => null }));
vi.mock("@/components/ui/prompt-dialog", () => ({ PromptDialogProvider: () => null }));
vi.mock("@/components/ui/kind-picker-dialog", () => ({ KindPickerDialogProvider: () => null }));
vi.mock("@/components/chrome/desktop-chat-window", () => ({ DesktopChatWindow: () => null }));
vi.mock("@/components/workspace-picker", () => ({ WorkspacePicker: () => null }));
vi.mock("@/components/doc/workspace-chrome", async () => {
  const { Link } = await import("react-router-dom");
  return { WorkspaceChrome: ({ children }: { children: ReactNode }) => <><Link to="/w/workspace-one/feed">Feed</Link><Link to="/w/workspace-one/feed/campaigns">Campaigns</Link>{children}</> };
});
let root: Root, host: HTMLDivElement;
const signOut = vi.fn(), signIn = vi.fn(), addAccount = vi.fn(), retry = vi.fn();
async function mount(query = "") {
  window.history.replaceState(null, "", `/${query}#/`);
  await act(async () => root.render(<App />));
}
const button = (label: string) => [...document.querySelectorAll("button")].find(b => b.textContent === label)!;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  vi.clearAllMocks();
  auth.token.mockResolvedValue(null);
  window.usebrianDesktop = {
    signIn, signOut, addAccount, retry, getAccessToken: () => null, getRefreshToken: () => null,
    runLocal: vi.fn(), listAccounts: vi.fn().mockResolvedValue({ accounts: [], canSwitch: true }),
  };
  window.__USE_BRIAN_PUBLIC_CONFIG__ = resolveRuntimePublicConfig({ USEBRIAN_EDITION: "hosted" });
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount()); host.remove();
  delete window.usebrianDesktop; delete window.__USE_BRIAN_PUBLIC_CONFIG__;
  window.history.replaceState(null, "", "/");
});

describe("[COMP:app-web/desktop-spa] main app account entry", () => {
  it("stays usable without a session, does not repeat logout or expose cached workspaces", async () => {
    await mount();
    expect(host.textContent).toContain(en.desktopSession.description);
    expect(host.textContent).not.toContain("Private cached workspace");
    expect(host.querySelector('[role="menuitem"]')).toBeNull();
    expect(signOut).not.toHaveBeenCalled();
    expect(signIn).not.toHaveBeenCalled();
    expect(auth.fetch).not.toHaveBeenCalled();
    await act(async () => button(en.workspaceSwitcher.addAccountDialog.cloud).click());
    expect(addAccount).toHaveBeenCalledOnce();
  });
  it("opens server address entry directly without starting Cloud sign-in", async () => {
    await mount();
    await act(async () => button(en.desktopSession.connectServer).click());
    expect(document.querySelector('[role="dialog"] input')).not.toBeNull();
    expect(document.querySelector('[role="dialog"]')?.textContent).toContain(en.workspaceSwitcher.addAccountDialog.serverAddress);
    expect(addAccount).not.toHaveBeenCalled();
  });
  it.each([
    ["signed-out", en.desktopSession.description],
    ["unreachable", en.workspaceSwitcher.addAccountDialog.unreachable],
    ["auth", en.workspaceSwitcher.addAccountDialog.authError],
    ["gateway-auth", en.workspaceSwitcher.addAccountDialog.approvalError],
    ["access", en.workspaceSwitcher.addAccountDialog.approvalError],
  ])("keeps %s recovery in the app without bootstrap requests", async (mode, message) => {
    await mount(`?accountEntry=${mode}`);
    expect(host.textContent).toContain(message);
    expect(auth.token).not.toHaveBeenCalled();
    expect(auth.fetch).not.toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
    if (mode !== "signed-out") {
      await act(async () => button(en.desktopSession.retry).click());
      expect(retry).toHaveBeenCalledOnce();
    }
  });
  it("lists another saved account while the current deployment is signed out", async () => {
    window.usebrianDesktop!.listAccounts = vi.fn().mockResolvedValue({ accounts: [{
      key: "saved", id: "user", name: "Example user", email: "person@example.com", deployment: "cloud",
      appUrl: "https://app.example.com", active: false,
    }], canSwitch: true });
    window.usebrianDesktop!.selectAccount = vi.fn().mockResolvedValue({ ok: true });
    await mount();
    expect(host.textContent).toContain("person@example.com");
    const saved = host.querySelector<HTMLButtonElement>('button[aria-label*="person@example.com"]')!;
    await act(async () => saved.click());
    expect(window.usebrianDesktop!.selectAccount).toHaveBeenCalledExactlyOnceWith("saved");
  });
});
