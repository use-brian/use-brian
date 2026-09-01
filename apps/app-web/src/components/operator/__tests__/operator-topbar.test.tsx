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
import { Activity } from "lucide-react";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { OPERATOR_APP_KEYS } from "@/lib/operator-apps";

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

  it("names every registered non-Page app chip from operatorBar labels", () => {
    for (const app of OPERATOR_APP_KEYS) {
      if (app === "page") continue;
      expect(wrap(<OperatorTopbar app={app} />)).toContain(en.operatorBar[app]);
    }
  });

  it("accepts a top-level surface identity without adding it to Home apps", () => {
    const html = wrap(
      <OperatorTopbar identity={{ label: en.liveApp.title, icon: Activity }} />,
    );
    expect(html).toContain(en.liveApp.title);
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

  it("uses center navigation only as a mobile or collapsed-sidebar fallback", () => {
    const expanded = wrap(
      <OperatorTopbar
        app="crm"
        centerVisibility="when-sidebar-unavailable"
        center={<span>CRM-NAV</span>}
      />,
    );
    expect(expanded).toContain('data-center-visibility="when-sidebar-unavailable"');
    expect(expanded).toContain('data-center-desktop-hidden="true"');

    sidebarState.collapsed = true;
    const collapsed = wrap(
      <OperatorTopbar
        app="crm"
        centerVisibility="when-sidebar-unavailable"
        center={<span>CRM-NAV</span>}
      />,
    );
    expect(collapsed).toContain('data-center-desktop-hidden="false"');
    expect(collapsed).toContain("CRM-NAV");
  });

  it("accepts a surface-owned responsive app-chip width", () => {
    const html = wrap(
      <OperatorTopbar
        app="browsers"
        appChipClassName="hidden sm:flex sm:w-[200px]"
      />,
    );
    expect(html).toContain("hidden sm:flex sm:w-[200px]");
  });
});
