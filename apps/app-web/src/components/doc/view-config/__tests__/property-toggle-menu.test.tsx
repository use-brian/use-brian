/**
 * [COMP:app-web/view-config-property-toggle-menu] PropertyToggleMenu
 * — closed-state SSR + aria.
 *
 * vitest in app-web is node-only (no jsdom). We assert the closed
 * trigger renders, the aria attributes match the closed state, and the
 * popover root is absent until the trigger is clicked. The reorder
 * behaviour is dnd-kit drag-and-drop on the per-row grip handle — its
 * pointer/keyboard path needs a DOM, so it's out of scope here, but the
 * props contract (controlled `visibleProperties` + `order`, an
 * `onChange` that emits an `arrayMove`d order) is what tests downstream
 * pieces can assert.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { PropertyToggleMenu } from "../property-toggle-menu";
import type { A2UIColumn } from "@sidanclaw/views-renderer";

const dict = en as unknown as Dictionary;

const COLUMNS: A2UIColumn[] = [
  { field: "title", header: "Title", kind: "text" },
  { field: "status", header: "Status", kind: "status" },
  { field: "owner", header: "Owner", kind: "person" },
];

function mount(args: {
  visibleProperties?: string[];
  order?: string[];
}) {
  const visibleProperties =
    args.visibleProperties ?? COLUMNS.map((c) => c.field);
  const order = args.order ?? COLUMNS.map((c) => c.field);
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <PropertyToggleMenu
        columns={COLUMNS}
        visibleProperties={visibleProperties}
        order={order}
        onChange={() => {}}
      />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/view-config-property-toggle-menu] closed-state SSR", () => {
  it("renders the trigger button", () => {
    const html = mount({});
    expect(html).toMatch(/data-action="open-properties"/);
    // English label: "Properties"
    expect(html).toMatch(/Properties/);
  });

  it("sets aria-haspopup=dialog and aria-expanded=false when closed", () => {
    const html = mount({});
    expect(html).toMatch(/aria-haspopup="dialog"/);
    expect(html).toMatch(/aria-expanded="false"/);
  });

  it("does not render the popover root when closed", () => {
    const html = mount({});
    expect(html).not.toMatch(/data-popover="properties"/);
    expect(html).not.toMatch(/data-row="property"/);
  });

  it("does not render the show-all / hide-all controls when closed", () => {
    const html = mount({});
    expect(html).not.toMatch(/data-action="show-all"/);
    expect(html).not.toMatch(/data-action="hide-all"/);
  });

  it("does not render any per-property reorder/toggle controls when closed", () => {
    const html = mount({});
    expect(html).not.toMatch(/data-action="reorder"/);
    expect(html).not.toMatch(/data-action="toggle-visible"/);
  });

  it("respects the provided visibility list shape (no crash on partial visibility)", () => {
    const html = mount({
      visibleProperties: ["title"],
      order: ["title", "status", "owner"],
    });
    expect(html).toMatch(/data-action="open-properties"/);
  });

  it("respects a reordered `order` list (no crash on permutation)", () => {
    const html = mount({
      visibleProperties: ["title", "status", "owner"],
      order: ["owner", "status", "title"],
    });
    expect(html).toMatch(/data-action="open-properties"/);
  });
});
