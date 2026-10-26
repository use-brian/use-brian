// @vitest-environment jsdom
/**
 * [COMP:app-web/workspace-root] A generic workspace/app open waits for the
 * Chat Home immediately, without waiting for App store configuration.
 */

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const navigation = vi.hoisted(() => ({
  replace: vi.fn(),
  query: "",
}));
vi.mock("next/navigation", () => ({
  useParams: () => ({ workspaceId: "w1" }),
  useRouter: () => ({
    replace: navigation.replace,
    push: vi.fn(),
    prefetch: vi.fn(),
  }),
  useSearchParams: () => new URLSearchParams(navigation.query),
}));

const sidebar = vi.hoisted(() => ({
  state: {
    homeApps: ["page", "office", "chat"] as Array<
      "page" | "office" | "chat" | "crm"
    >,
    homeAppsLoading: false,
  },
}));
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  useSidebarData: () => sidebar.state,
}));
vi.mock("@/components/chrome/surface-skeleton", () => ({
  SurfaceSkeletonFor: ({ surface }: { surface: string | null }) => (
    <div data-testid="skeleton" data-surface={surface ?? ""} />
  ),
}));
vi.mock("@/lib/plan-gate", () => ({
  forwardPlanGateCheckoutReturn: (path: string) => path,
}));
vi.mock("@/lib/siri-use-brian", () => ({
  useBrianWorkspacePath: (workspaceId: string, prompt: string | null) =>
    prompt ? `/w/${workspaceId}/p?useBrian=${encodeURIComponent(prompt)}` : null,
}));

import WorkspaceRootPage from "../page";

describe("[COMP:app-web/workspace-root] opens Chat Home and preserves explicit handoffs", () => {
  let container: HTMLDivElement | null = null;
  let root: Root | null = null;

  beforeEach(() => {
    navigation.replace.mockReset();
    navigation.query = "";
    window.localStorage.clear();
    sidebar.state = {
      homeApps: ["page", "office", "chat"],
      homeAppsLoading: false,
    };
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

  function mount() {
    act(() => {
      root!.render(<WorkspaceRootPage />);
    });
  }

  const skeleton = () =>
    container!.querySelector<HTMLElement>('[data-testid="skeleton"]');

  it("opens Chat even when configuration and previous app name other destinations", () => {
    window.localStorage.setItem("doc:operator-app:w1", "page");
    sidebar.state = {
      homeApps: ["crm", "page"],
      homeAppsLoading: false,
    };
    mount();
    expect(navigation.replace).toHaveBeenCalledWith("/w/w1/chat");
    expect(skeleton()!.dataset.surface).toBe("chat");
  });

  it("opens Chat without waiting for catalogue configuration", () => {
    sidebar.state = {
      homeApps: ["page", "office", "chat"],
      homeAppsLoading: true,
    };
    mount();
    expect(navigation.replace).toHaveBeenCalledWith("/w/w1/chat");
    expect(skeleton()!.dataset.surface).toBe("chat");
  });

  it("keeps Chat as Home when catalogue configuration changes", () => {
    sidebar.state = {
      homeApps: ["page", "office", "chat"],
      homeAppsLoading: true,
    };
    mount();
    sidebar.state = { homeApps: ["chat", "page"], homeAppsLoading: false };
    act(() => {
      root!.render(<WorkspaceRootPage />);
    });
    expect(navigation.replace).toHaveBeenCalledWith("/w/w1/chat");
  });

  it.each(["capture=1", "record=1"])("keeps explicit Page handoff %s", (query) => {
    navigation.query = query;
    sidebar.state = {
      homeApps: ["crm", "page"],
      homeAppsLoading: true,
    };
    mount();
    expect(navigation.replace).toHaveBeenCalledWith(`/w/w1/p?${query}`);
  });
});
