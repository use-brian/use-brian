"use client";

// [COMP:app-web/slash-menu]
/**
 * Phase 2 — Slash menu.
 *
 * Typing `/` inside any text-bearing block opens a fuzzy-filterable popup
 * that lists every block type. Selecting an item either **transforms the
 * current block** (if it's empty) or **inserts a new block below** — the
 * Notion convention from `docs/research/notion/page-construction.md` § 4.
 *
 * This file ships three concerns:
 *
 *   1. The static catalogue (`SLASH_MENU_ITEMS`) — 17 items spread across
 *      four categories. The catalogue is exported so the page renderer's
 *      add-block menu (and tests) can introspect it without having to
 *      double-source the labels.
 *   2. The `<SlashMenuPopup>` component — a categorized list with
 *      keyboard navigation. Arrow keys move the highlight, Enter selects,
 *      Esc dismisses. The popup is forward-ref'd to the Suggestion
 *      plugin which forwards key events to its `onKeyDown` handler.
 *   3. `createSlashMenuExtension({ onSelect })` — a Tiptap extension
 *      factory that wires `@tiptap/suggestion` into the editor. The
 *      caller (the page renderer in P2G) supplies `onSelect`; this
 *      component is standalone and does not touch page state directly.
 *
 * Positioning is intentionally simple for v1: the popup is absolutely
 * positioned below the suggestion's `clientRect` with a 4 px gap. Phase
 * 4 can swap in Floating UI for edge-flip; the wiring point is the
 * `onStart`/`onUpdate` calls that set `style.top` / `style.left` on
 * the rendered element.
 *
 * Insert semantics live entirely in `onSelect` — the consumer decides
 * whether to transform (current block was empty) or insert (non-empty),
 * because that's a page-state operation, not a Tiptap-internal one. The
 * extension itself only strips the `/` + query from the editor on
 * selection.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ForwardRefRenderFunction,
} from "react";
import {
  AudioLines,
  Bookmark,
  ChartBar,
  ChevronRight,
  CircleAlert,
  Code,
  Database,
  FileText,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  Image as ImageIcon,
  Link2,
  List,
  ListOrdered,
  Minus,
  Paperclip,
  Quote,
  SquareCheck,
  Table,
  Type,
  Video,
  Workflow,
  type LucideIcon,
} from "lucide-react";
import { Extension } from "@tiptap/core";
import { Suggestion, type SuggestionKeyDownProps, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { ReactRenderer } from "@tiptap/react";
import { createSuggestionDismiss } from "./suggestion-dismiss";

/**
 * Distinct ProseMirror plugin key. `@tiptap/suggestion` defaults every
 * instance to `PluginKey('suggestion')`; with the slash menu AND the `@`
 * mention extension both live in one editor, sharing that default throws
 * "Adding different instances of a keyed plugin (suggestion$)" at mount.
 * Each suggestion-based extension MUST carry its own key. Module-scoped so
 * the identity is stable across editor re-creations (each EditorState holds
 * at most one plugin per key, so reuse across states is safe).
 */
const slashMenuPluginKey = new PluginKey("docSlashMenu");

// ── Categories ─────────────────────────────────────────────────────────

/**
 * The four buckets the Notion catalogue uses. Embeds is empty in v1 but
 * kept in the union because the docs research note lists it as a
 * top-level group; Phase 4+ will populate it (Equation, GitHub gist,
 * Figma, etc.).
 */
export type SlashMenuCategory = "basic" | "media" | "database" | "embed";

// ── Item shape ─────────────────────────────────────────────────────────

/**
 * One row in the slash-menu catalogue. `id` is the stable key used by
 * tests + the parent's switch statement; `labelKey` looks up the
 * dictionary entry (`docPage.slashMenu.items.<labelKey>`). `aliases`
 * are the secondary fuzzy-match tokens (already lowercased). `icon` is
 * a `LucideIcon` component reference — not a string — so the popup
 * renders without a name-to-component lookup table.
 *
 * `blockKind` is the doc block kind to insert; `headingLevel` exists
 * only for the three heading variants to disambiguate `{ kind:
 * 'heading' }`.
 */
export type SlashMenuItem = {
  id: string;
  /** Dictionary key under `docPage.slashMenu.items.<labelKey>`. */
  labelKey: keyof typeof FALLBACK_LABELS;
  category: SlashMenuCategory;
  aliases: string[];
  icon: LucideIcon;
  /** The doc block kind this item inserts. */
  blockKind: SlashMenuBlockKind;
  /** Only set for heading variants. */
  headingLevel?: 1 | 2 | 3 | 4;
  /**
   * The Notion-style markdown shortcut shown right-aligned in the row
   * (`#`, `1.`, `[]`, `>`, `"`, `---`). Display-only — the actual input
   * rules live in `@sidanclaw/doc-model`'s schema. Omitted for items with
   * no inline shortcut (Page, Callout, Table, Link to page, media).
   */
  shortcut?: string;
};

/**
 * The block-kind alphabet the slash menu can produce. Mirrors the 15
 * block types landed in Phase 2 Batch 1 plus the three canonical kinds
 * (`text`, `heading`, `divider`) from `@/lib/api/views`. Kept local
 * because the `Block` union there only covers a subset (text / heading
 * / divider / data / chart); the other 10 kinds are defined in their
 * respective `block-*.tsx` files and the renderer will sort out the
 * dispatch.
 */
export type SlashMenuBlockKind =
  | "text"
  | "heading"
  | "bulleted_list_item"
  | "numbered_list_item"
  | "to_do"
  | "toggle"
  | "table"
  | "quote"
  | "callout"
  | "code"
  | "divider"
  | "image"
  | "video"
  | "audio"
  | "file"
  | "bookmark"
  | "data"
  | "chart"
  | "diagram"
  // Async/picker kinds — handled by the editor's slash `onSelect` (they need
  // workspace context + the router / a page picker), not the synchronous
  // `executeSlashItem` chain. `child_page` mints a new nested page; `link_to_page`
  // points at an existing one.
  | "child_page"
  | "link_to_page";

/**
 * English fallback labels — used only when the popup is rendered outside
 * an `<I18nProvider>` (defensive default for tests / future contexts).
 * The canonical labels live in `lib/i18n/dictionaries/en.ts`; this is a
 * keyed mirror so the type system enforces that every item has a known
 * dictionary key.
 */
export const FALLBACK_LABELS = {
  paragraph: "Text",
  heading_1: "Heading 1",
  heading_2: "Heading 2",
  heading_3: "Heading 3",
  heading_4: "Heading 4",
  bulleted_list: "Bulleted list",
  numbered_list: "Numbered list",
  to_do: "To-do list",
  toggle: "Toggle list",
  page: "Page",
  callout: "Callout",
  quote: "Quote",
  table: "Table",
  table_view: "Table view",
  divider: "Divider",
  link_to_page: "Link to page",
  code: "Code",
  image: "Image",
  video: "Video",
  audio: "Audio",
  file: "File",
  bookmark: "Bookmark",
  chart: "Chart",
  diagram: "Diagram",
} as const;

export const FALLBACK_CATEGORY_LABELS: Record<SlashMenuCategory, string> = {
  basic: "Basic",
  media: "Media",
  database: "Database",
  embed: "Embeds",
};

// ── Catalogue ──────────────────────────────────────────────────────────

/**
 * The slash-menu catalogue. 24 items across three populated categories,
 * ordered + labelled to mirror Notion's `/` menu 1:1
 * (`docs/plans/doc-notion-clone.md` §5):
 *
 *   - Basic (16): Text, Heading 1–4, Bulleted/Numbered/To-do/Toggle list,
 *     Page, Callout, Quote, Table (the native simple table), Divider,
 *     Link to page, Code
 *   - Media (5): Image, Video, Audio, File, Bookmark
 *   - Database (3): Table view (the bound `data` database), Chart, Diagram
 *
 * `shortcut` is the right-aligned Notion markdown hint (`#`, `1.`, `[]`,
 * `>`, `"`, `---`). Order is meaningful: the source order is what the
 * "Filtered results" flat view renders, and the empty-query state shows
 * the first 10 (Text → Page), so the heavy-use basics come first.
 */
export const SLASH_MENU_ITEMS: readonly SlashMenuItem[] = [
  // ── Basic ──
  {
    id: "paragraph",
    labelKey: "paragraph",
    category: "basic",
    aliases: ["text", "paragraph", "p", "body"],
    icon: Type,
    blockKind: "text",
  },
  {
    id: "heading_1",
    labelKey: "heading_1",
    category: "basic",
    aliases: ["h1", "heading 1", "title"],
    icon: Heading1,
    blockKind: "heading",
    headingLevel: 1,
    shortcut: "#",
  },
  {
    id: "heading_2",
    labelKey: "heading_2",
    category: "basic",
    aliases: ["h2", "heading 2", "subtitle"],
    icon: Heading2,
    blockKind: "heading",
    headingLevel: 2,
    shortcut: "##",
  },
  {
    id: "heading_3",
    labelKey: "heading_3",
    category: "basic",
    aliases: ["h3", "heading 3"],
    icon: Heading3,
    blockKind: "heading",
    headingLevel: 3,
    shortcut: "###",
  },
  {
    id: "heading_4",
    labelKey: "heading_4",
    category: "basic",
    aliases: ["h4", "heading 4"],
    icon: Heading4,
    blockKind: "heading",
    headingLevel: 4,
    shortcut: "####",
  },
  {
    id: "bulleted_list",
    labelKey: "bulleted_list",
    category: "basic",
    aliases: ["bullet", "ul", "list", "unordered"],
    icon: List,
    blockKind: "bulleted_list_item",
    shortcut: "-",
  },
  {
    id: "numbered_list",
    labelKey: "numbered_list",
    category: "basic",
    aliases: ["number", "ol", "ordered"],
    icon: ListOrdered,
    blockKind: "numbered_list_item",
    shortcut: "1.",
  },
  {
    id: "to_do",
    labelKey: "to_do",
    category: "basic",
    aliases: ["todo", "to-do", "checkbox", "task"],
    icon: SquareCheck,
    blockKind: "to_do",
    shortcut: "[]",
  },
  {
    id: "toggle",
    labelKey: "toggle",
    category: "basic",
    aliases: ["collapse", "fold", "disclosure"],
    icon: ChevronRight,
    blockKind: "toggle",
    shortcut: ">",
  },
  {
    id: "page",
    labelKey: "page",
    category: "basic",
    aliases: ["page", "sub-page", "subpage", "child"],
    icon: FileText,
    blockKind: "child_page",
  },
  {
    id: "callout",
    labelKey: "callout",
    category: "basic",
    aliases: ["note", "aside", "info", "warning"],
    icon: CircleAlert,
    blockKind: "callout",
  },
  {
    id: "quote",
    labelKey: "quote",
    category: "basic",
    aliases: ["blockquote", "citation"],
    icon: Quote,
    blockKind: "quote",
    shortcut: '"',
  },
  {
    id: "table",
    labelKey: "table",
    category: "basic",
    aliases: ["table", "grid", "rows", "columns", "cells", "spreadsheet"],
    icon: Table,
    blockKind: "table",
  },
  {
    id: "divider",
    labelKey: "divider",
    category: "basic",
    aliases: ["hr", "rule", "---", "separator"],
    icon: Minus,
    blockKind: "divider",
    shortcut: "---",
  },
  {
    id: "link_to_page",
    labelKey: "link_to_page",
    category: "basic",
    aliases: ["link", "link to page", "mention page", "reference"],
    icon: Link2,
    blockKind: "link_to_page",
  },
  // ── Media ──
  {
    id: "image",
    labelKey: "image",
    category: "media",
    aliases: ["img", "picture", "photo"],
    icon: ImageIcon,
    blockKind: "image",
  },
  {
    id: "video",
    labelKey: "video",
    category: "media",
    aliases: ["video", "mp4", "youtube", "player", "clip"],
    icon: Video,
    blockKind: "video",
  },
  {
    id: "audio",
    labelKey: "audio",
    category: "media",
    aliases: ["audio", "sound", "voice", "mp3", "podcast"],
    icon: AudioLines,
    blockKind: "audio",
  },
  {
    id: "code",
    labelKey: "code",
    category: "basic",
    aliases: ["snippet", "pre", "code"],
    icon: Code,
    blockKind: "code",
  },
  {
    id: "file",
    labelKey: "file",
    category: "media",
    aliases: ["attach", "attachment", "upload"],
    icon: Paperclip,
    blockKind: "file",
  },
  {
    id: "bookmark",
    labelKey: "bookmark",
    category: "media",
    aliases: ["link", "url", "preview", "web bookmark"],
    icon: Bookmark,
    blockKind: "bookmark",
  },
  // ── Database ──
  {
    id: "table_view",
    labelKey: "table_view",
    category: "database",
    aliases: ["table view", "database", "db", "board", "view", "data"],
    icon: Database,
    blockKind: "data",
  },
  {
    id: "chart",
    labelKey: "chart",
    category: "database",
    aliases: ["graph", "kpi", "viz"],
    icon: ChartBar,
    blockKind: "chart",
  },
  {
    id: "diagram",
    labelKey: "diagram",
    category: "database",
    aliases: ["diagram", "graph", "flowchart", "mermaid", "mindmap", "sequence", "org chart"],
    icon: Workflow,
    blockKind: "diagram",
  },
];

/** Fixed category render order for the grouped (empty-query) popup view. */
const CATEGORY_ORDER: SlashMenuCategory[] = ["basic", "media", "database", "embed"];

/**
 * The order rows are RENDERED in — and therefore the order ↑/↓ navigate. The
 * filtered view keeps source order as-is; the grouped (empty-query) view
 * flattens the categories in `CATEGORY_ORDER`, source order within each. The
 * popup's keyboard cursor indexes THIS list, so navigation follows what's on
 * screen instead of the raw source order (otherwise arrow-up from "File" in
 * the Media group would jump to "Code" in Basic — `code` precedes `file` in
 * source order but renders in a different group).
 */
export function orderSlashItemsForDisplay(
  items: SlashMenuItem[],
  isFiltering: boolean,
): SlashMenuItem[] {
  if (isFiltering) return items;
  const byCategory = new Map<SlashMenuCategory, SlashMenuItem[]>();
  for (const item of items) {
    const bucket = byCategory.get(item.category) ?? [];
    bucket.push(item);
    byCategory.set(item.category, bucket);
  }
  return CATEGORY_ORDER.flatMap((category) => byCategory.get(category) ?? []);
}

// ── Fuzzy filter ───────────────────────────────────────────────────────

/**
 * Lowercase-substring match against the resolved label + aliases. This
 * is intentionally minimal — Phase 4 can plug in a real fuzzy matcher
 * (fzf / fuse.js) but Notion's slash menu is already a substring filter
 * in practice; arrow keys + categorisation do the heavy lifting.
 *
 * `labelLookup` is supplied by the popup so the filter honours the
 * active locale. When omitted (tests, fallback), the English mirror
 * (`FALLBACK_LABELS`) is used.
 */
export function filterSlashMenuItems(
  query: string,
  labelLookup?: (item: SlashMenuItem) => string,
  limit = 10,
): SlashMenuItem[] {
  const q = query.trim().toLowerCase();
  const resolve = labelLookup ?? ((item: SlashMenuItem) => FALLBACK_LABELS[item.labelKey]);

  if (!q) {
    return SLASH_MENU_ITEMS.slice(0, limit);
  }

  const matches = SLASH_MENU_ITEMS.filter((item) => {
    const label = resolve(item).toLowerCase();
    if (label.includes(q)) return true;
    return item.aliases.some((alias) => alias.toLowerCase().includes(q));
  });

  return matches.slice(0, limit);
}

// ── Popup component ────────────────────────────────────────────────────

export type SlashMenuPopupRef = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

type SlashMenuPopupProps = {
  items: SlashMenuItem[];
  command: (item: SlashMenuItem) => void;
  /** The current query string (for highlighting / empty-state). */
  query: string;
  /**
   * Optional locale lookup the renderer threads in. When set, the popup
   * displays the localised label; otherwise it falls back to the
   * English mirror.
   */
  resolveLabel?: (item: SlashMenuItem) => string;
  resolveCategoryLabel?: (category: SlashMenuCategory) => string;
  /** Empty-state copy + aria-label, also locale-aware. */
  emptyLabel?: string;
  ariaLabel?: string;
  /** "Filtered results" header shown above the flat list when a query is typed. */
  filteredLabel?: string;
  /** Footer affordance copy — "Close menu" + the "esc" key hint. */
  closeMenuLabel?: string;
  escLabel?: string;
};

const SlashMenuPopupImpl: ForwardRefRenderFunction<SlashMenuPopupRef, SlashMenuPopupProps> = (
  {
    items,
    command,
    query,
    resolveLabel,
    resolveCategoryLabel,
    emptyLabel,
    ariaLabel,
    filteredLabel,
    closeMenuLabel,
    escLabel,
  },
  ref,
) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  // The scrollable list container — so keyboard navigation past the visible
  // edge can keep the active row in view.
  const scrollRef = useRef<HTMLDivElement>(null);

  // Reset highlight when the list changes (typing narrows / widens the items).
  useEffect(() => {
    setSelectedIndex(0);
  }, [items]);

  // Follow the active row as ↑/↓ move past the visible edge — scroll the LIST
  // CONTAINER only (rect-delta on its own `scrollTop`), never the page, so the
  // popup tracks the selection like Notion's. A no-op when the row is already
  // in view (so mouse-hover selection never yanks the scroll).
  useEffect(() => {
    const container = scrollRef.current;
    if (!container) return;
    const active = container.querySelector<HTMLElement>("[data-active]");
    if (!active) return;
    // When the active row is the FIRST item of its category, track the grey
    // category HEADER into view too — otherwise arrowing to the first Media /
    // Database item leaves its header clipped above the fold (SLASH-1). For
    // any other row, track the row itself. Scroll the LIST CONTAINER only
    // (rect-delta on its own scrollTop), never the page, and no-op when the
    // tracked element is already in view (so mouse-hover never yanks scroll).
    const li = active.closest("li");
    const group = active.closest<HTMLElement>("[data-category]");
    const isFirstInGroup = !!(group && li && li === group.querySelector("ul > li:first-child"));
    const tracked: HTMLElement = isFirstInGroup && group ? group : active;
    const c = container.getBoundingClientRect();
    const a = tracked.getBoundingClientRect();
    if (a.top < c.top) container.scrollTop -= c.top - a.top;
    else if (a.bottom > c.bottom) container.scrollTop += a.bottom - c.bottom;
  }, [selectedIndex, items]);

  const labelFor = useCallback(
    (item: SlashMenuItem) => (resolveLabel ? resolveLabel(item) : FALLBACK_LABELS[item.labelKey]),
    [resolveLabel],
  );

  const categoryLabelFor = useCallback(
    (category: SlashMenuCategory) =>
      resolveCategoryLabel ? resolveCategoryLabel(category) : FALLBACK_CATEGORY_LABELS[category],
    [resolveCategoryLabel],
  );

  // A typed query renders the flat "Filtered results" view (no category
  // headers), exactly like Notion's `/`-then-type state; an empty query
  // renders the categorised list. Source order is preserved inside both.
  const isFiltering = query.trim().length > 0;

  // Group by category in a FIXED order (basic → media → database → embed),
  // not first-appearance — so the database `table` item doesn't pull the
  // whole Database group up to wherever it sits in source order.
  const grouped = useMemo(() => {
    const byCategory = new Map<SlashMenuCategory, SlashMenuItem[]>();
    for (const item of items) {
      const bucket = byCategory.get(item.category) ?? [];
      bucket.push(item);
      byCategory.set(item.category, bucket);
    }
    return CATEGORY_ORDER.flatMap((category) => {
      const groupItems = byCategory.get(category);
      return groupItems && groupItems.length > 0
        ? [{ category, items: groupItems }]
        : [];
    });
  }, [items]);

  // The keyboard cursor MUST index the VISUAL render order, not the source
  // order — otherwise ↑/↓ jumps across category groups (e.g. arrow-up from
  // "File" in Media would land on "Code" in Basic, since `code` precedes
  // `file` in source order but renders in a different group). In the grouped
  // view that order is the category-flattened list; in the filtered view it's
  // the source order as-is.
  const orderedItems = useMemo(
    () => orderSlashItemsForDisplay(items, isFiltering),
    [items, isFiltering],
  );

  const selectItem = useCallback(
    (index: number) => {
      const item = orderedItems[index];
      if (item) command(item);
    },
    [orderedItems, command],
  );

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }) => {
        const n = orderedItems.length;
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => (n === 0 ? 0 : (i + 1) % n));
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => (n === 0 ? 0 : (i - 1 + n) % n));
          return true;
        }
        if (event.key === "Enter") {
          selectItem(selectedIndex);
          return true;
        }
        return false;
      },
    }),
    [orderedItems, selectedIndex, selectItem],
  );

  if (items.length === 0) {
    return (
      <div
        role="listbox"
        aria-label={ariaLabel ?? "Block types"}
        className="z-50 w-72 rounded-md border border-border bg-popover px-3 py-4 text-sm text-muted-foreground shadow-lg"
        data-slash-menu="empty"
      >
        {emptyLabel ?? "No matches."}
      </div>
    );
  }

  // One row. `flatIndex` is the item's position in the flat `items` array —
  // it's what the keyboard cursor (`selectedIndex`) indexes, so it must line
  // up across both the flat and grouped layouts.
  const renderRow = (item: SlashMenuItem, flatIndexForItem: number) => {
    const isActive = flatIndexForItem === selectedIndex;
    const Icon = item.icon;
    return (
      <li key={item.id}>
        <button
          type="button"
          role="option"
          aria-selected={isActive}
          data-item-id={item.id}
          data-active={isActive || undefined}
          onMouseEnter={() => setSelectedIndex(flatIndexForItem)}
          onMouseDown={(e) => {
            // Prevent the editor from losing focus before we dispatch.
            e.preventDefault();
          }}
          onClick={() => selectItem(flatIndexForItem)}
          className={
            "flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground transition-colors " +
            (isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted")
          }
        >
          <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
          <span className="flex-1 truncate">{labelFor(item)}</span>
          {item.shortcut ? (
            <span
              className="flex-shrink-0 font-mono text-xs text-muted-foreground/70"
              data-shortcut={item.shortcut}
              aria-hidden
            >
              {item.shortcut}
            </span>
          ) : null}
        </button>
      </li>
    );
  };

  // Map each item id → its position in the VISUAL render order, so every
  // rendered row's highlight + click line up with the keyboard cursor
  // (`selectedIndex` also indexes `orderedItems`).
  const indexOf = new Map(orderedItems.map((item, i) => [item.id, i] as const));

  return (
    <div
      role="listbox"
      aria-label={ariaLabel ?? "Block types"}
      className="z-50 w-72 overflow-hidden rounded-md border border-border bg-popover text-sm shadow-lg"
      data-slash-menu="root"
      data-mode={isFiltering ? "filtered" : "grouped"}
    >
      <div ref={scrollRef} className="max-h-80 overflow-y-auto py-1">
        {isFiltering ? (
          <div data-section="filtered">
            <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
              {filteredLabel ?? "Filtered results"}
            </div>
            <ul>{items.map((item) => renderRow(item, indexOf.get(item.id) ?? 0))}</ul>
          </div>
        ) : (
          grouped.map((group) => (
            <div key={group.category} data-category={group.category}>
              <div className="px-3 pb-1 pt-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                {categoryLabelFor(group.category)}
              </div>
              <ul>{group.items.map((item) => renderRow(item, indexOf.get(item.id) ?? 0))}</ul>
            </div>
          ))
        )}
      </div>
      {/* Footer — Notion's "Close menu  esc" affordance. */}
      <div className="flex items-center justify-between border-t border-border px-3 py-1.5 text-xs text-muted-foreground">
        <span>{closeMenuLabel ?? "Close menu"}</span>
        <span className="font-mono text-[10px] uppercase tracking-wider text-muted-foreground/70">
          {escLabel ?? "esc"}
        </span>
      </div>
    </div>
  );
};

export const SlashMenuPopup = forwardRef(SlashMenuPopupImpl);
SlashMenuPopup.displayName = "SlashMenuPopup";

// ── Tiptap extension ───────────────────────────────────────────────────

/**
 * Callback fired when the user picks an item. The consumer (the page
 * renderer in P2G) inspects the current block and decides whether to
 * **transform** it (empty current block) or **insert below** (non-empty
 * current block). This component only strips the `/` + query from the
 * editor; everything else is a page-state operation.
 */
export type SlashMenuOnSelect = (
  item: SlashMenuItem,
  context: {
    /**
     * The Tiptap editor instance the user typed into. The consumer can
     * read `editor.getJSON()` to inspect the current block's content
     * before deciding transform-vs-insert.
     */
    editor: import("@tiptap/core").Editor;
  },
) => void;

export type SlashMenuExtensionOptions = {
  onSelect?: SlashMenuOnSelect;
  /**
   * Optional locale resolvers so the rendered popup shows localised
   * strings. Defaults to the English mirror baked into this module.
   */
  resolveLabel?: (item: SlashMenuItem) => string;
  resolveCategoryLabel?: (category: SlashMenuCategory) => string;
  /** Localised "Filtered results" header + "Close menu" / "esc" footer copy. */
  filteredLabel?: string;
  closeMenuLabel?: string;
  escLabel?: string;
};

/**
 * Build the Tiptap extension. We return a fresh extension per call so
 * the `onSelect` closure is captured at install time — the renderer can
 * mount different editors with different consumers.
 */
export function createSlashMenuExtension(options: SlashMenuExtensionOptions = {}) {
  return Extension.create<SlashMenuExtensionOptions>({
    name: "slashMenu",

    addOptions() {
      return {
        onSelect: options.onSelect,
        resolveLabel: options.resolveLabel,
        resolveCategoryLabel: options.resolveCategoryLabel,
        filteredLabel: options.filteredLabel,
        closeMenuLabel: options.closeMenuLabel,
        escLabel: options.escLabel,
      };
    },

    addProseMirrorPlugins() {
      const ext = this;
      return [
        Suggestion<SlashMenuItem, SlashMenuItem>({
          editor: this.editor,
          pluginKey: slashMenuPluginKey,
          char: "/",
          // Notion's slash menu is fundamentally a single-token prompt;
          // allowing spaces would make a sentence like "1/2 is half"
          // open the menu repeatedly. Match against the typed token only.
          allowSpaces: false,
          startOfLine: false,
          command: ({ editor, range, props }) => {
            // 1. Strip the `/` + any typed query from the editor before
            //    handing off to the consumer — the consumer's transform
            //    or insert is then operating on a clean block.
            editor.chain().focus().deleteRange(range).run();
            // 2. Dispatch upward. Page-state changes (transform-or-insert,
            //    moving cursor focus into the new block) are the
            //    consumer's responsibility.
            ext.options.onSelect?.(props, { editor });
          },
          items: ({ query }) =>
            // No cap — the catalogue is short (23) and the popup scrolls, so
            // every match (and the full menu on an empty query) is reachable.
            filterSlashMenuItems(query, ext.options.resolveLabel, SLASH_MENU_ITEMS.length),
          render: () => {
            let component: ReactRenderer<SlashMenuPopupRef, SlashMenuPopupProps> | null = null;
            // Escape-to-close state. `@tiptap/suggestion` keeps the plugin active
            // as long as the `/` token sits in the doc, so returning `true` from
            // `onKeyDown` never closed the popup — we hide it ourselves and skip
            // updates for this token. See `suggestion-dismiss.ts`.
            const dismiss = createSuggestionDismiss();

            const positionPopup = (props: SuggestionProps<SlashMenuItem>) => {
              const el = component?.element as HTMLElement | undefined;
              if (!el) return;
              const rect = props.clientRect?.();
              if (!rect) return;
              el.style.position = "absolute";
              el.style.top = `${rect.bottom + window.scrollY + 4}px`;
              el.style.left = `${rect.left + window.scrollX}px`;
            };

            const setHidden = (hidden: boolean) => {
              const el = component?.element as HTMLElement | undefined;
              if (el) el.style.display = hidden ? "none" : "";
            };

            return {
              onStart: (props) => {
                dismiss.reset();
                component = new ReactRenderer<SlashMenuPopupRef, SlashMenuPopupProps>(SlashMenuPopup, {
                  props: {
                    items: props.items,
                    command: (item: SlashMenuItem) => props.command(item),
                    query: props.query,
                    resolveLabel: ext.options.resolveLabel,
                    resolveCategoryLabel: ext.options.resolveCategoryLabel,
                    filteredLabel: ext.options.filteredLabel,
                    closeMenuLabel: ext.options.closeMenuLabel,
                    escLabel: ext.options.escLabel,
                  },
                  editor: props.editor,
                });
                // Attach the popup to the document so it floats on top
                // of the editor; absolute positioning re-targets it to
                // the suggestion's client rect on every update.
                if (typeof document !== "undefined") {
                  document.body.appendChild(component.element);
                }
                positionPopup(props);
              },
              onUpdate: (props) => {
                // Stay closed for the rest of a dismissed token (Notion behavior).
                if (dismiss.shouldSkipUpdate()) return;
                component?.updateProps({
                  items: props.items,
                  command: (item: SlashMenuItem) => props.command(item),
                  query: props.query,
                  resolveLabel: ext.options.resolveLabel,
                  resolveCategoryLabel: ext.options.resolveCategoryLabel,
                  filteredLabel: ext.options.filteredLabel,
                  closeMenuLabel: ext.options.closeMenuLabel,
                  escLabel: ext.options.escLabel,
                });
                positionPopup(props);
              },
              onKeyDown: (props) => {
                const action = dismiss.onKey(props.event.key);
                if (action === "dismiss") {
                  // Hide now; the plugin stays "active" (the `/` text is still in
                  // the doc) and tears the popup down via `onExit` once the cursor
                  // leaves the token.
                  setHidden(true);
                  return true;
                }
                // Dismissed → popup hidden, so let keys fall through to the editor.
                if (action === "passthrough") return false;
                return component?.ref?.onKeyDown(props) ?? false;
              },
              onExit: () => {
                dismiss.reset();
                if (component) {
                  component.element.parentNode?.removeChild(component.element);
                  component.destroy();
                  component = null;
                }
              },
            };
          },
        }),
      ];
    },
  });
}

/**
 * Default-export shorthand for the common case (no options). Most call
 * sites will use `createSlashMenuExtension({ onSelect })` instead so
 * the consumer can wire transform-vs-insert; this no-op variant exists
 * for storybook / smoke contexts.
 */
export const slashMenuExtension = createSlashMenuExtension();
