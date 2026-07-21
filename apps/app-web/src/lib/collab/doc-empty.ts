/**
 * Pure predicates over a page's Yjs state: is the synced body empty
 * (`isYFragmentEmpty`), and has the doc loaded any state at all
 * (`hasLoadedState`)?
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

/**
 * Pure predicate: does this Y.Doc carry ANY loaded state (at least one client
 * has ever written a struct to it)?
 *
 * Used by `use-collab-provider` to decide whether the local IndexedDB copy is
 * good enough to unblock the editor while offline: a page previously opened on
 * this device loads with real structs (even a visually empty page carries its
 * synced paragraph skeleton), while a page never seen here loads nothing — and
 * rendering *that* as an editable blank doc would misrepresent a server-backed
 * page. Distinct from `isYFragmentEmpty`, which asks about visible content.
 */
export function hasLoadedState(doc: Y.Doc): boolean {
  return doc.store.clients.size > 0;
}
