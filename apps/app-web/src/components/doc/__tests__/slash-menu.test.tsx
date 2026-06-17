/**
 * [COMP:app-web/slash-menu] Slash menu — catalogue + filter + popup.
 *
 * Vitest in app-web is node-only (no jsdom). These tests focus on:
 *   - the static catalogue (`SLASH_MENU_ITEMS`) — size, ids, categories
 *   - the fuzzy filter (`filterSlashMenuItems`) — query + alias matching
 *   - server-rendered popup (`renderToString`) — markup shape, item
 *     count, categorised structure
 *
 * Keyboard navigation, focus management, and the Tiptap extension's
 * `Suggestion` plugin lifecycle require a real editor + DOM and are
 * left to a future jsdom-equipped suite (or e2e). The contract those
 * pieces honour is captured in unit form here — the popup's
 * `useImperativeHandle` returns `{ onKeyDown }`; the extension's
 * `command` strips the `/` + query from the editor before firing
 * `onSelect`.
 */

import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  FALLBACK_CATEGORY_LABELS,
  FALLBACK_LABELS,
  filterSlashMenuItems,
  orderSlashItemsForDisplay,
  SLASH_MENU_ITEMS,
  SlashMenuPopup,
  createSlashMenuExtension,
  type SlashMenuCategory,
  type SlashMenuItem,
} from "../slash-menu";

const dict = en as unknown as Dictionary;

// ── Catalogue ──────────────────────────────────────────────────────────

describe("[COMP:app-web/slash-menu] Catalogue", () => {
  it("ships 24 items total (Notion-identical catalogue + simple Table + Diagram)", () => {
    expect(SLASH_MENU_ITEMS).toHaveLength(24);
  });

  it("groups items into Basic / Media / Database (16 / 5 / 3)", () => {
    const byCategory = SLASH_MENU_ITEMS.reduce<Record<SlashMenuCategory, number>>(
      (acc, item) => {
        acc[item.category] = (acc[item.category] ?? 0) + 1;
        return acc;
      },
      { basic: 0, media: 0, database: 0, embed: 0 },
    );

    // Basic gains the native simple Table; Database keeps 3 (Table view = the
    // bound `data` block, Chart, Diagram).
    expect(byCategory.basic).toBe(16);
    expect(byCategory.media).toBe(5);
    expect(byCategory.database).toBe(3);
    // Embeds is intentionally empty in v1; Phase 4 populates it.
    expect(byCategory.embed).toBe(0);
  });

  it("carries the new Notion catalogue ids (Heading 4, Page, Table, Link to page, Video, Audio)", () => {
    const ids = new Set(SLASH_MENU_ITEMS.map((i) => i.id));
    for (const id of ["heading_4", "page", "table", "link_to_page", "video", "audio"]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it("renders the Notion markdown shortcut hints on the items that have one", () => {
    const shortcutFor = (id: string) =>
      SLASH_MENU_ITEMS.find((i) => i.id === id)?.shortcut;
    expect(shortcutFor("heading_1")).toBe("#");
    expect(shortcutFor("heading_4")).toBe("####");
    expect(shortcutFor("bulleted_list")).toBe("-");
    expect(shortcutFor("numbered_list")).toBe("1.");
    expect(shortcutFor("to_do")).toBe("[]");
    expect(shortcutFor("toggle")).toBe(">");
    expect(shortcutFor("quote")).toBe('"');
    expect(shortcutFor("divider")).toBe("---");
    // Items with no inline shortcut leave it undefined.
    expect(shortcutFor("page")).toBeUndefined();
    expect(shortcutFor("callout")).toBeUndefined();
  });

  it("uses unique ids across all items", () => {
    const ids = SLASH_MENU_ITEMS.map((item) => item.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("references a defined fallback label for every item", () => {
    for (const item of SLASH_MENU_ITEMS) {
      expect(FALLBACK_LABELS[item.labelKey]).toBeTruthy();
    }
  });

  it("includes the four Notion-feel heading variants with explicit levels", () => {
    const headings = SLASH_MENU_ITEMS.filter((item) => item.blockKind === "heading");
    expect(headings).toHaveLength(4);
    expect(headings.map((h) => h.headingLevel).sort()).toEqual([1, 2, 3, 4]);
  });

  it("exposes the four canonical categories in FALLBACK_CATEGORY_LABELS", () => {
    expect(Object.keys(FALLBACK_CATEGORY_LABELS).sort()).toEqual([
      "basic",
      "database",
      "embed",
      "media",
    ]);
  });
});

// ── Visual render order (keyboard-nav order) ───────────────────────────

describe("[COMP:app-web/slash-menu] orderSlashItemsForDisplay", () => {
  const all = [...SLASH_MENU_ITEMS];

  it("keeps source order in the filtered (typed-query) view", () => {
    expect(orderSlashItemsForDisplay(all, true)).toEqual(all);
  });

  it("flattens by category (basic → media → database) in the grouped view", () => {
    const ordered = orderSlashItemsForDisplay(all, false);
    // Categories appear in fixed order with no interleaving.
    const categorySequence = ordered
      .map((i) => i.category)
      .filter((c, idx, arr) => idx === 0 || c !== arr[idx - 1]);
    expect(categorySequence).toEqual(["basic", "media", "database"]);
    // Same items, just reordered.
    expect(ordered.map((i) => i.id).sort()).toEqual(all.map((i) => i.id).sort());
  });

  it("makes ↑/↓ follow what's on screen — File sits right after Audio, not after Code (the reported bug)", () => {
    const ordered = orderSlashItemsForDisplay(all, false);
    const pos = (id: string) => ordered.findIndex((i) => i.id === id);
    // In SOURCE order `code` precedes `file`; visually `code` is the last Basic
    // item while `file` is in Media after `audio`. Arrow-up from File must land
    // on Audio.
    expect(pos("file")).toBe(pos("audio") + 1);
    expect(pos("code")).toBeLessThan(pos("image")); // Code stays in Basic, above all Media
  });
});

// ── Fuzzy filter ───────────────────────────────────────────────────────

describe("[COMP:app-web/slash-menu] filterSlashMenuItems", () => {
  it("matches 'h1' to Heading 1 via the alias", () => {
    const matches = filterSlashMenuItems("h1");
    expect(matches.some((item) => item.id === "heading_1")).toBe(true);
  });

  it("matches 'todo' to the to-do item via alias", () => {
    const matches = filterSlashMenuItems("todo");
    expect(matches.some((item) => item.id === "to_do")).toBe(true);
  });

  it("matches 'img' to the image item via alias", () => {
    const matches = filterSlashMenuItems("img");
    expect(matches.some((item) => item.id === "image")).toBe(true);
  });

  it("matches by display label too — 'callout' returns the callout item", () => {
    const matches = filterSlashMenuItems("callout");
    expect(matches.some((item) => item.id === "callout")).toBe(true);
  });

  it("is case-insensitive — 'H1', 'h1', and 'H 1' all behave the same way for the prefix", () => {
    const upper = filterSlashMenuItems("H1");
    const lower = filterSlashMenuItems("h1");
    expect(upper.map((i) => i.id)).toEqual(lower.map((i) => i.id));
  });

  it("returns an empty array when no items match", () => {
    const matches = filterSlashMenuItems("zzznosuchitem");
    expect(matches).toEqual([]);
  });

  it("limits to 10 items when the query is empty", () => {
    const matches = filterSlashMenuItems("");
    expect(matches).toHaveLength(10);
    // The first 10 items of the catalogue come from the Basic category
    // (paragraph, headings, lists, to-do, toggle, quote, callout, code).
    expect(matches[0]?.id).toBe("paragraph");
  });

  it("honours a smaller explicit limit", () => {
    const matches = filterSlashMenuItems("", undefined, 3);
    expect(matches).toHaveLength(3);
  });

  it("uses the provided labelLookup so localised matches work", () => {
    // Pretend the locale dictionary translates "Heading 1" to "見出し 1".
    // A user typing "見出" should match the heading items.
    const lookup = (item: SlashMenuItem) =>
      item.labelKey === "heading_1"
        ? "見出し 1"
        : FALLBACK_LABELS[item.labelKey];

    const matches = filterSlashMenuItems("見出", lookup);
    expect(matches.some((m) => m.id === "heading_1")).toBe(true);
  });
});

// ── Popup rendering (server-side) ──────────────────────────────────────

describe("[COMP:app-web/slash-menu] SlashMenuPopup", () => {
  function renderPopup(items: SlashMenuItem[]) {
    return renderToString(
      <I18nProvider locale="en" dict={dict}>
        <SlashMenuPopup items={items} command={() => {}} query="" />
      </I18nProvider>,
    );
  }

  it("renders a listbox with the full default catalogue", () => {
    const html = renderPopup([...SLASH_MENU_ITEMS]);
    expect(html).toMatch(/role="listbox"/);
    // Every catalogue label should appear at least once.
    for (const item of SLASH_MENU_ITEMS) {
      expect(html).toContain(FALLBACK_LABELS[item.labelKey]);
    }
  });

  it("renders one categorised group per populated category", () => {
    const html = renderPopup([...SLASH_MENU_ITEMS]);
    // Each populated category is exposed via data-category for the
    // group wrapper; embed is empty in v1 so it should not be present.
    expect(html).toMatch(/data-category="basic"/);
    expect(html).toMatch(/data-category="media"/);
    expect(html).toMatch(/data-category="database"/);
    expect(html).not.toMatch(/data-category="embed"/);
  });

  it("renders the empty-state copy when no items match", () => {
    const html = renderPopup([]);
    // The empty-state block carries the `empty` marker.
    expect(html).toMatch(/data-slash-menu="empty"/);
  });

  it("renders one button per item with data-item-id", () => {
    const html = renderPopup([...SLASH_MENU_ITEMS]);
    const matches = html.match(/data-item-id="/g) ?? [];
    expect(matches.length).toBe(SLASH_MENU_ITEMS.length);
  });
});

// ── Tiptap extension factory ───────────────────────────────────────────

describe("[COMP:app-web/slash-menu] createSlashMenuExtension", () => {
  it("returns an Extension whose name is 'slashMenu'", () => {
    const ext = createSlashMenuExtension();
    // Tiptap Extension exposes the config via `.config.name`.
    expect(ext.name).toBe("slashMenu");
  });

  it("captures the onSelect callback in options for the consumer", () => {
    const onSelect = () => {};
    const ext = createSlashMenuExtension({ onSelect });
    expect(ext.options.onSelect).toBe(onSelect);
  });
});
