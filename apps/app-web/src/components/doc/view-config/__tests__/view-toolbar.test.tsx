/**
 * [COMP:app-web/view-config-toolbar] ViewToolbar — container SSR +
 * default value helper.
 *
 * vitest in app-web is node-only (no jsdom). We assert the four
 * affordances are mounted side-by-side with a search input on the
 * left, plus the `defaultViewToolbarValue` factory shape.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  ViewToolbar,
  defaultViewToolbarValue,
  type ViewToolbarValue,
} from "../view-toolbar";
import type { A2UIColumn } from "@use-brian/views-renderer";

const dict = en as unknown as Dictionary;

const COLUMNS: A2UIColumn[] = [
  { field: "title", header: "Title", kind: "text" },
  { field: "status", header: "Status", kind: "status" },
  { field: "due", header: "Due", kind: "date" },
];

function mount(value: ViewToolbarValue) {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <ViewToolbar columns={COLUMNS} value={value} onChange={() => {}} />
    </I18nProvider>,
  );
}

describe("[COMP:app-web/view-config-toolbar] defaultViewToolbarValue", () => {
  it("returns every column visible in declared order with no filters / sort / group", () => {
    const v = defaultViewToolbarValue(COLUMNS);
    expect(v.search).toBe("");
    expect(v.filters).toEqual([]);
    expect(v.sort).toBeNull();
    expect(v.groupBy).toBeNull();
    expect(v.visibleProperties).toEqual(["title", "status", "due"]);
    expect(v.order).toEqual(["title", "status", "due"]);
  });

  it("returns an empty default for an empty column list", () => {
    const v = defaultViewToolbarValue([]);
    expect(v.visibleProperties).toEqual([]);
    expect(v.order).toEqual([]);
  });
});

describe("[COMP:app-web/view-config-toolbar] container SSR", () => {
  const v = defaultViewToolbarValue(COLUMNS);

  it("mounts the search input", () => {
    const html = mount(v);
    expect(html).toMatch(/data-field="search"/);
    expect(html).toMatch(/type="search"/);
  });

  it("mounts the filter bar trigger", () => {
    const html = mount(v);
    expect(html).toMatch(/data-action="add-filter"/);
  });

  it("mounts the sort menu trigger", () => {
    const html = mount(v);
    expect(html).toMatch(/data-action="open-sort"/);
  });

  it("mounts the group-by menu trigger", () => {
    const html = mount(v);
    expect(html).toMatch(/data-action="open-group-by"/);
  });

  it("mounts the property-toggle menu trigger", () => {
    const html = mount(v);
    expect(html).toMatch(/data-action="open-properties"/);
  });

  it("renders the toolbar root with the right component marker", () => {
    const html = mount(v);
    expect(html).toMatch(/data-component="view-toolbar"/);
  });

  it("threads the current search value into the input", () => {
    const html = mount({ ...v, search: "alpha" });
    expect(html).toMatch(/value="alpha"/);
  });
});
