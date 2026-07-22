/**
 * [COMP:app-web/operator-topbar] Operator top bar — the shared doc-style
 * chrome row the non-Page operator apps (Tasks / CRM / Feed) open with.
 *
 * app-web's vitest is node-only (no jsdom), so we SSR-render via
 * `renderToString` and assert against the static markup (the doc-topbar test
 * pattern). The router + layout-level sidebar state are module-mocked; here
 * we assert the presentational contract: the chrome controls render, the
 * toggle label flips with the collapse flag, each app's chip carries its
 * `operatorBar` label, the chip is NOT closable, there is no `+` (new-tab)
 * control, and the center/right slots render injected content.
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

import { OperatorTopbar } from "../operator-topbar";

const dict = en as unknown as Dictionary;

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

beforeEach(() => {
  sidebarState.collapsed = false;
});

describe("[COMP:app-web/operator-topbar] Operator top bar chrome", () => {
  it("renders the sidebar toggle + history arrows and the app tab chip", () => {
    const html = wrap(<OperatorTopbar app="tasks" />);
    expect(html).toContain(en.docPage.topbarSidebarCollapseAria);
    expect(html).toContain(en.docPage.topbarBackAria);
    expect(html).toContain(en.docPage.topbarForwardAria);
    expect(html).toContain(en.operatorBar.tasks);
    // Desktop-shell hooks: drag-handle + self-set collapse flag.
    expect(html).toContain("data-doc-topbar");
    expect(html).toContain('data-sidebar-collapsed="false"');
  });

  it("flips the sidebar toggle label when collapsed", () => {
    sidebarState.collapsed = true;
    const html = wrap(<OperatorTopbar app="tasks" />);
    expect(html).toContain(en.docPage.topbarSidebarExpandAria);
    expect(html).toContain('data-sidebar-collapsed="true"');
  });

  it("names the chip per app from the operatorBar labels", () => {
    expect(wrap(<OperatorTopbar app="crm" />)).toContain(en.operatorBar.crm);
    expect(wrap(<OperatorTopbar app="feed" />)).toContain(en.operatorBar.feed);
  });

  it("has no close ✕ and no new-tab + (doc-tabs stays Page-only)", () => {
    const html = wrap(<OperatorTopbar app="tasks" />);
    expect(html).not.toContain(en.docPage.topbarCloseTabAria);
    expect(html).not.toContain(en.docPage.topbarNewTabAria);
  });

  it("renders injected center and right slot content", () => {
    const html = wrap(
      <OperatorTopbar
        app="crm"
        center={<span>CENTER-SLOT</span>}
        right={<span>RIGHT-SLOT</span>}
      />,
    );
    expect(html).toContain("CENTER-SLOT");
    expect(html).toContain("RIGHT-SLOT");
  });
});
