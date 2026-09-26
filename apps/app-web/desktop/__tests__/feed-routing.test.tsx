// @vitest-environment jsdom
import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveRuntimePublicConfig } from "@/lib/runtime-public-config";
import { App } from "../app";

// Exercise the real HashRouter and route table. Network-loaded workspace
// chrome and page contents are boundaries; no routing or edition logic is mocked.
vi.mock("@/lib/auth-fetch", () => ({
  getValidAccessToken: async () => "test-token",
  authFetch: async () => new Response(JSON.stringify({ name: "Test workspace", role: "owner", me: { id: "user-one" } })),
}));
vi.mock("@/lib/offline/idb", () => ({ idbGet: async () => null, idbSet: async () => {} }));
vi.mock("@/lib/theme", () => ({ ThemeProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/workspace-context", () => ({ WorkspaceContextProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/lib/custom-themes", () => ({ CustomThemesProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  DocSidebarDataProvider: ({ children }: { children: ReactNode }) => children,
  useSidebarData: () => ({ homeApps: ["feed", "page"], homeAppsLoading: false }),
}));
vi.mock("@/contexts/brain-surface-context", () => ({ BrainSurfaceProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/contexts/primary-assistant", () => ({ PrimaryAssistantProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/components/ui/confirm-dialog", () => ({ ConfirmDialogProvider: () => null }));
vi.mock("@/components/ui/prompt-dialog", () => ({ PromptDialogProvider: () => null }));
vi.mock("@/components/ui/kind-picker-dialog", () => ({ KindPickerDialogProvider: () => null }));
vi.mock("@/components/desktop-add-account", () => ({
  DesktopAddAccountProvider: () => null,
  onDesktopAccountConnected: () => () => {},
}));
vi.mock("@/components/chrome/desktop-chat-window", () => ({ DesktopChatWindow: () => null }));
vi.mock("@/components/workspace-picker", () => ({ WorkspacePicker: () => null }));
vi.mock("@/components/doc/workspace-chrome", async () => {
  const { Link } = await import("react-router-dom");
  return { WorkspaceChrome: ({ children }: { children: ReactNode }) => <><Link to="/w/workspace-one/feed">Feed</Link><Link to="/w/workspace-one/feed/campaigns">Campaigns</Link>{children}</> };
});
vi.mock("@/app/w/[workspaceId]/p/layout", () => ({ default: () => <main data-page>Page</main> }));
vi.mock("@/components/feed/feed-surface-shell", () => ({
  FeedSurfaceShell: ({ workspaceId, children }: { workspaceId: string; children: ReactNode }) => <main data-feed-workspace={workspaceId}>{children}</main>,
}));
vi.mock("@/components/feed/feed-plan", () => ({ FeedPlan: () => <h1>Feed Plan</h1> }));
vi.mock("@/components/feed/feed-campaigns", () => ({
  FeedCampaigns: ({ workspaceId }: { workspaceId: string }) => <h1 data-campaign-workspace={workspaceId}>Campaigns</h1>,
}));
vi.mock("@/components/feed/feed-voice", () => ({ FeedVoice: () => <h1>Company Voice</h1> }));
vi.mock("@/app/w/[workspaceId]/feed/[platform]/posts/page", () => ({ default: () => <h1>Platform Posts</h1> }));
vi.mock("@/app/w/[workspaceId]/feed/[platform]/posts/[sessionId]/page", () => ({ default: () => <h1>Post Editor</h1> }));
vi.mock("@/components/feed/feed-settings", () => ({ FeedSettings: () => <h1>Feed Settings</h1> }));

let root: Root;
let host: HTMLDivElement;
const mount = async (edition: "oss" | "hosted", path: string) => {
  window.__USE_BRIAN_PUBLIC_CONFIG__ = resolveRuntimePublicConfig({ USEBRIAN_EDITION: edition });
  window.history.replaceState(null, "", `#${path}`);
  await act(async () => root.render(<App />));
  await act(async () => { await vi.dynamicImportSettled(); });
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove(); delete window.__USE_BRIAN_PUBLIC_CONFIG__;
  window.history.replaceState(null, "", "/");
});

describe("[COMP:app-web/desktop-spa] Feed routes in both editions", () => {
  it("opens the first configured mini app from a bare workspace route", async () => {
    await mount("oss", "/w/workspace-one");
    expect(window.location.hash).toBe("#/w/workspace-one/feed");
    expect(host.querySelector("h1")?.textContent).toBe("Feed Plan");
    expect(host.querySelector("[data-page]")).toBeNull();
  });

  it.each(["oss", "hosted"] as const)("opens Feed from Page in %s without bouncing back", async (edition) => {
    await mount(edition, "/w/workspace-one/p");
    expect(host.querySelector("[data-page]")).not.toBeNull();
    await act(async () => host.querySelector<HTMLAnchorElement>("a")!.click());
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(window.location.hash).toBe("#/w/workspace-one/feed");
    expect(host.querySelector("[data-feed-workspace]")?.getAttribute("data-feed-workspace")).toBe("workspace-one");
    expect(host.querySelector("h1")?.textContent).toBe("Feed Plan");
    expect(host.querySelector("[data-page]")).toBeNull();
  });

  it.each(["oss", "hosted"] as const)("opens Campaigns from Plan in %s without redirecting", async (edition) => {
    await mount(edition, "/w/workspace-one/feed");
    await act(async () => host.querySelector<HTMLAnchorElement>('a[href$="/feed/campaigns"]')!.click());
    await act(async () => { await vi.dynamicImportSettled(); });
    expect(window.location.hash).toBe("#/w/workspace-one/feed/campaigns");
    expect(host.querySelector("h1")?.textContent).toBe("Campaigns");
    expect(host.querySelector("[data-campaign-workspace]")?.getAttribute("data-campaign-workspace")).toBe("workspace-one");
  });

  it.each(["oss", "hosted"] as const)("opens a Campaigns deep link in %s with its workspace", async (edition) => {
    await mount(edition, "/w/workspace-two/feed/campaigns");
    expect(window.location.hash).toBe("#/w/workspace-two/feed/campaigns");
    expect(host.querySelector("h1")?.textContent).toBe("Campaigns");
    expect(host.querySelector("[data-campaign-workspace]")?.getAttribute("data-campaign-workspace")).toBe("workspace-two");
  });

  it.each([
    ["voice", "Company Voice"],
    ["threads/posts", "Platform Posts"],
    ["threads/posts/draft-one", "Post Editor"],
    // Managed access is enforced by the API, not an edition-wide redirect.
    ["threads/settings", "Feed Settings"],
  ])("keeps the OSS Feed %s deep link inside Feed", async (suffix, title) => {
    await mount("oss", `/w/workspace-one/feed/${suffix}`);
    expect(window.location.hash).toBe(`#/w/workspace-one/feed/${suffix}`);
    expect(host.querySelector("h1")?.textContent).toBe(title);
  });

  it("returns an unknown platform to Feed Plan instead of Page", async () => {
    await mount("oss", "/w/workspace-one/feed/unknown-platform/posts");
    expect(window.location.hash).toBe("#/w/workspace-one/feed");
    expect(host.querySelector("h1")?.textContent).toBe("Feed Plan");
  });
});
