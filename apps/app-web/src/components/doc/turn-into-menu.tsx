"use client";

// [COMP:app-web/turn-into-menu]
/**
 * Phase 4 — "Turn into" block-type conversion menu.
 *
 * Notion's selection bubble leads with a "Turn into ▾" control that
 * converts the **current block** to another type (paragraph ↔ heading /
 * quote / callout / list / to-do / toggle) — distinct from the slash menu,
 * which inserts at the caret. This component is the conversion menu: a
 * trigger button + a popover list of target types, each wired to a Tiptap
 * command that rewrites the block in place.
 *
 * Conversion table (`TURN_INTO_ITEMS`) is exported so tests can introspect
 * the labels + commands without a live editor. The actual command dispatch
 * (`applyTurnInto`) is exported too — pure wrt the React layer so it can be
 * exercised against a recorded chain (app-web's vitest is node-only).
 *
 * Prose conversions use Tiptap's built-in node commands (`setParagraph`,
 * `toggleHeading`, `toggleBlockquote`, `toggleBulletList`, …). The two
 * custom containers (`callout`, `toggle`) have no in-place "set" command, so
 * we wrap the current block's content into a fresh container via
 * `wrapIn` — keeping the user's text rather than discarding it.
 */

import { useEffect, useRef, useState } from "react";
import type { Editor } from "@tiptap/core";
// Side-effect import: brings the `toggleTaskList` command into the
// `@tiptap/core` `Commands` augmentation so the chain is typed.
import "@tiptap/extension-task-list";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code,
  Heading1,
  Heading2,
  Heading3,
  Heading4,
  List,
  ListOrdered,
  Quote,
  SquareCheck,
  Type,
  type LucideIcon,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";

/** The block kinds "Turn into" can convert the current block to. */
export type TurnIntoKind =
  | "paragraph"
  | "heading_1"
  | "heading_2"
  | "heading_3"
  | "heading_4"
  | "bulleted_list"
  | "numbered_list"
  | "to_do"
  | "quote"
  | "callout"
  | "toggle"
  | "code";

export type TurnIntoItem = {
  id: TurnIntoKind;
  /** Dictionary key under `docPage.slashMenu.items.<labelKey>`. */
  labelKey:
    | "paragraph"
    | "heading_1"
    | "heading_2"
    | "heading_3"
    | "heading_4"
    | "bulleted_list"
    | "numbered_list"
    | "to_do"
    | "quote"
    | "callout"
    | "toggle"
    | "code";
  icon: LucideIcon;
};

/**
 * The conversion catalogue — the convertible subset of the slash menu (no
 * media / database, no divider, since "turn a paragraph into a divider" is
 * nonsensical). Order mirrors the slash menu's Basic group, including
 * Heading 4 and Code (both first-class slash-menu kinds — see CHROME-2/3 in
 * `docs/plans/doc-notion-parity-audit-2.md`).
 */
export const TURN_INTO_ITEMS: readonly TurnIntoItem[] = [
  { id: "paragraph", labelKey: "paragraph", icon: Type },
  { id: "heading_1", labelKey: "heading_1", icon: Heading1 },
  { id: "heading_2", labelKey: "heading_2", icon: Heading2 },
  { id: "heading_3", labelKey: "heading_3", icon: Heading3 },
  { id: "heading_4", labelKey: "heading_4", icon: Heading4 },
  { id: "bulleted_list", labelKey: "bulleted_list", icon: List },
  { id: "numbered_list", labelKey: "numbered_list", icon: ListOrdered },
  { id: "to_do", labelKey: "to_do", icon: SquareCheck },
  { id: "quote", labelKey: "quote", icon: Quote },
  { id: "callout", labelKey: "callout", icon: CircleAlert },
  { id: "toggle", labelKey: "toggle", icon: ChevronRight },
  { id: "code", labelKey: "code", icon: Code },
];

/**
 * Convert the block at the current selection to `kind`. Pure wrt React —
 * returns the boolean the underlying chain returns. Built-in node commands
 * convert in place; the custom `callout` / `toggle` containers wrap the
 * current block so the user's text is preserved.
 */
export function applyTurnInto(editor: Editor, kind: TurnIntoKind): boolean {
  const chain = editor.chain().focus();
  switch (kind) {
    case "paragraph":
      return chain.setParagraph().run();
    case "heading_1":
      return chain.setHeading({ level: 1 }).run();
    case "heading_2":
      return chain.setHeading({ level: 2 }).run();
    case "heading_3":
      return chain.setHeading({ level: 3 }).run();
    case "heading_4":
      return chain.setHeading({ level: 4 }).run();
    case "bulleted_list":
      return chain.toggleBulletList().run();
    case "numbered_list":
      return chain.toggleOrderedList().run();
    case "to_do":
      return chain.toggleTaskList().run();
    case "quote":
      return chain.toggleBlockquote().run();
    case "callout":
      return chain.wrapIn("callout").run();
    case "toggle":
      return chain.wrapIn("toggle").run();
    case "code":
      return chain.setCodeBlock().run();
  }
}

/**
 * Whether the current selection is already block-kind `kind` — drives the
 * Notion-style checkmark on the active turn-into row (CHROME-4). Exported so
 * the block-action menu's turn-into rows reuse the same predicate. `paragraph`
 * is "plain text only": a paragraph nested inside a list / quote / container
 * is reported as that container's kind, not as Text (matching Notion's single
 * checkmark).
 */
export function isActiveTurnIntoKind(editor: Editor, kind: TurnIntoKind): boolean {
  switch (kind) {
    case "paragraph":
      return (
        editor.isActive("paragraph") &&
        !editor.isActive("bulletList") &&
        !editor.isActive("orderedList") &&
        !editor.isActive("taskList") &&
        !editor.isActive("blockquote") &&
        !editor.isActive("callout") &&
        !editor.isActive("toggle")
      );
    case "heading_1":
      return editor.isActive("heading", { level: 1 });
    case "heading_2":
      return editor.isActive("heading", { level: 2 });
    case "heading_3":
      return editor.isActive("heading", { level: 3 });
    case "heading_4":
      return editor.isActive("heading", { level: 4 });
    case "bulleted_list":
      return editor.isActive("bulletList");
    case "numbered_list":
      return editor.isActive("orderedList");
    case "to_do":
      return editor.isActive("taskList");
    case "quote":
      return editor.isActive("blockquote");
    case "callout":
      return editor.isActive("callout");
    case "toggle":
      return editor.isActive("toggle");
    case "code":
      return editor.isActive("codeBlock");
  }
}

export function TurnIntoMenu({ editor }: { editor: Editor }) {
  const t = useT().docPage;
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    function onDocClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: globalThis.KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    if (typeof document !== "undefined") {
      document.addEventListener("mousedown", onDocClick);
      document.addEventListener("keydown", onKey);
      return () => {
        document.removeEventListener("mousedown", onDocClick);
        document.removeEventListener("keydown", onKey);
      };
    }
    return undefined;
  }, [open]);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        data-action="open-turn-into"
        aria-label={t.turnInto.button}
        aria-haspopup="menu"
        aria-expanded={open}
        // Keep the selection alive when the bubble button is pressed.
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((o) => !o)}
        className="inline-flex h-7 items-center gap-0.5 rounded px-1.5 text-xs text-foreground transition-colors hover:bg-[var(--muted)]"
      >
        <span className="whitespace-nowrap">{t.turnInto.button}</span>
        <ChevronDown size={12} className="flex-shrink-0" aria-hidden />
      </button>

      {open ? (
        <div
          role="menu"
          aria-label={t.turnInto.button}
          data-popover="turn-into"
          className="absolute left-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-md border border-border bg-popover py-1 text-sm shadow-lg"
        >
          <div className="px-3 pb-1 pt-1.5 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
            {t.turnInto.heading}
          </div>
          <ul className="max-h-72 overflow-y-auto">
            {TURN_INTO_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = isActiveTurnIntoKind(editor, item.id);
              return (
                <li key={item.id}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={active}
                    data-item-id={item.id}
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => {
                      applyTurnInto(editor, item.id);
                      setOpen(false);
                    }}
                    className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-foreground transition-colors hover:bg-muted"
                  >
                    <Icon className="h-4 w-4 flex-shrink-0 text-muted-foreground" aria-hidden />
                    <span className="flex-1 truncate">
                      {t.slashMenu.items[item.labelKey]}
                    </span>
                    {active ? (
                      <Check
                        className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground"
                        aria-hidden
                      />
                    ) : null}
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ) : null}
    </div>
  );
}
