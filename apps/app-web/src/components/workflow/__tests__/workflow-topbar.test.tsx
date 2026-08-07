/**
 * [COMP:app-web/workflow-topbar] Shared Workflow surface chrome.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ back: vi.fn(), forward: vi.fn() }),
}));

const sidebarState = { collapsed: false };
vi.mock("@/components/doc/doc-sidebar-data", () => ({
  useSidebarData: () => ({
    sidebarCollapsed: sidebarState.collapsed,
    setSidebarCollapsed: vi.fn(),
  }),
}));

import { WorkflowTopbar } from "../workflow-topbar";

const dict = en as unknown as Dictionary;

function renderBar(): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <WorkflowTopbar workspaceId="workspace-123" />
    </I18nProvider>,
  );
}

beforeEach(() => {
  sidebarState.collapsed = false;
});

describe("[COMP:app-web/workflow-topbar] Workflow surface chrome", () => {
  it("renders the shared sidebar and history controls with a Workflow breadcrumb", () => {
    const html = renderBar();

    expect(html).toContain(en.docPage.topbarSidebarCollapseAria);
    expect(html).toContain(en.docPage.topbarBackAria);
    expect(html).toContain(en.docPage.topbarForwardAria);
    expect(html).toContain(en.workflowPage.title);
    expect(html).toContain('href="/w/workspace-123/workflow"');
    expect(html).toContain("data-doc-topbar");
    expect(html).toContain('data-sidebar-collapsed="false"');
  });

  it("reflects the collapsed state for the desktop-shell title-bar clearance", () => {
    sidebarState.collapsed = true;

    const html = renderBar();
    expect(html).toContain(en.docPage.topbarSidebarExpandAria);
    expect(html).toContain('data-sidebar-collapsed="true"');
  });
});
