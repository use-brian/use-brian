/**
 * [COMP:app-web/slash-execute] executeSlashItem — runs the editor command
 * for a chosen slash-menu item.
 *
 * app-web's vitest is node-only (no DOM / real editor), so we exercise the
 * dispatch table against a recorded `chain()` proxy — the same pattern
 * floating-toolbar.test.tsx uses. The contract under test is "which Tiptap
 * chain does each slash kind run", not ProseMirror's apply (that's e2e).
 */

import { describe, expect, it } from "vitest";
import type { Editor } from "@tiptap/core";
import { executeSlashItem } from "../slash-execute";
import { SLASH_MENU_ITEMS, type SlashMenuItem } from "../slash-menu";

/** Records the chain calls; `.run()` returns true and flushes the trail. */
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
  // executeSlashItem reads the current block's emptiness + node range to choose
  // transform-in-place (prose) vs replace-the-empty-block (atoms) — SLASH-2.
  // The recorded-chain editor models an EMPTY current block at a fixed range.
  const editor = {
    chain: () => makeChain(""),
    state: {
      selection: {
        $from: {
          parent: { isTextblock: true, content: { size: 0 } },
          before: () => 0,
          after: () => 2,
        },
      },
    },
  } as unknown as Editor;
  return { editor, calls };
}

function itemFor(id: string): SlashMenuItem {
  const item = SLASH_MENU_ITEMS.find((i) => i.id === id);
  if (!item) throw new Error(`no slash item ${id}`);
  return item;
}

/** Pull the inserted NODE (the 2nd arg) out of a recorded
 *  `focus().insertContentAt({"from":N,"to":M},{node})` call string. */
function nodeArg(call: string): Record<string, unknown> & { [k: string]: any } {
  const json = call
    .replace(/^focus\(\)\.insertContentAt\(\{"from":\d+,"to":\d+\},/, "")
    .replace(/\)$/, "");
  return JSON.parse(json);
}

describe("[COMP:app-web/slash-execute] executeSlashItem", () => {
  it("paragraph → focus().setParagraph()", () => {
    const { editor, calls } = makeEditor();
    executeSlashItem(editor, itemFor("paragraph"));
    expect(calls[0]).toBe("focus().setParagraph()");
  });

  it("heading_1/2/3 → focus().setHeading({ level }) with the item's level", () => {
    for (const [id, level] of [
      ["heading_1", 1],
      ["heading_2", 2],
      ["heading_3", 3],
    ] as const) {
      const { editor, calls } = makeEditor();
      executeSlashItem(editor, itemFor(id));
      expect(calls[0]).toBe(`focus().setHeading({"level":${level}})`);
    }
  });

  it("list kinds → the matching toggle command", () => {
    const cases: [string, string][] = [
      ["bulleted_list", "focus().toggleBulletList()"],
      ["numbered_list", "focus().toggleOrderedList()"],
      ["to_do", "focus().toggleTaskList()"],
    ];
    for (const [id, expected] of cases) {
      const { editor, calls } = makeEditor();
      executeSlashItem(editor, itemFor(id));
      expect(calls[0]).toBe(expected);
    }
  });

  it("quote → toggleBlockquote, code → setCodeBlock (transform in place)", () => {
    const cases: [string, string][] = [
      ["quote", "focus().toggleBlockquote()"],
      ["code", "focus().setCodeBlock()"],
    ];
    for (const [id, expected] of cases) {
      const { editor, calls } = makeEditor();
      executeSlashItem(editor, itemFor(id));
      expect(calls[0]).toBe(expected);
    }
  });

  it("divider replaces the empty block with a horizontalRule (SLASH-2)", () => {
    const { editor, calls } = makeEditor();
    executeSlashItem(editor, itemFor("divider"));
    expect(calls[0]).toMatch(/^focus\(\)\.insertContentAt\(/);
    expect(nodeArg(calls[0]).type).toBe("horizontalRule");
  });

  it("callout / toggle replace the empty block with a schema-valid container (SLASH-2)", () => {
    for (const id of ["callout", "toggle"] as const) {
      const { editor, calls } = makeEditor();
      executeSlashItem(editor, itemFor(id));
      // The empty current block is REPLACED with the container (no stray empty
      // paragraph left behind) via insertContentAt over its node range.
      expect(calls[0]).toMatch(/^focus\(\)\.insertContentAt\(/);
      const payload = nodeArg(calls[0]);
      expect(payload.type).toBe(id);
      expect(typeof payload.attrs.blockId).toBe("string");
      expect((payload.content as { type: string }[])[0].type).toBe("paragraph");
    }
  });

  it("embed kinds insert an `embed` node carrying the block kind + id", () => {
    // Each embed item replaces the empty block with an `embed` atom whose stored
    // block JSON carries its `blockKind` (Table view → `data`) + the same id.
    // Media kinds also seed the empty/awaiting-URL shape so the stub round-trips
    // through validation.
    for (const id of ["image", "file", "bookmark", "video", "audio", "table_view", "chart"]) {
      const item = itemFor(id);
      const { editor, calls } = makeEditor();
      executeSlashItem(editor, item);
      expect(calls[0]).toMatch(/^focus\(\)\.insertContentAt\(/);
      const payload = nodeArg(calls[0]);
      expect(payload.type).toBe("embed");
      const block = JSON.parse(payload.attrs.block as string);
      expect(block.kind).toBe(item.blockKind);
      expect(block.id).toBe((payload.attrs as { blockId: string }).blockId);
      if (id === "video" || id === "audio") expect(block.url).toBe("");
    }
  });

  it("the simple-table item inserts a native `table` node (not an embed)", () => {
    const { editor, calls } = makeEditor();
    executeSlashItem(editor, itemFor("table"));
    expect(calls[0]).toMatch(/^focus\(\)\.insertContentAt\(/);
    const payload = nodeArg(calls[0]);
    expect(payload.type).toBe("table");
    expect(typeof payload.attrs.blockId).toBe("string");
    // 3 rows, header row first, each cell a paragraph (co-editable cells).
    expect(payload.content).toHaveLength(3);
    expect(payload.content[0].content[0].type).toBe("tableHeader");
    expect(payload.content[1].content[0].type).toBe("tableCell");
    expect(payload.content[0].content[0].content[0].type).toBe("paragraph");
  });

  it("is a no-op for the editor-handled Page / Link-to-page / Template items", () => {
    // `child_page` (Page), `link_to_page`, and `template` are intercepted by the
    // editor's slash `onSelect` — `executeSlashItem` runs no chain, returns false.
    for (const id of ["page", "link_to_page", "template"]) {
      const { editor, calls } = makeEditor();
      const ok = executeSlashItem(editor, itemFor(id));
      expect(ok).toBe(false);
      expect(calls).toHaveLength(0);
    }
  });

  it("runs a single command for every synchronous catalogue item", () => {
    for (const item of SLASH_MENU_ITEMS) {
      // Page / Link-to-page / Template are async/picker actions handled by the editor.
      if (
        item.blockKind === "child_page" ||
        item.blockKind === "link_to_page" ||
        item.blockKind === "template"
      ) {
        continue;
      }
      const { editor, calls } = makeEditor();
      const ok = executeSlashItem(editor, item);
      expect(ok).toBe(true);
      expect(calls).toHaveLength(1);
    }
  });
});
