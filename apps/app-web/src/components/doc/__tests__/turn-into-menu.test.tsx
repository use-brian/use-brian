/**
 * [COMP:app-web/turn-into-menu] Turn-into block conversion.
 *
 * Three surfaces (app-web vitest is node-only):
 *   1. `TURN_INTO_ITEMS` — the conversion catalogue (the prose subset).
 *   2. `applyTurnInto` — the kind→chain dispatch, against a recorded chain.
 *   3. `<TurnIntoMenu>` SSR markup — the collapsed trigger.
 */

import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Editor } from "@tiptap/core";
import { I18nProvider } from "@/lib/i18n/client";
import { en } from "@/lib/i18n/dictionaries/en";
import type { Dictionary } from "@/lib/i18n/dictionaries";
import {
  TURN_INTO_ITEMS,
  TurnIntoMenu,
  applyTurnInto,
  isActiveTurnIntoKind,
  type TurnIntoKind,
} from "../turn-into-menu";

const dict = en as unknown as Dictionary;

function makeEditor(): { editor: Editor; calls: string[] } {
  const calls: string[] = [];
  function makeChain(prefix: string): unknown {
    return new Proxy(
      {},
      {
        get(_t, prop) {
          if (prop === "run") {
            return () => {
              calls.push(prefix);
              return true;
            };
          }
          return (...args: unknown[]) => {
            const next =
              prefix +
              (prefix ? "." : "") +
              String(prop) +
              (args.length
                ? `(${args.map((a) => JSON.stringify(a)).join(",")})`
                : "()");
            return makeChain(next);
          };
        },
      },
    );
  }
  const editor = { chain: () => makeChain("") } as unknown as Editor;
  return { editor, calls };
}

describe("[COMP:app-web/turn-into-menu] TURN_INTO_ITEMS", () => {
  it("covers the convertible subset (12 items, incl. Heading 4 + Code) with unique ids", () => {
    expect(TURN_INTO_ITEMS).toHaveLength(12);
    const ids = TURN_INTO_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
    // CHROME-2 / CHROME-3: Heading 4 + Code are first-class slash-menu kinds,
    // so turn-into must offer them too.
    expect(ids).toContain("heading_4" as TurnIntoKind);
    expect(ids).toContain("code" as TurnIntoKind);
  });

  it("excludes media / database / divider kinds (those are insert-only)", () => {
    const ids = new Set(TURN_INTO_ITEMS.map((i) => i.id));
    for (const excluded of ["image", "file", "bookmark", "data", "chart", "divider"]) {
      expect(ids.has(excluded as TurnIntoKind)).toBe(false);
    }
  });

  it("every item's labelKey resolves in the slash-menu items dictionary", () => {
    for (const item of TURN_INTO_ITEMS) {
      expect(dict.docPage.slashMenu.items[item.labelKey]).toBeTruthy();
    }
  });
});

describe("[COMP:app-web/turn-into-menu] applyTurnInto", () => {
  const cases: [TurnIntoKind, string][] = [
    ["paragraph", "focus().setParagraph()"],
    ["heading_1", 'focus().setHeading({"level":1})'],
    ["heading_2", 'focus().setHeading({"level":2})'],
    ["heading_3", 'focus().setHeading({"level":3})'],
    ["heading_4", 'focus().setHeading({"level":4})'],
    ["bulleted_list", "focus().toggleBulletList()"],
    ["numbered_list", "focus().toggleOrderedList()"],
    ["to_do", "focus().toggleTaskList()"],
    ["quote", "focus().toggleBlockquote()"],
    ["callout", 'focus().wrapIn("callout")'],
    ["toggle", 'focus().wrapIn("toggle")'],
    ["code", "focus().setCodeBlock()"],
  ];

  for (const [kind, expected] of cases) {
    it(`${kind} → ${expected}`, () => {
      const { editor, calls } = makeEditor();
      const ok = applyTurnInto(editor, kind);
      expect(ok).toBe(true);
      expect(calls[0]).toBe(expected);
    });
  }
});

describe("[COMP:app-web/turn-into-menu] isActiveTurnIntoKind (CHROME-4 checkmark)", () => {
  const mk = (active: (name: string, attrs?: { level?: number }) => boolean) =>
    ({ isActive: active }) as unknown as Editor;

  it("matches a node type/level to its turn-into kind", () => {
    expect(
      isActiveTurnIntoKind(mk((n, a) => n === "heading" && a?.level === 2), "heading_2"),
    ).toBe(true);
    expect(isActiveTurnIntoKind(mk((n) => n === "codeBlock"), "code")).toBe(true);
    expect(isActiveTurnIntoKind(mk((n) => n === "bulletList"), "bulleted_list")).toBe(true);
    expect(isActiveTurnIntoKind(mk((n) => n === "blockquote"), "quote")).toBe(true);
  });

  it("a paragraph nested in a list/container reports that kind, not Text", () => {
    expect(isActiveTurnIntoKind(mk((n) => n === "paragraph"), "paragraph")).toBe(true);
    expect(
      isActiveTurnIntoKind(mk((n) => n === "paragraph" || n === "bulletList"), "paragraph"),
    ).toBe(false);
  });
});

describe("[COMP:app-web/turn-into-menu] TurnIntoMenu render", () => {
  it("renders the collapsed trigger (menu list hidden until opened)", () => {
    const { editor } = makeEditor();
    const html = renderToStaticMarkup(
      <I18nProvider locale="en" dict={dict}>
        <TurnIntoMenu editor={editor} />
      </I18nProvider>,
    );
    expect(html).toMatch(/data-action="open-turn-into"/);
    expect(html).toMatch(/aria-label="Turn into"/);
    expect(html).toMatch(/aria-expanded="false"/);
    // The popover list is not in the SSR markup while collapsed.
    expect(html).not.toMatch(/data-popover="turn-into"/);
  });
});
