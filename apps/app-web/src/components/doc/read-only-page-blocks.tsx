"use client";

/**
 * Read-only page renderer for the anonymous public-share route.
 *
 * The authed surface edits through the Tiptap collab editor; an external
 * viewer gets this static, non-interactive renderer instead — no editor,
 * no Yjs socket, no write affordances. Two inputs (index-aligned):
 *   - `blocks`  — neutralized page blocks (mentions stripped server-side,
 *     so rich text is plain StarterKit JSON; media bucket/path blanked).
 *   - `payload` — the public A2UI payload from `renderPage` (data resolved
 *     at clearance:'public', identity widgets scrubbed). `payload.root`
 *     has one child per block, so `data` / `chart` / `diagram` blocks render
 *     from `payload.root.children[i]` via `renderWidget`.
 *
 * Media (image/file) bytes come from the token-gated public media endpoint
 * — the renderer builds the URL from the token + block id; it never sees a
 * storage path.
 *
 * [COMP:app-web/share-dialog]
 */

import { Fragment, useEffect, useState, type MouseEvent, type ReactNode } from "react";
import { FileText } from "lucide-react";
import { renderWidget } from "@use-brian/views-renderer";
import type { A2UIWidget, ViewPayload } from "@use-brian/views-renderer";
import { scanStamps } from "@use-brian/shared";
import type { PublicBlock, PublicComment } from "@/lib/api/public-share";
import { publicMediaUrlFor, type PublicSource } from "@/lib/api/public-share";
import { useRecordingPlayer } from "@/lib/recordings/recording-player-context";
import {
  anchorThreadsInRichText,
  type BlockAnchor,
  type QuoteTipNode,
} from "@/lib/comment-quote-anchor";

const noop = () => {};

// ── `[H:MM:SS]` citations → seek links ────────────────────────────────
//
// The EDITOR linkifies citations with a ProseMirror decoration
// (`timecode-decoration.ts`); this renderer has no ProseMirror, so the same
// parse (`scanStamps` — the one shared scanner the transcriber / transcript
// file / synthesis prompt already agree on) runs over each text run at render.
// The chips are real anchors (`#t=<seconds>` — the Fathom convention the
// decoration also uses) styled by the same `.doc-timecode` CSS, and a click
// seeks the page's player AND pops the transcript card, mirroring the
// editor's `onSeek`. On a page with no recording (`useRecordingPlayer()`
// outside a provider, or a provider with a null id) the text renders as plain
// prose by construction — the same inert default as the editor.

/** One run of a text split on its citations. Pure + exported for the unit
 *  test (app-web's vitest is node-only; the component stays thin over it). */
export type TimecodeSegment =
  | { kind: "text"; text: string }
  | { kind: "stamp"; text: string; ms: number };

export function timecodeSegments(text: string): TimecodeSegment[] {
  const out: TimecodeSegment[] = [];
  let cursor = 0;
  for (const hit of scanStamps(text)) {
    if (hit.index > cursor) out.push({ kind: "text", text: text.slice(cursor, hit.index) });
    out.push({ kind: "stamp", text: hit.text, ms: hit.ms });
    cursor = hit.index + hit.length;
  }
  if (out.length === 0) return [{ kind: "text", text }];
  if (cursor < text.length) out.push({ kind: "text", text: text.slice(cursor) });
  return out;
}

/** A text run with its `[H:MM:SS]` citations rendered as seek chips. */
function TimecodeText({ text }: { text: string }) {
  const { recordingId, seekTo, showTranscriptAt } = useRecordingPlayer();
  if (!recordingId || !text) return <>{text}</>;
  const segments = timecodeSegments(text);
  if (segments.length === 1 && segments[0].kind === "text") return <>{text}</>;
  const onClick = (ms: number) => (e: MouseEvent<HTMLAnchorElement>) => {
    // A modified click keeps browser behavior (the href is real).
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
    e.preventDefault();
    seekTo(ms);
    showTranscriptAt(ms);
  };
  return (
    <>
      {segments.map((seg, i) =>
        seg.kind === "stamp" ? (
          <a
            key={i}
            href={`#t=${Math.floor(seg.ms / 1000)}`}
            className="doc-timecode"
            role="button"
            data-timecode-ms={seg.ms}
            onClick={onClick(seg.ms)}
          >
            {seg.text}
          </a>
        ) : (
          <Fragment key={i}>{seg.text}</Fragment>
        ),
      )}
    </>
  );
}

// ── Minimal Tiptap-JSON → React (mentions already stripped server-side) ──

type TipNode = { type?: string; text?: string; attrs?: Record<string, unknown>; marks?: Array<{ type: string; attrs?: Record<string, unknown> }>; content?: TipNode[] };

/** Only allow safe link schemes — never `javascript:` on a public page. */
function safeHref(href: unknown): string {
  if (typeof href !== "string") return "#";
  return /^(https?:|mailto:)/i.test(href.trim()) ? href : "#";
}

function plainText(node: TipNode | undefined): string {
  if (!node) return "";
  if (node.text) return node.text;
  return (node.content ?? []).map(plainText).join("");
}

function renderInline(node: TipNode, key: string): ReactNode {
  // Citations linkify at the innermost level so a bolded `[0:47:21]` still
  // seeks; inert (plain text) whenever the page carries no recording.
  let el: ReactNode = <TimecodeText text={node.text ?? ""} />;
  for (const mark of node.marks ?? []) {
    if (mark.type === "bold") el = <strong>{el}</strong>;
    else if (mark.type === "italic") el = <em>{el}</em>;
    else if (mark.type === "strike") el = <s>{el}</s>;
    else if (mark.type === "code") el = <code className="rounded bg-muted px-1 py-0.5 text-[0.9em]">{el}</code>;
    else if (mark.type === "comment") {
      // Commented text shares the editor's `.doc-comment-hl` swatch (so the
      // resting + linked-hover states match across surfaces). `data-comment-thread`
      // is what the margin rail (public-page-view) aligns each card to;
      // `data-thread-id` is what the linked-hover controller (comment-hover.ts)
      // keys on, so hovering a card here brightens its text just like the editor.
      const threadId = typeof mark.attrs?.threadId === "string" ? mark.attrs.threadId : "";
      el = (
        <span
          data-comment-thread={threadId}
          data-thread-id={threadId}
          className="doc-comment-hl"
        >
          {el}
        </span>
      );
    }
    else if (mark.type === "link")
      // `doc-link` = the shared Notion link treatment (globals.css): ink-coloured
      // text + muted underline — same class the live editor's Link mark renders,
      // so resting/hover states match across surfaces.
      el = (
        <a
          href={safeHref(mark.attrs?.href)}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="doc-link"
        >
          {el}
        </a>
      );
  }
  return <span key={key}>{el}</span>;
}

function renderNodes(nodes: TipNode[] | undefined, kp: string): ReactNode {
  return (nodes ?? []).map((n, i) => renderNode(n, `${kp}.${i}`));
}

/**
 * Render a toggle (both the `toggle` BLOCK and nested inline `toggle` nodes):
 * the first paragraph is the clickable summary (rendered INLINE next to the
 * disclosure triangle — a block `<p>` here is what broke the layout), the rest
 * is the collapsible body. On the shared/public page every toggle renders
 * COLLAPSED by default — the authored `open`/`expanded` state is intentionally
 * ignored so a shared page reads scannable; the native `<details>` stays
 * togglable, so a viewer can still expand any toggle. CSS
 * (`.doc-public-body summary`) supplies the triangle + hover.
 */
function renderToggle(
  content: TipNode[] | undefined,
  key: string,
  /** Structured `children` blocks (the toggle child model) — rendered in the
   *  body after any legacy richText body nodes. */
  childBlocks?: ReactNode,
  /** Root attributes for a toggle BLOCK (`data-block-id` + an unplaced-thread
   *  tint); nested inline toggles pass none. */
  rootProps?: RootProps,
): ReactNode {
  const nodes = content ?? [];
  const head = nodes[0];
  const summary =
    head?.type === "paragraph"
      ? renderNodes(head.content, `${key}.s`)
      : head
        ? renderNode(head, `${key}.s`)
        : null;
  const body = nodes.slice(1);
  const hasBody = body.length > 0 || !!childBlocks;
  return (
    <details key={key} {...rootProps} className={cx("doc-toggle", rootProps?.className)}>
      <summary>
        <span className="doc-toggle-summary">{summary}</span>
      </summary>
      {hasBody ? (
        <div className="doc-toggle-body">
          {body.length > 0 ? renderNodes(body, `${key}.b`) : null}
          {childBlocks}
        </div>
      ) : null}
    </details>
  );
}

function renderNode(node: TipNode, key: string): ReactNode {
  switch (node.type) {
    case "paragraph":
      return <p key={key}>{renderNodes(node.content, key)}</p>;
    case "toggle":
      return renderToggle(node.content, key);
    case "heading": {
      const lvl = Math.min(Math.max(Number(node.attrs?.level ?? 2), 1), 4);
      const Tag = `h${lvl}` as "h1" | "h2" | "h3" | "h4";
      return <Tag key={key}>{renderNodes(node.content, key)}</Tag>;
    }
    case "bulletList":
      // No list-style class — `.doc-public-body` CSS sets depth-cycling
      // markers (disc/circle/square) so nesting reads like the editor.
      return <ul key={key}>{renderNodes(node.content, key)}</ul>;
    case "orderedList":
      return <ol key={key}>{renderNodes(node.content, key)}</ol>;
    case "listItem":
      return <li key={key}>{renderNodes(node.content, key)}</li>;
    case "blockquote":
      return <blockquote key={key} className="border-l-2 border-border pl-3 text-muted-foreground">{renderNodes(node.content, key)}</blockquote>;
    case "codeBlock":
      return <pre key={key} className="overflow-x-auto rounded-md bg-muted p-3 text-sm"><code>{plainText(node)}</code></pre>;
    case "horizontalRule":
      return <hr key={key} className="my-4 border-border" />;
    case "hardBreak":
      return <br key={key} />;
    case "text":
      return renderInline(node, key);
    default:
      return node.content ? <span key={key}>{renderNodes(node.content, key)}</span> : null;
  }
}

/** Render opaque rich-text JSON (a Tiptap doc) to React. `anchors` are the
 *  threads anchored to the owning block: those without an inline `comment`
 *  mark get one injected over their quote (`anchorThreadsInRichText`), so a
 *  guest's range comment highlights exactly what they selected. Threads whose
 *  quote is gone are the caller's whole-block fallback (`anchorRich`). */
function RichText({ value, anchors }: { value: unknown; anchors?: BlockAnchor[] }) {
  const doc = value as TipNode | undefined;
  if (!doc) return null;
  const nodes = anchors && anchors.length > 0 ? anchorRich(doc, anchors).nodes : doc.content;
  return <>{renderNodes(nodes, "rt")}</>;
}

/** Anchor `anchors` into a rich-text doc: the marked/quote-placed nodes plus the
 *  threads that found no home (→ whole-block tint). Pure. */
function anchorRich(
  value: unknown,
  anchors: BlockAnchor[],
): { nodes: TipNode[]; unplaced: BlockAnchor[] } {
  const doc = value as TipNode | undefined;
  const r = anchorThreadsInRichText(doc?.content as QuoteTipNode[] | undefined, anchors);
  return { nodes: r.nodes as TipNode[], unplaced: r.unplaced };
}

/** `className` join that drops falsy parts. */
function cx(...parts: Array<string | undefined | false>): string | undefined {
  const s = parts.filter(Boolean).join(" ");
  return s || undefined;
}

/** Attributes every block root carries: `data-block-id` (what the public
 *  guest-comment selection resolves a selection to — `guest-comment-selection.ts`)
 *  plus, when a thread anchored here could not be placed inline (no mark, quote
 *  gone — or a textless block), the whole-block tint + rail anchor. */
type RootProps = {
  "data-block-id"?: string;
  "data-comment-thread"?: string;
  "data-thread-id"?: string;
  className?: string;
};
function rootProps(block: PublicBlock, unplaced: ReadonlyArray<BlockAnchor> = []): RootProps {
  const out: RootProps = {};
  if (block.id) out["data-block-id"] = block.id;
  const tint = unplaced[0]?.threadId;
  if (tint) {
    out["data-comment-thread"] = tint;
    out["data-thread-id"] = tint;
    out.className = "doc-comment-block-hl";
  }
  return out;
}

// ── Nested list rendering (Block[] path) ──────────────────────────────
//
// `bulleted_list_item` / `numbered_list_item` carry an optional 0-based `indent`
// (to-dos carry it too, rendered with a per-level inset in their own case
// below). Rebuild the same nested `<ul>`/`<ol>` tree the editor
// shows: clamp depths so a child is at most one level under its parent, fold the
// flat run into a tree, then render — grouping consecutive same-kind siblings at
// each level so numbers sequence and markers cycle (1→a→i, disc→circle→square)
// via the `.doc-public-body` CSS. Mirrors `@use-brian/doc-model` `blocksToPMDoc`.

type ListNode = { block: PublicBlock; children: ListNode[] };

function rawListIndent(b: PublicBlock): number {
  const indent = (b as { indent?: unknown }).indent;
  return typeof indent === "number" && indent > 0 ? Math.floor(indent) : 0;
}

function foldListTree(run: PublicBlock[]): ListNode[] {
  const roots: ListNode[] = [];
  const stack: ListNode[] = []; // stack[d] = the open parent at depth d
  let maxAllowed = 0;
  for (const block of run) {
    const d = Math.min(rawListIndent(block), maxAllowed);
    maxAllowed = d + 1;
    const node: ListNode = { block, children: [] };
    if (d === 0 || !stack[d - 1]) roots.push(node);
    else stack[d - 1].children.push(node);
    stack.length = d;
    stack[d] = node;
  }
  return roots;
}

function renderListNodes(
  nodes: ListNode[],
  keyPrefix: string,
  anchors: AnchorMap = EMPTY_ANCHORS,
): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    const kind = nodes[i].block.kind;
    const group: ListNode[] = [];
    while (i < nodes.length && nodes[i].block.kind === kind) group.push(nodes[i++]);
    const items = group.map((n, j) => {
      const a = anchors.get(n.block.id) ?? [];
      const rich = a.length > 0 ? anchorRich(n.block.richText, a) : null;
      return (
        <li key={n.block.id || `${keyPrefix}-${j}`} {...rootProps(n.block, rich?.unplaced)}>
          {rich ? renderNodes(rich.nodes, "rt") : <RichText value={n.block.richText} />}
          {n.children.length > 0 ? renderListNodes(n.children, `${keyPrefix}-${j}`, anchors) : null}
        </li>
      );
    });
    out.push(
      kind === "numbered_list_item" ? (
        <ol key={`${keyPrefix}-ol-${i}`}>{items}</ol>
      ) : (
        <ul key={`${keyPrefix}-ul-${i}`}>{items}</ul>
      ),
    );
  }
  return out;
}

// ── Comment anchors (block-id + quote based) ──────────────────────────
//
// A comment's inline `comment` mark survives serialization only for rich-text
// blocks (callout / quote / list / to_do / toggle / table cells) — there the
// mark rides inside the block's opaque Tiptap `richText`, so `renderInline`
// emits the `.doc-comment-hl` swatch + `data-comment-thread` rail anchor for it.
// Two cases arrive with NO mark to paint: a `heading` / `text` block serializes
// to a FLAT `text` string (block-mapping `inlineText` drops every inline mark),
// and a GUEST's range comment from the public page never had one (a guest can't
// write the Yjs doc — the thread persists only `anchorBlockId` + `quote`).
// Both re-anchor the same way (`comment-quote-anchor.ts`): find the thread's
// `quote` inside the block's text and paint exactly that range; a quote that no
// longer occurs falls back to the whole block — an inline swatch over a
// text-bearing block's text, a whole-block tint for a commented atom (chart /
// image / … — no inline text to mark), mirroring the editor's
// `buildDecorations` (comment-decorations.ts) so both surfaces match.

/** Rich-text block kinds — `richText` carries marks, and quote anchors are
 *  injected into it (`RichText anchors=`); never double-anchor them outside. */
const RICH_TEXT_KINDS = new Set([
  "callout",
  "quote",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "table",
]);
/** Plain-text block kinds — flattened to `text`, anchored by quote over that
 *  string (handled in `BlockView`, not the atom wrapper). */
const PLAIN_TEXT_KINDS = new Set(["heading", "text"]);

/** blockId → the threads anchored there, in thread order. */
export type AnchorMap = Map<string, BlockAnchor[]>;
const EMPTY_ANCHORS: AnchorMap = new Map();

/** blockId → every thread anchored to that block (document order of the
 *  threads list). Each thread keeps its `quote` so the renderer can place it
 *  precisely; several threads may anchor one block (each on its own quote).
 *  Pure + exported for unit testing. */
export function commentAnchorsByBlock(
  comments: ReadonlyArray<{ threadId: string; anchorBlockId: string | null; quote?: string | null }>,
): AnchorMap {
  const map: AnchorMap = new Map();
  for (const c of comments) {
    if (!c.anchorBlockId) continue;
    const list = map.get(c.anchorBlockId) ?? [];
    list.push({ threadId: c.threadId, quote: c.quote ?? null });
    map.set(c.anchorBlockId, list);
  }
  return map;
}

/** A plain-text block's text with its anchored threads painted: a thread whose
 *  quote occurs in the text gets the swatch over exactly that run; one whose
 *  quote is absent (or null) wraps the whole text. `data-comment-thread` is
 *  what the share rail aligns each card to; `data-thread-id` wires the linked
 *  hover (comment-hover.ts). */
function commentedText(text: string, anchors: ReadonlyArray<BlockAnchor> | undefined): ReactNode {
  if (!anchors || anchors.length === 0 || !text) return <TimecodeText text={text} />;
  const { nodes, unplaced } = anchorThreadsInRichText([{ type: "text", text }], anchors);
  let el: ReactNode = <>{renderNodes(nodes as TipNode[], "pt")}</>;
  for (const a of unplaced) {
    el = (
      <span data-comment-thread={a.threadId} data-thread-id={a.threadId} className="doc-comment-hl">
        {el}
      </span>
    );
  }
  return el;
}

// ── Block dispatch ────────────────────────────────────────────────────

/**
 * Render a container's structured `children` blocks (the toggle/callout child
 * model): bulleted/numbered runs group into nested `<ul>`/`<ol>` exactly like
 * the top level; every other child renders through `BlockView` (no A2UI
 * widget — a public child carries no live-data binding payload). Returns
 * null when the block has no children, so legacy richText-only containers
 * render unchanged.
 */
function renderChildBlocks(
  block: PublicBlock,
  source: PublicSource,
  mounted: boolean,
  paths?: Record<string, string>,
  anchors: AnchorMap = EMPTY_ANCHORS,
): ReactNode {
  const children = (block as { children?: PublicBlock[] }).children;
  if (!Array.isArray(children) || children.length === 0) return null;
  const out: ReactNode[] = [];
  let i = 0;
  while (i < children.length) {
    const kind = children[i].kind;
    if (kind === "bulleted_list_item" || kind === "numbered_list_item") {
      const run: PublicBlock[] = [];
      while (
        i < children.length &&
        (children[i].kind === "bulleted_list_item" ||
          children[i].kind === "numbered_list_item")
      ) {
        run.push(children[i]);
        i++;
      }
      out.push(...renderListNodes(foldListTree(run), `${block.id}-cl-${i}`, anchors));
      continue;
    }
    const child = children[i];
    out.push(
      <Fragment key={child.id || `${block.id}-c${i}`}>
        <BlockView
          block={child}
          widget={undefined}
          source={source}
          mounted={mounted}
          paths={paths}
          anchors={anchors.get(child.id)}
          anchorMap={anchors}
        />
      </Fragment>,
    );
    i++;
  }
  return <>{out}</>;
}

function BlockView({
  block,
  widget,
  source,
  mounted,
  anchors,
  anchorMap = EMPTY_ANCHORS,
  paths,
}: {
  block: PublicBlock;
  widget: A2UIWidget | undefined;
  source: PublicSource;
  mounted: boolean;
  /** Custom-domain (site) sources only: canonical site path per page id. */
  paths?: Record<string, string>;
  /** Threads anchored to THIS block (text-bearing kinds paint them inline over
   *  the quote / whole text; atoms are tinted by the caller). */
  anchors?: BlockAnchor[];
  /** The whole page's anchor map — for the block's structured `children`. */
  anchorMap?: AnchorMap;
}) {
  const a = anchors ?? [];
  const root = rootProps(block);
  switch (block.kind) {
    case "heading": {
      const lvl = Math.min(Math.max(Number(block.level ?? 2), 1), 4);
      const Tag = `h${lvl}` as "h1" | "h2" | "h3" | "h4";
      return <Tag {...root}>{commentedText(String(block.text ?? ""), a)}</Tag>;
    }
    case "text": {
      const variant = block.variant === "muted" ? "text-muted-foreground" : undefined;
      return (
        <p {...root} className={cx(variant, root.className)}>
          {commentedText(String(block.text ?? ""), a)}
        </p>
      );
    }
    case "divider":
      return <hr {...root} className={cx("my-4 border-border", root.className)} />;
    case "code": {
      // No inline run to paint inside a code block → an anchored thread tints it.
      const r = rootProps(block, a);
      return (
        <pre {...r} className={cx("overflow-x-auto rounded-md bg-muted p-3 text-sm", r.className)}>
          <code>{String(block.code ?? "")}</code>
        </pre>
      );
    }
    case "quote": {
      const rich = anchorRich(block.richText, a);
      const r = rootProps(block, rich.unplaced);
      return (
        <blockquote {...r} className={cx("border-l-2 border-border pl-3 text-muted-foreground", r.className)}>
          {renderNodes(rich.nodes, "rt")}
        </blockquote>
      );
    }
    case "callout": {
      const rich = anchorRich(block.richText, a);
      const r = rootProps(block, rich.unplaced);
      return (
        <div
          {...r}
          className={cx("flex gap-3 rounded-md border border-border bg-muted/40 px-3 py-2", r.className)}
        >
          <div className="flex-shrink-0 pt-[2px] text-lg leading-none">{String(block.icon ?? "💡")}</div>
          <div className="min-w-0 flex-1">
            {renderNodes(rich.nodes, "rt")}
            {renderChildBlocks(block, source, mounted, paths, anchorMap)}
          </div>
        </div>
      );
    }
    // bulleted_list_item / numbered_list_item are grouped into real <ul>/<ol>
    // by ReadOnlyPageBlocks (so numbers sequence + nesting markers cycle).
    case "to_do": {
      // Nested to-dos carry `indent` — mirror the editor's pitch with a
      // per-level inset (the public view has no taskList wrapper to nest).
      const indent = typeof block.indent === "number" && block.indent > 0 ? block.indent : 0;
      // The checkbox sits in a one-line-tall band (`h-7` == the body's
      // `leading-7`) and centres inside it, so it lands on the first text line
      // and STAYS there when the row wraps — the editor's task row does the
      // same with `calc(1.5em + 6px)`. The empty `<span>` is the tick (masked in
      // `.doc-todo-check`, globals.css), mirroring the span Tiptap's TaskItem
      // node view renders, so a published to-do renders the same control as the
      // editor it was authored in.
      const rich = anchorRich(block.richText, a);
      const r = rootProps(block, rich.unplaced);
      return (
        <label
          {...r}
          className={cx("flex items-start gap-2", r.className)}
          style={indent ? { marginLeft: indent * 24 } : undefined}
        >
          <span className="doc-todo-check grid h-7 flex-none place-items-center">
            <input type="checkbox" checked={Boolean(block.checked)} readOnly disabled />
            <span />
          </span>
          <div
            className={`min-w-0 flex-1${
              block.checked ? " text-muted-foreground line-through" : ""
            }`}
          >
            {renderNodes(rich.nodes, "rt")}
          </div>
        </label>
      );
    }
    case "toggle": {
      const rich = anchorRich(block.richText, a);
      return renderToggle(
        rich.nodes,
        block.id,
        renderChildBlocks(block, source, mounted, paths, anchorMap),
        rootProps(block, rich.unplaced),
      );
    }
    case "table": {
      // Native simple table — cells are rich text (mentions already scrubbed
      // server-side). Header row/column map to <th>; everything else <td>.
      const rows = Array.isArray(block.rows) ? (block.rows as unknown[][]) : [];
      if (rows.length === 0) return null;
      const hasHeaderRow = block.hasHeaderRow === true;
      const hasHeaderColumn = block.hasHeaderColumn === true;
      // Anchor threads cell by cell in reading order: a thread placed (or
      // already marked) in an earlier cell is not re-tried in later ones; what
      // no cell can place tints the whole table.
      let pending: BlockAnchor[] = a;
      const cells = rows.map((row) =>
        (Array.isArray(row) ? row : []).map((cellValue) => {
          if (pending.length === 0) return { value: cellValue, nodes: null as TipNode[] | null };
          const rich = anchorRich(cellValue, pending);
          pending = rich.unplaced;
          return { value: cellValue, nodes: rich.nodes };
        }),
      );
      const rp = rootProps(block, pending);
      return (
        <div {...rp} className={cx("doc-public-table-wrap my-2 overflow-x-auto", rp.className)}>
          <table className="doc-public-table">
            <tbody>
              {cells.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => {
                    const isHeader =
                      (hasHeaderRow && r === 0) || (hasHeaderColumn && c === 0);
                    const Cell = isHeader ? "th" : "td";
                    return (
                      <Cell key={c}>
                        {cell.nodes ? renderNodes(cell.nodes, "rt") : <RichText value={cell.value} />}
                      </Cell>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    }
    case "image": {
      const ref = block.ref as { name?: string } | null;
      if (!ref) return null;
      const alt = typeof block.alt === "string" ? block.alt : (ref.name ?? "");
      return (
        <figure {...root} className={cx("my-2", root.className)}>
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={publicMediaUrlFor(source, block.id)} alt={alt} className="max-w-full rounded-md" loading="lazy" />
          {typeof block.caption === "string" && block.caption ? (
            <figcaption className="mt-1 text-sm text-muted-foreground">{block.caption}</figcaption>
          ) : null}
        </figure>
      );
    }
    case "file": {
      const ref = block.ref as { name?: string } | null;
      if (!ref) return null;
      return (
        <a
          {...root}
          href={publicMediaUrlFor(source, block.id)}
          target="_blank"
          rel="noopener noreferrer"
          className={cx(
            "inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted",
            root.className,
          )}
        >
          {ref.name ?? "Download file"}
        </a>
      );
    }
    case "bookmark": {
      const url = typeof block.url === "string" ? block.url : "";
      const meta = block.meta as { title?: string; description?: string } | undefined;
      if (!url) return null;
      return (
        <a
          {...root}
          href={safeHref(url)}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className={cx("block rounded-md border border-border px-3 py-2 hover:bg-muted", root.className)}
        >
          <div className="font-medium">{meta?.title ?? url}</div>
          {meta?.description ? <div className="text-sm text-muted-foreground">{meta.description}</div> : null}
        </a>
      );
    }
    case "child_page": {
      // Subtree cascade: the server resolves a title for children inside the
      // shared subtree (`via:'subtree'`) or independently published
      // (`via:'published'`); anything else arrives with a blanked id + no
      // title → render nothing. The href follows `via`: a published source
      // always uses the universal URL; a link source keeps subtree children
      // inside the token context (`/share/<token>/p/<id>`) and sends
      // independently-published targets to their universal URL.
      const childId = typeof block.childPageId === "string" ? block.childPageId : "";
      const title = typeof block.title === "string" ? block.title : "";
      if (!childId || !title) return null;
      const emoji = typeof block.icon === "string" && block.icon ? block.icon : null;
      const href =
        source.kind === "site"
          ? (paths?.[childId] ?? `/p/${encodeURIComponent(childId)}`)
          : source.kind === "link" && block.via === "subtree"
            ? `/share/${encodeURIComponent(source.token)}/p/${encodeURIComponent(childId)}`
            : `/share/p/${encodeURIComponent(childId)}`;
      return (
        <a
          {...root}
          href={href}
          className={cx(
            "flex items-center gap-2 rounded-md py-1 font-medium underline-offset-4 hover:underline",
            root.className,
          )}
        >
          {emoji ? (
            <span className="text-lg leading-none" aria-hidden>{emoji}</span>
          ) : (
            <FileText className="size-[1.1em] shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span className="min-w-0 truncate">{title}</span>
        </a>
      );
    }
    case "data":
    case "chart":
    case "diagram":
      // Client-only: chart/diagram widgets touch `window` at render, so we
      // skip them during SSR and paint after mount.
      return mounted && widget ? (
        <div {...root} className={cx("my-2", root.className)}>
          {renderWidget(widget, noop)}
        </div>
      ) : null;
    // video / audio URLs are blanked server-side. Nothing to render.
    default:
      return null;
  }
}

export function ReadOnlyPageBlocks({
  blocks,
  payload,
  source,
  comments = [],
  paths,
}: {
  blocks: PublicBlock[];
  payload: ViewPayload;
  source: PublicSource;
  /** Custom-domain (site) sources only: canonical site path per page id
   *  (child_page links). See docs/architecture/features/custom-domains.md. */
  paths?: Record<string, string>;
  /** Page comment threads — used to rebuild each block's highlight + rail anchor
   *  from `anchorBlockId` (the inline `comment` mark is lost for heading / text
   *  blocks once they serialize to a flat `text` string). */
  comments?: PublicComment[];
}) {
  const root = payload?.root as { children?: A2UIWidget[] } | undefined;
  const children = root?.children ?? [];
  const anchors = commentAnchorsByBlock(comments);
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  // Group consecutive list-item blocks into a real <ul>/<ol> so numbered items
  // sequence (1, 2, 3) and nesting markers cycle (1→a→i, disc→circle→square),
  // mirroring the editor. Non-list blocks render 1:1 with their A2UI widget.
  const out: ReactNode[] = [];
  let i = 0;
  while (i < blocks.length) {
    const kind = blocks[i].kind;
    if (kind === "bulleted_list_item" || kind === "numbered_list_item") {
      // Consume the whole bulleted/numbered run (across kinds, so a numbered
      // sub-list under a bullet groups together) and render it as a nested tree.
      const run: PublicBlock[] = [];
      while (
        i < blocks.length &&
        (blocks[i].kind === "bulleted_list_item" || blocks[i].kind === "numbered_list_item")
      ) {
        run.push(blocks[i]);
        i++;
      }
      out.push(...renderListNodes(foldListTree(run), `list-${i}`, anchors));
    } else {
      const block = blocks[i];
      const key = block.id || String(i);
      const blockAnchors = anchors.get(block.id);
      const threadId = blockAnchors?.[0]?.threadId;
      const blockEl = (
        <BlockView
          block={block}
          widget={children[i]}
          source={source}
          mounted={mounted}
          anchors={blockAnchors}
          anchorMap={anchors}
          paths={paths}
        />
      );
      // An anchored atom (chart / image / file / … — no inline text to carry the
      // swatch; text-bearing kinds paint their own inline swatch / tint inside
      // `BlockView`) gets a whole-block tint + rail anchor, mirroring the
      // editor's textless-block `doc-comment-block-hl`.
      const atomAnchor =
        !!threadId &&
        !RICH_TEXT_KINDS.has(block.kind) &&
        !PLAIN_TEXT_KINDS.has(block.kind) &&
        block.kind !== "code";
      out.push(
        atomAnchor ? (
          <div
            key={key}
            data-comment-thread={threadId}
            data-thread-id={threadId}
            className="doc-comment-block-hl"
          >
            {blockEl}
          </div>
        ) : (
          <Fragment key={key}>{blockEl}</Fragment>
        ),
      );
      i++;
    }
  }

  return <div className="doc-public-body text-[15px] leading-7 text-foreground">{out}</div>;
}
