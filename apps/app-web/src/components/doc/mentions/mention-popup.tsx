"use client";

// [COMP:app-web/mention-popup]
/**
 * Phase 4 — Shared `@`-mention popup.
 *
 * Notion ships **one** suggestion menu behind `@` and routes the result
 * to the right mention sub-type based on what the user picks (see
 * `docs/research/notion/inline-text-and-mentions.md` § 6). Lock #15 v1
 * ships only the two sub-types — `person` and `page` — so this popup is
 * a two-tab list:
 *
 *     ┌── @-mention popup ────────────────┐
 *     │ [ People ]  Pages                 │  ← tabs (Tab key swaps)
 *     │ ─────────────────────────────────  │
 *     │ ▶ 👤 Jane Doe       jane@…         │  ← arrow keys navigate the active tab
 *     │   👤 Mark Lee       mark@…         │
 *     │   👤 Sara Park      sara@…         │
 *     └────────────────────────────────────┘
 *
 * The popup is **owned by the mention extension(s)** — it's rendered
 * through `ReactRenderer` and absolute-positioned under the caret's
 * `clientRect`, the same wiring slash-menu.tsx already uses. The popup
 * itself is presentational + keyboard-aware:
 *
 *   - Arrow ↑/↓ navigate within the active tab.
 *   - Tab (and Shift+Tab) cycle the active tab.
 *   - Enter selects the highlighted row.
 *   - Esc is handled one level up by the suggestion-plugin glue.
 *
 * It is **stateless about the query** — the parent extension does the
 * filtering and hands in pre-filtered lists per tab. Empty query passes
 * empty filter, which is the cue for the parent to return the "recent
 * items" list. This keeps the popup re-usable for any future mention
 * subtype without baking fetching into the UI.
 *
 * Type-design note: each tab item carries a `kind` discriminator so the
 * popup can render the correct icon + label without a per-tab component
 * fork, and the `onSelect` callback receives the typed payload for the
 * extension to drop into the editor.
 */

import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
  type ForwardRefRenderFunction,
} from "react";
import { FileText, User } from "lucide-react";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";

// ── Tab + item shapes ──────────────────────────────────────────────────

export type MentionTab = "people" | "pages";

/**
 * One workspace member as the popup sees it. Minimal display fields
 * only — the extension that resolves these is responsible for shaping
 * its API response into this trim type.
 */
export type PersonMentionItem = {
  kind: "person";
  id: string;
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
};

/**
 * One doc/page result as the popup sees it. `title` is what gets
 * dropped into the editor (and shown in the row); `id` is the stable
 * page id the mention node persists.
 */
export type PageMentionItem = {
  kind: "page";
  id: string;
  title: string;
};

export type MentionItem = PersonMentionItem | PageMentionItem;

// ── Pure keyboard helpers ─────────────────────────────────────────────
//
// The popup's selection + tab-cycling logic is exposed as pure functions
// so unit tests can exercise the keyboard contract without a real DOM
// (app-web's vitest runner is node-only — see vitest.config.ts).

/**
 * Advance the selection index for an arrow-key press.
 *
 * Returns the next index, wrapping at both ends. When `length === 0`
 * the index stays at `0` — there's nothing to highlight.
 */
export function nextSelectionIndex(
  current: number,
  length: number,
  direction: 1 | -1,
): number {
  if (length === 0) return 0;
  return (current + direction + length) % length;
}

/**
 * Cycle the active tab. `direction = 1` is forward (Tab), `-1` is back
 * (Shift+Tab). The order is `people → pages → people`.
 */
export function nextTab(current: MentionTab, direction: 1 | -1): MentionTab {
  const order: MentionTab[] = ["people", "pages"];
  const idx = order.indexOf(current);
  const next = (idx + direction + order.length) % order.length;
  return order[next] ?? current;
}

// ── Popup component ────────────────────────────────────────────────────

export type MentionPopupRef = {
  onKeyDown: (props: SuggestionKeyDownProps) => boolean;
};

export type MentionPopupProps = {
  /** People-tab rows. May be empty (caller decides recents-vs-search). */
  people: PersonMentionItem[];
  /** Pages-tab rows. May be empty. */
  pages: PageMentionItem[];
  /** Tab to render initially. */
  initialTab?: MentionTab;
  /** Fires when the user selects an item — either tab. */
  onSelect: (item: MentionItem) => void;
  /** Localised tab labels. */
  labels?: {
    people: string;
    pages: string;
    empty: string;
    /** Aria label for the listbox container. */
    aria: string;
  };
};

const FALLBACK_LABELS: NonNullable<MentionPopupProps["labels"]> = {
  people: "People",
  pages: "Pages",
  empty: "No matches",
  aria: "Mention picker",
};

const MentionPopupImpl: ForwardRefRenderFunction<MentionPopupRef, MentionPopupProps> = (
  { people, pages, initialTab = "people", onSelect, labels },
  ref,
) => {
  const [activeTab, setActiveTab] = useState<MentionTab>(initialTab);
  const [selectedIndex, setSelectedIndex] = useState(0);

  const resolved = labels ?? FALLBACK_LABELS;

  const items = activeTab === "people" ? (people as MentionItem[]) : (pages as MentionItem[]);

  // Reset the highlight whenever the active tab or list changes — the
  // user's mental "first row" is always row 0 of the new view.
  useEffect(() => {
    setSelectedIndex(0);
  }, [activeTab, people, pages]);

  const tabs = useMemo<readonly { id: MentionTab; label: string; count: number }[]>(
    () => [
      { id: "people", label: resolved.people, count: people.length },
      { id: "pages", label: resolved.pages, count: pages.length },
    ],
    [people.length, pages.length, resolved.people, resolved.pages],
  );

  const cycleTab = useCallback((direction: 1 | -1) => {
    setActiveTab((current) => nextTab(current, direction));
  }, []);

  const selectAt = useCallback(
    (index: number) => {
      const item = items[index];
      if (item) onSelect(item);
    },
    [items, onSelect],
  );

  useImperativeHandle(
    ref,
    () => ({
      onKeyDown: ({ event }) => {
        if (event.key === "ArrowDown") {
          setSelectedIndex((i) => nextSelectionIndex(i, items.length, 1));
          return true;
        }
        if (event.key === "ArrowUp") {
          setSelectedIndex((i) => nextSelectionIndex(i, items.length, -1));
          return true;
        }
        if (event.key === "Tab") {
          cycleTab(event.shiftKey ? -1 : 1);
          return true;
        }
        if (event.key === "Enter") {
          selectAt(selectedIndex);
          return true;
        }
        return false;
      },
    }),
    [items, selectedIndex, selectAt, cycleTab],
  );

  return (
    <div
      role="listbox"
      aria-label={resolved.aria}
      className="z-50 w-80 overflow-hidden rounded-md border border-border bg-popover text-sm shadow-lg"
      data-mention-popup="root"
    >
      {/* ── Tabs ─────────────────────────────────────────────────── */}
      <div
        className="flex items-center gap-1 border-b border-border bg-muted/40 px-1 py-1"
        role="tablist"
      >
        {tabs.map((tab) => {
          const isActive = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              data-tab={tab.id}
              data-active={isActive || undefined}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => setActiveTab(tab.id)}
              className={
                "flex-1 rounded px-2 py-1 text-xs font-medium transition-colors " +
                (isActive
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground")
              }
            >
              {tab.label}
            </button>
          );
        })}
      </div>

      {/* ── Body ─────────────────────────────────────────────────── */}
      <div className="max-h-72 overflow-y-auto py-1" data-tab-panel={activeTab}>
        {items.length === 0 ? (
          <div
            className="px-3 py-3 text-xs text-muted-foreground"
            data-mention-popup="empty"
          >
            {resolved.empty}
          </div>
        ) : (
          <ul>
            {items.map((item, index) => {
              const isActive = index === selectedIndex;
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={isActive}
                    data-item-id={item.id}
                    data-item-kind={item.kind}
                    data-active={isActive || undefined}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onMouseDown={(e) => {
                      // Prevent the editor from losing focus before we
                      // dispatch the select.
                      e.preventDefault();
                    }}
                    onClick={() => selectAt(index)}
                    className={
                      "flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground transition-colors " +
                      (isActive ? "bg-accent text-accent-foreground" : "hover:bg-muted")
                    }
                  >
                    {item.kind === "person" ? (
                      <PersonRowChrome item={item} />
                    ) : (
                      <PageRowChrome item={item} />
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
};

export const MentionPopup = forwardRef(MentionPopupImpl);
MentionPopup.displayName = "MentionPopup";

// ── Row chrome ────────────────────────────────────────────────────────

function PersonRowChrome({ item }: { item: PersonMentionItem }) {
  return (
    <>
      {item.avatarUrl ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={item.avatarUrl}
          alt=""
          aria-hidden
          className="h-5 w-5 flex-shrink-0 rounded-full object-cover"
        />
      ) : (
        <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
          <User className="h-3 w-3" aria-hidden />
        </span>
      )}
      <span className="flex min-w-0 flex-1 items-baseline gap-2">
        <span className="truncate text-foreground">{item.name}</span>
        {item.email ? (
          <span className="truncate text-[11px] text-muted-foreground">{item.email}</span>
        ) : null}
      </span>
    </>
  );
}

function PageRowChrome({ item }: { item: PageMentionItem }) {
  return (
    <>
      <span className="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-sm bg-muted text-muted-foreground">
        <FileText className="h-3 w-3" aria-hidden />
      </span>
      <span className="flex-1 truncate text-foreground">{item.title}</span>
    </>
  );
}
