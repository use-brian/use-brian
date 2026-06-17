/**
 * [COMP:app-web/doc-topbar] Doc top "layer" — sidebar toggle,
 * browse-history arrows, and the open-tab strip.
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
import { DocTopBar, type TabView } from "../doc-topbar";

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
      onToggleSidebar={noop}
      onBack={noop}
      onForward={noop}
      onSwitchTab={noop}
      onCloseTab={noop}
      onNewTab={noop}
    />,
  );
}

describe("[COMP:app-web/doc-topbar] Top-bar chrome", () => {
  it("renders the sidebar collapse control + history arrows + new-tab button", () => {
    const html = bar();
    expect(html).toContain(en.docPage.topbarSidebarCollapseAria);
    expect(html).toContain(en.docPage.topbarBackAria);
    expect(html).toContain(en.docPage.topbarForwardAria);
    expect(html).toContain(en.docPage.topbarNewTabAria);
  });

  it("flips the sidebar toggle label when collapsed", () => {
    expect(bar({ sidebarCollapsed: false })).toContain(
      en.docPage.topbarSidebarCollapseAria,
    );
    expect(bar({ sidebarCollapsed: true })).toContain(
      en.docPage.topbarSidebarExpandAria,
    );
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
    expect(closes).toBe(2);
  });

  it("hides the close affordance when only one tab is open", () => {
    // A lone tab can't be closed (the strip is never empty), so no ✕ renders.
    expect(bar()).not.toContain(en.docPage.topbarCloseTabAria);
  });
});
