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

vi.mock("@/app/w/[workspaceId]/studio/layout",async()=>{const {Outlet}=await import("react-router-dom");return {default:()=> <main><Outlet/></main>}});
vi.mock("@/app/w/[workspaceId]/studio/programmatic-access/history/page",()=>({default:()=> <h1>Engineering history fixture</h1>}));
vi.mock("@/app/w/[workspaceId]/studio/programmatic-access/applications/page",()=>({default:()=> <h1>Application management fixture</h1>}));
describe("[COMP:app-web/engineering-history] desktop entry routing",()=>{
 it.each(["oss","hosted"] as const)("opens admitted history directly in %s without falling back to configuration or Home",async edition=>{
  await mount(edition,"/w/workspace-one/studio/programmatic-access/history");expect(window.location.hash).toBe("#/w/workspace-one/studio/programmatic-access/history");expect(host.querySelector("h1")?.textContent).toBe("Engineering history fixture");expect(host.querySelector("[data-page]")).toBeNull()
 })
});

describe("[COMP:app-web/studio-application-management] desktop entry routing",()=>{
 it.each(["oss","hosted"] as const)("opens dedicated application administration in %s",async edition=>{
  await mount(edition,"/w/workspace-one/studio/programmatic-access/applications");
  expect(window.location.hash).toBe("#/w/workspace-one/studio/programmatic-access/applications");
  expect(host.querySelector("h1")?.textContent).toBe("Application management fixture");
  expect(host.querySelector("[data-page]")).toBeNull();
 });
});
