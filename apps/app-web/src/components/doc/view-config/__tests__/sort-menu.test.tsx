/**
 * [COMP:app-web/view-config-sort-menu] SortMenu — closed-state SSR
 * + value-driven label shape.
 *
 * vitest in app-web is node-only (no jsdom). The popover open state
 * needs an `onClick` to dispatch — out of scope here. The contract this
 * suite asserts:
 *   - closed-state SSR renders the trigger with the right label
 *   - the label switches between "Sort" (placeholder) and
 *     "<Column> ↑|↓" (active sort)
 *   - the active arrow glyph reflects `direction`
 *   - aria-haspopup / aria-expanded reflect the closed state
 *   - the popover root is absent in the closed state
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { SortMenu, type Sort } from "../sort-menu";
import type { A2UIColumn } from "@use-brian/views-renderer";

const dict = en as unknown as Dictionary;

const COLUMNS: A2UIColumn[] = [
  { field: "title", header: "Title", kind: "text" },
  { field: "amount", header: "Amount", kind: "number" },
  { field: "due", header: "Due", kind: "date" },
];

function mount(value: Sort | null) {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <SortMenu columns={COLUMNS} value={value} onChange={() => {}} />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/view-config-sort-menu] closed-state SSR", () => {
  it("renders the placeholder label when value is null", () => {
    const html = mount(null);
    expect(html).toMatch(/data-action="open-sort"/);
    // English: "Sort" is the placeholder.
    expect(html).toMatch(/Sort/);
    // Popover is closed.
    expect(html).not.toMatch(/data-popover="sort"/);
  });

  it("renders the column header when sorted ascending", () => {
    const html = mount({ propertyName: "amount", direction: "asc" });
    expect(html).toMatch(/Amount/);
    expect(html).toMatch(/↑/);
  });

  it("renders the column header when sorted descending", () => {
    const html = mount({ propertyName: "due", direction: "desc" });
    expect(html).toMatch(/Due/);
    expect(html).toMatch(/↓/);
  });

  it("sets aria-haspopup=dialog and aria-expanded=false when closed", () => {
    const html = mount(null);
    expect(html).toMatch(/aria-haspopup="dialog"/);
    expect(html).toMatch(/aria-expanded="false"/);
  });

  it("does not render the asc/desc toggles when closed", () => {
    const html = mount({ propertyName: "title", direction: "asc" });
    // Toggles are inside the popover.
    expect(html).not.toMatch(/data-action="set-asc"/);
    expect(html).not.toMatch(/data-action="set-desc"/);
  });

  it("does not render the clear-sort affordance when closed", () => {
    const html = mount({ propertyName: "title", direction: "asc" });
    expect(html).not.toMatch(/data-action="clear-sort"/);
  });

  it("falls through to the placeholder when value points at an unknown column", () => {
    // Defensive: a stale sort whose column was deleted should still
    // render the trigger without crashing.
    const html = mount({ propertyName: "nonexistent", direction: "asc" });
    // The placeholder ("Sort") is what wins when currentCol is null.
    expect(html).toMatch(/Sort/);
    expect(html).toMatch(/data-action="open-sort"/);
  });
});
