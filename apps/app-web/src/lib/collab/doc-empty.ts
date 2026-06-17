/**
 * Pure predicate: is a synced doc page body empty?
 *
 * Used by `doc-shell`'s draft landing to decide whether a `'placeholder'`
 * draft is still the "what do you want to see?" prompt surface or has gained
 * content (so the editor — not the landing — must own it). Gating the landing on
 * the *actual* body emptiness, not just the placeholder title, is what keeps a
 * built page from being stranded behind the prompt if its auto-title ever fails.
 *
 * y-prosemirror maps an empty ProseMirror doc to a single empty `paragraph`
 * element in the page's `Y.XmlFragment` (`FRAGMENT_FIELD`). So "empty" is zero
 * top-level blocks or exactly that one empty paragraph; anything more is content.
 *
 * [COMP:app-web/doc-empty]
 */

import * as Y from "yjs";

export function isYFragmentEmpty(frag: Y.XmlFragment): boolean {
  if (frag.length === 0) return true;
  if (frag.length > 1) return false;
  const only = frag.get(0);
  return (
    only instanceof Y.XmlElement &&
    only.nodeName === "paragraph" &&
    only.length === 0
  );
}
