/**
 * [COMP:app-web/view-config-group-by-menu] GroupByMenu — groupable
 * kind filter + closed-state SSR.
 *
 * vitest in app-web is node-only (no jsdom). We assert:
 *   - the `GROUPABLE_KINDS` set is the canonical Phase-3 list
 *   - the `isGroupableColumn` predicate accepts groupable kinds and
 *     rejects everything else
 *   - the closed-state SSR markup
 *   - the label shape ("Group" vs "Group: Status")
 *   - aria attributes
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  GROUPABLE_KINDS,
  GroupByMenu,
  isGroupableColumn,
} from "../group-by-menu";
import type { A2UIColumn } from "@sidanclaw/views-renderer";

const dict = en as unknown as Dictionary;

const COLUMNS: A2UIColumn[] = [
  { field: "title", header: "Title", kind: "text" },
  { field: "status", header: "Status", kind: "status" },
  { field: "owner", header: "Owner", kind: "person" },
  { field: "tags", header: "Tags", kind: "tags" },
  { field: "amount", header: "Amount", kind: "number" },
  { field: "due", header: "Due", kind: "date" },
];

function mount(value: string | null) {
  return renderToString(
    <I18nProvider locale="en" dict={dict}>
      <GroupByMenu columns={COLUMNS} value={value} onChange={() => {}} />
    </I18nProvider>,
  );
}

// ── Groupable kinds catalog ──────────────────────────────────────────

describe("[COMP:app-web/view-config-group-by-menu] groupable kinds", () => {
  it("includes select / status / person / tags / relation", () => {
    expect(GROUPABLE_KINDS.has("select")).toBe(true);
    expect(GROUPABLE_KINDS.has("status")).toBe(true);
    expect(GROUPABLE_KINDS.has("person")).toBe(true);
    expect(GROUPABLE_KINDS.has("tags")).toBe(true);
    expect(GROUPABLE_KINDS.has("relation")).toBe(true);
  });

  it("excludes free-text, numbers, dates, and checkbox", () => {
    expect(GROUPABLE_KINDS.has("text")).toBe(false);
    expect(GROUPABLE_KINDS.has("number")).toBe(false);
    expect(GROUPABLE_KINDS.has("date")).toBe(false);
    expect(GROUPABLE_KINDS.has("checkbox")).toBe(false);
    expect(GROUPABLE_KINDS.has("url")).toBe(false);
  });

  it("isGroupableColumn accepts groupable kinds", () => {
    expect(isGroupableColumn({ field: "x", header: "X", kind: "status" })).toBe(true);
    expect(isGroupableColumn({ field: "x", header: "X", kind: "person" })).toBe(true);
  });

  it("isGroupableColumn rejects non-groupable kinds and untagged cols", () => {
    expect(isGroupableColumn({ field: "x", header: "X", kind: "number" })).toBe(false);
    expect(isGroupableColumn({ field: "x", header: "X" })).toBe(false);
  });
});

// ── SSR markup ───────────────────────────────────────────────────────

describe("[COMP:app-web/view-config-group-by-menu] closed-state SSR", () => {
  it("renders the placeholder label when value is null", () => {
    const html = mount(null);
    expect(html).toMatch(/data-action="open-group-by"/);
    expect(html).toMatch(/Group/);
    // Popover is closed.
    expect(html).not.toMatch(/data-popover="group-by"/);
  });

  it("renders 'Group: <column>' when grouped", () => {
    const html = mount("status");
    expect(html).toMatch(/Group/);
    expect(html).toMatch(/Status/);
  });

  it("sets aria-haspopup=dialog and aria-expanded=false when closed", () => {
    const html = mount(null);
    expect(html).toMatch(/aria-haspopup="dialog"/);
    expect(html).toMatch(/aria-expanded="false"/);
  });

  it("does not render the clear-grouping affordance when closed", () => {
    const html = mount("status");
    expect(html).not.toMatch(/data-action="clear-group-by"/);
  });

  it("recovers gracefully when value points at an unknown column", () => {
    // A stale group-by whose column was deleted falls back to the
    // placeholder, not a crash.
    const html = mount("nonexistent");
    expect(html).toMatch(/data-action="open-group-by"/);
  });
});
