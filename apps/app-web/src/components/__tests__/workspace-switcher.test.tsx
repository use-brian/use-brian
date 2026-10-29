// @vitest-environment jsdom
/**
 * [COMP:app-web/workspace-switcher] The switcher paints the shared workspace
 * list on its first open (instant-navigation contract N1 / N4 / N5).
 *
 * Report E: the popover kept a private `/api/workspaces` copy and showed a
 * "Loading workspaces..." line on every first open per page load, while
 * `contexts/workspace-context.tsx` already held the same list for every
 * ported surface. The contract under test: a list already in the shared
 * cache paints on the first open with no fetch; a genuinely cold list shows
 * skeleton rows (never the loading sentence) and swaps to rows when the
 * shared fetch lands; a rename event patches the shared list so the rows
 * follow.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const { routerPush } = vi.hoisted(() => ({ routerPush: vi.fn() }));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: routerPush, replace: vi.fn(), prefetch: vi.fn() }),
}));
const activeWorkspace = vi.hoisted(() => ({
  workspaceId: "w1", name: "Acme", iconSeed: null as number | null,
  iconUrl: null as string | null, role: "owner", clearance: "internal", me: { id: "u1" },
}));
vi.mock("@/lib/workspace-context", () => ({
  useWorkspaceContext: () => activeWorkspace,
  WORKSPACE_ICON_CHANGED_EVENT: "brian:workspace-icon-changed",
  WORKSPACE_RENAMED_EVENT: "brian:workspace-renamed",
}));
vi.mock("@/lib/i18n/client", async () => {
  const { en } = await import("@/lib/i18n/dictionaries/en");
  const { format } = await import("@/lib/i18n/format");
  return { useT: () => en, format };
});
const { desktopBridgeMock, openAddAccountMock } = vi.hoisted(() => ({ desktopBridgeMock: vi.fn(), openAddAccountMock: vi.fn() }));
vi.mock("@/lib/desktop-auth-source", () => ({ desktopBridge: desktopBridgeMock }));
vi.mock("@/components/desktop-add-account", () => ({ openDesktopAddAccount: openAddAccountMock }));
const { authFetchMock } = vi.hoisted(() => ({ authFetchMock: vi.fn() }));
vi.mock("@/lib/auth-fetch", () => ({ authFetch: authFetchMock }));
vi.mock("@/lib/primary-auth", () => ({
  primaryAuthUrl: () => null,
  webAppUrl: () => "",
}));
vi.mock("@/lib/user", () => ({
  getUserInfo: () => ({ id: "u1", name: "U", email: "u@example.com" }),
}));
vi.mock("@/lib/account-logout", () => ({ signOutActiveAccount: vi.fn() }));
vi.mock("@/lib/sidebar-close", () => ({ requestSidebarClose: vi.fn() }));
vi.mock("@/lib/edition", () => ({
  deploymentCapabilities: () => ({ billing: false }),
}));
vi.mock("@/lib/api/workspaces", () => ({
  updateWorkspacePickerPreferences: vi.fn(async () => ({})),
}));
vi.mock("@/lib/accounts", () => ({ getAccountsDir: () => [] }));
vi.mock("@/lib/route-progress", () => ({ routeProgress: { start: vi.fn() } }));
vi.mock("@/components/team-avatar", () => ({ TeamAvatar: ({ iconUrl }: { iconUrl: string | null }) => <img alt="" data-workspace-avatar src={iconUrl ?? undefined} /> }));
vi.mock("@/components/desktop-accounts", () => ({ DesktopAccounts: () => null }));
vi.mock("@/components/ui/user-avatar", () => ({ UserAvatar: () => null }));
vi.mock("@/components/create-workspace-form", () => ({
  CreateWorkspaceForm: () => null,
}));
vi.mock("@/components/settings-modal/settings-modal", () => ({
  SettingsModal: ({ open, initialSection }: { open: boolean; initialSection: string }) => open ? <div data-settings-modal>{initialSection}</div> : null,
  OPEN_SETTINGS_EVENT: "brian:open-settings",
}));


import {
  __resetWorkspaceCacheForTest,
  setWorkspaces,
} from "@/contexts/workspace-context";
import { WORKSPACE_RENAMED_EVENT } from "@/lib/workspace-context";
import { WorkspaceSwitcher } from "../workspace-switcher";

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("[COMP:app-web/workspace-switcher] paints the shared workspace list", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    activeWorkspace.name = "Acme"; activeWorkspace.iconUrl = null;
    __resetWorkspaceCacheForTest();
    authFetchMock.mockReset();
    desktopBridgeMock.mockReset().mockReturnValue(null);
    openAddAccountMock.mockReset();
    routerPush.mockReset();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = null;
    container = null;
  });

  async function mount(iconOnly = false) {
    await act(async () => {
      root!.render(<WorkspaceSwitcher iconOnly={iconOnly} />);
      await settle();
    });
  }

  async function open() {
    await act(async () => {
      container!.querySelector<HTMLButtonElement>('[data-workspace-switcher-trigger]')!.click();
      await settle();
    });
  }

  const content = () => document.querySelector('[data-slot="popover-content"]');
  const rowNames = () =>
    Array.from(content()!.querySelectorAll('ul li button[role="menuitem"] span.flex-1')).map(
      (el) => el.textContent,
    );

  it("opens directly from the icon and tracks shared workspace identity without a name row", async () => {
    setWorkspaces([{ id: "w1", name: "Acme" }, { id: "w2", name: "Beta" }]);
    await mount(true);
    const trigger = container!.querySelector<HTMLButtonElement>("[data-workspace-switcher-trigger]")!;
    expect(trigger.textContent).toBe("");
    expect(trigger.getAttribute("aria-label")).toBe("Switch workspace (Acme)");
    expect(trigger.hasAttribute("data-workspace-icon")).toBe(true);
    await open();
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(rowNames()).toEqual(["Acme", "Beta"]);
    expect(content()!.textContent).toContain("Acme");
    expect(authFetchMock).not.toHaveBeenCalled();
    await open();
    activeWorkspace.name = "Fictional studio";
    activeWorkspace.iconUrl = "https://example.test/workspace.png";
    await mount(true);
    expect(trigger.getAttribute("aria-label")).toBe("Switch workspace (Fictional studio)");
    expect(trigger.querySelector("img")?.getAttribute("src")).toBe(activeWorkspace.iconUrl);
  });

  it("retains one settings owner when Settings opens from the icon menu", async () => {
    setWorkspaces([{ id: "w1", name: "Acme" }]);
    await mount(true); await open();
    const settings = [...content()!.querySelectorAll<HTMLButtonElement>("button")].find(button => button.textContent === "Settings")!;
    await act(async () => settings.click());
    expect(content()).toBeNull();
    expect(container!.querySelectorAll("[data-settings-modal]")).toHaveLength(1);
    expect(container!.querySelector("[data-settings-modal]")?.textContent).toBe("ws-general");
  });

  it("first open paints an already-fetched list with no fetch and no loading line", async () => {
    setWorkspaces([
      { id: "w1", name: "Acme" },
      { id: "w2", name: "Beta" },
    ]);
    authFetchMock.mockImplementation(() => new Promise(() => {}));
    await mount();
    await open();

    expect(rowNames()).toEqual(["Acme", "Beta"]);
    expect(content()!.querySelector("[aria-busy]")).toBeNull();
    expect(content()!.textContent).not.toContain("Loading workspaces");
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("a cold list shows skeleton rows, never the loading sentence, then the rows when the shared fetch lands", async () => {
    let release: (value: unknown) => void = () => {};
    authFetchMock.mockImplementation(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );
    await mount();
    // The mount-time warm already started the ONE shared request.
    expect(authFetchMock).toHaveBeenCalledTimes(1);
    await open();

    expect(content()!.querySelector("ul[aria-busy='true']")).not.toBeNull();
    expect(content()!.textContent).not.toContain("Loading workspaces");
    // Opening joined the in-flight warm instead of starting a second request.
    expect(authFetchMock).toHaveBeenCalledTimes(1);

    await act(async () => {
      release({
        ok: true,
        json: async () => ({ workspaces: [{ id: "w1", name: "Acme" }, { id: "w3", name: "Gamma" }] }),
      });
      await settle();
    });
    expect(content()!.querySelector("[aria-busy]")).toBeNull();
    expect(rowNames()).toEqual(["Acme", "Gamma"]);
  });

  it("a rename event patches the shared list so the rows follow without a refetch", async () => {
    setWorkspaces([
      { id: "w1", name: "Acme" },
      { id: "w2", name: "Beta" },
    ]);
    await mount();
    await open();
    expect(rowNames()).toEqual(["Acme", "Beta"]);

    await act(async () => {
      window.dispatchEvent(
        new CustomEvent(WORKSPACE_RENAMED_EVENT, {
          detail: { workspaceId: "w2", name: "Beta Robotics" },
        }),
      );
      await settle();
    });
    expect(rowNames()).toEqual(["Acme", "Beta Robotics"]);
    expect(authFetchMock).not.toHaveBeenCalled();
  });

  it("switches through the bare workspace root so the shared Home resolver applies", async () => {
    setWorkspaces([
      { id: "w1", name: "Acme" },
      { id: "w2", name: "Beta" },
    ]);
    await mount();
    await open();
    const beta = [...content()!.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent?.includes("Beta"),
    );
    expect(beta).toBeDefined();
    await act(async () => beta!.click());
    expect(routerPush).toHaveBeenCalledWith("/w/w2");
  });

  it("offers one desktop Add account entry instead of launching cloud or the standalone OSS page", async () => {
    const addAccount = vi.fn(), chooseDeployment = vi.fn();
    desktopBridgeMock.mockReturnValue({ addAccount, chooseDeployment, runLocal: vi.fn() });
    setWorkspaces([{ id: "w1", name: "Example workspace" }]);
    await mount(); await open();
    expect(content()!.textContent).not.toContain("Use own deployment");
    const add = [...content()!.querySelectorAll("button")].find(b => b.textContent === "Add another account")!;
    await act(async () => add.click());
    expect(openAddAccountMock).toHaveBeenCalledOnce();
    expect(addAccount).not.toHaveBeenCalled();
    expect(chooseDeployment).not.toHaveBeenCalled();
  });
  it("retains direct cloud add-account for an older bridge without local connection support", async () => {
    const addAccount = vi.fn();
    desktopBridgeMock.mockReturnValue({ addAccount });
    setWorkspaces([{ id: "w1", name: "Example workspace" }]);
    await mount(); await open();
    const add = [...content()!.querySelectorAll("button")].find(b => b.textContent === "Add another account")!;
    await act(async () => add.click());
    expect(addAccount).toHaveBeenCalledOnce();
    expect(openAddAccountMock).not.toHaveBeenCalled();
  });

});
