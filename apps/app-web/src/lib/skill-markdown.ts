/**
 * Markdown ⇄ ProseMirror round-trip for the skill body editor
 * (`components/brain/skill-body-editor.tsx`).
 *
 * The skill editor edits `workspace_skills.content` — a PLAIN MARKDOWN
 * string (zero backend change) — through one Tiptap document restricted to
 * the markdown-representable block set:
 *
 *   nodes: paragraph, heading 1-3, bulletList / orderedList / listItem,
 *          blockquote, codeBlock, horizontalRule, hardBreak
 *   marks: bold, italic, code, strike, link
 *
 * Built on prosemirror-markdown (re-exported via `@tiptap/pm/markdown`),
 * trimmed + re-keyed to the TIPTAP schema names. The tokenizer is the
 * default parser's markdown-it instance (commonmark, html:false — pnpm's
 * strict layout makes markdown-it itself unresolvable here) with two rule
 * tweaks applied once at module init: `strikethrough` enabled (for `~~`)
 * and `image` disabled. Nothing else in this app touches
 * `defaultMarkdownParser`, so the shared-instance mutation is contained.
 *
 * STABILITY CONTRACT (what the tests pin):
 *   - Canonical markdown of every enabled construct round-trips parse →
 *     serialize as IDENTITY (no diff noise; `buildSkillPatch` must never see
 *     phantom changes from an untouched body).
 *   - ANY input is a fixed point after ONE pass:
 *     `serialize(parse(serialize(parse(md)))) === serialize(parse(md))`.
 *
 * UNKNOWN-MD BEHAVIOR (content the schema can't represent — preserved as
 * text, never silently destroyed, but structure may flatten on the FIRST
 * EDIT; an untouched body is never rewritten because the page only adopts
 * the editor's serialization after a real user edit):
 *   - Tables (commonmark has no table rule): each line parses as paragraph
 *     text; soft line breaks join with spaces, so a table flattens to one
 *     paragraph of its literal `| a | b |` source.
 *   - Images (`image` rule disabled): `![alt](url)` survives as a literal
 *     `!` + the link — serialized as `\![alt](url)` (the `!` gets escaped),
 *     clickable and lossless.
 *   - Raw HTML (html:false): kept as literal text.
 *   - Task syntax `- [ ]` (no markdown-it plugin available; see the
 *     component header): parses as a plain bullet whose text starts with
 *     the literal brackets — serialized with the brackets escaped
 *     (`- \[ \] …`).
 *   - A parser throw (defensive; should be unreachable with the rule set
 *     above) falls back to the whole input inside one code block.
 *
 * [COMP:app-web/skill-body-editor]
 */

import { getSchema } from "@tiptap/core";
import type { AnyExtension } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Link from "@tiptap/extension-link";
import {
  MarkdownParser,
  MarkdownSerializer,
  defaultMarkdownParser,
  defaultMarkdownSerializer,
} from "@tiptap/pm/markdown";
import type { Node as PMNode } from "@tiptap/pm/model";

/** Hard cap mirrored from `POST/PATCH /api/skills` validation. The editor
 *  surfaces a counter past `SKILL_BODY_WARN_AT` and blocks Save past the max
 *  (fail before the wire). */
export const SKILL_BODY_MAX_CHARS = 5000;
export const SKILL_BODY_WARN_AT = 4000;

/**
 * The schema-bearing extensions — ONE list shared by this module's parser/
 * serializer schema and the live editor, so the two can never drift.
 * (StarterKit's history/dropcursor/gapcursor are plugin-only and contribute
 * nothing to the schema; heading levels cap at 3 — deeper md headings clamp
 * on parse.)
 */
export const skillBodySchemaExtensions: AnyExtension[] = [
  StarterKit.configure({ heading: { levels: [1, 2, 3] } }),
  Link.configure({ openOnClick: false, autolink: true }),
];

const schema = getSchema(skillBodySchemaExtensions);

// The default parser's markdown-it instance (commonmark preset, html:false),
// with the two rule tweaks described in the header.
const tokenizer = defaultMarkdownParser.tokenizer;
tokenizer.enable("strikethrough", true);
tokenizer.disable("image", true);

/** markdown-it token name → Tiptap node/mark spec (the default parser's
 *  table, re-keyed to Tiptap's camelCase schema names). */
const parser = new MarkdownParser(schema, tokenizer, {
  blockquote: { block: "blockquote" },
  paragraph: { block: "paragraph" },
  list_item: { block: "listItem" },
  bullet_list: { block: "bulletList" },
  ordered_list: {
    block: "orderedList",
    getAttrs: (tok) => ({ start: Number(tok.attrGet("start")) || 1 }),
  },
  heading: {
    block: "heading",
    // `#### h4`+ clamps to the schema's deepest level.
    getAttrs: (tok) => ({ level: Math.min(Number(tok.tag.slice(1)), 3) }),
  },
  code_block: { block: "codeBlock", noCloseToken: true },
  fence: {
    block: "codeBlock",
    getAttrs: (tok) => ({ language: tok.info || null }),
    noCloseToken: true,
  },
  hr: { node: "horizontalRule" },
  hardbreak: { node: "hardBreak" },
  s: { mark: "strike" },
  em: { mark: "italic" },
  strong: { mark: "bold" },
  link: {
    mark: "link",
    getAttrs: (tok) => ({
      href: tok.attrGet("href"),
      title: tok.attrGet("title") || null,
    }),
  },
  code_inline: { mark: "code", noCloseToken: true },
});

const base = defaultMarkdownSerializer;

const serializer = new MarkdownSerializer(
  {
    paragraph: base.nodes.paragraph,
    heading: (state, node) => {
      state.write("#".repeat(node.attrs.level) + " ");
      state.renderInline(node, false);
      state.closeBlock(node);
    },
    blockquote: base.nodes.blockquote,
    codeBlock: (state, node) => {
      // Pick a fence longer than any backtick run inside the block (the
      // default code_block behavior, re-keyed for Tiptap's `language` attr).
      const backticks = node.textContent.match(/`{3,}/gm);
      const fence = backticks ? backticks.sort().slice(-1)[0] + "`" : "```";
      state.write(fence + (node.attrs.language || "") + "\n");
      state.text(node.textContent, false);
      state.write("\n");
      state.write(fence);
      state.closeBlock(node);
    },
    // `- ` bullets (the default serializer's `*` would normalize every
    // typical skill body on first edit).
    bulletList: (state, node) => state.renderList(node, "  ", () => "- "),
    orderedList: (state, node) => {
      const start = node.attrs.start || 1;
      const maxW = String(start + node.childCount - 1).length;
      const space = " ".repeat(maxW + 2);
      state.renderList(node, space, (i) => {
        const nStr = String(start + i);
        return nStr + ". ".padEnd(maxW - nStr.length + 2);
      });
    },
    listItem: base.nodes.list_item,
    horizontalRule: (state, node) => {
      state.write("---");
      state.closeBlock(node);
    },
    hardBreak: base.nodes.hard_break,
    text: base.nodes.text,
  },
  {
    bold: base.marks.strong,
    italic: base.marks.em,
    code: base.marks.code,
    strike: { open: "~~", close: "~~", mixable: true, expelEnclosingWhitespace: true },
    link: base.marks.link,
  },
);

/**
 * Parse a markdown string into a ProseMirror doc on the restricted schema.
 * Never throws: a parser failure (defensive) preserves the whole input
 * inside one code block instead of losing it.
 */
export function markdownToDoc(md: string): PMNode {
  try {
    return parser.parse(md ?? "");
  } catch {
    const fallback = schema.nodes.codeBlock.createChecked(
      null,
      md ? [schema.text(md)] : [],
    );
    return schema.topNodeType.createChecked(null, [fallback]);
  }
}

/** Serialize a doc back to markdown. `tightLists` keeps list items on
 *  adjacent lines — the canonical skill-body shape. */
export function docToMarkdown(doc: PMNode): string {
  return serializer.serialize(doc, { tightLists: true });
}
