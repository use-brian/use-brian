"use client";

// [COMP:app-web/block-indent]
/**
 * The Notion-parity structural keymap — Tab / Shift-Tab / Backspace / Enter
 * block semantics, plus the "caret is never invisible" guard. Spec:
 * `docs/architecture/features/doc.md` → "Editing affordances"; audit + parity
 * contract: `docs/plans/doc-editor-notion-parity-audit.md` (finding IDs like
 * B1/T2/E3 below refer to its §3 tables).
 *
 *   - **Tab** → list `sinkListItem` (with the separate-sibling-wrapper join),
 *     else `indentBlock`: nest the current block under its preceding sibling
 *     when that sibling is a container (`toggle` / `callout` / `blockquote`).
 *     Indenting into a collapsed toggle auto-opens it (T2 — content must never
 *     vanish). Code blocks get a two-space soft tab. Tab is ALWAYS swallowed
 *     and can never throw out of the handler (T1: `sinkListItem('taskItem')`
 *     throws against a flat taskItem schema, and an escaped exception
 *     skips `preventDefault` → the browser's focus traversal fires).
 *   - **Shift-Tab** → Notion outdent ordering (S1/S2): a nested list item
 *     lifts one list level (native `liftListItem`); an item at the top level
 *     of a list directly inside a container moves OUT of the container as its
 *     own same-kind list (it stays a bullet/number/to-do — never converts to
 *     a paragraph in place); an unindented top-level item is a no-op. Other
 *     blocks lift out of their container via `outdentBlock`.
 *   - **Backspace** (at a block start; otherwise native) — three Notion rules
 *     ahead of ProseMirror's wrap-happy `deleteBarrier`:
 *       1. toggle summary → `unwrapToggle`: the toggle unwraps; the summary
 *          becomes a plain block and the children lift to siblings (B3; the
 *          empty-toggle staircase peels one level per press, B6).
 *       2. list item → `unwrapListItem`: un-bullet IN PLACE — the item turns
 *          into a paragraph at the same spot and the list splits around it
 *          (B4). Notion's two-step: first Backspace un-formats, second merges.
 *       3. textblock after a list/container → `joinBackwardIntoVisible`: the
 *          text joins the end of the previous block's last VISIBLE textblock
 *          (a collapsed toggle's summary — never its hidden body, B2) instead
 *          of `deleteBarrier` wrapping it into a brand-new list item (B1, the
 *          "backspace creates bullets" bug) or a hidden toggle child.
 *   - **Enter** in a toggle's summary line (E1–E3): at the start of a
 *     non-empty summary, an empty paragraph inserts ABOVE the toggle (the
 *     title never gets displaced into the body); in a COLLAPSED toggle the
 *     split lands as a paragraph sibling AFTER the toggle (never into the
 *     hidden body); in an open toggle the default split-into-first-child is
 *     already Notion parity. Bails while a slash/mention suggestion popup is
 *     active so the popup keeps its Enter-to-select.
 *   - **Caret guard** (ProseMirror plugin): after any transaction that leaves
 *     the selection inside a collapsed toggle's hidden body, either the
 *     toggle opens (content/caret legitimately moved in — drag-drop, paste,
 *     arrow-through) or, when the toggle was collapsed AROUND an unmoved
 *     caret (chevron click while editing a child), the caret moves out to the
 *     summary. Defense-in-depth for every path the keymap doesn't special-case.
 *
 * The commands are plain ProseMirror `Command`s (no Tiptap-chain wrapping) so
 * they unit-test against a constructed `EditorState`, and run against the live
 * doc through `editor.view.dispatch`. They mutate the shared
 * `@sidanclaw/doc-model` nodes only structurally (move/append children, flip
 * the existing `open` attr) — no schema change, so the Yjs contract is
 * untouched.
 */

import { Extension, type Editor } from "@tiptap/core";
import { Fragment, type Node as PMNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, TextSelection, type Command, type EditorState } from "@tiptap/pm/state";

/** Non-list block kinds that hold nested child blocks (`content: 'block+'`). */
export const CONTAINER_NODES = new Set(["toggle", "callout", "blockquote"]);

/**
 * List wrappers whose first item can be nested (Tab) into the **previous
 * sibling list** of the same kind.
 */
const JOINABLE_LISTS = new Set(["bulletList", "orderedList", "taskList"]);

/** Wrapper kinds Backspace must not let `deleteBarrier` wrap a block into. */
const JOIN_SOURCE_NODES = new Set([
  "bulletList",
  "orderedList",
  "taskList",
  ...CONTAINER_NODES,
]);

/** The list-item node types (the blocks `unwrapListItem` un-bullets). */
const LIST_ITEM_NODES = new Set(["listItem", "taskItem"]);

/** Every list wrapper kind (Tab can nest a block into the last item of one). */
const LIST_WRAPPER_NODES = new Set(["bulletList", "orderedList", "taskList"]);

/**
 * Whether the schema lets a `taskItem` hold a nested `taskList` (true since
 * `TaskItem.configure({ nested: true })`; false against any flat-configured
 * schema, e.g. a unit-test editor). Attempting `sinkListItem('taskItem')`
 * against a flat schema THROWS a RangeError mid-step — checked up front so
 * Tab can skip the sink instead of letting the exception escape
 * `handleKeyDown` (T1).
 */
function taskItemCanNest(state: EditorState): boolean {
  const { taskItem, taskList, paragraph } = state.schema.nodes;
  if (!taskItem || !taskList || !paragraph) return false;
  return !!taskItem.contentMatch.matchType(paragraph)?.matchType(taskList);
}

/**
 * True while any `@tiptap/suggestion` popup (slash menu, `@` mentions) is
 * active — its plugin state carries `{ active, range, … }`. The Enter binding
 * bails then, so the popup (whose plugin runs after this priority-1000
 * keymap) keeps Enter-to-select.
 */
function suggestionActive(state: EditorState): boolean {
  for (const plugin of state.plugins) {
    const s = plugin.getState?.(state) as { active?: boolean; range?: unknown } | null | undefined;
    if (s && typeof s === "object" && "active" in s && "range" in s && s.active) return true;
  }
  return false;
}

/**
 * Indent: move the current block under its previous sibling — into a
 * container's content (toggle/callout/blockquote), or into a LIST's last item
 * (T3/T4: Notion nests a paragraph after a list under the last bullet, and a
 * different-kind list item under the previous list's last item, kind kept).
 * The "current block" is the shallowest ancestor that has a previous sibling —
 * so a cursor in a toggle's summary (no previous sibling) indents the whole
 * toggle, not the summary line. A collapsed toggle target auto-opens (T2):
 * nesting must never hide the moved block (and the caret with it) behind the
 * closed disclosure.
 */
export const indentBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;

  let depth = -1;
  for (let d = 1; d <= $from.depth; d++) {
    if ($from.index(d - 1) > 0) {
      depth = d;
      break;
    }
  }
  if (depth < 0) return false;

  const parent = $from.node(depth - 1);
  const index = $from.index(depth - 1);
  const block = $from.node(depth);
  const prev = parent.child(index - 1);

  // Container target: append to its content.
  if (CONTAINER_NODES.has(prev.type.name)) {
    if (!prev.contentMatchAt(prev.childCount).matchType(block.type)) return false;
    if (dispatch) {
      const before = $from.before(depth);
      const after = $from.after(depth);
      const attrs =
        prev.type.name === "toggle" && !prev.attrs.open
          ? { ...prev.attrs, open: true }
          : prev.attrs;
      const merged = prev.type.create(attrs, prev.content.append(Fragment.from(block)), prev.marks);
      const tr = state.tr.replaceWith(before - prev.nodeSize, after, merged);
      // The block slid one position left (it now sits inside `prev`).
      tr.setSelection(TextSelection.near(tr.doc.resolve(state.selection.from - 1)));
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  // List target: nest into the previous list's LAST item (T3). When the
  // current block is itself a different-kind list (the cursor sits in its
  // first item — same-kind was handled upstream by join+sink), only that one
  // item moves, wrapped in its own kind so a bullet stays a bullet (T4).
  if (LIST_WRAPPER_NODES.has(prev.type.name) && prev.lastChild) {
    const lastItem = prev.lastChild;
    let payload: PMNode = block;
    let rest: PMNode | null = null;
    if (LIST_WRAPPER_NODES.has(block.type.name)) {
      const first = block.firstChild;
      if (!first) return false;
      payload = block.copy(Fragment.from(first));
      if (block.childCount > 1) {
        const remainingItems: PMNode[] = [];
        block.forEach((c, _off, i) => {
          if (i > 0) remainingItems.push(c);
        });
        rest = block.copy(Fragment.fromArray(remainingItems));
      }
    }
    // The last item must accept the payload (a flat `taskItem` accepts
    // nothing after its paragraph — Tab on a block after a to-do list no-ops).
    if (!lastItem.contentMatchAt(lastItem.childCount).matchType(payload.type)) return false;
    if (dispatch) {
      const before = $from.before(depth);
      const after = $from.after(depth);
      const prevStart = before - prev.nodeSize;
      const items: PMNode[] = [];
      prev.forEach((c, _off, i) => {
        items.push(
          i === prev.childCount - 1 ? c.copy(c.content.append(Fragment.from(payload))) : c,
        );
      });
      const mergedList = prev.copy(Fragment.fromArray(items));
      const replacement = rest ? [mergedList, rest] : [mergedList];
      const tr = state.tr.replaceWith(prevStart, after, replacement);
      // The payload now ends the merged list's last item: its start sits two
      // closing tokens (item + list) in from the list's end. The caret keeps
      // its offset within the moved block.
      const payloadStart = prevStart + mergedList.nodeSize - 2 - payload.nodeSize;
      tr.setSelection(
        TextSelection.near(tr.doc.resolve(payloadStart + (state.selection.from - before))),
      );
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  return false;
};

/**
 * Multi-block Tab (T5): indent every block in a non-empty selection into the
 * container right before the first one (collapsed toggles auto-open, as with
 * the single-block path). The native `sinkListItem` already handles ranges
 * INSIDE one list; this covers the block-range case (`BlockAreaSelect` /
 * `NodeRangeSelection` sweeps).
 */
export const indentBlockRange: Command = (state, dispatch) => {
  const { $from, $to, empty } = state.selection;
  if (empty) return false;
  const range = $from.blockRange($to);
  if (!range) return false;
  const { parent, startIndex, endIndex } = range;
  if (startIndex === 0) return false;
  const prev = parent.child(startIndex - 1);
  if (!CONTAINER_NODES.has(prev.type.name)) return false;
  const blocks: PMNode[] = [];
  for (let i = startIndex; i < endIndex; i++) blocks.push(parent.child(i));
  let match = prev.contentMatchAt(prev.childCount);
  for (const b of blocks) {
    const next = match.matchType(b.type);
    if (!next) return false;
    match = next;
  }
  if (dispatch) {
    const prevStart = range.start - prev.nodeSize;
    const attrs =
      prev.type.name === "toggle" && !prev.attrs.open
        ? { ...prev.attrs, open: true }
        : prev.attrs;
    const merged = prev.type.create(attrs, prev.content.append(Fragment.fromArray(blocks)), prev.marks);
    const tr = state.tr.replaceWith(prevStart, range.end, merged);
    // Every block slid one position left (now inside `prev`).
    tr.setSelection(
      TextSelection.between(
        tr.doc.resolve(state.selection.from - 1),
        tr.doc.resolve(state.selection.to - 1),
      ),
    );
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Multi-block Shift-Tab (T5): lift every block in a non-empty selection out
 * of its container, after it. The range must not include the container's
 * first child (the summary) — that case stays a no-op.
 */
export const outdentBlockRange: Command = (state, dispatch) => {
  const { $from, $to, empty } = state.selection;
  if (empty) return false;
  const range = $from.blockRange($to);
  if (!range) return false;
  const container = range.parent;
  if (!CONTAINER_NODES.has(container.type.name)) return false;
  const { startIndex, endIndex, depth } = range;
  if (startIndex === 0) return false;
  if (dispatch) {
    const cBefore = $from.before(depth);
    const cAfter = $from.after(depth);
    const remaining: PMNode[] = [];
    const moved: PMNode[] = [];
    container.forEach((child, _off, i) => {
      if (i >= startIndex && i < endIndex) moved.push(child);
      else remaining.push(child);
    });
    const replacement = remaining.length
      ? [container.copy(Fragment.fromArray(remaining)), ...moved]
      : moved;
    const tr = state.tr.replaceWith(cBefore, cAfter, replacement);
    const movedStart = remaining.length ? cBefore + replacement[0].nodeSize : cBefore;
    const movedSize = moved.reduce((s, n) => s + n.nodeSize, 0);
    tr.setSelection(
      TextSelection.between(
        tr.doc.resolve(movedStart + 1),
        tr.doc.resolve(movedStart + movedSize - 1),
      ),
    );
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Join the current list into the **previous sibling list** of the same kind,
 * when the cursor sits in that list's FIRST item. This is the separate-sibling-
 * lists case the AI write path produces: `applyOpsToYDoc` used to drop every
 * `add`ed list-item block in its own one-item wrapper, so a model-built bullet
 * list was a stack of adjacent `<ul>`s, not one list with many items. Native
 * `sinkListItem` can only nest under a **preceding item inside the same list**,
 * so on the first (only) item of each wrapper it found no sibling and Tab
 * silently no-op'd — you couldn't make a sub-bullet without first dragging the
 * row to merge the lists.
 *
 * Joining the two wrappers gives the item a preceding sibling; the caller then
 * runs `sinkListItem` to nest it. Returns false (no dispatch) when there's no
 * same-kind previous sibling list, so the Tab handler falls through to
 * `indentBlock`.
 */
export const joinPrevSiblingList: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;

  // Innermost list wrapper containing the cursor.
  let wrapperDepth = -1;
  for (let d = $from.depth; d >= 1; d--) {
    if (JOINABLE_LISTS.has($from.node(d).type.name)) {
      wrapperDepth = d;
      break;
    }
  }
  if (wrapperDepth < 0) return false;

  // Only the first item lands here (a later item nests via native sinkListItem).
  if ($from.index(wrapperDepth) !== 0) return false;

  const wrapper = $from.node(wrapperDepth);
  const parentIndex = $from.index(wrapperDepth - 1);
  if (parentIndex === 0) return false; // no preceding sibling — truly first
  const prev = $from.node(wrapperDepth - 1).child(parentIndex - 1);
  if (prev.type !== wrapper.type) return false; // not a same-kind list

  if (dispatch) {
    // Join the boundary between `prev` and `wrapper` into one list. The cursor's
    // item then sits after `prev`'s items, so `sinkListItem` can nest it.
    const tr = state.tr.join($from.before(wrapperDepth));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * The full list-indent the Tab key (and a drag-drop nest) runs on the current
 * selection: native `sinkListItem` first (nests under a preceding item in the
 * same wrapper), then — for the first item of a separate same-kind sibling list
 * — `joinPrevSiblingList` + sink. Returns true if the item nested. Shared so the
 * keymap and the drag handle nest a bullet identically. The to-do sink is
 * gated on the schema actually allowing nested task lists (T1).
 */
export function sinkListItemOrJoin(editor: Editor): boolean {
  if (editor.commands.sinkListItem("listItem")) return true;
  if (taskItemCanNest(editor.state) && editor.commands.sinkListItem("taskItem")) return true;
  if (joinPrevSiblingList(editor.state, editor.view.dispatch)) {
    if (editor.commands.sinkListItem("listItem")) return true;
    return taskItemCanNest(editor.state) && editor.commands.sinkListItem("taskItem");
  }
  return false;
}

/**
 * Outdent: lift the current block out of its enclosing container to become the
 * container's next sibling. A cursor in the container's first child (summary)
 * lifts the whole container instead — and a top-level container can't outdent
 * further, so that's a no-op.
 */
export const outdentBlock: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;

  // Nearest ancestor whose parent is a container.
  let blockDepth = -1;
  for (let d = 2; d <= $from.depth; d++) {
    if (CONTAINER_NODES.has($from.node(d - 1).type.name)) {
      blockDepth = d;
      break;
    }
  }
  if (blockDepth < 0) return false;

  // Cursor in the container's summary (first child) → lift the container itself.
  if ($from.index(blockDepth - 1) === 0) {
    blockDepth -= 1;
    if (blockDepth < 1) return false; // container is top-level → nothing to do
    if (!CONTAINER_NODES.has($from.node(blockDepth - 1).type.name)) return false;
  }

  const containerDepth = blockDepth - 1;
  const container = $from.node(containerDepth);
  const block = $from.node(blockDepth);
  const index = $from.index(containerDepth);

  if (dispatch) {
    const cBefore = $from.before(containerDepth);
    const cAfter = $from.after(containerDepth);
    const remaining: PMNode[] = [];
    container.forEach((child, _off, i) => {
      if (i !== index) remaining.push(child);
    });
    let cursorStart: number;
    let replacement: PMNode[];
    if (remaining.length) {
      const kept = container.copy(Fragment.fromArray(remaining));
      replacement = [kept, block];
      cursorStart = cBefore + kept.nodeSize + 1; // into the lifted block
    } else {
      replacement = [block]; // container had only this block — drop the husk
      cursorStart = cBefore + 1;
    }
    const tr = state.tr.replaceWith(cBefore, cAfter, replacement);
    tr.setSelection(TextSelection.near(tr.doc.resolve(cursorStart)));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Shift-Tab on a list item, Notion ordering (S1/S2). Three cases by what the
 * item's wrapper list sits inside:
 *   - another list item (a nested sub-list) → native `liftListItem`, one list
 *     level up;
 *   - a container (toggle/callout/blockquote) → the item moves OUT of the
 *     container as its own same-kind list right after it — it stays a
 *     bullet/number/to-do (S1: `liftListItem` would un-bullet it in place,
 *     stranding a paragraph inside the toggle);
 *   - the doc top level → no-op (S2; Notion doesn't un-format on Shift-Tab).
 * Returns false when the cursor isn't in a list item at all, so the caller
 * falls through to `outdentBlock`.
 */
export function outdentListItem(editor: Editor): boolean {
  const { $from, empty } = editor.state.selection;

  let itemDepth = -1;
  for (let d = $from.depth; d >= 1; d--) {
    if (LIST_ITEM_NODES.has($from.node(d).type.name)) {
      itemDepth = d;
      break;
    }
  }
  if (itemDepth < 1) return false;

  const itemTypeName = $from.node(itemDepth).type.name as "listItem" | "taskItem";
  const wrapperDepth = itemDepth - 1;
  const wrapperParent = wrapperDepth >= 1 ? $from.node(wrapperDepth - 1) : null;

  // Nested sub-list → native lift, one level (handles multi-item ranges too).
  if (wrapperParent && LIST_ITEM_NODES.has(wrapperParent.type.name)) {
    return editor.commands.liftListItem(itemTypeName);
  }
  // Directly inside a container → move out after it, kind preserved.
  if (wrapperParent && CONTAINER_NODES.has(wrapperParent.type.name)) {
    if (empty) return outdentListItemFromContainer(editor.state, editor.view.dispatch);
    return editor.commands.liftListItem(itemTypeName);
  }
  // Top level → Notion no-op; report handled so Shift-Tab is still swallowed.
  return true;
}

/**
 * Move the cursor's list item out of the container its list sits in, placing
 * it after the container as its own same-kind list (the `ListNormalizer` then
 * merges it with any adjacent same-kind list). Items before/after it stay in
 * the original wrapper; an emptied wrapper is dropped, and a container left
 * with no children at all is dropped too (mirrors `outdentBlock`'s husk rule).
 */
export const outdentListItemFromContainer: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;

  let itemDepth = -1;
  for (let d = $from.depth; d >= 1; d--) {
    if (LIST_ITEM_NODES.has($from.node(d).type.name)) {
      itemDepth = d;
      break;
    }
  }
  if (itemDepth < 2) return false;
  const wrapperDepth = itemDepth - 1;
  const containerDepth = wrapperDepth - 1;
  if (containerDepth < 0) return false;
  if (!CONTAINER_NODES.has($from.node(containerDepth).type.name)) return false;

  const wrapper = $from.node(wrapperDepth);
  const container = $from.node(containerDepth);
  const item = $from.node(itemDepth);
  const itemIndex = $from.index(wrapperDepth);
  const wrapperIndex = $from.index(containerDepth);

  if (dispatch) {
    const cBefore = $from.before(containerDepth);
    const cAfter = $from.after(containerDepth);

    const keptItems: PMNode[] = [];
    wrapper.forEach((child, _off, i) => {
      if (i !== itemIndex) keptItems.push(child);
    });
    const containerChildren: PMNode[] = [];
    container.forEach((child, _off, i) => {
      if (i !== wrapperIndex) containerChildren.push(child);
      else if (keptItems.length) containerChildren.push(wrapper.copy(Fragment.fromArray(keptItems)));
      // else: the wrapper held only this item — drop the husk.
    });

    const lifted = wrapper.copy(Fragment.from(item));
    const replacement: PMNode[] = containerChildren.length
      ? [container.copy(Fragment.fromArray(containerChildren)), lifted]
      : [lifted]; // container would be empty → drop it (block+ forbids empty)
    const tr = state.tr.replaceWith(cBefore, cAfter, replacement);
    const cursorStart = containerChildren.length
      ? cBefore + replacement[0].nodeSize + 2 // into lifted wrapper > item
      : cBefore + 2;
    tr.setSelection(TextSelection.near(tr.doc.resolve(cursorStart)));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Backspace at the very start of a toggle's summary unwraps the toggle: the
 * wrapper is replaced by its children, so the summary becomes a plain block
 * at the toggle's level and the body blocks lift to siblings after it (B3 —
 * Notion's "un-toggle"; the title never merges into the previous block and
 * the first child is never promoted to a surprise summary). Peels one level
 * per press, which is also how a staircase of accidentally-nested empty
 * toggles dismantles (B6 — the old `liftEmptyToggle` behaviour, now without
 * the empty-only guard).
 */
export const unwrapToggle: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;

  if (!$from.parent.isTextblock) return false;
  const toggleDepth = $from.depth - 1;
  if (toggleDepth < 0) return false;
  const toggle = $from.node(toggleDepth);
  if (toggle.type.name !== "toggle") return false;
  if ($from.index(toggleDepth) !== 0) return false; // only the summary line

  if (dispatch) {
    const before = $from.before(toggleDepth);
    const after = $from.after(toggleDepth);
    const tr = state.tr.replaceWith(before, after, toggle.content);
    // Caret stays at the start of the (now-lifted) summary text.
    tr.setSelection(TextSelection.near(tr.doc.resolve(before + 1)));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Backspace at the start of a list item un-formats it IN PLACE (B4, Notion's
 * two-step delete): the item's content lifts to the wrapper's level — a
 * paragraph where the bullet was — and the list splits around it. Items
 * before/after stay in their own wrappers (the `ListNormalizer` never merges
 * across the new paragraph). A nested item un-bullets at its own indent
 * level. The to-do variant drops its `checked` state with the marker.
 */
export const unwrapListItem: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  if (!$from.parent.isTextblock) return false;

  const itemDepth = $from.depth - 1;
  if (itemDepth < 1) return false;
  const item = $from.node(itemDepth);
  if (!LIST_ITEM_NODES.has(item.type.name)) return false;
  if ($from.index(itemDepth) !== 0) return false; // caret in the item's lead textblock

  const wrapperDepth = itemDepth - 1;
  const wrapper = $from.node(wrapperDepth);
  const itemIndex = $from.index(wrapperDepth);

  if (dispatch) {
    const wBefore = $from.before(wrapperDepth);
    const wAfter = $from.after(wrapperDepth);
    const beforeItems: PMNode[] = [];
    const afterItems: PMNode[] = [];
    wrapper.forEach((child, _off, i) => {
      if (i < itemIndex) beforeItems.push(child);
      else if (i > itemIndex) afterItems.push(child);
    });
    const replacement: PMNode[] = [];
    if (beforeItems.length) replacement.push(wrapper.copy(Fragment.fromArray(beforeItems)));
    const cursorStart = wBefore + (beforeItems.length ? replacement[0].nodeSize : 0);
    item.forEach((child) => replacement.push(child)); // lead paragraph + any nested list
    if (afterItems.length) replacement.push(wrapper.copy(Fragment.fromArray(afterItems)));
    const tr = state.tr.replaceWith(wBefore, wAfter, replacement);
    tr.setSelection(TextSelection.near(tr.doc.resolve(cursorStart + 1)));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * The textblock a Backspace-join lands in: the last VISIBLE textblock inside
 * `node`. Descends along last children — except into a COLLAPSED toggle,
 * where only the summary (first child) is visible. `pos` is the position just
 * before `node`; returns the position just before the found textblock.
 */
function lastVisibleTextblock(
  node: PMNode,
  pos: number,
): { node: PMNode; pos: number } | null {
  if (node.isTextblock) return { node, pos };
  if (node.isLeaf || node.childCount === 0) return null;
  if (node.type.name === "toggle" && !node.attrs.open) {
    return lastVisibleTextblock(node.firstChild as PMNode, pos + 1);
  }
  const last = node.lastChild as PMNode;
  return lastVisibleTextblock(last, pos + 1 + node.content.size - last.nodeSize);
}

/**
 * Backspace at the start of a textblock whose previous sibling is a list or a
 * container: join the text into that sibling's last VISIBLE textblock (B1/B2).
 * This pre-empts ProseMirror's `deleteBarrier`, whose wrap-and-join would
 * instead absorb the block INTO the structure — a paragraph after a list
 * became a brand-new bullet, and a paragraph after a collapsed toggle
 * vanished into the hidden body. Notion never re-wraps on Backspace.
 */
export const joinBackwardIntoVisible: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty || $from.parentOffset !== 0) return false;
  const block = $from.parent;
  if (!block.isTextblock) return false;

  const depth = $from.depth;
  if (depth < 1) return false;
  const index = $from.index(depth - 1);
  if (index === 0) return false; // first child — the toggle/list commands own that
  const prev = $from.node(depth - 1).child(index - 1);
  if (!JOIN_SOURCE_NODES.has(prev.type.name)) return false;

  const target = lastVisibleTextblock(prev, $from.before(depth) - prev.nodeSize);
  if (!target) return false; // e.g. the structure ends in an atom — let PM defaults run
  if (!target.node.type.validContent(block.content)) return false; // e.g. mention into codeBlock

  if (dispatch) {
    const blockBefore = $from.before(depth);
    const blockAfter = $from.after(depth);
    const targetEnd = target.pos + 1 + target.node.content.size;
    const tr = state.tr.delete(blockBefore, blockAfter);
    if (block.content.size) tr.insert(targetEnd, block.content);
    tr.setSelection(TextSelection.create(tr.doc, targetEnd));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Enter on a toggle's summary line (E1–E3). At the very start of a non-empty
 * summary the toggle is pushed down — an empty paragraph inserts ABOVE it and
 * the title stays put (E3; the default split would crown an empty paragraph
 * as the new summary and hide the real title in the body). In a COLLAPSED
 * toggle the split lands AFTER the toggle as a plain paragraph sibling
 * carrying the tail text (E1/E2; the default put it — and the caret — into
 * the `display: none` body). An OPEN toggle keeps the default split: the new
 * line becomes the first child, which is Notion parity (E4).
 */
export const toggleSummaryEnter: Command = (state, dispatch) => {
  const { $from, empty } = state.selection;
  if (!empty) return false;
  const summary = $from.parent;
  if (!summary.isTextblock) return false;
  const toggleDepth = $from.depth - 1;
  if (toggleDepth < 0) return false;
  const toggle = $from.node(toggleDepth);
  if (toggle.type.name !== "toggle") return false;
  if ($from.index(toggleDepth) !== 0) return false; // only the summary line
  if (suggestionActive(state)) return false; // popup owns Enter-to-select

  const paragraph = state.schema.nodes.paragraph;

  // Start of a non-empty summary → push the toggle down, title stays.
  if ($from.parentOffset === 0 && summary.content.size > 0) {
    if (dispatch) {
      const tr = state.tr.insert($from.before(toggleDepth), paragraph.create());
      dispatch(tr.scrollIntoView());
    }
    return true;
  }

  // Open toggle: the default split-into-first-child is already Notion.
  if (toggle.attrs.open) return false;

  if (dispatch) {
    const after = $from.after(toggleDepth);
    const summaryEnd = $from.end();
    const tail = summary.content.cut($from.parentOffset, summary.content.size);
    const tr = state.tr;
    if (tail.size) tr.delete($from.pos, summaryEnd);
    const insertPos = tr.mapping.map(after);
    tr.insert(insertPos, paragraph.create(null, tail));
    tr.setSelection(TextSelection.create(tr.doc, insertPos + 1));
    dispatch(tr.scrollIntoView());
  }
  return true;
};

/**
 * Mod-Enter, Notion-style (A5): with the caret in a to-do, flip its `checked`;
 * otherwise, with the caret anywhere inside a toggle (summary or body), flip
 * its `open`. Closing a toggle from inside its body hands the caret to the
 * caret guard, which moves it out to the summary. Falls through (hard break)
 * outside both.
 */
export const modEnterDisclosure: Command = (state, dispatch) => {
  const { $from } = state.selection;
  for (let d = $from.depth; d >= 1; d--) {
    const node = $from.node(d);
    if (node.type.name === "taskItem") {
      if (dispatch) {
        const tr = state.tr.setNodeMarkup($from.before(d), undefined, {
          ...node.attrs,
          checked: !node.attrs.checked,
        });
        dispatch(tr);
      }
      return true;
    }
    if (node.type.name === "toggle") {
      if (dispatch) {
        const tr = state.tr.setNodeMarkup($from.before(d), undefined, {
          ...node.attrs,
          open: !node.attrs.open,
        });
        dispatch(tr);
      }
      return true;
    }
  }
  return false;
};

const caretGuardKey = new PluginKey("docToggleCaretGuard");

/**
 * "The caret is never invisible" (RC1 in the audit). After any transaction
 * that leaves the selection head inside a collapsed toggle's hidden body
 * (anything past the first child — CSS `display: none`):
 *   - if the head MOVED there (drag-drop, paste, arrow-through — `docChanged`
 *     with a remapped head, or a pure selection move), the collapsed
 *     ancestors OPEN, so the content and caret stay visible;
 *   - if the toggle was collapsed AROUND an unmoved caret (the chevron click
 *     while editing a child; a collaborator collapsing remotely), the caret
 *     moves out to the end of the summary instead — re-opening would make the
 *     chevron un-clickable for anyone with a caret inside.
 * Edit-gated; the fix-up never lands in the undo history as its own step.
 */
function toggleCaretGuard(editor: Editor): Plugin {
  return new Plugin({
    key: caretGuardKey,
    appendTransaction(transactions, oldState, newState) {
      if (!editor?.isEditable) return null;
      const { $head } = newState.selection;
      // Collapsed toggle ancestors whose hidden region holds the head.
      const hiddenAt: number[] = [];
      for (let d = 1; d <= $head.depth; d++) {
        const node = $head.node(d);
        if (node.type.name === "toggle" && !node.attrs.open && $head.index(d) > 0) {
          hiddenAt.push($head.before(d));
        }
      }
      if (!hiddenAt.length) return null;

      const docChanged = transactions.some((tr) => tr.docChanged);
      const mappedOldHead = transactions.reduce(
        (pos, tr) => tr.mapping.map(pos),
        oldState.selection.head,
      );
      // Unmoved caret + a doc change ⇒ the toggle collapsed around it.
      if (docChanged && mappedOldHead === newState.selection.head) {
        const outermost = hiddenAt[0];
        const summary = newState.doc.nodeAt(outermost)?.firstChild;
        if (!summary) return null;
        const tr = newState.tr.setSelection(
          TextSelection.near(newState.doc.resolve(outermost + 1 + summary.nodeSize - 1), -1),
        );
        tr.setMeta("addToHistory", false);
        return tr;
      }
      // Otherwise the caret/content legitimately moved in — open the way.
      const tr = newState.tr;
      for (const pos of hiddenAt) {
        const node = tr.doc.nodeAt(pos);
        if (node?.type.name === "toggle") {
          tr.setNodeMarkup(pos, undefined, { ...node.attrs, open: true });
        }
      }
      if (!tr.steps.length) return null;
      tr.setMeta("addToHistory", false);
      return tr;
    },
  });
}

/** Tab / Shift-Tab / Backspace / Enter keymap + caret guard. High priority so
 *  it owns the keys before any node (the suggestion popups run after it and
 *  are bailed to explicitly). The Tab/Shift-Tab bodies are exception-proofed:
 *  a command that throws must still swallow the key, or `preventDefault` is
 *  skipped and the browser's focus traversal fires (T1). */
export const BlockIndent = Extension.create({
  name: "blockIndent",
  priority: 1000,
  addKeyboardShortcuts() {
    return {
      // Notion Backspace at a block start: un-toggle → un-bullet → join into
      // the previous block's last visible line. Anything else falls through
      // to the editor's default Backspace (returns false → no-op here).
      Backspace: ({ editor }) =>
        unwrapToggle(editor.state, editor.view.dispatch) ||
        unwrapListItem(editor.state, editor.view.dispatch) ||
        joinBackwardIntoVisible(editor.state, editor.view.dispatch),
      // Toggle-summary Enter (E1–E3); everything else keeps the default.
      Enter: ({ editor }) => toggleSummaryEnter(editor.state, editor.view.dispatch),
      // Notion Mod-Enter: check a to-do / flip a toggle. Falls through to the
      // default (hard break) outside both.
      "Mod-Enter": ({ editor }) => modEnterDisclosure(editor.state, editor.view.dispatch),
      Tab: ({ editor }) => {
        try {
          if (editor.isActive("codeBlock")) {
            editor.commands.insertContent("  ");
            return true;
          }
          // Native sink (handles in-list ranges too), else (first item of a
          // separate same-kind sibling list — the AI-authored stacked-wrappers
          // case) join the previous list + sink.
          if (sinkListItemOrJoin(editor)) return true;
          // Multi-block selection → indent the whole range (T5).
          if (indentBlockRange(editor.state, editor.view.dispatch)) return true;
          indentBlock(editor.state, editor.view.dispatch);
        } catch (err) {
          // A structural command must never let an exception escape the key
          // handler — that skips preventDefault and Tab traverses focus.
          console.error("doc Tab handler error", err);
        }
        return true; // swallow Tab so it never traverses focus
      },
      "Shift-Tab": ({ editor }) => {
        try {
          if (editor.isActive("codeBlock")) return true;
          if (outdentListItem(editor)) return true;
          // Multi-block selection → lift the whole range out (T5).
          if (outdentBlockRange(editor.state, editor.view.dispatch)) return true;
          outdentBlock(editor.state, editor.view.dispatch);
        } catch (err) {
          console.error("doc Shift-Tab handler error", err);
        }
        return true;
      },
    };
  },
  addProseMirrorPlugins() {
    return [toggleCaretGuard(this.editor)];
  },
});
