"use client";

// [COMP:app-web/page-mention]
/**
 * Phase 4 — `@page` mention extension.
 *
 * The `pageMention` node spec is mirrored in the SHARED schema
 * (`@use-brian/doc-model` → `PageMention`) so the Yjs sync server derives
 * the same node type and an inline page reference round-trips through the
 * CRDT to every collaborator (y-prosemirror maps the ProseMirror schema to
 * the CRDT — a node type on one end and not the other desyncs). This file's
 * `PageMentionNode` is the **byte-identical browser copy** (same name,
 * attrs, parse/render) — registered in the editor while the shared one is
 * filtered out of `browserDocExtensions()` so they don't collide.
 * (Consolidating onto one exported node is a follow-up that needs the
 * `@use-brian/doc-model` barrel to re-export `PageMention` — see the
 * handoff report.)
 *
 *   1. **v1 composed setup (default).** Install both
 *      `createPersonMentionExtension({ fetchMembers, fetchPages })` and
 *      `createPageMentionExtension({})`. The Person extension owns the `@`
 *      trigger; the Page extension contributes only this node schema.
 *      (`withSuggestion` defaults to `false` so the two don't collide.)
 *
 *   2. **Pages-only standalone.** Pass `withSuggestion: true` plus a
 *      `fetchPages` resolver and the extension installs its own `@`
 *      Suggestion plugin. The popup is single-tab in this mode.
 *
 * On click the pill links to the workspace-scoped page route
 * `/w/<workspaceId>/p/<id>` when the factory gets a `workspaceId` (the
 * collab editor always passes one); the base node's bare `/p/<id>` only
 * survives in schema-only contexts with no workspace (unit-test editors).
 */

import { Node, type Editor } from "@tiptap/core";
import { ReactRenderer } from "@tiptap/react";
import { Suggestion, type SuggestionProps } from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import { createSuggestionDismiss } from "../suggestion-dismiss";

/**
 * Distinct suggestion plugin key for the standalone (`withSuggestion: true`)
 * Pages-only mode — see the note in `slash-menu.tsx`. Even though the v1
 * composed setup lets `person-mention` own the `@` trigger, this guarantees
 * the standalone path never collides with the slash menu's key.
 */
const pageMentionPluginKey = new PluginKey("docPageMention");

import {
  MentionPopup,
  type MentionItem,
  type MentionPopupProps,
  type MentionPopupRef,
  type PageMentionItem,
} from "./mention-popup";

// ── The Node ───────────────────────────────────────────────────────────

/**
 * The `pageMention` ProseMirror node — byte-identical to
 * `@use-brian/doc-model`'s `PageMention` (kept in lockstep so the two Yjs
 * ends agree). Inline atom; renders an `<a>` pill so it's keyboard-focusable
 * + Cmd-clickable in the read-only viewer.
 */
export const PageMentionNode = Node.create({
  name: "pageMention",
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
      title: {
        default: "" as string,
        parseHTML: (element: HTMLElement) =>
          element.getAttribute("data-title") ??
          element.textContent?.replace(/^📄\s*/, "") ??
          "",
        renderHTML: (attrs: Record<string, unknown>): Record<string, string> =>
          attrs.title ? { "data-title": String(attrs.title) } : {},
      },
    };
  },

  parseHTML() {
    return [{ tag: 'a[data-mention="page"]' }];
  },

  renderHTML({ node, HTMLAttributes }) {
    const id = (node.attrs.id as string | null) ?? "";
    const title = (node.attrs.title as string) || id || "";
    return [
      "a",
      {
        ...HTMLAttributes,
        "data-mention": "page",
        href: id ? `/p/${id}` : "#",
        class:
          "inline-flex items-center gap-1 rounded-md bg-muted px-1 py-0.5 text-foreground no-underline hover:underline",
      },
      `📄 ${title}`,
    ];
  },

  renderText({ node }) {
    const title = (node.attrs.title as string) || (node.attrs.id as string | null) || "";
    return `📄 ${title}`;
  },
});

// ── Extension factory ──────────────────────────────────────────────────

export type PageMentionExtensionOptions = {
  /**
   * Scopes the rendered pill's href to the workspace page route
   * (`/w/<workspaceId>/p/<id>`); without it the pill falls back to the
   * base node's bare `/p/<id>`, which is dead on the app origin — so
   * every editor mount should pass it. Also required when the extension
   * owns its own Suggestion plugin (`withSuggestion: true`).
   */
  workspaceId?: string;
  /**
   * Required when `withSuggestion: true`. Otherwise unused.
   */
  fetchPages?: (workspaceId: string, query: string) => Promise<PageMentionItem[]>;
  /**
   * Set to `true` if this is the only mention extension in the editor
   * and you want a Pages-only popup. Default `false` — the v1 setup
   * lets `createPersonMentionExtension` own the `@` trigger and route
   * both tabs through one popup.
   */
  withSuggestion?: boolean;
  /** Localised labels for the popup tabs / empty / aria strings. */
  popupLabels?: MentionPopupProps["labels"];
};

/**
 * Build the `@page` mention extension. Default is the shared node only — a
 * sibling of `createPersonMentionExtension` that contributes no competing
 * `@` plugin. With `withSuggestion: true` it installs its own Pages-only
 * Suggestion plugin.
 */
export function createPageMentionExtension(
  options: PageMentionExtensionOptions = {},
) {
  const { workspaceId, fetchPages, withSuggestion = false, popupLabels } = options;

  return PageMentionNode.extend({
    name: "pageMention",

    // Rendering-only override of the base node's `/p/<id>` href: the pill
    // links to the workspace-scoped page route. `.extend()` leaves the node
    // *spec* (name/attrs/parse) untouched, so Yjs schema parity with
    // `@use-brian/doc-model` holds — same pattern as the React node-views in
    // `doc-schema.ts`. Without a workspaceId (schema-only test editors) the
    // base-identical relative href stays as the fallback.
    renderHTML({ node, HTMLAttributes }) {
      const id = (node.attrs.id as string | null) ?? "";
      const title = (node.attrs.title as string) || id || "";
      const href = id
        ? workspaceId
          ? `/w/${workspaceId}/p/${id}`
          : `/p/${id}`
        : "#";
      return [
        "a",
        {
          ...HTMLAttributes,
          "data-mention": "page",
          href,
          class:
            "inline-flex items-center gap-1 rounded-md bg-muted px-1 py-0.5 text-foreground no-underline hover:underline",
        },
        `📄 ${title}`,
      ];
    },

    addProseMirrorPlugins() {
      const parentPlugins = this.parent?.() ?? [];
      const plugins = [...parentPlugins];

      if (!withSuggestion) {
        return plugins;
      }

      if (!fetchPages || !workspaceId) {
        // Misconfiguration — drop a console hint and bail out so the
        // editor still mounts (the schema is fine on its own).
        if (typeof console !== "undefined") {
          console.warn(
            "[page-mention] withSuggestion: true requires workspaceId + fetchPages — falling back to schema-only.",
          );
        }
        return plugins;
      }

      plugins.push(
        Suggestion<PageMentionItem, PageMentionItem>({
          editor: this.editor,
          pluginKey: pageMentionPluginKey,
          char: "@",
          allowSpaces: true,
          startOfLine: false,
          command: ({ editor, range, props }) => {
            const tr = editor.state.tr.deleteRange(range.from, range.to);
            editor.view.dispatch(tr);
            insertPageMention(editor, props);
          },
          items: async ({ query }) => fetchPages(workspaceId, query),
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

            const position = (props: SuggestionProps<PageMentionItem>) => {
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
                component = new ReactRenderer<MentionPopupRef, MentionPopupProps>(
                  MentionPopup,
                  {
                    props: {
                      people: [],
                      pages: props.items,
                      initialTab: "pages",
                      onSelect: (item: MentionItem) => {
                        if (item.kind === "page") props.command(item);
                      },
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
                component?.updateProps({
                  people: [],
                  pages: props.items,
                  onSelect: (item: MentionItem) => {
                    if (item.kind === "page") props.command(item);
                  },
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

// ── Insert helper ──────────────────────────────────────────────────────

function insertPageMention(editor: Editor, item: PageMentionItem) {
  editor
    .chain()
    .focus()
    .insertContent([
      { type: "pageMention", attrs: { id: item.id, title: item.title } },
      { type: "text", text: " " },
    ])
    .run();
}
