// @vitest-environment jsdom
/** [COMP:app-web/workspace-topbar] Shared presentation with surface-owned behavior. */
import React, { act } from "react";
import { renderToString } from "react-dom/server";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { Activity, FolderKanban } from "lucide-react";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import { WorkspaceTopbar, WorkspaceTopbarProvider, WorkspaceTopbarHost, WorkspaceAppTitleHost } from "../workspace-topbar";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { BrainTopbar } from "@/components/brain/brain-topbar";
import { StudioTopbar } from "@/components/studio/studio-topbar";
import { WorkflowTopbar } from "@/components/workflow/workflow-topbar";
import { DocTopBar } from "@/components/doc/doc-topbar";
import { OfficeTopbar } from "@/components/office/office-topbar";
import { OPERATOR_APP_KEYS } from "@/lib/operator-apps";
import { SIDEBAR_CLOSE_EVENT } from "@/lib/sidebar-close";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const navigation = vi.hoisted(() => ({ back: vi.fn(), forward: vi.fn(), push: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => navigation, usePathname: () => "/w/workspace-a/studio/connectors" }));
vi.mock("@/components/doc/doc-sidebar-data", () => ({ useSidebarData: () => ({ sidebarCollapsed: true }) }));
vi.mock("@/contexts/brain-surface-context", () => ({ useBrainSurface: () => ({ section: "entries", setSection: vi.fn() }) }));
const noop = () => {};
const wrap = (children: React.ReactNode) => <I18nProvider locale="en" dict={en}>{children}</I18nProvider>;

describe("[COMP:app-web/workspace-topbar] common frame", () => {
  it("keeps active-tab history callbacks and disabled states in the phone Page menu", async () => {
    const host = document.createElement('div'); document.body.append(host);
    const root = createRoot(host), back = vi.fn(), forward = vi.fn();
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    try {
      await act(async () => root.render(wrap(<DocTopBar tabs={[{ key: 'tab-a', pageId: 'page-a', title: 'A page', icon: null, isActive: true }]} sidebarCollapsed canBack canForward={false} onBack={back} onForward={forward} onSwitchTab={noop} onCloseTab={noop} onNewTab={noop} />)));
      const trigger = host.querySelector<HTMLButtonElement>('[data-doc-tabs-menu]')!;
      await act(async () => trigger.click());
      const menuItems = [...document.querySelectorAll<HTMLElement>('[role=menuitem]')];
      const backItem = menuItems.find(item => item.textContent === en.docPage.topbarBackAria)!;
      const forwardItem = menuItems.find(item => item.textContent === en.docPage.topbarForwardAria)!;
      expect(forwardItem.getAttribute('aria-disabled')).toBe('true');
      await act(async () => backItem.click());
      expect(back).toHaveBeenCalledOnce(); expect(forward).not.toHaveBeenCalled();
    } finally { await act(async () => root.unmount()); host.remove(); vi.unstubAllGlobals(); }
  });

  it("uses the same frame and one search slot for every app, breadcrumbs and real Page tabs", () => {
    const bars = [
      ...OPERATOR_APP_KEYS.map(app => <OperatorTopbar key={app} app={app} center={<button>View control</button>} right={<button>App action</button>} />),
      <OperatorTopbar key="projects" identity={{ label: en.contextScope.projectsTitle, icon: FolderKanban }} />,
      <OperatorTopbar key="live" identity={{ label: en.liveApp.title, icon: Activity }} />,
      <BrainTopbar key="brain" workspaceId="workspace-a" tail="Long item title" center={<button>View control</button>} right={<button>Save action</button>} />,
      <StudioTopbar key="studio" workspaceId="workspace-a" />,
      <WorkflowTopbar key="workflow" workspaceId="workspace-a" />,
      <OfficeTopbar key="office" workspaceId="workspace-a" breadcrumbs={[{ label: "A folder", href: "/folder" }, { label: "A file" }]} />,
      <DocTopBar key="page" tabs={[{ key: "tab-a", pageId: "page-a", title: "A document", icon: null, isActive: true }]} sidebarCollapsed canBack canForward onBack={noop} onForward={noop} onSwitchTab={noop} onCloseTab={noop} onNewTab={noop} />,
    ];
    let frameClass: string | undefined;
    for (const bar of bars) {
      const host = document.createElement("div");
      host.innerHTML = renderToString(wrap(bar));
      const frame = host.querySelector<HTMLElement>("[data-workspace-topbar]")!;
      expect(frame).not.toBeNull();
      frameClass ??= frame.className;
      expect(frame.className).toBe(frameClass);
      expect(frame.className).toContain("h-11");
      expect(frame.className).toContain("md:h-9");
      expect(frame.className).toContain("border-b");
      expect(frame.className).toContain("border-border bg-background");
      expect(frame.querySelectorAll("[data-workspace-search-slot]")).toHaveLength(1);
      expect(frame.querySelectorAll("[data-workspace-history] button")).toHaveLength(2);
      expect(host.innerHTML).not.toContain(en.docPage.topbarSidebarCollapseAria);
      expect(host.innerHTML).not.toContain(en.docPage.topbarSidebarExpandAria);
      expect(host.innerHTML).not.toContain("rounded-t-lg");
      expect(host.innerHTML).not.toContain("-mb-px");
    }
  });

  it("hosts the app heading and controls outside the body without remounting route state", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const RouteContext = React.createContext("");
    const mounted = vi.fn();
    function Action() {
      const label = React.useContext(RouteContext);
      const [count, setCount] = React.useState(0);
      return <button data-route-action onClick={() => setCount(count + 1)}>{label}: {count}</button>;
    }
    function Surface({ app }: { app: string }) {
      React.useEffect(() => { mounted(); }, []);
      return <RouteContext.Provider value={app}>
        <WorkspaceTopbar sidebarCollapsed={false} history={{ onBack: noop, onForward: noop }} identity={<span data-workspace-app-identity>{app}</span>}><Action /></WorkspaceTopbar>
        <input aria-label="Draft" defaultValue="A draft" />
      </RouteContext.Provider>;
    }
    function Shell({ app, active = true }: { app: string; active?: boolean }) {
      return <WorkspaceTopbarProvider>
        <WorkspaceTopbarHost />
        <div data-workspace-surfaces>
          <aside><WorkspaceAppTitleHost /></aside>
          <main>{active && <Surface app={app} />}</main>
        </div>
      </WorkspaceTopbarProvider>;
    }
    try {
      await act(async () => root.render(wrap(<Shell app="First app" />)));
      const body = host.querySelector("main")!;
      const title = host.querySelector("[data-workspace-app-heading]")!;
      const toolbar = host.querySelector("[data-workspace-topbar-host]")!;
      expect(toolbar.hasAttribute("data-workspace-window-header")).toBe(true);
      expect(toolbar.nextElementSibling).toBe(host.querySelector("[data-workspace-surfaces]"));
      expect(host.querySelector("[data-workspace-surfaces] [data-workspace-topbar]")).toBeNull();
      expect(toolbar.querySelector("[data-workspace-topbar]")?.className).toContain("bg-transparent");
      const draft = body.querySelector("input")!;
      draft.value = "Unsaved changes";
      expect(title.textContent).toBe("First app");
      expect(body.querySelector("[data-workspace-topbar], [data-workspace-app-identity]")).toBeNull();
      expect(toolbar.querySelectorAll("[data-workspace-search-slot]")).toHaveLength(1);
      const action = toolbar.querySelector<HTMLButtonElement>("[data-route-action]")!;
      await act(async () => action.click());
      expect(action.textContent).toBe("First app: 1");

      await act(async () => root.render(wrap(<Shell app="Second app" />)));
      expect(title.textContent).toBe("Second app");
      expect(action.textContent).toBe("Second app: 1");
      expect(body.querySelector("input")).toBe(draft);
      expect(draft.value).toBe("Unsaved changes");
      expect(mounted).toHaveBeenCalledOnce();

      await act(async () => root.render(wrap(<Shell app="Second app" active={false} />)));
      expect(title.textContent).toBe("");
      expect(toolbar.querySelector("[data-workspace-topbar]")).toBeNull();
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("keeps app-root navigation in the sidebar heading and closes a phone drawer", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const close = vi.fn();
    window.addEventListener(SIDEBAR_CLOSE_EVENT, close);
    const bars = [<BrainTopbar workspaceId="workspace-a" />, <StudioTopbar workspaceId="workspace-a" />, <WorkflowTopbar workspaceId="workspace-a" />, <OfficeTopbar workspaceId="workspace-a" />];
    try {
      for (const bar of bars) {
        await act(async () => root.render(wrap(<WorkspaceTopbarProvider><WorkspaceAppTitleHost /><WorkspaceTopbarHost /><main>{bar}</main></WorkspaceTopbarProvider>)));
        const heading = host.querySelector("[data-workspace-app-heading]")!;
        const target = heading.querySelector<HTMLElement>("a, button")!;
        expect(target).not.toBeNull();
        target.addEventListener("click", event => event.preventDefault());
        close.mockClear();
        await act(async () => target.click());
        expect(close).toHaveBeenCalledOnce();
      }
    } finally {
      window.removeEventListener(SIDEBAR_CLOSE_EVENT, close);
      await act(async () => root.unmount()); host.remove();
    }
  });

  it("preserves caller-owned history, disabled states and native collapsed clearance", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host);
    const back = vi.fn(), forward = vi.fn();
    try {
      await act(async () => root.render(wrap(<WorkspaceTopbar sidebarCollapsed history={{ onBack: back, onForward: forward, canBack: false, onPhone: true }}><span>Current document</span></WorkspaceTopbar>)));
      const buttons = host.querySelectorAll<HTMLButtonElement>("[data-workspace-history] button");
      expect(buttons[0].disabled).toBe(true);
      await act(async () => { buttons[0].click(); buttons[1].click(); });
      expect(back).not.toHaveBeenCalled();
      expect(forward).toHaveBeenCalledOnce();
      expect(host.querySelector("[data-workspace-topbar]")?.getAttribute("data-sidebar-collapsed")).toBe("true");
      expect(buttons[0].className).not.toContain("max-md:hidden");
      await act(async () => root.render(wrap(<WorkspaceTopbar sidebarCollapsed={false} history={{ onBack: back, onForward: forward }}><button>Surface action</button></WorkspaceTopbar>)));
      await act(async () => buttons[0].click());
      expect(back).toHaveBeenCalledOnce();
      expect(buttons[0].className).toContain("max-md:hidden");
      expect(host.textContent).toContain("Surface action");
    } finally { await act(async () => root.unmount()); host.remove(); }
  });

  it("places sidebar collapse next to window history and keeps its state accessible", async () => {
    const host = document.createElement("div"); document.body.append(host);
    const root = createRoot(host), toggle = vi.fn();
    const view = (collapsed: boolean) => wrap(<WorkspaceTopbarProvider onToggleSidebar={toggle}><WorkspaceTopbarHost /><WorkspaceTopbar sidebarCollapsed={collapsed} history={{ onBack: noop, onForward: noop }}><span>View controls</span></WorkspaceTopbar></WorkspaceTopbarProvider>);
    try {
      await act(async () => root.render(view(false)));
      const button = host.querySelector<HTMLButtonElement>("[data-workspace-window-navigation] [data-workspace-sidebar-toggle]")!;
      expect(button.getAttribute("aria-expanded")).toBe("true");
      expect(button.getAttribute("aria-label")).toBe(en.docPage.topbarSidebarCollapseAria);
      await act(async () => button.click());
      expect(toggle).toHaveBeenCalledOnce();
      await act(async () => root.render(view(true)));
      expect(button.getAttribute("aria-expanded")).toBe("false");
      expect(button.getAttribute("aria-label")).toBe(en.docPage.topbarSidebarExpandAria);
    } finally { await act(async () => root.unmount()); host.remove(); }
  });
});
