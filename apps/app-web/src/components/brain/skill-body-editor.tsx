"use client";

/**
 * Skill body editor — doc-block editing UX over a plain markdown string.
 *
 * ONE Tiptap document on the md-restricted schema
 * (`lib/skill-markdown.ts`: paragraph, heading 1-3, lists, blockquote,
 * code block, divider; bold/italic/code/strike/link), serialized to/from
 * markdown so `workspace_skills.content` stays a plain md string — no
 * backend change. Deliberately NOT the doc shell's per-block machinery
 * (page-renderer / sortable-block-list are coupled to viewId/Yjs); the
 * doc FEEL comes from:
 *
 *   - StarterKit's markdown input rules (`# `, `- `, `1. `, `> `, ``` , `---`),
 *   - a slim slash menu — the doc `SlashMenuPopup` + suggestion wiring
 *     reused verbatim, with a skill-only catalogue of the md blocks
 *     (labels from the existing `docPage.slashMenu` dictionary),
 *   - a slim floating mark toolbar (bold / italic / strike / code / link) —
 *     the doc `floating-toolbar.tsx` pattern incl. its `shouldShowToolbar`
 *     predicate + DOM-desync `display:contents` guard, minus TurnInto and
 *     comments,
 *   - the official `@tiptap/extension-drag-handle-react` grip, styled to
 *     match the doc's ⋮⋮ handle,
 *   - the `doc-collab-editor` CSS scope, so typography (headings, lists,
 *     quotes, code, the `.is-empty` placeholder paint) matches the doc
 *     surface 1:1.
 *
 * Task list (`- [ ]`) is NOT enabled: commonmark's tokenizer has no
 * task-list rule and no markdown-it plugin is installable here, so the
 * syntax survives as a literal bullet (see `skill-markdown.ts`).
 *
 * Controlled-ish contract: `value` is parsed into the editor once (and
 * re-applied only when it changes EXTERNALLY — e.g. the creator's
 * "Regenerate" swapping the draft); user edits serialize back through
 * `onChange` debounced ~150ms, flushed immediately on blur so a Save click
 * (mousedown → blur) never reads a stale draft. An untouched body never
 * emits — first-load md normalization can't arm the Save button.
 *
 * [COMP:app-web/skill-body-editor]
 */

import { useEffect, useMemo, useRef, useState } from "react";
import {
  BubbleMenu,
  EditorContent,
  ReactRenderer,
  useEditor,
  type Editor,
} from "@tiptap/react";
import { Extension } from "@tiptap/core";
import {
  Suggestion,
  type SuggestionKeyDownProps,
  type SuggestionProps,
} from "@tiptap/suggestion";
import { PluginKey } from "@tiptap/pm/state";
import Placeholder from "@tiptap/extension-placeholder";
import { DragHandle } from "@tiptap/extension-drag-handle-react";
import {
  Bold,
  Code,
  GripVertical,
  Heading1,
  Heading2,
  Heading3,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Minus,
  Quote,
  Strikethrough,
  Type,
} from "lucide-react";
import { useT } from "@/lib/i18n/client";
import {
  docToMarkdown,
  markdownToDoc,
  skillBodySchemaExtensions,
} from "@/lib/skill-markdown";
import {
  SlashMenuPopup,
  type SlashMenuItem,
  type SlashMenuPopupRef,
} from "@/components/doc/slash-menu";
import { shouldShowToolbar } from "@/components/doc/floating-toolbar";
import { createSuggestionDismiss } from "@/components/doc/suggestion-dismiss";

// ── Slim slash catalogue — md-representable blocks only ────────────────
//
// Reuses the doc's `SlashMenuItem` shape + popup; every label resolves from
// the existing `docPage.slashMenu.items.*` dictionary. All items sit in one
// "basic" category, so the popup renders a single group.

const SKILL_SLASH_ITEMS: readonly SlashMenuItem[] = [
  { id: "paragraph", labelKey: "paragraph", category: "basic", aliases: ["text", "paragraph", "p", "body"], icon: Type, blockKind: "text" },
  { id: "heading_1", labelKey: "heading_1", category: "basic", aliases: ["h1", "heading 1", "title"], icon: Heading1, blockKind: "heading", headingLevel: 1, shortcut: "#" },
  { id: "heading_2", labelKey: "heading_2", category: "basic", aliases: ["h2", "heading 2", "subtitle"], icon: Heading2, blockKind: "heading", headingLevel: 2, shortcut: "##" },
  { id: "heading_3", labelKey: "heading_3", category: "basic", aliases: ["h3", "heading 3"], icon: Heading3, blockKind: "heading", headingLevel: 3, shortcut: "###" },
  { id: "bulleted_list", labelKey: "bulleted_list", category: "basic", aliases: ["ul", "bullet", "unordered", "list"], icon: List, blockKind: "bulleted_list_item", shortcut: "-" },
  { id: "numbered_list", labelKey: "numbered_list", category: "basic", aliases: ["ol", "ordered", "numbered"], icon: ListOrdered, blockKind: "numbered_list_item", shortcut: "1." },
  { id: "quote", labelKey: "quote", category: "basic", aliases: ["blockquote", "citation"], icon: Quote, blockKind: "quote", shortcut: ">" },
  { id: "code", labelKey: "code", category: "basic", aliases: ["codeblock", "fence", "snippet"], icon: Code, blockKind: "code", shortcut: "```" },
  { id: "divider", labelKey: "divider", category: "basic", aliases: ["hr", "rule", "separator", "line"], icon: Minus, blockKind: "divider", shortcut: "---" },
];

/** Apply a picked block command to the (already `/`-stripped) selection. */
function executeSkillSlashItem(editor: Editor, item: SlashMenuItem) {
  const chain = editor.chain().focus();
  switch (item.id) {
    case "heading_1":
    case "heading_2":
    case "heading_3":
      chain.setNode("heading", { level: item.headingLevel ?? 1 }).run();
      return;
    case "bulleted_list":
      chain.toggleBulletList().run();
      return;
    case "numbered_list":
      chain.toggleOrderedList().run();
      return;
    case "quote":
      chain.toggleBlockquote().run();
      return;
    case "code":
      chain.toggleCodeBlock().run();
      return;
    case "divider":
      chain.setHorizontalRule().run();
      return;
    default:
      chain.setParagraph().run();
  }
}

/** Substring filter over the slim catalogue (the doc's filter is hardwired
 *  to the full 23-item doc catalogue, so the skill set filters locally). */
function filterSkillSlashItems(
  query: string,
  resolveLabel: (item: SlashMenuItem) => string,
): SlashMenuItem[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...SKILL_SLASH_ITEMS];
  return SKILL_SLASH_ITEMS.filter((item) => {
    if (resolveLabel(item).toLowerCase().includes(q)) return true;
    return item.aliases.some((a) => a.includes(q));
  });
}

// Distinct plugin key — the doc rule: every suggestion-based extension
// carries its own key (sharing the default throws at mount).
const skillSlashPluginKey = new PluginKey("skillSlashMenu");

type SlashCopy = {
  resolveLabel: (item: SlashMenuItem) => string;
  resolveCategoryLabel: (category: SlashMenuItem["category"]) => string;
  emptyLabel: string;
  ariaLabel: string;
  filteredLabel: string;
  closeMenuLabel: string;
  escLabel: string;
};

/** The skill slash extension — the doc `createSlashMenuExtension`'s
 *  ReactRenderer/positioning/dismiss wiring, over the slim catalogue, with
 *  the block transform applied directly (one Tiptap doc — no page-state
 *  indirection). */
function createSkillSlashExtension(copy: SlashCopy) {
  return Extension.create({
    name: "skillSlashMenu",
    addProseMirrorPlugins() {
      return [
        Suggestion<SlashMenuItem, SlashMenuItem>({
          editor: this.editor,
          pluginKey: skillSlashPluginKey,
          char: "/",
          allowSpaces: false,
          startOfLine: false,
          command: ({ editor, range, props }) => {
            editor.chain().focus().deleteRange(range).run();
            executeSkillSlashItem(editor as Editor, props);
          },
          items: ({ query }) => filterSkillSlashItems(query, copy.resolveLabel),
          render: () => {
            let component: ReactRenderer<SlashMenuPopupRef, React.ComponentProps<typeof SlashMenuPopup>> | null = null;
            const dismiss = createSuggestionDismiss();

            const position = (props: SuggestionProps<SlashMenuItem>) => {
              const el = component?.element as HTMLElement | undefined;
              if (!el) return;
              const rect = props.clientRect?.();
              if (!rect) return;
              el.style.position = "absolute";
              el.style.top = `${rect.bottom + window.scrollY + 4}px`;
              el.style.left = `${rect.left + window.scrollX}px`;
            };
            const popupProps = (props: SuggestionProps<SlashMenuItem>) => ({
              items: props.items,
              command: (item: SlashMenuItem) => props.command(item),
              query: props.query,
              resolveLabel: copy.resolveLabel,
              resolveCategoryLabel: copy.resolveCategoryLabel,
              emptyLabel: copy.emptyLabel,
              ariaLabel: copy.ariaLabel,
              filteredLabel: copy.filteredLabel,
              closeMenuLabel: copy.closeMenuLabel,
              escLabel: copy.escLabel,
            });

            return {
              onStart: (props: SuggestionProps<SlashMenuItem>) => {
                dismiss.reset();
                component = new ReactRenderer(SlashMenuPopup, {
                  props: popupProps(props),
                  editor: props.editor,
                });
                if (typeof document !== "undefined") {
                  document.body.appendChild(component.element);
                }
                position(props);
              },
              onUpdate: (props: SuggestionProps<SlashMenuItem>) => {
                if (dismiss.shouldSkipUpdate()) return;
                component?.updateProps(popupProps(props));
                position(props);
              },
              onKeyDown: (props: SuggestionKeyDownProps) => {
                const action = dismiss.onKey(props.event.key);
                if (action === "dismiss") {
                  const el = component?.element as HTMLElement | undefined;
                  if (el) el.style.display = "none";
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
      ];
    },
  });
}

// ── The component ───────────────────────────────────────────────────────

type Props = {
  /** The markdown source of truth (the page's `content` draft state). */
  value: string;
  /** Debounced (~150ms, flushed on blur) serialized-markdown updates. */
  onChange: (md: string) => void;
  placeholder: string;
  ariaLabel?: string;
  /** Form-field mode (the creator's bordered box): short min-height, no
   *  document tail padding, no drag handle. Default = full document mode. */
  compact?: boolean;
};

const EMIT_DEBOUNCE_MS = 150;

export function SkillBodyEditor({
  value,
  onChange,
  placeholder,
  ariaLabel,
  compact,
}: Props) {
  const t = useT();
  const slash = t.docPage.slashMenu;
  const toolbarCopy = t.docPage.floatingToolbar;
  const slashHint = t.brainPage.skillEditor.slashHint;

  // The last markdown WE emitted — distinguishes our own echo (value prop
  // updating from onChange) from a real external swap (creator regenerate).
  const lastEmittedRef = useRef<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const extensions = useMemo(
    () => [
      ...skillBodySchemaExtensions,
      Placeholder.configure({
        // `showOnlyCurrent: false` so the EMPTY-DOC hint paints before focus;
        // per-node gating happens in the callback instead. The doc CSS paints
        // `content: attr(data-placeholder)`, so returning "" renders nothing
        // even though the extension still classes the node `is-empty` — no
        // CSS override needed, and the doc surface's own placeholder
        // extension is untouched.
        showOnlyCurrent: false,
        placeholder: ({ editor: ed, node, hasAnchor }) => {
          // Whole document empty → the full instruction hint (even unfocused).
          if (ed.isEmpty) return placeholder;
          // Non-empty doc: a quiet slash whisper on the FOCUSED empty
          // paragraph only; every other empty line is pure whitespace (the
          // old config stacked the long hint on every skipped line).
          if (!hasAnchor || node.type.name !== "paragraph") return "";
          return slashHint;
        },
      }),
      createSkillSlashExtension({
        resolveLabel: (item) => slash.items[item.labelKey],
        resolveCategoryLabel: (category) => slash.categories[category],
        emptyLabel: slash.empty,
        ariaLabel: slash.ariaLabel,
        filteredLabel: slash.filteredResults,
        closeMenuLabel: slash.closeMenu,
        escLabel: slash.esc,
      }),
    ],
    // The dictionary object is stable per locale; placeholder is static copy.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [placeholder, slash, slashHint],
  );

  const editor = useEditor({
    extensions,
    content: markdownToDoc(value).toJSON(),
    immediatelyRender: false,
    editorProps: {
      attributes: {
        // `!ml-0 !pl-0` neutralizes the doc CSS's drag-handle gutter (its
        // negative margin would overflow this page's narrower padding; the
        // official DragHandle positions via tippy, not an in-box gutter).
        // Compact mode also drops the document tail padding for form use.
        class: compact
          ? "min-h-[10rem] outline-none !ml-0 !pl-0 !pb-2"
          : "min-h-[30vh] outline-none !ml-0 !pl-0",
        ...(ariaLabel ? { "aria-label": ariaLabel } : {}),
      },
    },
    onUpdate: ({ editor: ed }) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => {
        const md = docToMarkdown(ed.state.doc);
        lastEmittedRef.current = md;
        onChangeRef.current(md);
      }, EMIT_DEBOUNCE_MS);
    },
    onBlur: ({ editor: ed }) => {
      // Flush immediately — a Save click blurs the editor first (mousedown →
      // blur → click), so the page never reads a stale 150ms-old draft.
      if (timerRef.current) {
        clearTimeout(timerRef.current);
        timerRef.current = null;
      }
      const md = docToMarkdown(ed.state.doc);
      if (md !== lastEmittedRef.current) {
        lastEmittedRef.current = md;
        onChangeRef.current(md);
      }
    },
  });

  // Clear any pending emit on unmount.
  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  // EXTERNAL value swap (creator regenerate, a reload that diverged): reset
  // the editor content. Our own echoes (value === lastEmitted) and md that
  // already matches the doc are no-ops, so typing never loops.
  useEffect(() => {
    if (!editor || editor.isDestroyed) return;
    if (value === lastEmittedRef.current) return;
    const current = docToMarkdown(editor.state.doc);
    if (current === value) return;
    editor.commands.setContent(markdownToDoc(value).toJSON());
  }, [value, editor]);

  // IMPORTANT: memoized — a fresh object re-initializes the handle each
  // render and breaks dragging (see @tiptap/extension-drag-handle-react).
  const dragTippyOptions = useMemo(() => ({ placement: "left" as const, offset: [0, 4] as [number, number] }), []);

  return (
    // `doc-collab-editor` scopes the doc surface's block typography (headings,
    // lists, quote, code, hr, the placeholder paint) AND the left gutter the
    // drag handle hovers in — visual parity with the page editor for free.
    <div className="doc-collab-editor relative">
      {editor && !compact && (
        <DragHandle editor={editor} tippyOptions={dragTippyOptions}>
          <div
            className="doc-drag-handle flex h-6 w-5 cursor-grab items-center justify-center rounded text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            aria-hidden
          >
            <GripVertical className="size-4" />
          </div>
        </DragHandle>
      )}
      {editor && <SkillMarkToolbar editor={editor} />}
      <EditorContent editor={editor} />
    </div>
  );
}

// ── Floating mark toolbar — the doc pattern, marks only ────────────────

function SkillMarkToolbar({ editor }: { editor: Editor }) {
  const t = useT();
  const copy = t.docPage.floatingToolbar;
  const [linkOpen, setLinkOpen] = useState(false);
  const [linkUrl, setLinkUrl] = useState("");

  const openLink = () => {
    setLinkUrl((editor.getAttributes("link").href as string | undefined) ?? "");
    setLinkOpen(true);
  };
  const submitLink = () => {
    if (linkUrl) {
      editor.chain().focus().extendMarkRange("link").setLink({ href: linkUrl }).run();
    } else {
      editor.chain().focus().extendMarkRange("link").unsetLink().run();
    }
    setLinkOpen(false);
  };

  const buttons: { label: string; active: boolean; onClick: () => void; icon: React.ReactNode }[] = [
    { label: copy.bold, active: editor.isActive("bold"), onClick: () => editor.chain().focus().toggleBold().run(), icon: <Bold size={14} /> },
    { label: copy.italic, active: editor.isActive("italic"), onClick: () => editor.chain().focus().toggleItalic().run(), icon: <Italic size={14} /> },
    { label: copy.strike, active: editor.isActive("strike"), onClick: () => editor.chain().focus().toggleStrike().run(), icon: <Strikethrough size={14} /> },
    { label: copy.code, active: editor.isActive("code"), onClick: () => editor.chain().focus().toggleCode().run(), icon: <Code size={14} /> },
  ];

  return (
    // `display:contents` host — the doc floating-toolbar's DOM-desync guard
    // (tippy detaches the bubble div; this keeps it off React's sibling list).
    <div className="contents">
      <BubbleMenu
        editor={editor}
        tippyOptions={{ duration: 100, placement: "top" }}
        shouldShow={({ editor: ed, from, to }) =>
          shouldShowToolbar({
            from,
            to,
            isInCodeBlock: ed.isActive("codeBlock"),
          })
        }
        className="inline-flex items-center gap-0.5 rounded-md border border-border bg-background p-1 shadow-md"
      >
        {buttons.map((b) => (
          <button
            key={b.label}
            type="button"
            aria-label={b.label}
            aria-pressed={b.active}
            onClick={b.onClick}
            className={[
              "inline-flex h-7 w-7 items-center justify-center rounded transition-colors",
              b.active
                ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
                : "hover:bg-[var(--muted)]",
            ].join(" ")}
          >
            {b.icon}
          </button>
        ))}
        <button
          type="button"
          aria-label={copy.link}
          aria-pressed={editor.isActive("link") || linkOpen}
          onClick={openLink}
          className={[
            "inline-flex h-7 w-7 items-center justify-center rounded transition-colors",
            editor.isActive("link") || linkOpen
              ? "bg-[var(--accent)] text-[var(--accent-foreground)]"
              : "hover:bg-[var(--muted)]",
          ].join(" ")}
        >
          <LinkIcon size={14} />
        </button>
        {linkOpen ? (
          <input
            type="url"
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                submitLink();
              } else if (e.key === "Escape") {
                e.preventDefault();
                setLinkOpen(false);
              }
            }}
            placeholder={copy.linkPlaceholder}
            className="ml-1 h-7 w-48 rounded border border-border bg-transparent px-2 text-sm outline-none focus:ring-1 focus:ring-border"
          />
        ) : null}
      </BubbleMenu>
    </div>
  );
}
