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

import { Fragment, useEffect, useState, type ReactNode } from "react";
import { FileText } from "lucide-react";
import { renderWidget } from "@sidanclaw/views-renderer";
import type { A2UIWidget, ViewPayload } from "@sidanclaw/views-renderer";
import type { PublicBlock, PublicComment } from "@/lib/api/public-share";
import { publicMediaUrlFor, type PublicSource } from "@/lib/api/public-share";

const noop = () => {};

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
  let el: ReactNode = node.text ?? "";
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
    <details key={key} className="doc-toggle">
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

/** Render opaque rich-text JSON (a Tiptap doc) to React. */
function RichText({ value }: { value: unknown }) {
  const doc = value as TipNode | undefined;
  if (!doc) return null;
  return <>{renderNodes(doc.content, "rt")}</>;
}

// ── Nested list rendering (Block[] path) ──────────────────────────────
//
// `bulleted_list_item` / `numbered_list_item` carry an optional 0-based `indent`
// (to-dos carry it too, rendered with a per-level inset in their own case
// below). Rebuild the same nested `<ul>`/`<ol>` tree the editor
// shows: clamp depths so a child is at most one level under its parent, fold the
// flat run into a tree, then render — grouping consecutive same-kind siblings at
// each level so numbers sequence and markers cycle (1→a→i, disc→circle→square)
// via the `.doc-public-body` CSS. Mirrors `@sidanclaw/doc-model` `blocksToPMDoc`.

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

function renderListNodes(nodes: ListNode[], keyPrefix: string): ReactNode[] {
  const out: ReactNode[] = [];
  let i = 0;
  while (i < nodes.length) {
    const kind = nodes[i].block.kind;
    const group: ListNode[] = [];
    while (i < nodes.length && nodes[i].block.kind === kind) group.push(nodes[i++]);
    const items = group.map((n, j) => (
      <li key={n.block.id || `${keyPrefix}-${j}`}>
        <RichText value={n.block.richText} />
        {n.children.length > 0 ? renderListNodes(n.children, `${keyPrefix}-${j}`) : null}
      </li>
    ));
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

// ── Comment anchors (block-id based) ──────────────────────────────────
//
// A comment's inline `comment` mark survives serialization only for rich-text
// blocks (callout / quote / list / to_do / toggle / table cells) — there the
// mark rides inside the block's opaque Tiptap `richText`, so `renderInline`
// emits the `.doc-comment-hl` swatch + `data-comment-thread` rail anchor for it.
// A `heading` / `text` block, though, serializes to a FLAT `text` string
// (block-mapping `inlineText` drops every inline mark), so its comment mark is
// gone by the time the public render runs — the highlight + rail anchor would
// silently vanish, and the rail card then parks at the top, detached from its
// line. Rebuild the anchor from the thread's `anchorBlockId` instead: that points
// at the block id (`block.id` ↔ the PM node's `blockId`), which is intact. A
// text-bearing block gets the inline swatch over its text; a commented atom
// (chart / image / … — no inline text to mark) gets a whole-block tint, mirroring
// the editor's `buildDecorations` (comment-decorations.ts) so both surfaces match.

/** Rich-text block kinds — their comment mark survives in `richText`, so
 *  `renderInline` already emits the anchor; never double-anchor them here. */
const RICH_TEXT_KINDS = new Set([
  "callout",
  "quote",
  "bulleted_list_item",
  "numbered_list_item",
  "to_do",
  "toggle",
  "table",
]);
/** Plain-text block kinds — flattened to `text`, so they get an inline swatch
 *  rebuilt from `anchorBlockId` (handled in `BlockView`, not the atom wrapper). */
const PLAIN_TEXT_KINDS = new Set(["heading", "text"]);

/** blockId → threadId for every block-anchored comment thread. First thread
 *  wins if several anchor one block: the rail aligns one card per thread, and a
 *  plain-text block carries only one inline anchor span, so any extra threads on
 *  the same block fall back to the top-stacked position (rare; acceptable). Pure
 *  + exported for unit testing. */
export function commentAnchorsByBlock(
  comments: ReadonlyArray<{ threadId: string; anchorBlockId: string | null }>,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const c of comments) {
    if (c.anchorBlockId && !map.has(c.anchorBlockId)) map.set(c.anchorBlockId, c.threadId);
  }
  return map;
}

/** A plain-text block's text, wrapped in the comment swatch + rail anchor when a
 *  thread is anchored to the block. `data-comment-thread` is what the share rail
 *  aligns each card to; `data-thread-id` wires the linked hover (comment-hover.ts).
 *  Mirrors the editor's inline highlight over a text-bearing block. */
function commentedText(text: string, threadId: string | undefined): ReactNode {
  if (!threadId || !text) return text;
  return (
    <span data-comment-thread={threadId} data-thread-id={threadId} className="doc-comment-hl">
      {text}
    </span>
  );
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
      out.push(...renderListNodes(foldListTree(run), `${block.id}-cl-${i}`));
      continue;
    }
    const child = children[i];
    out.push(
      <Fragment key={child.id || `${block.id}-c${i}`}>
        <BlockView block={child} widget={undefined} source={source} mounted={mounted} />
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
  commentThreadId,
}: {
  block: PublicBlock;
  widget: A2UIWidget | undefined;
  source: PublicSource;
  mounted: boolean;
  /** Thread anchored to this block (heading / text only — atoms are wrapped by
   *  the caller). When set, the block's text carries the comment swatch + anchor. */
  commentThreadId?: string;
}) {
  switch (block.kind) {
    case "heading": {
      const lvl = Math.min(Math.max(Number(block.level ?? 2), 1), 4);
      const Tag = `h${lvl}` as "h1" | "h2" | "h3" | "h4";
      return <Tag>{commentedText(String(block.text ?? ""), commentThreadId)}</Tag>;
    }
    case "text": {
      const variant = block.variant === "muted" ? "text-muted-foreground" : "";
      return <p className={variant}>{commentedText(String(block.text ?? ""), commentThreadId)}</p>;
    }
    case "divider":
      return <hr className="my-4 border-border" />;
    case "code":
      return (
        <pre className="overflow-x-auto rounded-md bg-muted p-3 text-sm">
          <code>{String(block.code ?? "")}</code>
        </pre>
      );
    case "quote":
      return (
        <blockquote className="border-l-2 border-border pl-3 text-muted-foreground">
          <RichText value={block.richText} />
        </blockquote>
      );
    case "callout":
      return (
        <div className="flex gap-3 rounded-md border border-border bg-muted/40 px-3 py-2">
          <div className="flex-shrink-0 pt-[2px] text-lg leading-none">{String(block.icon ?? "💡")}</div>
          <div className="min-w-0 flex-1">
            <RichText value={block.richText} />
            {renderChildBlocks(block, source, mounted)}
          </div>
        </div>
      );
    // bulleted_list_item / numbered_list_item are grouped into real <ul>/<ol>
    // by ReadOnlyPageBlocks (so numbers sequence + nesting markers cycle).
    case "to_do": {
      // Nested to-dos carry `indent` — mirror the editor's pitch with a
      // per-level inset (the public view has no taskList wrapper to nest).
      const indent = typeof block.indent === "number" && block.indent > 0 ? block.indent : 0;
      return (
        <label className="flex items-start gap-2" style={indent ? { marginLeft: indent * 24 } : undefined}>
          <input type="checkbox" checked={Boolean(block.checked)} readOnly disabled className="mt-1" />
          <div className="min-w-0 flex-1"><RichText value={block.richText} /></div>
        </label>
      );
    }
    case "toggle": {
      const doc = block.richText as TipNode | undefined;
      return renderToggle(doc?.content, block.id, renderChildBlocks(block, source, mounted));
    }
    case "table": {
      // Native simple table — cells are rich text (mentions already scrubbed
      // server-side). Header row/column map to <th>; everything else <td>.
      const rows = Array.isArray(block.rows) ? (block.rows as unknown[][]) : [];
      if (rows.length === 0) return null;
      const hasHeaderRow = block.hasHeaderRow === true;
      const hasHeaderColumn = block.hasHeaderColumn === true;
      return (
        <div className="doc-public-table-wrap my-2 overflow-x-auto">
          <table className="doc-public-table">
            <tbody>
              {rows.map((row, r) => (
                <tr key={r}>
                  {(Array.isArray(row) ? row : []).map((cellValue, c) => {
                    const isHeader =
                      (hasHeaderRow && r === 0) || (hasHeaderColumn && c === 0);
                    const Cell = isHeader ? "th" : "td";
                    return (
                      <Cell key={c}>
                        <RichText value={cellValue} />
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
        <figure className="my-2">
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
          href={publicMediaUrlFor(source, block.id)}
          target="_blank"
          rel="noopener noreferrer"
          className="inline-flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:bg-muted"
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
          href={safeHref(url)}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="block rounded-md border border-border px-3 py-2 hover:bg-muted"
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
        source.kind === "link" && block.via === "subtree"
          ? `/share/${encodeURIComponent(source.token)}/p/${encodeURIComponent(childId)}`
          : `/share/p/${encodeURIComponent(childId)}`;
      return (
        <a
          href={href}
          className="flex items-center gap-2 rounded-md py-1 font-medium underline-offset-4 hover:underline"
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
      return mounted && widget ? <div className="my-2">{renderWidget(widget, noop)}</div> : null;
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
}: {
  blocks: PublicBlock[];
  payload: ViewPayload;
  source: PublicSource;
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
      out.push(...renderListNodes(foldListTree(run), `list-${i}`));
    } else {
      const block = blocks[i];
      const key = block.id || String(i);
      const threadId = anchors.get(block.id);
      const blockEl = (
        <BlockView
          block={block}
          widget={children[i]}
          source={source}
          mounted={mounted}
          commentThreadId={threadId}
        />
      );
      // An anchored atom (chart / image / file / … — no inline text to carry the
      // swatch, and not a rich-text block whose mark `renderInline` already
      // anchored) gets a whole-block tint + rail anchor, mirroring the editor's
      // textless-block `doc-comment-block-hl`.
      const atomAnchor =
        !!threadId && !RICH_TEXT_KINDS.has(block.kind) && !PLAIN_TEXT_KINDS.has(block.kind);
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
