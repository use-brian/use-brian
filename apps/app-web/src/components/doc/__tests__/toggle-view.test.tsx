/**
 * [COMP:app-web/toggle-view] Toggle block — Notion-style collapsible disclosure.
 *
 * Two surfaces under test, both node-only (no jsdom):
 *   1. `<ToggleView>` rendered output (via `renderToStaticMarkup`, the same
 *      SSR-only pattern floating-toolbar.test.tsx uses): the wrapper carries
 *      the `data-open` flag the collapse CSS keys off, the chevron carries the
 *      open/closed aria label, and the content region is the `doc-toggle-
 *      content` contentDOM the children render into.
 *   2. The schema's collapsible structure (via real ProseMirror commands on
 *      the shared `docSchema()`): pressing Enter inside a toggle nests the
 *      new block *inside* it (so there are children to collapse), and Enter on
 *      an empty trailing child exits the toggle. This is the contract the
 *      "collapse the toggle items" UX depends on.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { EditorState, TextSelection } from "@tiptap/pm/state";
import {
  chainCommands,
  newlineInCode,
  createParagraphNear,
  liftEmptyBlock,
  splitBlock,
} from "@tiptap/pm/commands";
import type { Node as PMNode } from "@tiptap/pm/model";
import { docSchema } from "@use-brian/doc-model";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import { ToggleView } from "../node-views/toggle-view";

const dict = en as unknown as Dictionary;

function renderToggle(open: boolean): string {
  const props = {
    node: { attrs: { open } },
    updateAttributes: () => {},
  } as never;
  return renderToStaticMarkup(
    createElement(
      I18nProvider,
      { dict, locale: "en", children: createElement(ToggleView, props) } as never,
    ),
  );
}

describe("[COMP:app-web/toggle-view] Toggle node-view render", () => {
  it("exposes data-open=true and the collapse aria when expanded", () => {
    const html = renderToggle(true);
    expect(html).toContain('data-open="true"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain(en.docPage.blocks.toggleCollapseAria);
    expect(html).toContain("doc-toggle-chevron");
    expect(html).toContain("doc-toggle-content");
  });

  it("exposes data-open=false and the expand aria when collapsed", () => {
    const html = renderToggle(false);
    expect(html).toContain('data-open="false"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain(en.docPage.blocks.toggleExpandAria);
  });
});

describe("[COMP:app-web/toggle-view] Toggle collapsible structure", () => {
  const schema = docSchema();
  // ProseMirror's default Enter keymap (what StarterKit binds).
  const enter = chainCommands(
    newlineInCode,
    createParagraphNear,
    liftEmptyBlock,
    splitBlock,
  );

  function run(doc: PMNode, pos: number) {
    let state = EditorState.create({ doc, schema });
    state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    let next: EditorState | null = null;
    const handled = enter(state, (tr) => {
      next = state.apply(tr);
    });
    return { handled, doc: (next ?? state).doc };
  }

  it("nests a new block INSIDE the toggle on Enter (so there are items to collapse)", () => {
    const toggle = schema.nodes.toggle.create(
      { open: true },
      schema.nodes.paragraph.create(null, schema.text("Title")),
    );
    const doc = schema.nodes.doc.create(null, [toggle]);
    // End of the summary line: toggle-open(1) + para-open(1) + "Title"(5).
    const { doc: out } = run(doc, 1 + 1 + 5);
    expect(out.childCount).toBe(1);
    expect(out.child(0).type.name).toBe("toggle");
    // summary + the new child — both still inside the toggle.
    expect(out.child(0).childCount).toBe(2);
  });

  it("exits the toggle on Enter from an empty trailing child", () => {
    const toggle = schema.nodes.toggle.create({ open: true }, [
      schema.nodes.paragraph.create(null, schema.text("Title")),
      schema.nodes.paragraph.create(),
    ]);
    const doc = schema.nodes.doc.create(null, [toggle]);
    // Inside the empty trailing child: toggle-open(1) + summary.nodeSize(7) + child-open(1).
    const { doc: out } = run(doc, 1 + 7 + 1);
    expect(out.childCount).toBe(2);
    expect(out.child(0).type.name).toBe("toggle");
    expect(out.child(0).childCount).toBe(1); // only the summary remains inside
    expect(out.child(1).type.name).toBe("paragraph"); // exited below the toggle
  });
});
