/**
 * Remote focus — where the OTHER people on this page are working.
 *
 * Replaces the stock `CollaborationCursor` look. The stock caret renders the
 * peer's name as a `<div>` inside the caret span; the doc editor never styled
 * it, so a block-level div inside a text line painted a full-width bar in the
 * peer's colour straight through the page. Presence here is deliberately
 * quiet instead:
 *
 * - **Caret** (`remoteCaret`, the `CollaborationCursor.render` override): a
 *   2px line in the peer's colour, no label. The name lives in a `title`
 *   tooltip and in the gutter avatar, never inline in the text.
 * - **Block tint** (`createRemoteFocusExtension`): the block a peer's cursor
 *   sits in (its textblock, else its top-level block) gets a node decoration
 *   (`.doc-remote-focus`) that CSS turns into a faint wash in the peer's
 *   colour.
 * - **Gutter avatar**: a widget at the start of that textblock renders each
 *   peer's photo (initials fallback), absolutely positioned into the right
 *   gutter and aligned to the block's first line.
 *   Several peers in one block share one stack; the same person open in two
 *   tabs collapses to one face (deduped by `user.id`, as `usePresence` does).
 *
 * View-layer only, like `find-in-page.ts`: decorations contribute nothing to
 * the document, so nothing here ever reaches Yjs. The local client is always
 * skipped — your own position is your own caret.
 *
 * [COMP:app-web/remote-focus]
 */

import { Extension } from "@tiptap/core";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";
import type { Node as PMNode } from "@tiptap/pm/model";
import type { HocuspocusProvider } from "@hocuspocus/provider";
import * as Y from "yjs";
import { relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import { readableTextColor } from "@/lib/collab/cursor-color";

export type RemoteFocusUser = {
  id?: string;
  name?: string;
  avatarUrl?: string | null;
  color?: string;
};

/** One remote client's resolved cursor head. */
export type RemotePeer = { clientId: number; head: number; user: RemoteFocusUser };

/**
 * A block with the (deduped) people focused in it. `textblock` blocks can host
 * the gutter avatar inside them (a widget at `from + 1`); a non-text block (an
 * image, embed, divider under a node selection) only gets the tint.
 */
export type RemoteFocusBlock = {
  from: number;
  to: number;
  textblock: boolean;
  users: RemoteFocusUser[];
};

const FALLBACK_COLOR = "#8E4EC6";

/**
 * Pure: map each peer's cursor head to the block it is working in and group
 * peers per block. That block is the textblock holding the head (a paragraph,
 * heading, list-item line, table-cell line) so the highlight hugs the line the
 * peer is on; a head that is not inside a textblock falls back to its
 * top-level block, and a head sitting between top-level blocks (a node
 * selection on an atom) credits the block after it. Heads are clamped into the
 * document.
 */
export function groupRemoteFocus(doc: PMNode, peers: RemotePeer[]): RemoteFocusBlock[] {
  const byBlock = new Map<number, RemoteFocusBlock>();
  const max = Math.max(doc.content.size - 1, 0);
  for (const peer of peers) {
    const head = Math.min(Math.max(peer.head, 0), max);
    const $pos = doc.resolve(head);
    let from: number;
    let to: number;
    let textblock = false;
    if ($pos.depth < 1) {
      // Between top-level blocks: a node selection on an atom (image,
      // divider, embed) puts the head here. Credit the block after it.
      const after = $pos.nodeAfter;
      if (!after) continue;
      from = head;
      to = head + after.nodeSize;
    } else {
      textblock = $pos.parent.isTextblock;
      const depth = textblock ? $pos.depth : 1;
      from = $pos.before(depth);
      to = from + $pos.node(depth).nodeSize;
    }
    const block = byBlock.get(from) ?? { from, to, textblock, users: [] };
    const key = peer.user.id ?? `client:${peer.clientId}`;
    if (!block.users.some((u) => u.id === key)) {
      block.users.push({ ...peer.user, id: key });
    }
    byBlock.set(from, block);
  }
  return [...byBlock.values()].sort((a, b) => a.from - b.from);
}

/** Initials for the avatar fallback ("Ada Lovelace" -> "AL"). */
export function initialsOf(name: string | undefined): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0]![0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1]![0] ?? "") : "";
  return (first + last).toUpperCase();
}

/** `CollaborationCursor.render` override: a thin caret, no inline label. */
export function remoteCaret(user: RemoteFocusUser): HTMLElement {
  const caret = document.createElement("span");
  caret.className = "doc-remote-caret";
  caret.style.setProperty("--doc-remote-color", user.color ?? FALLBACK_COLOR);
  if (user.name) caret.title = user.name;
  // Zero-width joiner keeps the span measurable without adding text width.
  caret.appendChild(document.createTextNode("⁠"));
  return caret;
}

function avatarFace(user: RemoteFocusUser): HTMLElement {
  const color = user.color ?? FALLBACK_COLOR;
  const face = document.createElement("span");
  face.className = "doc-remote-avatar";
  face.style.setProperty("--doc-remote-color", color);
  face.style.color = readableTextColor(color);
  if (user.name) face.title = user.name;
  const showInitials = () => {
    face.replaceChildren(document.createTextNode(initialsOf(user.name)));
  };
  if (user.avatarUrl) {
    const img = document.createElement("img");
    img.src = user.avatarUrl;
    img.alt = "";
    img.referrerPolicy = "no-referrer";
    img.draggable = false;
    img.addEventListener("error", showInitials, { once: true });
    face.appendChild(img);
  } else {
    showInitials();
  }
  return face;
}

function buildDecorations(state: EditorState, awareness: HocuspocusProvider["awareness"]): DecorationSet {
  const ystate = ySyncPluginKey.getState(state);
  if (
    !awareness ||
    !ystate ||
    ystate.snapshot != null ||
    ystate.prevSnapshot != null ||
    ystate.binding?.mapping?.size === 0
  ) {
    return DecorationSet.empty;
  }
  const peers: RemotePeer[] = [];
  awareness.getStates().forEach((aw, clientId) => {
    if (clientId === awareness.clientID || aw?.cursor == null) return;
    const head = relativePositionToAbsolutePosition(
      ystate.doc,
      ystate.type,
      Y.createRelativePositionFromJSON(aw.cursor.head),
      ystate.binding.mapping,
    );
    if (head == null) return;
    peers.push({ clientId, head, user: (aw.user ?? {}) as RemoteFocusUser });
  });
  if (peers.length === 0) return DecorationSet.empty;

  const decorations: Decoration[] = [];
  for (const block of groupRemoteFocus(state.doc, peers)) {
    const color = block.users[0]?.color ?? FALLBACK_COLOR;
    decorations.push(
      Decoration.node(block.from, block.to, {
        class: "doc-remote-focus",
        style: `--doc-remote-color: ${color}`,
      }),
    );
    if (!block.textblock) continue;
    const signature = block.users.map((u) => `${u.id}|${u.name}|${u.avatarUrl}|${u.color}`).join(",");
    decorations.push(
      Decoration.widget(
        block.from + 1,
        () => {
          const stack = document.createElement("span");
          stack.className = "doc-remote-avatars";
          stack.contentEditable = "false";
          stack.setAttribute("aria-hidden", "true");
          for (const user of block.users) stack.appendChild(avatarFace(user));
          return stack;
        },
        { side: -1, key: `remote-focus:${signature}`, ignoreSelection: true },
      ),
    );
  }
  return DecorationSet.create(state.doc, decorations);
}

const remoteFocusKey = new PluginKey<DecorationSet>("docRemoteFocus");

export function createRemoteFocusExtension(provider: HocuspocusProvider) {
  return Extension.create({
    name: "docRemoteFocus",
    addProseMirrorPlugins() {
      const awareness = provider.awareness;
      return [
        new Plugin<DecorationSet>({
          key: remoteFocusKey,
          state: {
            init: (_, state) => (awareness ? buildDecorations(state, awareness) : DecorationSet.empty),
            apply: (tr, prev, _old, next) => {
              if (!awareness) return prev;
              if (tr.getMeta(remoteFocusKey) || tr.docChanged) return buildDecorations(next, awareness);
              return prev;
            },
          },
          props: {
            decorations: (state) => remoteFocusKey.getState(state),
          },
          view: (view) => {
            if (!awareness) return {};
            const onChange = ({
              added,
              updated,
              removed,
            }: {
              added: number[];
              updated: number[];
              removed: number[];
            }) => {
              // Our own cursor moves never change what we draw (self is skipped),
              // so ignore frames that touch only the local client.
              const ids = [...added, ...updated, ...removed];
              if (ids.every((id) => id === awareness.clientID)) return;
              // The view may be mid-teardown when a late awareness frame lands.
              if (view.isDestroyed) return;
              view.dispatch(view.state.tr.setMeta(remoteFocusKey, true));
            };
            awareness.on("change", onChange);
            return { destroy: () => awareness.off("change", onChange) };
          },
        }),
      ];
    },
  });
}
