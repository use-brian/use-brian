"use client";

// [COMP:app-web/person-mention]
/**
 * Phase 4 — `@person` mention extension.
 *
 * Lock #15 v1 ships **two** mention types: `@person` (workspace member)
 * and `@page` (workspace page). Both node specs are mirrored in the SHARED
 * schema (`@use-brian/doc-model` → `PersonMention` / `PageMention`) so the
 * Yjs server derives the same node types and an inline mention round-trips
 * through the CRDT to every collaborator. This file's `PersonMentionNode`
 * is the byte-identical browser copy (registered in the editor while the
 * shared one is filtered out of `browserDocExtensions()` so they don't
 * collide — see `page-mention.tsx` for the consolidation handoff note). It
 * owns the single `@` Suggestion plugin that drives the shared
 * `<MentionPopup>` (people + pages tabs).
 *
 * Composition rule. To get the v1 two-tab popup in a single editor:
 *
 *   editor.use(createPersonMentionExtension({
 *     workspaceId,
 *     fetchMembers,
 *     fetchPages,            // optional — supply both for the v1 tabbed UI
 *   }))
 *   editor.use(createPageMentionExtension({ workspaceId, fetchPages }))
 *
 * `createPageMentionExtension` ships **without** its own suggestion plugin
 * by default, so the two extensions don't fight over `@`. The popup-owning
 * extension here does the routing — picking a Page row inserts a
 * `pageMention` Node, picking a Person row inserts a `personMention` Node.
 *
 * Standalone use is supported too: calling this factory with only
 * `fetchMembers` (no `fetchPages`) produces a single-tab People-only popup.
 */

import { Node, type Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { createSuggestionDismiss } from "../suggestion-dismiss";

/**
 * Distinct suggestion plugin key — see the note in `slash-menu.tsx`. The `@`
 * mention popup and the `/` slash menu coexist in one editor; without unique
 * keys ProseMirror throws "Adding different instances of a keyed plugin
 * (suggestion$)". This extension owns the single `@` trigger.
 */
const personMentionPluginKey = new PluginKey("docPersonMention");

import {
  MentionPopup,
  type MentionItem,
  type MentionPopupProps,
  type MentionPopupRef,
  type PageMentionItem,
  type PersonMentionItem,
} from "./mention-popup";

// ── Public option types ────────────────────────────────────────────────

/**
 * Workspace-members fetcher. The extension passes the active
 * `workspaceId` plus whatever the user has typed after `@` (sans the
 * leading char). Implementations should:
 *   - Return `[]` for queries that yield no matches.
 *   - Return a small "recent" set for `query === ""` (empty trigger).
 *   - Surface their own loading state by retaining the previous list.
 */
type FetchMembersFn = (
  workspaceId: string,
  query: string,
) => Promise<PersonMentionItem[]>;

/**
 * Pages fetcher. Same calling convention. Optional — when omitted, the
 * Pages tab is hidden and the popup is single-tab.
 */
type FetchPagesFn = (
  workspaceId: string,
  query: string,
) => Promise<PageMentionItem[]>;

export type PersonMentionExtensionOptions = {
  workspaceId: string;
  fetchMembers: FetchMembersFn;
  /** Optional — supply for the v1 two-tab popup. */
  fetchPages?: FetchPagesFn;
  /** Localised labels for the popup tabs / empty / aria strings. */
  popupLabels?: MentionPopupProps["labels"];
  /** Fired once when a `@person` mention is inserted (not on re-render). The
   *  page editor uses this to record a doc-Inbox notification for the
   *  tagged member. See `docs/architecture/features/doc-inbox.md`. */
  onPersonMentioned?: (item: PersonMentionItem) => void;
};

// ── The Node ───────────────────────────────────────────────────────────

/**
 * The `personMention` ProseMirror node — byte-identical to
 * `@use-brian/doc-model`'s `PersonMention` (kept in lockstep so the two Yjs
 * ends agree). Inline atom carrying `{ id, name, avatarUrl }`; renders an
 * `<span data-mention="person">@name</span>` pill.
 */
export const PersonMentionNode = Node.create({
  name: "personMention",
  group: "inline",
  inline: true,
  selectable: false,
  atom: true,

  addAttributes() {
    return {
      id: {
        default: null as string | null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-id"),
        renderHTML: (attrs: Record<string, unknown>): Record<string, string> =>
          attrs.id ? { "data-id": String(attrs.id) } : {},
      },
      name: {
        default: "" as string,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-name") ??
          element.textContent?.replace(/^@/, "") ??
          "",
        renderHTML: (attrs: Record<string, unknown>): Record<string, string> =>
          attrs.name ? { "data-name": String(attrs.name) } : {},
      },
      avatarUrl: {
        default: null as string | null,
        parseHTML: (element: HTMLElement) => element.getAttribute("data-avatar"),
        renderHTML: (attrs: Record<string, unknown>): Record<string, string> =>
          attrs.avatarUrl ? { "data-avatar": String(attrs.avatarUrl) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'span[data-mention="person"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const name = (node.attrs.name as string) || (node.attrs.id as string | null) || "";
    return [
      "span",
      {
        ...HTMLAttributes,
        "data-mention": "person",
        class:
          "inline-flex items-center rounded-md bg-muted px-1 py-0.5 text-foreground",
      },
      `@${name}`,
    ];
  },

  renderText({ node }) {
    const name = (node.attrs.name as string) || (node.attrs.id as string | null) || "";
    return `@${name}`;
  },
});

// ── Extension factory ──────────────────────────────────────────────────

/**
 * Build the `@person` mention extension. Returns the shared `personMention`
 * node `.extend()`ed with the `@` Suggestion plugin that drives the shared
 * `<MentionPopup>`. When `fetchPages` is supplied, the popup is two-tab and
 * picking a Pages row inserts a `pageMention` node (install both extensions
 * for the v1 setup).
 */
export function createPersonMentionExtension(
  options: PersonMentionExtensionOptions,
) {
  const { workspaceId, fetchMembers, fetchPages, popupLabels, onPersonMentioned } = options;

  return PersonMentionNode.extend({
    name: "personMention",

    addProseMirrorPlugins() {
      const parentPlugins = this.parent?.() ?? [];
      const plugins = [...parentPlugins];

      plugins.push(
        Suggestion<MentionItem, MentionItem>({
          editor: this.editor,
          pluginKey: personMentionPluginKey,
          char: "@",
          // Allow spaces inside the query so "@jane smith" finds Jane Smith.
          allowSpaces: true,
          startOfLine: false,
          command: ({ editor, range, props }) => {
            // Strip the `@<query>` from the editor before inserting the
            // typed node, then route by `kind`.
            const tr = editor.state.tr.deleteRange(range.from, range.to);
            editor.view.dispatch(tr);

            if (props.kind === "person") {
              insertPersonMention(editor, props);
              onPersonMentioned?.(props);
            } else {
              insertPageMention(editor, props);
            }
          },
          items: async ({ query }) => {
            const [people, pages] = await Promise.all([
              fetchMembers(workspaceId, query),
              fetchPages ? fetchPages(workspaceId, query) : Promise.resolve([]),
            ]);
            return [...people, ...pages];
          },
          render: () => {
            let component:
              | ReactRenderer<MentionPopupRef, MentionPopupProps>
              | null = null;
            // Escape-to-close — see `suggestion-dismiss.ts`. The plugin stays
            // active while `@…` is in the doc, so returning `true` alone never
            // closed the popup; we hide it and skip updates for this token.
            const dismiss = createSuggestionDismiss();

            const setHidden = (hidden: boolean) => {
              const el = component?.element as HTMLElement | undefined;
              if (el) el.style.display = hidden ? "none" : "";
            };

            const splitItems = (items: MentionItem[]) => {
              const people: PersonMentionItem[] = [];
              const pages: PageMentionItem[] = [];
              for (const item of items) {
                if (item.kind === "person") people.push(item);
                else pages.push(item);
              }
              return { people, pages };
            };

            const position = (props: SuggestionProps<MentionItem>) => {
              const el = component?.element as HTMLElement | undefined;
              if (!el) return;
              const rect = props.clientRect?.();
              if (!rect) return;
              el.style.position = "absolute";
              el.style.top = `${rect.bottom + window.scrollY + 4}px`;
              el.style.left = `${rect.left + window.scrollX}px`;
            };

            return {
              onStart: (props) => {
                dismiss.reset();
                const { people, pages } = splitItems(props.items);
                component = new ReactRenderer<MentionPopupRef, MentionPopupProps>(
                  MentionPopup,
                  {
                    props: {
                      people,
                      pages,
                      initialTab: "people",
                      onSelect: (item: MentionItem) => props.command(item),
                      labels: popupLabels,
                    },
                    editor: props.editor,
                  },
                );
                if (typeof document !== "undefined") {
                  document.body.appendChild(component.element);
                }
                position(props);
              },
              onUpdate: (props) => {
                if (dismiss.shouldSkipUpdate()) return;
                const { people, pages } = splitItems(props.items);
                component?.updateProps({
                  people,
                  pages,
                  onSelect: (item: MentionItem) => props.command(item),
                  labels: popupLabels,
                });
                position(props);
              },
              onKeyDown: (props) => {
                const action = dismiss.onKey(props.event.key);
                if (action === "dismiss") {
                  setHidden(true);
                  return true;
                }
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
      );

      return plugins;
    },
  });
}

// ── Insert helpers ─────────────────────────────────────────────────────

/**
 * Drop a `personMention` node into the editor at the current selection.
 * Adds a trailing space so the user can keep typing without rubbing up
 * against the pill.
 */
function insertPersonMention(editor: Editor, item: PersonMentionItem) {
  editor
    .chain()
    .focus()
    .insertContent([
      {
        type: "personMention",
        attrs: {
          id: item.id,
          name: item.name,
          avatarUrl: item.avatarUrl ?? null,
        },
      },
      { type: "text", text: " " },
    ])
    .run();
}

/**
 * Drop a `pageMention` node. Defined here (not in `page-mention.tsx`)
 * because this extension owns the Suggestion plugin and therefore the
 * insert path for both tabs.
 */
function insertPageMention(editor: Editor, item: PageMentionItem) {
  editor
    .chain()
    .focus()
    .insertContent([
      {
        type: "pageMention",
        attrs: {
          id: item.id,
          title: item.title,
        },
      },
      { type: "text", text: " " },
    ])
    .run();
}
