/**
 * Clickable `[H:MM:SS]` citations — the seek link in a meeting brief.
 *
 * The synthesis prompt asks the model to cite the moment for every claim, and it
 * does: `[0:47:21]` lands as literal characters inside a paragraph's rich text.
 * Until now nothing parsed it, so a brief was full of timestamps you could read
 * but not use.
 *
 * A **DECORATION, NOT A NODE.** This is the whole design, and it buys three
 * things a stored node cannot:
 *
 *  1. **Zero Yjs risk.** Decorations are view-layer only. They contribute no
 *     nodes and no marks, never enter the document, and never touch
 *     `schema.ts`'s `docExtensions()` — so there is no lockstep `doc-sync` +
 *     web deploy, and no possibility of desyncing a live document. An inline
 *     ProseMirror atom (the "proper" model) would require exactly that, to make
 *     text clickable.
 *  2. **It survives editing.** A citation is *text the model wrote*. The user
 *     can retype it, paste it into a new paragraph, or delete the sentence
 *     around it, and behavior stays correct because the text IS the citation —
 *     there is no object to orphan. A stored atom can be deleted silently, or
 *     copied into an unrelated page where it points at a recording that page has
 *     no context for.
 *  3. **It works retroactively.** Because it parses at render, every brief ever
 *     authored becomes clickable the moment this ships. A stored node would only
 *     help pages authored afterwards, and would need a backfill over
 *     `saved_views` blocks to catch up.
 *
 * The parse is `parseStamp` from `@use-brian/shared` — the SAME module the
 * transcriber, the transcript file, and the synthesis prompt use. Writer and
 * reader change together or the model cites stamps the UI cannot linkify. It
 * also rejects an impossible stamp (`[00:85]`), so a hallucinated citation
 * renders as plain text instead of seeking to a moment that never existed.
 *
 * [COMP:app-web/timecode-decoration]
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import { scanStamps } from "@use-brian/shared";

const timecodeKey = new PluginKey("timecodeCitations");

export type TimecodeMatch = { from: number; to: number; ms: number; text: string };

/**
 * Find every citation in the doc, as absolute positions.
 *
 * Exported pure so the unit test can drive it against a real ProseMirror doc
 * without a browser.
 */
export function findTimecodes(doc: PMNode): TimecodeMatch[] {
  const out: TimecodeMatch[] = [];
  doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    // `scanStamps` skips an impossible stamp the model invented ([00:85]), so it
    // stays plain text rather than linking to a moment that never existed.
    for (const hit of scanStamps(node.text)) {
      out.push({ from: pos + hit.index, to: pos + hit.index + hit.length, ms: hit.ms, text: hit.text });
    }
  });
  return out;
}

export type TimecodeOptions = {
  /**
   * Seek the player. Absent → citations render inert (no recording on this
   * page), which is the correct default rather than a dead link.
   */
  onSeek?: (ms: number) => void;
  /**
   * Deep-link target, e.g. `/w/<ws>/recordings/<id>`. The rendered anchor gets
   * `href="<base>#t=<seconds>"` — Fathom's convention, and a real URL, so
   * copy-link, open-in-new-tab, middle-click, keyboard nav, and screen readers
   * all work. The click itself is intercepted for an in-page seek.
   */
  hrefBase?: string;
};

function buildDecorations(doc: PMNode, opts: TimecodeOptions): DecorationSet {
  const active = Boolean(opts.onSeek || opts.hrefBase);
  if (!active) return DecorationSet.empty;

  const decos = findTimecodes(doc).map((hit) =>
    Decoration.inline(hit.from, hit.to, {
      class: "doc-timecode",
      // A real anchor, not a styled span — that is what makes right-click,
      // middle-click, and assistive tech work for free.
      nodeName: "a",
      ...(opts.hrefBase ? { href: `${opts.hrefBase}#t=${Math.floor(hit.ms / 1000)}` } : {}),
      "data-timecode-ms": String(hit.ms),
      role: "button",
    }),
  );
  return DecorationSet.create(doc, decos);
}

export function timecodeDecoration(options: TimecodeOptions = {}) {
  return Extension.create({
    name: "timecodeCitations",
    addProseMirrorPlugins() {
      return [
        new Plugin({
          key: timecodeKey,
          props: {
            decorations(state) {
              return buildDecorations(state.doc, options);
            },
            handleClick(view, _pos, event) {
              const el = (event.target as HTMLElement | null)?.closest?.("[data-timecode-ms]");
              if (!el) return false;
              const ms = Number(el.getAttribute("data-timecode-ms"));
              if (!Number.isFinite(ms) || !options.onSeek) return false;
              // Let a modified click do what the browser would (new tab, etc.) —
              // the href is real, so that lands on the deep link.
              const e = event as MouseEvent;
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return false;
              event.preventDefault();
              options.onSeek(ms);
              return true;
            },
          },
        }),
      ];
    },
  });
}
