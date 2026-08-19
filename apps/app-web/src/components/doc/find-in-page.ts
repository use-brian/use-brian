/**
 * Find in page — ⌘F / Ctrl+F over the open doc.
 *
 * The browser's own find bar is not a substitute here, which is why this
 * exists at all. Native find scans **rendered DOM**, and a doc page hides
 * matches from it three ways: collapsed toggles keep their body out of the
 * tree, node-view atoms (chart / data / embed) render their own DOM, and the
 * Electron desktop shell (`apps/app-desktop`) has no find UI at all — ⌘F
 * there did nothing whatsoever. So the shortcut is claimed
 * (`preventDefault()`) and answered from the ProseMirror document instead.
 *
 * A **DECORATION, NOT A MARK** — same reasoning as `timecode-decoration.ts`.
 * Highlights are view-layer only: they contribute no nodes and no marks, never
 * enter the document, and are pushed in through a **meta-only transaction**
 * (`setMeta(docFindKey, …)`, the channel `comment-decorations.ts` uses for its
 * draft highlight). A meta-only transaction carries no steps, so searching a
 * page writes nothing to Yjs — nobody else in the room sees your search, and a
 * read-only viewer can search a page they cannot edit.
 *
 * **Matching is per text-run, never across a block boundary.** The walk
 * accumulates adjacent text nodes into one string and flushes at every
 * non-text node. Two consequences, both deliberate: a query still matches
 * across an inline mark boundary (`he**ll**o` is one run, so "hello" hits),
 * and it never matches across the end of a paragraph or through an inline atom
 * (a mention), where the characters are only adjacent by accident of position.
 *
 * Search is case-insensitive and literal — the query is compared with
 * `indexOf`, never compiled to a regex, so `(`, `.` and `*` are searched for
 * rather than interpreted.
 *
 * [COMP:app-web/doc-find]
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet, type EditorView } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { isMacUa } from "@/lib/surface-shortcuts";

/** One hit, as absolute document positions. */
export type FindMatch = { from: number; to: number };

export type DocFindState = {
  /** The live query. Empty string = find is closed / idle. */
  query: string;
  /** Every hit, in document order. */
  matches: FindMatch[];
  /** Index into `matches` of the one the user is standing on; 0 when none. */
  activeIndex: number;
  deco: DecorationSet;
};

export const docFindKey = new PluginKey<DocFindState>("docFindInPage");

const IDLE: DocFindState = {
  query: "",
  matches: [],
  activeIndex: 0,
  deco: DecorationSet.empty,
};

/**
 * Every occurrence of `query` in the doc, case-insensitively, in document
 * order and without overlaps.
 *
 * Exported pure so the unit test can drive it against a real ProseMirror doc
 * with no browser and no editor view.
 */
export function findMatches(doc: PMNode, query: string): FindMatch[] {
  const needle = query.toLowerCase();
  if (!needle) return [];

  const out: FindMatch[] = [];
  // The current run of adjacent text nodes: its concatenated text, and the
  // document position its first character sits at. Adjacent text nodes are
  // contiguous in position space (a node at `pos` of length n is followed by
  // one at `pos + n`), so `runPos + offset` is the absolute position of any
  // character in the run.
  let runText = "";
  let runPos = -1;

  const flush = () => {
    if (runPos >= 0) {
      const hay = runText.toLowerCase();
      let at = hay.indexOf(needle);
      while (at !== -1) {
        out.push({ from: runPos + at, to: runPos + at + needle.length });
        // Step past the hit, not past its first character: overlapping matches
        // ("aa" in "aaa") would otherwise paint two highlights over one span.
        at = hay.indexOf(needle, at + needle.length);
      }
    }
    runText = "";
    runPos = -1;
  };

  doc.descendants((node, pos) => {
    if (node.isText && node.text) {
      if (runPos < 0) runPos = pos;
      runText += node.text;
      // Text nodes have no children; returning false skips a pointless descend.
      return false;
    }
    // Any non-text node ends the run — a block boundary, or an inline atom
    // whose neighbours must not be joined across it.
    flush();
    return true;
  });
  flush();

  return out;
}

function buildDeco(
  doc: PMNode,
  matches: FindMatch[],
  activeIndex: number,
): DecorationSet {
  if (!matches.length) return DecorationSet.empty;
  return DecorationSet.create(
    doc,
    matches.map((m, i) =>
      Decoration.inline(m.from, m.to, {
        class:
          i === activeIndex
            ? "doc-find-match doc-find-match-active"
            : "doc-find-match",
      }),
    ),
  );
}

/** Wrap an index into `[0, total)`, so next/prev cycle instead of dead-ending. */
export function wrapIndex(index: number, total: number): number {
  if (total <= 0) return 0;
  return ((index % total) + total) % total;
}

/**
 * `{ query }` replaces the search (and resets to the first hit); `{ step }`
 * moves the active hit by that many, wrapping at both ends.
 */
type FindMeta = { query?: string; step?: number };

export function docFindPlugin(): Plugin<DocFindState> {
  return new Plugin<DocFindState>({
    key: docFindKey,
    state: {
      init: () => IDLE,
      apply(tr, prev, _old, next) {
        const meta = tr.getMeta(docFindKey) as FindMeta | undefined;
        // Nothing asked and nothing moved: keep the existing set. (Positions
        // do not need remapping here because any transaction that CAN move
        // them sets `docChanged`, which recomputes from the new doc.)
        if (!meta && !tr.docChanged) return prev;

        const query = meta?.query ?? prev.query;
        if (!query) return IDLE;

        const matches = findMatches(next.doc, query);
        // A new query lands on the first hit; a step moves from where we were;
        // a plain edit keeps the current index (clamped by the wrap).
        const wanted =
          meta?.query !== undefined ? 0 : prev.activeIndex + (meta?.step ?? 0);
        const activeIndex = wrapIndex(wanted, matches.length);
        return {
          query,
          matches,
          activeIndex,
          deco: buildDeco(next.doc, matches, activeIndex),
        };
      },
    },
    props: {
      decorations(state) {
        return docFindKey.getState(state)?.deco ?? DecorationSet.empty;
      },
    },
  });
}

export function docFindExtension() {
  return Extension.create({
    name: "docFindInPage",
    addProseMirrorPlugins() {
      return [docFindPlugin()];
    },
  });
}

/** Current find state — `IDLE` before the plugin's first transaction. */
export function readFind(state: EditorState): DocFindState {
  return docFindKey.getState(state) ?? IDLE;
}

/** Set (or, with `""`, clear) the query. Meta-only: never written to Yjs. */
export function setFindQuery(view: EditorView, query: string): void {
  view.dispatch(view.state.tr.setMeta(docFindKey, { query }));
}

/** Move the active hit by `step` (+1 next, -1 previous), wrapping. */
export function stepFindMatch(view: EditorView, step: number): void {
  view.dispatch(view.state.tr.setMeta(docFindKey, { step }));
}

/**
 * True when a keydown is this platform's find chord.
 *
 * Platform-split rather than `metaKey || ctrlKey`: on macOS **Ctrl+F is a
 * system text-editing binding** (move the caret forward one character), and
 * hijacking it inside a text editor would break caret movement for everyone
 * who uses it. So mac matches ⌘F only and every other platform Ctrl+F only.
 * `isMacUa` comes from `lib/surface-shortcuts.ts`, the app's one place that
 * reads the platform off the UA.
 *
 * Unlike Accel+digit, Accel+F is reserved by no browser — Firefox included —
 * so `preventDefault()` reliably suppresses the native find bar and there is
 * no per-browser remap to make.
 */
export function findShortcutPressed(
  e: Pick<KeyboardEvent, "key" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">,
  ua: string = typeof navigator === "undefined" ? "" : navigator.userAgent,
): boolean {
  if (e.altKey || e.shiftKey) return false;
  if (e.key !== "f" && e.key !== "F") return false;
  return isMacUa(ua) ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
}
