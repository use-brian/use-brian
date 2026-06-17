"use client";

// [COMP:app-web/smart-arrows]
/**
 * Notion-style smart-arrow text replacement. Typing `->` becomes `→` and
 * `<-` becomes `←` the instant the closing character lands — the same inline
 * shortcut Notion ships.
 *
 * This is deliberately the *arrow subset* of Tiptap's own
 * `@tiptap/extension-typography`; we don't enable that extension wholesale
 * because its `--` / `---` rules inject the en/em dash this project bans from
 * copy (see the root `CLAUDE.md` em-dash rule) and its smart-quote / ellipsis
 * rewrites would change far more typing than the user asked for.
 *
 * An input rule only rewrites the text a user types — the resulting `→` / `←`
 * are ordinary characters in the inline content, so there is NO node/mark
 * schema change and the byte-for-byte Yjs contract with the sync server is
 * untouched. That's the same reasoning that keeps `BlockIndent` /
 * `ListNormalizer` browser-only (see `doc-schema.ts`); input rules are
 * editor plugins, which `getSchema` ignores when the Yjs server derives the
 * shared schema. Tiptap's input-rule plugin already skips code blocks and
 * inline-code spans, so `->` stays literal inside code. Pressing Backspace
 * right after the swap undoes it (`textInputRule` is undoable), matching the
 * editor's other markdown shortcuts.
 */

import { Extension, textInputRule } from "@tiptap/core";

export const SmartArrows = Extension.create({
  name: "smartArrows",

  addInputRules() {
    return [
      textInputRule({ find: /->$/, replace: "→" }),
      textInputRule({ find: /<-$/, replace: "←" }),
    ];
  },
});
