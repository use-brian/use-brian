/**
 * The canonical Tiptap/ProseMirror schema for a doc page — shared by
 * the browser editor (`apps/app-web`), the Yjs sync server
 * (`apps/doc-sync`), the server-side AI client (`@sidanclaw/core`), and
 * the block→Y.Doc migration. Both Yjs ends MUST build the schema from this
 * one list or documents corrupt (y-prosemirror maps a ProseMirror schema to
 * the CRDT; a node/attr that exists on one end and not the other desyncs).
 *
 * This module is React-free on purpose: it defines node *specs* (attrs +
 * parse/render HTML + content), not React node-views. The browser layers
 * `ReactNodeViewRenderer`s on top of these specs; the server only needs the
 * specs to derive a `prosemirror-model` `Schema` via `getSchema`.
 *
 * Non-prose blocks (data / chart / image / file / bookmark / child_page)
 * collapse to a single opaque `embed` atom whose `block` attr carries the
 * original block JSON as a string — lossless and id-preserving. The browser
 * node-view dispatches on the parsed `block.kind`.
 *
 * [COMP:doc-model/schema]
 */

import {
  Extension,
  Mark,
  Node,
  getSchema,
  wrappingInputRule,
  type AnyExtension,
} from '@tiptap/core'
import StarterKit from '@tiptap/starter-kit'
import Blockquote from '@tiptap/extension-blockquote'
import Link from '@tiptap/extension-link'
import TaskList from '@tiptap/extension-task-list'
import TaskItem from '@tiptap/extension-task-item'
import Table from '@tiptap/extension-table'
import TableRow from '@tiptap/extension-table-row'
import TableHeader from '@tiptap/extension-table-header'
import TableCell from '@tiptap/extension-table-cell'
import type { Schema } from 'prosemirror-model'

/** The Yjs XML-fragment field name. Must match the client's
 *  `Collaboration.configure({ field })` (Tiptap default is 'default'). */
export const FRAGMENT_FIELD = 'default'
/** Y.Map name holding page metadata (title) alongside the body fragment. */
export const META_MAP = 'meta'

/**
 * Markdown input-rule triggers for the two block kinds whose shortcut we
 * deliberately remap from the Tiptap defaults, Notion-style:
 *   - `| ` (pipe + space) → **quote**. StarterKit's blockquote default is
 *     `> `, which we hand to the toggle below.
 *   - `> ` (greater-than + space) → **toggle** (collapsible disclosure),
 *     matching Notion where `>` makes a toggle, not a quote.
 * Exported so the schema test pins the trigger chars — guarding against a
 * regression that re-points `> ` back at the blockquote. Input rules are
 * editor plugins, NOT part of the derived `Schema` (`getSchema` ignores
 * them), so this swap never touches the byte-for-byte Yjs node contract.
 */
export const BLOCKQUOTE_INPUT_REGEX = /^\s*\|\s$/
export const TOGGLE_INPUT_REGEX = /^\s*>\s$/

/** Tinted-panel block (Notion callout). `icon` is an emoji/glyph. */
export const Callout = Node.create({
  name: 'callout',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { icon: { default: '💡' } }
  },
  parseHTML() {
    return [{ tag: 'div[data-callout]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-callout': '', ...HTMLAttributes }, 0]
  },
})

/** Collapsible block (Notion toggle). `open` is the expanded flag. */
export const Toggle = Node.create({
  name: 'toggle',
  group: 'block',
  content: 'block+',
  defining: true,
  addAttributes() {
    return { open: { default: false } }
  },
  addInputRules() {
    // `> ` wraps the current block in a toggle. Created OPEN so the summary
    // line is visible to type into — a collapsed toggle hides everything but
    // its first child (see the node-view + globals.css `.doc-toggle`).
    return [
      wrappingInputRule({
        find: TOGGLE_INPUT_REGEX,
        type: this.type,
        getAttributes: () => ({ open: true }),
      }),
    ]
  },
  parseHTML() {
    return [{ tag: 'div[data-toggle]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-toggle': '', ...HTMLAttributes }, 0]
  },
})

/**
 * Blockquote with a Notion-style `| ` trigger. `> ` is reserved for the
 * Toggle node above, so we drop StarterKit's bundled blockquote (which owns
 * the `> ` input rule) and re-register the SAME upstream `@tiptap/extension-
 * blockquote` here with only its input rule changed. The node spec is
 * untouched — same name/content/parse/render — so the derived `Schema` stays
 * byte-for-byte identical on both Yjs ends; only the browser's input rule
 * differs.
 */
export const DocBlockquote = Blockquote.extend({
  addInputRules() {
    return [wrappingInputRule({ find: BLOCKQUOTE_INPUT_REGEX, type: this.type })]
  },
})

/**
 * Inline `@person` mention atom. Carries the workspace member/user `id`,
 * the display `name`, and an optional `avatarUrl`. Rendered as a
 * `<span data-mention="person" data-id="…">@name</span>` pill so the
 * read-only viewer and copy/paste round-trip preserve it.
 *
 * Lives in the SHARED schema (not just the browser) so a mention typed by
 * one collaborator round-trips through the Yjs doc to every other end —
 * y-prosemirror maps the ProseMirror schema to the CRDT, so a node that
 * exists on one end and not the other desyncs the document. The browser
 * layers a `ReactNodeViewRenderer` + the `@` Suggestion plugin on top via
 * `.extend()` (rendering + behavior only; the schema stays identical).
 */
export const PersonMention = Node.create({
  name: 'personMention',
  group: 'inline',
  inline: true,
  selectable: false,
  atom: true,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-id': String(attrs.id) } : {}),
      },
      name: {
        default: '',
        parseHTML: (el) =>
          el.getAttribute('data-name') ?? el.textContent?.replace(/^@/, '') ?? '',
        renderHTML: (attrs) => (attrs.name ? { 'data-name': String(attrs.name) } : {}),
      },
      avatarUrl: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-avatar'),
        renderHTML: (attrs) =>
          attrs.avatarUrl ? { 'data-avatar': String(attrs.avatarUrl) } : {},
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-mention="person"]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const name = (node.attrs.name as string) || (node.attrs.id as string | null) || ''
    return [
      'span',
      {
        ...HTMLAttributes,
        'data-mention': 'person',
        class: 'inline-flex items-center rounded-md bg-muted px-1 py-0.5 text-foreground',
      },
      `@${name}`,
    ]
  },
  renderText({ node }) {
    const name = (node.attrs.name as string) || (node.attrs.id as string | null) || ''
    return `@${name}`
  },
})

/**
 * Inline `@page` mention atom. Carries the target page `id` + display
 * `title`. Rendered as an `<a data-mention="page" href="/p/<id>">📄 title</a>`
 * pill — keyboard-focusable + Cmd-clickable in the viewer. Shared for the
 * same Yjs-round-trip reason as `personMention`.
 */
export const PageMention = Node.create({
  name: 'pageMention',
  group: 'inline',
  inline: true,
  selectable: false,
  atom: true,
  addAttributes() {
    return {
      id: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-id'),
        renderHTML: (attrs) => (attrs.id ? { 'data-id': String(attrs.id) } : {}),
      },
      title: {
        default: '',
        parseHTML: (el) =>
          el.getAttribute('data-title') ??
          el.textContent?.replace(/^📄\s*/, '') ??
          '',
        renderHTML: (attrs) => (attrs.title ? { 'data-title': String(attrs.title) } : {}),
      },
    }
  },
  parseHTML() {
    return [{ tag: 'a[data-mention="page"]' }]
  },
  renderHTML({ node, HTMLAttributes }) {
    const id = (node.attrs.id as string | null) ?? ''
    const title = (node.attrs.title as string) || id || ''
    return [
      'a',
      {
        ...HTMLAttributes,
        'data-mention': 'page',
        href: id ? `/p/${id}` : '#',
        class:
          'inline-flex items-center gap-1 rounded-md bg-muted px-1 py-0.5 text-foreground no-underline hover:underline',
      },
      `📄 ${title}`,
    ]
  },
  renderText({ node }) {
    const title = (node.attrs.title as string) || (node.attrs.id as string | null) || ''
    return `📄 ${title}`
  },
})

/**
 * Opaque embed atom for every non-prose block kind. `block` holds the
 * original block JSON as a string (string attrs round-trip through
 * y-prosemirror losslessly; object attrs are riskier). The client
 * node-view parses it and dispatches on `block.kind`.
 */
export const Embed = Node.create({
  name: 'embed',
  group: 'block',
  atom: true,
  selectable: true,
  draggable: true,
  addAttributes() {
    return {
      block: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-block'),
        renderHTML: (attrs) =>
          attrs.block ? { 'data-block': attrs.block as string } : {},
      },
    }
  },
  parseHTML() {
    return [{ tag: 'div[data-embed]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['div', { 'data-embed': '', ...HTMLAttributes }]
  },
})

/**
 * Native simple-table nodes (Notion `/table`, NOT the bound `data` database) —
 * the `prosemirror-tables` family via `@tiptap/extension-table*`. Registering
 * them in the shared `docExtensions()` is what makes table cells real CRDT
 * nodes that co-edit cell-by-cell through y-prosemirror (an opaque `embed`
 * atom could not).
 *
 * Cells are restricted to `paragraph+` (rich text — marks + `@mentions` +
 * comment ranges — but no nested blocks/lists/tables, the Notion simple-table
 * model). The restriction lives HERE in the shared schema so both Yjs ends
 * derive the identical content model.
 *
 * The `tableEditing` / `columnResizing` ProseMirror plugins these extensions
 * contribute are interaction-only: `getSchema` (the server `docSchema()`)
 * ignores plugins, so they run only inside the browser Editor — no
 * schema-parity risk and no `withViewPlugins` gate needed.
 */
export const DocTableCell = TableCell.extend({ content: 'paragraph+' })
export const DocTableHeader = TableHeader.extend({ content: 'paragraph+' })

/**
 * Comment mark — anchors a Notion-style comment thread to a precise text
 * range (the `human_range` anchor in doc-comments). Carries the
 * `threadId`; the live yellow highlight + gutter badge are painted by a
 * ProseMirror decoration plugin in `apps/app-web`, not by this mark's
 * own rendering (the `data-comment` span + class are the fallback for the
 * static read-only HTML / copy-paste path).
 *
 * Reopens Lock #15 (the 4-mark cap → +1 structural mark). MUST be in this
 * shared list so it round-trips through y-prosemirror on every Yjs end.
 *
 *   - `inclusive: false` — typing at a boundary doesn't extend the comment
 *     onto the new text (the highlight stays put).
 *   - `excludes: ''` — coexists with bold/italic/code/link on the same run.
 *
 * The AI never writes this mark: AI comments are block-anchored
 * (`anchor_block_id`) and never mutate the Yjs doc. The ONLY writer is the
 * floating-toolbar "Comment" action in `apps/app-web`.
 */
export const Comment = Mark.create({
  name: 'comment',
  inclusive: false,
  excludes: '',
  addAttributes() {
    return {
      threadId: {
        default: null,
        parseHTML: (el) => el.getAttribute('data-thread-id'),
        renderHTML: (attrs) =>
          attrs.threadId ? { 'data-thread-id': attrs.threadId as string } : {},
      },
    }
  },
  parseHTML() {
    return [{ tag: 'span[data-comment]' }]
  },
  renderHTML({ HTMLAttributes }) {
    return ['span', { 'data-comment': '', class: 'doc-comment-mark', ...HTMLAttributes }, 0]
  },
})

/**
 * Global attributes layered onto the built-in + custom block nodes:
 *   - `blockId` — preserves the legacy `Block.id` so a page round-trips
 *     through the CRDT with stable ids (load-bearing for the migration and
 *     for `child_page`/data bindings).
 *   - `color` / `bgColor` — whole-block text color + background tint (the
 *     block-action menu's "Color"). Named-palette ids (e.g. `'blue'`), never
 *     hex — `apps/app-web` `globals.css` maps `data-color`/`data-bg` to
 *     theme-aware values. String attrs with a `null` default, so they
 *     round-trip safely through y-prosemirror and pre-color docs stay valid
 *     (a node lacking them loads the default → no data-attr → renders as today).
 *   - `variant` — paragraph body/muted/caption (only on paragraph).
 * `level` (heading) and `language` (codeBlock) already ship on the
 * StarterKit nodes.
 */
export const ID_NODE_TYPES = [
  'paragraph',
  'heading',
  'codeBlock',
  'blockquote',
  'horizontalRule',
  'listItem',
  'taskItem',
  'callout',
  'toggle',
  'embed',
  // The simple-table container is a top-level block: the drag handle targets
  // it, and it carries the round-trip `blockId` + block color. Rows/cells are
  // positional — they need no id.
  'table',
  // The list CONTAINERS are the top-level block the drag handle targets (the
  // handle reorders/colours the whole list, not a single item). Without an id
  // attr the container couldn't carry block color or a deep-link blockId —
  // colouring a list or copying its link would silently no-op.
  'bulletList',
  'orderedList',
  'taskList',
]

export const DocAttrs = Extension.create({
  name: 'docAttrs',
  addGlobalAttributes() {
    return [
      {
        types: ID_NODE_TYPES,
        attributes: {
          blockId: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-block-id'),
            renderHTML: (attrs) =>
              attrs.blockId ? { 'data-block-id': attrs.blockId } : {},
          },
        },
      },
      {
        // Whole-block color, on the SAME node list that carries `blockId` — so
        // both Yjs ends derive these attrs identically (byte-for-byte schema
        // parity). String ids from a named palette; the CSS lives in app-web.
        types: ID_NODE_TYPES,
        attributes: {
          color: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-color'),
            renderHTML: (attrs) =>
              attrs.color ? { 'data-color': attrs.color as string } : {},
          },
          bgColor: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-bg'),
            renderHTML: (attrs) =>
              attrs.bgColor ? { 'data-bg': attrs.bgColor as string } : {},
          },
        },
      },
      {
        types: ['paragraph'],
        attributes: {
          variant: {
            default: null,
            parseHTML: (el) => el.getAttribute('data-variant'),
            renderHTML: (attrs) =>
              attrs.variant ? { 'data-variant': attrs.variant } : {},
          },
        },
      },
    ]
  },
})

/**
 * The shared extension list. `withViewPlugins: false` drops the
 * interaction-only plugins (dropcursor/gapcursor) for headless/server use —
 * they contribute no nodes or marks, so the derived `Schema` is byte-for-byte
 * identical on both ends regardless of the flag.
 */
export function docExtensions(
  opts: { withViewPlugins?: boolean } = {},
): AnyExtension[] {
  const withViewPlugins = opts.withViewPlugins ?? true
  return [
    StarterKit.configure({
      history: false,
      // `> ` is the toggle trigger; the blockquote moves to `| ` via
      // `DocBlockquote` below. Drop StarterKit's bundled blockquote so its
      // default `> ` input rule doesn't also fire (and so its node isn't
      // registered twice). The node spec is unchanged — re-added below.
      blockquote: false,
      ...(withViewPlugins ? {} : { dropcursor: false, gapcursor: false }),
    }),
    DocBlockquote,
    // `doc-link` carries the Notion link treatment (ink text + muted underline,
    // app-web globals.css). HTMLAttributes is render-only — the mark spec is
    // unchanged, so the server-derived Yjs schema stays byte-for-byte matched.
    Link.configure({
      openOnClick: false,
      autolink: true,
      HTMLAttributes: { class: 'doc-link' },
    }),
    TaskList,
    // `nested: true` widens taskItem content to `paragraph block*` so to-dos
    // nest like Notion's (Tab on a to-do makes a sub-to-do). SCHEMA-AFFECTING:
    // both Yjs ends derive their schema from this list, so a prod rollout must
    // deploy `apps/doc-sync` and the web clients together — a stale end
    // parsing a nested taskItem desyncs the document.
    TaskItem.configure({ nested: true }),
    Callout,
    Toggle,
    Table,
    TableRow,
    DocTableHeader,
    DocTableCell,
    PersonMention,
    PageMention,
    Embed,
    Comment,
    DocAttrs,
  ]
}

let _schema: Schema | null = null

/** The ProseMirror schema, built once. Used by y-prosemirror on the server. */
export function docSchema(): Schema {
  if (!_schema) {
    _schema = getSchema(docExtensions({ withViewPlugins: false }))
  }
  return _schema
}
