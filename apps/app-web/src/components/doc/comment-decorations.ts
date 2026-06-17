/**
 * Comment decorations — the unified highlight + gutter-badge layer.
 *
 * One Tiptap extension wrapping one ProseMirror plugin (module-scoped
 * PluginKey, mirroring slash-menu) that paints a single `DecorationSet` from
 * BOTH comment anchor sources (see doc-comments.md):
 *
 *   (a) human ranges  — every `comment` mark run → an inline highlight over
 *       its exact range, keyed by the mark's `threadId`.
 *   (b) block anchors  — a whole-block tint for any block whose `blockId`
 *       matches a block-anchored thread's `anchorBlockId`. Two kinds anchor
 *       this way: `ai_block` (the AI's own annotations) and `human_block` (a
 *       person commenting on an atom block — chart / image / data / … — that
 *       has no inner text to carry a mark). Neither stores a mark; the
 *       highlight is purely this decoration.
 *
 * Plus one gutter badge widget per anchored block (counts aggregated across
 * both sources), clickable to open the thread.
 *
 * Data flow: React owns thread state and pushes it in via a meta-only
 * transaction (`setMeta(commentDecorationsKey, { threads })`) — it carries no
 * steps, so it never syncs to the Yjs doc. The plugin rebuilds on
 * `docChanged || meta`, else cheaply maps positions.
 *
 * Plus a transient **draft** highlight: while the user is composing a brand-new
 * comment (before the first message is sent) the selected range is painted with
 * the SAME amber inline highlight as a real comment, but as a LOCAL decoration
 * — never a `comment` mark, so nothing is written to the Yjs doc or the backend
 * until the comment is committed. It's pushed in the same meta channel
 * (`setMeta(..., { draft })`) and remapped through edits like the thread decos;
 * clearing it (`syncCommentDraft(view, null)`) leaves the doc untouched.
 *
 * [COMP:app-web/comment-decorations]
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { MarkType, Node as PMNode } from "@tiptap/pm/model";

/** Minimal thread shape the plugin needs (subset of the SDK's CommentThread). */
export type DecorationThread = {
  id: string;
  anchorKind: "human_range" | "ai_block" | "human_block";
  anchorBlockId: string | null;
};

/** Anchor kinds that pin a thread to a WHOLE block (highlight derived from
 *  `anchorBlockId`, no stored `comment` mark) rather than a text range. */
function isBlockAnchored(kind: DecorationThread["anchorKind"]): boolean {
  return kind === "ai_block" || kind === "human_block";
}

export const commentDecorationsKey = new PluginKey<CommentDecoState>(
  "docCommentDecorations",
);

/** The transient range of a not-yet-committed comment (local-only highlight). */
export type CommentDraftRange = { from: number; to: number };

type CommentDecoState = {
  threads: DecorationThread[];
  /** Local draft highlight while composing a new comment, or null. */
  draft: CommentDraftRange | null;
  deco: DecorationSet;
};

export type CommentDecorationsOptions = {
  /** Called when the user clicks a commented span or a gutter badge.
   *  `anchorEl` is the clicked element — the popover anchors to it. */
  onOpenThread: (threadId: string, anchorEl: HTMLElement) => void;
};

/** Build the full decoration set for the current doc + thread list (+ an
 *  optional transient draft range). Exported for unit testing the deco-builder
 *  over a fixture doc. */
export function buildDecorations(
  doc: PMNode,
  threads: DecorationThread[],
  draft: CommentDraftRange | null = null,
): DecorationSet {
  // blockId → threadId for every WHOLE-block-anchored thread (ai_block +
  // human_block). Both render the same client-side tint from the blockId.
  const blockAnchored = new Map<string, string>();
  for (const t of threads) {
    if (isBlockAnchored(t.anchorKind) && t.anchorBlockId) {
      blockAnchored.set(t.anchorBlockId, t.id);
    }
  }

  const decos: Decoration[] = [];
  // blockId → one gutter badge: its position, the FIRST thread anchored there
  // (the badge's representative — clicking it opens this thread), and the SET of
  // distinct threads touching the block (the badge count). A `Set` (not a bare
  // counter) is load-bearing: a single comment mark can be split into several
  // text-node runs within one block (e.g. a bold word mid-range) and can span
  // several blocks (a heading + the paragraph below it) — neither must inflate
  // the count or mint a second badge. `seenThreads` enforces one-badge-per-thread:
  // each thread is attributed to the FIRST block it appears in (doc order) only.
  const badge = new Map<
    string,
    { pos: number; threadIds: Set<string>; firstThreadId: string }
  >();
  const seenThreads = new Set<string>();

  doc.descendants((node, pos) => {
    const blockId = node.attrs?.blockId as string | undefined;

    // (b) Whole-block anchor (ai_block / human_block) → highlight + badge.
    // A block WITH inner text highlights the TEXT itself — the same warm
    // inline swatch as a human range (Notion-style), not a full-width block
    // tint. Only a TEXTLESS block (an `embed` atom — chart / image / data /
    // … — or an empty block) keeps the whole-block tint, since it has no
    // inline content to paint over.
    if (blockId && blockAnchored.has(blockId)) {
      const threadId = blockAnchored.get(blockId)!;
      if (node.textContent.length > 0) {
        // Inner content range (inside the block's open/close tokens). The
        // inline decoration paints only the text runs within, ignoring block
        // boundaries — so it never fills the block's full width.
        decos.push(
          Decoration.inline(pos + 1, pos + node.nodeSize - 1, {
            class: "doc-comment-hl",
            "data-thread-id": threadId,
          }),
        );
      } else {
        decos.push(
          Decoration.node(pos, pos + node.nodeSize, {
            class: "doc-comment-block-hl",
            "data-thread-id": threadId,
          }),
        );
      }
      const b = badge.get(blockId);
      if (b) b.threadIds.add(threadId);
      else
        badge.set(blockId, {
          pos,
          threadIds: new Set([threadId]),
          firstThreadId: threadId,
        });
      seenThreads.add(threadId);
    }

    // (a) human comment marks → inline highlight over each run.
    if (node.isText && node.marks.length > 0) {
      const mark = node.marks.find((m) => m.type.name === "comment");
      const threadId = mark?.attrs?.threadId as string | undefined;
      if (threadId) {
        decos.push(
          Decoration.inline(pos, pos + node.nodeSize, {
            class: "doc-comment-hl",
            "data-thread-id": threadId,
          }),
        );
        // Attribute the badge to the nearest ancestor block — but only ONCE per
        // thread. A comment mark can span multiple blocks (a heading + the
        // paragraph below it) or split into several runs within one block; each
        // extra run still paints its inline highlight above, but must NOT mint a
        // second gutter badge for the same conversation. The first block the
        // thread appears in (descendants is pre-order = doc order) owns its badge.
        if (!seenThreads.has(threadId)) {
          const $pos = doc.resolve(pos);
          let anchorBlockId: string | undefined;
          for (let d = $pos.depth; d > 0; d--) {
            const id = $pos.node(d).attrs?.blockId as string | undefined;
            if (id) {
              anchorBlockId = id;
              break;
            }
          }
          const key = anchorBlockId ?? `mark:${threadId}`;
          const blockStart = anchorBlockId ? $pos.before($pos.depth) : pos;
          const b = badge.get(key);
          if (b) b.threadIds.add(threadId);
          else
            badge.set(key, {
              pos: blockStart,
              threadIds: new Set([threadId]),
              firstThreadId: threadId,
            });
          seenThreads.add(threadId);
        }
      }
    }
    return true;
  });

  // Transient draft highlight — the same amber inline highlight as a real
  // comment, but a LOCAL decoration (no `comment` mark), so composing a new
  // comment writes nothing to the Yjs doc until it's committed. No badge: a
  // draft has no thread to count yet.
  if (draft && draft.to > draft.from) {
    const from = Math.max(0, Math.min(draft.from, doc.content.size));
    const to = Math.max(0, Math.min(draft.to, doc.content.size));
    if (to > from) {
      decos.push(
        Decoration.inline(from, to, {
          class: "doc-comment-hl is-active-thread",
          "data-comment-draft": "",
        }),
      );
    }
  }

  // One gutter badge widget per anchored block — deduped to one per thread; the
  // count is the number of DISTINCT threads on the block, never the run count.
  for (const [, b] of badge) {
    const count = b.threadIds.size;
    decos.push(
      Decoration.widget(
        b.pos,
        () => {
          const el = document.createElement("button");
          el.type = "button";
          el.className = "doc-comment-badge";
          el.setAttribute("data-thread-id", b.firstThreadId);
          el.setAttribute("data-comment-badge", "");
          // Lucide `message-square` glyph (STATIC markup only) + the count via
          // textContent — no dynamic data ever flows through innerHTML.
          el.innerHTML =
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>';
          const countEl = document.createElement("span");
          countEl.textContent = String(count);
          el.appendChild(countEl);
          return el;
        },
        { side: 1, key: `badge:${b.firstThreadId}:${count}` },
      ),
    );
  }

  return DecorationSet.create(doc, decos);
}

/**
 * Find every `comment`-mark run whose `threadId` is in `staleIds` — the doc
 * ranges the editor strips on load to clear an orphaned highlight (a thread
 * minted with its mark stamped, but whose first comment never landed, or one
 * since deleted). Pure + exported so the load-time sweep is unit-testable over
 * a fixture doc, mirroring `buildDecorations`. `removeMark` doesn't shift
 * positions, so the caller can apply every returned range in one transaction
 * using these original positions.
 */
export function findStaleCommentMarkRanges(
  doc: PMNode,
  staleIds: ReadonlySet<string>,
  markType: MarkType,
): Array<{ from: number; to: number }> {
  const ranges: Array<{ from: number; to: number }> = [];
  if (staleIds.size === 0) return ranges;
  doc.descendants((node, pos) => {
    if (!node.isText) return;
    const mark = node.marks.find((m) => m.type === markType);
    const threadId = mark?.attrs?.threadId as string | undefined;
    if (threadId && staleIds.has(threadId)) {
      ranges.push({ from: pos, to: pos + node.nodeSize });
    }
  });
  return ranges;
}

/**
 * Thread ids whose stored `comment` mark must be swept because the thread is
 * **resolved**. A `human_range` highlight is a `comment` mark in the Yjs doc,
 * painted directly from the mark (independent of the thread list) — so
 * resolving a thread (which only flips `resolved_at` in Postgres and drops it
 * from the open list) leaves the inline highlight stranded unless the mark is
 * stripped. Only `human_range` threads carry a mark: block-anchored threads
 * (`ai_block` / `human_block`) render their tint from the live open-thread list,
 * so resolving already clears them — including one here would be dead work
 * (there is no mark to strip). Pairs with `findStaleCommentMarkRanges` (the
 * editor feeds this set into it for the resolved-thread sweep), mirroring the
 * empty-thread sweep. Pure + exported so the rule is unit-testable.
 */
export function resolvedMarkThreadIds(
  threads: ReadonlyArray<{
    id: string;
    anchorKind: DecorationThread["anchorKind"];
    resolvedAt: string | null;
  }>,
): Set<string> {
  const ids = new Set<string>();
  for (const t of threads) {
    if (t.resolvedAt && t.anchorKind === "human_range") ids.add(t.id);
  }
  return ids;
}

export function createCommentDecorationsExtension(
  options: CommentDecorationsOptions,
): Extension {
  return Extension.create({
    name: "commentDecorations",
    addProseMirrorPlugins() {
      return [
        new Plugin<CommentDecoState>({
          key: commentDecorationsKey,
          state: {
            init: () => ({ threads: [], draft: null, deco: DecorationSet.empty }),
            apply(tr, value, _oldState, newState) {
              // Meta carries threads and/or draft; each is merged independently
              // (an absent key keeps the current value) so the two update
              // channels — React's thread fetch and the live draft highlight —
              // don't clobber each other.
              const meta = tr.getMeta(commentDecorationsKey) as
                | { threads?: DecorationThread[]; draft?: CommentDraftRange | null }
                | undefined;
              if (meta) {
                const threads = meta.threads ?? value.threads;
                const draft = meta.draft !== undefined ? meta.draft : value.draft;
                return {
                  threads,
                  draft,
                  deco: buildDecorations(newState.doc, threads, draft),
                };
              }
              if (tr.docChanged) {
                // Keep the draft range anchored to its text as the doc edits.
                const draft = value.draft
                  ? {
                      from: tr.mapping.map(value.draft.from),
                      to: tr.mapping.map(value.draft.to),
                    }
                  : null;
                return {
                  threads: value.threads,
                  draft,
                  deco: buildDecorations(newState.doc, value.threads, draft),
                };
              }
              return {
                threads: value.threads,
                draft: value.draft,
                deco: value.deco.map(tr.mapping, tr.doc),
              };
            },
          },
          props: {
            decorations(state) {
              return commentDecorationsKey.getState(state)?.deco ?? null;
            },
            handleDOMEvents: {
              mousedown: (_view, event) => {
                const target = event.target as HTMLElement | null;
                const el = target?.closest("[data-thread-id]") as HTMLElement | null;
                const threadId = el?.getAttribute("data-thread-id");
                if (threadId && el) {
                  event.preventDefault();
                  options.onOpenThread(threadId, el);
                  return true;
                }
                return false;
              },
            },
          },
        }),
      ];
    },
  });
}

type DispatchView = {
  state: import("@tiptap/pm/state").EditorState;
  dispatch: (tr: import("@tiptap/pm/state").Transaction) => void;
};

/** Push the current thread list into the plugin (call from React on change). */
export function syncCommentThreads(view: DispatchView, threads: DecorationThread[]): void {
  view.dispatch(view.state.tr.setMeta(commentDecorationsKey, { threads }));
}

/** Set (or clear, with `null`) the transient draft highlight. A meta-only
 *  transaction — it never touches the doc, so it's safe to call freely while
 *  the user composes; dismissing a draft leaves no trace. */
export function syncCommentDraft(view: DispatchView, draft: CommentDraftRange | null): void {
  view.dispatch(view.state.tr.setMeta(commentDecorationsKey, { draft }));
}

/** The current draft range, kept mapped through edits — read it just before
 *  committing so the `comment` mark lands on the right (possibly shifted) text.
 *  Null when no draft is active. */
export function getCommentDraftRange(
  state: import("@tiptap/pm/state").EditorState,
): CommentDraftRange | null {
  return commentDecorationsKey.getState(state)?.draft ?? null;
}
