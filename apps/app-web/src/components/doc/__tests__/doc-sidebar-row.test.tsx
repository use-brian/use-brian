/**
 * [COMP:app-web/doc-sidebar] Draft prune caption + Save-page action.
 *
 * vitest in app-web is node-only (no jsdom) — we mount through
 * `renderToString` and assert against the static markup, the same shape
 * mobile-chat-drawer.test.tsx uses. The prune caption is height-animated
 * via a CSS `grid-rows 0fr→1fr` track (revealed on hover or while the
 * draft is the active page) that jsdom couldn't exercise anyway, so the
 * contract we assert is the *static* one: on the active draft the caption
 * is expanded with the verbose "Nd until auto-delete" copy and carries the
 * clickable "Save page" CTA; on an inactive, un-hovered draft it is
 * present-but-collapsed; and it is absent entirely on saved rows.
 *
 * The row's leading glyph is a static icon (no emoji picker), so nothing
 * here pulls the DOM-only emoji-mart bundle at import.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";

import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { DocSidebarRow } from "../doc-sidebar-row";
import type { ViewListRow } from "@/lib/api/views";

const dict = en as unknown as Dictionary;
const noop = () => {};

function draftRow(overrides: Partial<ViewListRow> = {}): ViewListRow {
  return {
    id: "v1",
    name: "Untitled — draft",
    icon: null,
    state: "draft",
    entity: null,
    viewType: null,
    nameOrigin: "placeholder",
    ...overrides,
  } as unknown as ViewListRow;
}

function render(node: React.ReactNode): string {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      {node}
    </I18nProvider>,
  );
}

// 28 days out (+1h cushion so Math.round in daysUntilPrune lands on 28).
const in28Days = new Date(Date.now() + 28 * 86_400_000 + 3_600_000).toISOString();

describe("[COMP:app-web/doc-sidebar] Draft prune caption", () => {
  it("expands the verbose countdown on the active draft", () => {
    const html = render(
      <DocSidebarRow
        row={draftRow()}
        active
        autoPruneAt={in28Days}
        onSelect={noop}
        onSave={noop}
        onDelete={noop}
      />,
    );
    expect(html).toContain("28d until auto-delete");
    expect(html).toContain("grid-rows-[1fr]");
    expect(html).toContain("opacity-100");
  });

  it("renders the prune caption as a clickable Save-page button", () => {
    const html = render(
      <DocSidebarRow
        row={draftRow()}
        active
        autoPruneAt={in28Days}
        onSelect={noop}
        onSave={noop}
        onDelete={noop}
      />,
    );
    // The caption doubles as the rescue affordance — the "Save page" CTA
    // (swapped in on hover via CSS) ships in the markup with the button's
    // aria-label, alongside the countdown.
    expect(html).toContain(en.docPage.sidebarDraftSave); // "Save page"
    expect(html).toContain(`aria-label="${en.docPage.sidebarDraftSave}"`);
  });

  it("keeps the caption collapsed on an inactive, un-hovered draft", () => {
    const html = render(
      <DocSidebarRow
        row={draftRow()}
        active={false}
        autoPruneAt={in28Days}
        onSelect={noop}
        onSave={noop}
        onDelete={noop}
      />,
    );
    // Present in the DOM but height/opacity-collapsed — revealed only on
    // hover or while active.
    expect(html).toContain("grid-rows-[0fr]");
    expect(html).toContain("opacity-0");
  });

  it("omits the caption entirely on a saved row", () => {
    const html = render(
      <DocSidebarRow
        row={draftRow({ state: "saved" })}
        active
        onSelect={noop}
        onSave={noop}
        onDelete={noop}
      />,
    );
    expect(html).not.toContain("until auto-delete");
    expect(html).not.toContain(en.docPage.sidebarDraftSave);
  });

  it("omits the Save CTA on a draft kept by a saved ancestor", () => {
    // A draft filed inside a saved (Favorites) subtree is kept by its
    // parent's save — no per-child "Save page" CTA / prune countdown, even
    // though it is still `state: 'draft'` with an active prune date.
    const html = render(
      <DocSidebarRow
        row={draftRow()}
        active
        autoPruneAt={in28Days}
        inSavedSubtree
        onSelect={noop}
        onSave={noop}
        onDelete={noop}
      />,
    );
    expect(html).not.toContain("until auto-delete");
    expect(html).not.toContain(en.docPage.sidebarDraftSave);
  });
});
