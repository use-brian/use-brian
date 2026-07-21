import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { FRAGMENT_FIELD } from "@use-brian/doc-model";
import { hasLoadedState, isYFragmentEmpty } from "../doc-empty";

/**
 * Guards the draft-landing gate: a placeholder draft is the "what do you want to
 * see?" prompt only while truly empty, and the instant any block lands the editor
 * must take over — so a built page can never be stranded behind the prompt (the
 * auto-title-failed case). These assertions pin the empty vs has-content line.
 *
 * [COMP:app-web/doc-empty]
 */
describe("[COMP:app-web/doc-empty] isYFragmentEmpty", () => {
  function frag(): Y.XmlFragment {
    return new Y.Doc().getXmlFragment(FRAGMENT_FIELD);
  }
  function paragraph(text?: string): Y.XmlElement {
    const p = new Y.XmlElement("paragraph");
    if (text) p.insert(0, [new Y.XmlText(text)]);
    return p;
  }

  it("treats a fragment with zero blocks as empty", () => {
    expect(isYFragmentEmpty(frag())).toBe(true);
  });

  it("treats the lone empty paragraph (freshly-seeded doc) as empty", () => {
    const f = frag();
    f.insert(0, [paragraph()]);
    expect(isYFragmentEmpty(f)).toBe(true);
  });

  it("treats a paragraph carrying text as content", () => {
    const f = frag();
    f.insert(0, [paragraph("hello")]);
    expect(isYFragmentEmpty(f)).toBe(false);
  });

  it("treats two top-level blocks as content even when both are empty", () => {
    const f = frag();
    f.insert(0, [paragraph(), paragraph()]);
    expect(isYFragmentEmpty(f)).toBe(false);
  });

  it("treats a single non-paragraph block as content", () => {
    const f = frag();
    f.insert(0, [new Y.XmlElement("heading")]);
    expect(isYFragmentEmpty(f)).toBe(false);
  });
});

/**
 * Guards the offline-readiness rule in `use-collab-provider`: the local
 * IndexedDB copy may unblock the editor only when it actually loaded state.
 * A doc that loaded nothing (page never opened on this device) must NOT count
 * — rendering it would present a server-backed page as a blank editable doc.
 */
describe("[COMP:app-web/doc-empty] hasLoadedState", () => {
  it("is false for a fresh doc that loaded nothing", () => {
    expect(hasLoadedState(new Y.Doc())).toBe(false);
  });

  it("is true once any struct lands, even a visually empty paragraph", () => {
    const doc = new Y.Doc();
    doc.getXmlFragment(FRAGMENT_FIELD).insert(0, [new Y.XmlElement("paragraph")]);
    expect(hasLoadedState(doc)).toBe(true);
  });

  it("is true after applying a remote update (the IndexedDB load path)", () => {
    const source = new Y.Doc();
    source
      .getXmlFragment(FRAGMENT_FIELD)
      .insert(0, [new Y.XmlElement("paragraph")]);
    const loaded = new Y.Doc();
    Y.applyUpdate(loaded, Y.encodeStateAsUpdate(source));
    expect(hasLoadedState(loaded)).toBe(true);
  });
});
