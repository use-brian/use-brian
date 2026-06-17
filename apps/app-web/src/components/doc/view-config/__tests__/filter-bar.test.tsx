/**
 * [COMP:app-web/view-config-filter-bar] FilterBar — catalog + SSR.
 *
 * vitest in app-web is node-only (no jsdom). We exercise:
 *   - the static operator catalog (`OPERATORS_BY_KIND`) — every supported
 *     property kind maps to the right ops
 *   - the `operatorsForKind` resolver — undefined and unknown kinds fall
 *     back to the text catalog
 *   - the closed-state SSR markup (`renderToString`) — empty bar renders
 *     a single "+ Filter" button, populated bar renders one chip per
 *     filter plus the add-another button
 *   - `renderFilterValue` — the chip-friendly value summariser
 *
 * The popover open-state (property → operator → value walk) requires
 * pointer events and a DOM to interact with the `<select>` elements;
 * those interactions are out of scope for this node-only suite. The
 * contract is tested indirectly: the closed-state markup shows the
 * popover root is not present until the trigger is clicked.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  FilterBar,
  OPERATORS_BY_KIND,
  VALUE_LESS_OPS,
  operatorsForKind,
  renderFilterValue,
  type Filter,
} from "../filter-bar";
import type { A2UIColumn } from "@sidanclaw/views-renderer";

const dict = en as unknown as Dictionary;

const COLUMNS: A2UIColumn[] = [
  { field: "title", header: "Title", kind: "text" },
  { field: "amount", header: "Amount", kind: "number" },
  { field: "status", header: "Status", kind: "status" },
  { field: "due", header: "Due", kind: "date" },
  { field: "done", header: "Done", kind: "checkbox" },
  { field: "owner", header: "Owner", kind: "person" },
];

function mount(filters: Filter[] = []) {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <FilterBar columns={COLUMNS} value={filters} onChange={() => {}} />
    </I18nProvider>,
  );
}

// ── Catalog ──────────────────────────────────────────────────────────

describe("[COMP:app-web/view-config-filter-bar] operator catalog", () => {
  it("exposes text ops (contains / equals / starts_with) for text kinds", () => {
    expect(OPERATORS_BY_KIND.text).toEqual([
      "contains",
      "equals",
      "starts_with",
    ]);
    // url / email / phone share the text catalog.
    expect(OPERATORS_BY_KIND.url).toEqual(OPERATORS_BY_KIND.text);
    expect(OPERATORS_BY_KIND.email).toEqual(OPERATORS_BY_KIND.text);
    expect(OPERATORS_BY_KIND.phone).toEqual(OPERATORS_BY_KIND.text);
  });

  it("exposes the six comparison ops for number kinds", () => {
    expect(OPERATORS_BY_KIND.number).toEqual([
      "eq",
      "neq",
      "gt",
      "gte",
      "lt",
      "lte",
    ]);
  });

  it("exposes is / is_not / is_any_of for select / status / tags", () => {
    expect(OPERATORS_BY_KIND.select).toEqual(["is", "is_not", "is_any_of"]);
    expect(OPERATORS_BY_KIND.status).toEqual(["is", "is_not", "is_any_of"]);
    expect(OPERATORS_BY_KIND.tags).toEqual(["is", "is_not", "is_any_of"]);
  });

  it("exposes is / before / after / between for date kinds", () => {
    expect(OPERATORS_BY_KIND.date).toEqual(["is", "before", "after", "between"]);
    expect(OPERATORS_BY_KIND.created_time).toEqual(OPERATORS_BY_KIND.date);
    expect(OPERATORS_BY_KIND.last_edited_time).toEqual(OPERATORS_BY_KIND.date);
  });

  it("exposes is_checked / is_unchecked for checkbox (no value editor)", () => {
    expect(OPERATORS_BY_KIND.checkbox).toEqual(["is_checked", "is_unchecked"]);
    expect(VALUE_LESS_OPS.has("is_checked")).toBe(true);
    expect(VALUE_LESS_OPS.has("is_unchecked")).toBe(true);
  });

  it("exposes is / is_not for person + relation", () => {
    expect(OPERATORS_BY_KIND.person).toEqual(["is", "is_not"]);
    expect(OPERATORS_BY_KIND.relation).toEqual(["is", "is_not"]);
  });
});

describe("[COMP:app-web/view-config-filter-bar] operatorsForKind", () => {
  it("returns the text catalog for undefined kinds", () => {
    expect(operatorsForKind(undefined)).toEqual(OPERATORS_BY_KIND.text);
  });

  it("returns the number catalog for number kinds", () => {
    expect(operatorsForKind("number")).toEqual(OPERATORS_BY_KIND.number);
  });

  it("returns the date catalog for date kinds", () => {
    expect(operatorsForKind("date")).toEqual(OPERATORS_BY_KIND.date);
  });
});

// ── renderFilterValue ────────────────────────────────────────────────

describe("[COMP:app-web/view-config-filter-bar] renderFilterValue", () => {
  it("returns empty string for value-less ops", () => {
    expect(
      renderFilterValue({ propertyName: "done", op: "is_checked", value: null }),
    ).toBe("");
  });

  it("joins array values with comma + space", () => {
    expect(
      renderFilterValue({
        propertyName: "status",
        op: "is_any_of",
        value: ["todo", "doing"],
      }),
    ).toBe("todo, doing");
  });

  it("stringifies primitives directly", () => {
    expect(
      renderFilterValue({ propertyName: "amount", op: "gt", value: 100 }),
    ).toBe("100");
    expect(
      renderFilterValue({
        propertyName: "title",
        op: "contains",
        value: "foo",
      }),
    ).toBe("foo");
  });

  it("collapses null/undefined to empty string", () => {
    expect(
      renderFilterValue({ propertyName: "title", op: "equals", value: null }),
    ).toBe("");
  });
});

// ── SSR markup ───────────────────────────────────────────────────────

describe("[COMP:app-web/view-config-filter-bar] SSR markup", () => {
  it("renders a single trigger button when empty", () => {
    const html = mount([]);
    expect(html).toMatch(/data-action="add-filter"/);
    // No chips.
    expect(html).not.toMatch(/data-chip="filter"/);
    // Popover is closed.
    expect(html).not.toMatch(/data-popover="filter"/);
  });

  it("renders one chip per active filter plus the add-another button", () => {
    const html = mount([
      { propertyName: "title", op: "contains", value: "foo" },
      { propertyName: "amount", op: "gt", value: 100 },
    ]);
    const chips = html.match(/data-chip="filter"/g) ?? [];
    expect(chips.length).toBe(2);
    // The "+ Filter" trigger is still present so the user can add more.
    expect(html).toMatch(/data-action="add-filter"/);
  });

  it("emits the property header in the chip (not the field name)", () => {
    const html = mount([
      { propertyName: "amount", op: "gt", value: 100 },
    ]);
    expect(html).toMatch(/Amount/);
  });

  it("emits the operator label from the dictionary", () => {
    const html = mount([
      { propertyName: "title", op: "contains", value: "foo" },
    ]);
    // English label: "contains".
    expect(html).toMatch(/contains/);
  });

  it("renders a remove button per chip", () => {
    const html = mount([
      { propertyName: "title", op: "contains", value: "x" },
      { propertyName: "amount", op: "lt", value: 10 },
    ]);
    const removes = html.match(/data-action="remove-chip"/g) ?? [];
    expect(removes.length).toBe(2);
  });
});
