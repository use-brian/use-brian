import { describe, it, expect } from "vitest";
import * as Y from "yjs";
import { FRAGMENT_FIELD } from "@use-brian/doc-model";
import { isYFragmentEmpty } from "../doc-empty";

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
