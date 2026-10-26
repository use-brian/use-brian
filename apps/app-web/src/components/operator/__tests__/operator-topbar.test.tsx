/** [COMP:app-web/operator-topbar] Inline app identities, responsive controls
 * and custom labels compose into the same workspace header frame. */

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
  it("renders shared history and the inline app identity", () => {
    const html = wrap(<OperatorTopbar app="tasks" />);
    expect(html).not.toContain(en.docPage.topbarSidebarCollapseAria);
    expect(html).toContain(en.docPage.topbarBackAria);
    expect(html).toContain(en.docPage.topbarForwardAria);
    expect(html).toContain(en.operatorBar.tasks);
    // Desktop-shell hooks: drag-handle + self-set collapse flag.
    expect(html).toContain("data-doc-topbar");
    expect(html).toContain('data-sidebar-collapsed="false"');
  });

  it("preserves native clearance state when collapsed", () => {
    sidebarState.collapsed = true;
    const html = wrap(<OperatorTopbar app="tasks" />);
    expect(html).not.toContain(en.docPage.topbarSidebarExpandAria);
    expect(html).toContain('data-sidebar-collapsed="true"');
  });

  it("keeps Chat audience and actions in the same shared header", () => {
    const html = wrap(<OperatorTopbar app="chat" center={<button>Audience</button>} right={<button>New conversation</button>} />);
    expect(html).toContain("data-workspace-topbar");
    expect(html).toContain("Audience");
    expect(html).toContain("New conversation");
    expect(html).not.toContain(en.docPage.topbarSidebarCollapseAria);
    expect(html).toContain(en.docPage.topbarBackAria);
    expect(html).toContain(en.docPage.topbarForwardAria);
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

  it("hides the app identity below `sm` by default so the center slot keeps its width (M8)", () => {
    // Regression for the 390px Chat surface: a 200px chip beside a `flex-1
    // min-w-0` center slot absorbed every pixel of negative space and the
    // Personal / Workspace toggle rendered 0px wide. The chip now yields
    // below `sm` in the PRIMITIVE, so no surface has to remember to pass an
    // override (graded: invariants/topbar-chip-gate).
    const html = wrap(<OperatorTopbar app="chat" center={<span>CENTER</span>} />);
    const chip = /data-workspace-app-identity[^>]*class="([^"]*)"/.exec(html)?.[1] ?? "";
    expect(chip).toContain("hidden");
    expect(chip).toContain("sm:flex");
    expect(chip).toContain("max-w-52");
    expect(chip).not.toContain("rounded-t-lg");
    expect(chip).not.toMatch(/(^|\s)w-\[200px\]/);
  });

  it("still composes a surface-owned app-chip override on top of the default", () => {
    const html = wrap(
      <OperatorTopbar app="browsers" appChipClassName="sm:w-[200px]" />,
    );
    expect(html).toContain("sm:w-[200px]");
    expect(html).toContain("hidden");
  });
});
