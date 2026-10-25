/**
 * [COMP:app-web/doc-topbar] Page tabs and active-tab history inside the shared workspace header.
 *
 * app-web's vitest is node-only (no jsdom), so we SSR-render via
 * `renderToString` and assert against the static markup — the same pattern
 * as `mobile-chat-drawer.test.tsx` / `floating-toolbar.test.tsx`. The pure
 * tab/history state behind the arrows + chips is covered exhaustively in
 * `lib/__tests__/doc-tabs.test.ts`; here we assert the presentational
 * contract: which labels render, which arrows are disabled, the active-tab
 * styling, the blank-tab fallback label, and the single-tab close rule.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  DocTopBar,
  PHONE_TAB_CHIPS,
  collapseTabStrip,
  type TabView,
} from "../doc-topbar";

const dict = en as unknown as Dictionary;
const noop = () => {};

function wrap(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

function bar(overrides: Partial<React.ComponentProps<typeof DocTopBar>> = {}) {
  const tabs: TabView[] = overrides.tabs ?? [
    {
      key: "t0",
      pageId: "p1",
      isActive: true,
      title: "Goals",
      icon: "⚽",
      entity: "tasks",
      viewType: "table",
    },
  ];
  return wrap(
    <DocTopBar
      tabs={tabs}
      canBack={overrides.canBack ?? false}
      canForward={overrides.canForward ?? false}
      sidebarCollapsed={overrides.sidebarCollapsed ?? false}
      onBack={noop}
      onForward={noop}
      onSwitchTab={noop}
      onCloseTab={noop}
      onNewTab={noop}
    />,
  );
}

describe("[COMP:app-web/doc-topbar] Top-bar chrome", () => {
  it("renders shared history and new-tab controls while the rail owns sidebar collapse", () => {
    const html = bar();
    expect(html).not.toContain(en.docPage.topbarSidebarCollapseAria);
    expect(html).toContain(en.docPage.topbarBackAria);
    expect(html).toContain(en.docPage.topbarForwardAria);
    expect(html).toContain(en.docPage.topbarNewTabAria);
  });

  it("keeps native title-bar clearance tied to the sidebar state", () => {
    expect(bar({ sidebarCollapsed: false })).toContain('data-sidebar-collapsed="false"');
    expect(bar({ sidebarCollapsed: true })).toContain('data-sidebar-collapsed="true"');
  });

  it("disables back/forward when the active tab cannot navigate", () => {
    // Both ends of the history → both arrows carry the disabled attribute.
    const html = bar({ canBack: false, canForward: false });
    const disabledCount = (html.match(/disabled=""/g) ?? []).length;
    expect(disabledCount).toBeGreaterThanOrEqual(2);
  });

  it("enables forward when there is forward history", () => {
    const html = bar({ canBack: true, canForward: true });
    // With both navigable, neither history arrow is disabled (the strip has
    // no other disabled controls).
    expect(html).not.toContain("disabled=\"\"");
  });

  it("labels a page tab by its title", () => {
    expect(bar()).toContain("Goals");
  });

  it("falls back to the New-tab label for a blank tab", () => {
    const html = bar({
      tabs: [{ key: "t0", pageId: null, isActive: true, title: null, icon: null }],
    });
    expect(html).toContain(en.docPage.topbarNewTabLabel);
  });

  it("labels a panel tab by its fixed label, not the blank/New-tab fallback", () => {
    // A panel tab has pageId=null (it isn't a page) but must NOT read as a
    // blank "New tab" — it shows its own label + glyph.
    const html = bar({
      tabs: [
        {
          key: "t0",
          pageId: null,
          panel: "approvals",
          isActive: true,
          title: en.docPage.topbarPanelApprovals,
          icon: null,
        },
      ],
    });
    expect(html).toContain(en.docPage.topbarPanelApprovals);
    expect(html).not.toContain(en.docPage.topbarNewTabLabel);
  });

  it("falls back to Untitled for a page tab with no title", () => {
    const html = bar({
      tabs: [
        {
          key: "t0",
          pageId: "p1",
          isActive: true,
          title: null,
          icon: null,
          entity: "tasks",
          viewType: "table",
        },
      ],
    });
    expect(html).toContain(en.docPage.breadcrumbUntitled);
  });

  it("renders a close affordance per tab when more than one is open", () => {
    const html = bar({
      tabs: [
        { key: "t0", pageId: "p1", isActive: true, title: "A", icon: null, entity: "tasks", viewType: "table" },
        { key: "t1", pageId: "p2", isActive: false, title: "B", icon: null, entity: "tasks", viewType: "table" },
      ],
    });
    const closes = (
      html.match(new RegExp(`aria-label="${en.docPage.topbarCloseTabAria}"`, "g")) ??
      []
    ).length;
    // Two strips render (desktop + phone, CSS picks one): a ✕ per tab in each.
    expect(closes).toBe(4);
  });

  it("hides the close affordance when only one tab is open", () => {
    // A lone tab can't be closed (the strip is never empty), so no ✕ renders.
    expect(bar()).not.toContain(en.docPage.topbarCloseTabAria);
  });

  it("dims an inactive tab's close on touch instead of hiding it (M2)", () => {
    const html = bar({
      tabs: [
        { key: "t0", pageId: "p1", isActive: true, title: "A", icon: null, entity: "tasks", viewType: "table" },
        { key: "t1", pageId: "p2", isActive: false, title: "B", icon: null, entity: "tasks", viewType: "table" },
      ],
    });
    // The hover reveal stays behind `md:`; a bare `opacity-0` would never
    // show the ✕ to a finger (graded: invariants/touch-reveal).
    expect(html).toContain("opacity-60 md:opacity-0 md:group-hover/tab:opacity-100");
    expect(html).not.toMatch(/[\s"]opacity-0 group-hover/);
  });
});

/**
 * Phone strip (responsive contract M8). ~160px remain for tabs at 360px once
 * the history arrows are 44px, so the phone strip keeps label chips only up
 * to PHONE_TAB_CHIPS tabs and then collapses to the active chip + an "N tabs"
 * menu. `collapseTabStrip` is the pure rule; the SSR markup carries both
 * strips (CSS picks one), so the phone strip is asserted by its marker.
 */
describe("[COMP:app-web/doc-topbar] Phone tab strip", () => {
  const tab = (key: string, isActive: boolean): TabView => ({
    key,
    pageId: `p-${key}`,
    isActive,
    title: `Tab ${key}`,
    icon: null,
    entity: "tasks",
    viewType: "table",
  });

  it("keeps a chip per tab up to the chip cap", () => {
    expect(PHONE_TAB_CHIPS).toBe(2);
    const two = [tab("a", false), tab("b", true)];
    expect(collapseTabStrip(two)).toEqual({ chips: two, menu: [] });
  });

  it("collapses past the cap to the ACTIVE chip plus every tab in the menu", () => {
    const three = [tab("a", false), tab("b", true), tab("c", false)];
    const { chips, menu } = collapseTabStrip(three);
    expect(chips.map((t) => t.key)).toEqual(["b"]);
    expect(menu.map((t) => t.key)).toEqual(["a", "b", "c"]);
  });

  it("falls back to the first tab as the chip when none is active", () => {
    const three = [tab("a", false), tab("b", false), tab("c", false)];
    expect(collapseTabStrip(three).chips.map((t) => t.key)).toEqual(["a"]);
  });

  it("keeps a compact phone history menu at two tabs and tab overflow at three", () => {
    const two = bar({ tabs: [tab("a", true), tab("b", false)] });
    expect(two).toContain("data-doc-tabs-menu");

    const three = bar({ tabs: [tab("a", true), tab("b", false), tab("c", false)] });
    expect(three).toContain("data-doc-tabs-menu");
    expect(three).toContain("3 tabs");
    expect(three).toContain(en.docPage.topbarTabsMenuAria);
    // The phone strip shows only the active chip; the other titles are in the
    // (closed, portaled) menu, so they appear once - from the desktop strip.
    const phone = three.slice(three.indexOf('data-doc-tab-strip="phone"'));
    expect(phone).toContain("Tab a");
    expect(phone).not.toContain("Tab b");
  });
});
