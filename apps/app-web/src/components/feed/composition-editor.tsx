"use client";
/** Feed ProseMirror authoring with stable target decorations. [COMP:app-web/feed-composition-editor] */
import { useEffect, useRef, useState } from 'react';
import { FeedEditorToolbar, FeedSelectionActions, type FeedFormatAction, type FeedPlaceholderAction, type FeedBlockAction } from './editor-toolbar';
import { FeedSlashMenu, readFeedSlashQuery, type FeedSlashQuery, type FeedSlashCommand, type FeedSlashMenuHandle } from './editor-slash-menu';
import { createPortal } from 'react-dom';
import { GenerationPlaceholder, FeedGenerationImage, type FeedGenerationControls } from './generation-placeholder';
import { EditorState, NodeSelection, TextSelection, Plugin, PluginKey, type Transaction } from '@tiptap/pm/state';
import { EditorView, Decoration, DecorationSet } from '@tiptap/pm/view';
import { baseKeymap, toggleMark, setBlockType, wrapIn } from '@tiptap/pm/commands';
import { wrapInList, splitListItem, liftListItem, sinkListItem } from '@tiptap/pm/schema-list';
import { promptDialog } from '@/components/ui/prompt-dialog';
import { keymap } from '@tiptap/pm/keymap';
import { history, undo, redo, closeHistory } from '@tiptap/pm/history';
import { undoInputRule } from '@tiptap/pm/inputrules';
import { feedMarkdownInputRules, feedMarkdownPaste } from './editor-markdown';
import type { Node as PMNode } from '@tiptap/pm/model';
import { feedSchema, feedParagraph, canonicalFeedValue, applyFeedEdits, insertFeedPlaceholder, locateFeedNode, duplicateFeedNode, diffFeedComposition, validateFeedComposition, feedTargetQuote } from '@use-brian/doc-model';
import type { FeedComposition, FeedTarget, FeedEdit, FeedNode, FeedAnchor } from '@use-brian/shared';
import { useT } from '@/lib/i18n/client';
import type { FeedCommentThread } from '@/lib/feed-collaboration';
import styles from './composition-editor.module.css';
export type FeedEditorSelection = { target: FeedTarget; quote: string; caret?: { segmentId: string; blockId: string; offset: number } };
const decorationKey = new PluginKey('feed-comments');
function cleanNode(node: PMNode): FeedNode {
  const json = node.toJSON();
  const clean = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(clean);
    if (!value || typeof value !== 'object') return value;
    const result = Object.fromEntries(Object.entries(value).filter(([key, v]) => v !== null && !(key === 'marks' && Array.isArray(v) && !v.length)).map(([key, v]) => [key, clean(v)]));
    if ((result.type === 'paragraph' || result.type === 'heading') && !result.content) result.content = [];
    return result;
  };
  return clean(json) as FeedNode;
}
function feedSelectionFromEditor(state: EditorState, segmentId: string, composition: FeedComposition): FeedEditorSelection {
  const spans: Array<{ segmentId: string; blockId: string; from: number; to: number }> = [];
  const { from, to } = state.selection;
  let block: { id: string; pos: number; text: boolean } | null = null;
  state.doc.descendants((node, pos) => {
    if (node.isBlock && node.attrs.id && from >= pos && from <= pos + node.nodeSize) block = { id: node.attrs.id, pos, text: node.isTextblock };
    if (node.isTextblock && node.attrs.id && from < pos + 1 + node.content.size && to > pos + 1) spans.push({ segmentId, blockId: node.attrs.id, from: Math.max(0, from - pos - 1), to: Math.min(node.content.size, to - pos - 1) });
  });
  const found = block as { id: string; pos: number; text: boolean } | null;
  const target: FeedTarget = spans.length && from !== to ? { kind: 'range', spans } : found ? { kind: 'block', segmentId, blockId: found.id } : { kind: 'post' };
  return { target, quote: feedTargetQuote(composition, target), ...(found?.text ? { caret: { segmentId, blockId: found.id, offset: Math.max(0, from - found.pos - 1) } } : {}) };
}
export function CompositionEditor(props: {
  generation?: FeedGenerationControls; composition: FeedComposition; readOnly?: boolean; threads: FeedCommentThread[]; draftAnchor?: FeedAnchor | null;
  pendingLocalSave?: boolean;
  onEdit: (edits: FeedEdit[]) => void; onSelection: (selection: FeedEditorSelection) => void;
  onAction: (action: 'comment' | 'suggest' | 'ask') => void; onOpenThread: (threadId: string) => void;
}) {
  return <div className="space-y-4" data-feed-composition>
    {props.composition.segments.map(segment => <FeedSegmentEditor key={segment.id} {...props} segmentId={segment.id} />)}
  </div>;
}

function FeedSegmentEditor(props: Parameters<typeof CompositionEditor>[0] & { segmentId: string }) {
  const t = useT().feedCollaboration; const host = useRef<HTMLDivElement>(null); const viewRef = useRef<EditorView | null>(null); const latest = useRef(props); latest.current = props;
  const [slotMounts, setSlotMounts] = useState<{ id: string; dom: HTMLElement; node: FeedNode }[]>([]);
  const frameRef = useRef<HTMLDivElement>(null);
  const [selectionTop, setSelectionTop] = useState<number | null>(null);
  const [selectionBelow, setSelectionBelow] = useState(false);
  const [formatting, setFormatting] = useState<Partial<Record<FeedFormatAction, boolean>>>({});
  const local = useRef(props.composition); const lastEmitted = useRef('');
  const hasLocalTyping = useRef(false);
  const [slash, setSlash] = useState<FeedSlashQuery | null>(null);
  const slashMenu = useRef<FeedSlashMenuHandle>(null);
  const dismissedSlash = useRef<string | null>(null);
  function syncSlash(view: EditorView) {
    const query = readFeedSlashQuery(view.state);
    if (!query) dismissedSlash.current = null;
    const next = !latest.current.readOnly && view.hasFocus() && !view.composing && query?.blockId !== dismissedSlash.current ? query : null;
    setSlash(previous => JSON.stringify(previous) === JSON.stringify(next) ? previous : next);
  }
  function dismissSlash() { dismissedSlash.current = slash?.blockId ?? null; setSlash(null); }
  const decorations = (doc: PMNode) => {
    const output: Decoration[] = [];
    const anchors = [...latest.current.threads.filter(thread => !thread.resolved).map(thread => ({ id: thread.id, anchor: thread.anchor })), ...(latest.current.draftAnchor ? [{ id: 'draft', anchor: latest.current.draftAnchor }] : [])];
    doc.descendants((node, pos) => {
      if (!node.attrs.id) return;
      for (const item of anchors) {
        const { target, state } = item.anchor; if (state === 'detached') continue;
        if (target.kind === 'block' && target.segmentId === props.segmentId && target.blockId === node.attrs.id) output.push(Decoration.node(pos, pos + node.nodeSize, { class: 'bg-amber-100/60 dark:bg-amber-900/30', 'data-feed-thread': item.id }));
        if (target.kind === 'range' && node.isTextblock) for (const span of target.spans) if (span.segmentId === props.segmentId && span.blockId === node.attrs.id && span.to > span.from && span.to <= node.content.size) output.push(Decoration.inline(pos + 1 + span.from, pos + 1 + span.to, { class: 'bg-amber-200/60 dark:bg-amber-800/50 rounded-sm', 'data-feed-thread': item.id }));
      }
    });
    return DecorationSet.create(doc, output);
  };
  useEffect(() => {
    if (!host.current) return;
    const segment = latest.current.composition.segments.find(s => s.id === props.segmentId)!;
    local.current = latest.current.composition;
    const view = new EditorView(host.current, {
      state: EditorState.create({ schema: feedSchema, doc: feedSchema.nodeFromJSON({ type: 'doc', content: segment.content }), plugins: [history(), feedMarkdownInputRules(), feedMarkdownPaste(), keymap({ 'Mod-b': toggleMark(feedSchema.marks.bold!), 'Mod-i': toggleMark(feedSchema.marks.italic!), 'Mod-z': undo, 'Mod-Shift-z': redo, ...baseKeymap, Backspace: (state, dispatch, view) => undoInputRule(state, dispatch) || baseKeymap.Backspace!(state, dispatch, view), 'Shift-Enter': (state, dispatch) => { dispatch?.(state.tr.replaceSelectionWith(feedSchema.nodes.hardBreak!.create()).scrollIntoView()); return true; }, Enter: (state, dispatch, view) => {
          const block = state.selection.$from.parent; const shortcut = /^\/(text|image)(?:[ \t]+(.*))?$/.exec(block.textContent);
          if (shortcut && state.selection.empty && state.selection.$from.parentOffset === block.content.size && block.type.name === 'paragraph' && !latest.current.readOnly) {
            const node: FeedNode = { type: 'generationPlaceholder', attrs: { id: block.attrs.id, kind: shortcut[1] as 'text' | 'image', brief: shortcut[2]?.trim() ?? '', briefRevision: 0, references: [] } };
            insertSlot([{ kind: 'replaceBlock', segmentId: props.segmentId, blockId: block.attrs.id, preimage: cleanNode(block), replacement: [node] }], node.attrs.id); return true;
          }
          return splitListItem(feedSchema.nodes.listItem!)(state, dispatch) || baseKeymap.Enter!(state, dispatch, view);
        }, Tab: sinkListItem(feedSchema.nodes.listItem!), 'Shift-Tab': liftListItem(feedSchema.nodes.listItem!) }), new Plugin({ key: decorationKey, props: { decorations: state => decorations(state.doc) } })] }),
      nodeViews: props.generation ? { generationPlaceholder(node) {
        const dom = document.createElement('div'); const slotId = String(node.attrs.id); dom.contentEditable = 'false'; dom.dataset.placeholderId = slotId; dom.dataset.blockId = slotId;
        let renderedNode = node;
        setSlotMounts(mounts => [...mounts.filter(item => item.id !== slotId), { id: slotId, dom, node: cleanNode(node) }]);
        return { dom, update(next) {
          if (next.type.name !== 'generationPlaceholder' || next.attrs.id !== slotId) return false;
          if (!renderedNode.eq(next)) {
            renderedNode = next;
            setSlotMounts(mounts => mounts.map(item => item.dom === dom ? { ...item, node: cleanNode(next) } : item));
          }
          return true;
        }, ignoreMutation: () => true, stopEvent: () => true, destroy() { setSlotMounts(mounts => mounts.filter(item => item.dom !== dom)); } };
      }, image(node) {
        const dom = document.createElement('div'); const blockId = String(node.attrs.id); dom.contentEditable = 'false'; dom.dataset.blockId = blockId;
        let renderedNode = node;
        setSlotMounts(mounts => [...mounts.filter(item => item.id !== blockId), { id: blockId, dom, node: cleanNode(node) }]);
        return { dom, update(next) {
          if (next.type.name !== 'image' || next.attrs.id !== blockId) return false;
          if (!renderedNode.eq(next)) {
            renderedNode = next;
            setSlotMounts(mounts => mounts.map(item => item.dom === dom ? { ...item, node: cleanNode(next) } : item));
          }
          return true;
        }, ignoreMutation: () => true, destroy() { setSlotMounts(mounts => mounts.filter(item => item.dom !== dom)); } };
      } } : undefined,
      editable: () => !latest.current.readOnly,
      attributes: { role: 'textbox', 'aria-label': t.editor, 'aria-multiline': 'true', class: 'min-h-[max(20rem,calc(100dvh-16rem))] py-1 text-base leading-relaxed outline-none [&_p]:my-3 [&>:first-child]:mt-0 [&_h1]:text-2xl [&_h2]:text-xl [&_h3]:text-lg [&_h4]:font-semibold [&_h5]:font-semibold [&_h6]:font-semibold [&_ul]:list-disc [&_ol]:list-decimal [&_li]:ml-5 [&_blockquote]:border-l-2 [&_blockquote]:pl-4' },
      handleClick(_view, _pos, event) { const hit = (event.target as HTMLElement).closest<HTMLElement>('[data-feed-thread]'); if (hit?.dataset.feedThread && hit.dataset.feedThread !== 'draft') latest.current.onOpenThread(hit.dataset.feedThread); return false; },
      handleKeyDown(_view, event) { return slashMenu.current?.onKeyDown(event) ?? false; },
      handleDOMEvents: {
        // Leave IME confirmation to the browser, without running slash/Enter commands.
        keydown(_view, event) { return event.isComposing; },
        focus(view) { syncSlash(view); return false; },
        blur(_view, event) {
          setSelectionTop(null);
          if (!(event.relatedTarget instanceof Element && event.relatedTarget.closest('[data-feed-slash-menu]'))) setSlash(null);
          return false;
        },
        compositionstart() { setSlash(null); return false; },
        compositionend(view) { requestAnimationFrame(() => { if (viewRef.current === view) syncSlash(view); }); return false; },
      },
      dispatchTransaction(transaction: Transaction) {
        if (transaction.docChanged && latest.current.readOnly) return;
        if (transaction.docChanged) {
          // Keep identity steps inside the input-rule transaction so Backspace
          // can reverse the complete shortcut, including its new containers.
          const seen = new Set<string>();
          transaction.doc.descendants((node, pos) => { if (!node.isBlock) return; let blockId = node.attrs.id as string | null; if (!blockId || seen.has(blockId)) { blockId = crypto.randomUUID(); transaction.setNodeMarkup(pos, undefined, { ...node.attrs, id: blockId }); } seen.add(blockId); });
        }
        const next = view.state.apply(transaction);
        view.updateState(next);
        syncSlash(view);
        if (next.selection.empty || latest.current.readOnly || !view.hasFocus()) setSelectionTop(null);
        else {
          const below = next.selection.head < next.selection.anchor;
          let top = 48;
          try { const anchor = view.coordsAtPos(next.selection.anchor); top = (below ? anchor.bottom + 8 : anchor.top - 8) - (frameRef.current?.getBoundingClientRect().top ?? 0); } catch { /* A DOM-less editor still exposes toolbar actions. */ }
          setSelectionBelow(below);
          setSelectionTop(top);
        }
        const active: Partial<Record<FeedFormatAction, boolean>> = {};
        for (const mark of ['bold', 'italic', 'link'] as const) {
          const type = feedSchema.marks[mark]!;
          active[mark] = next.selection.empty ? Boolean(type.isInSet(next.storedMarks ?? next.selection.$from.marks())) : next.doc.rangeHasMark(next.selection.from, next.selection.to, type);
        }
        for (let depth = next.selection.$from.depth; depth > 0; depth--) {
          const kind = next.selection.$from.node(depth).type.name;
          if (kind === 'heading' || kind === 'bulletList' || kind === 'orderedList' || kind === 'blockquote') active[kind] = true;
        }
        setFormatting(previous => JSON.stringify(previous) === JSON.stringify(active) ? previous : active);
        if (transaction.docChanged) {
          const content: FeedNode[] = []; next.doc.forEach(node => content.push(cleanNode(node)));
          const before = local.current; const composition = validateFeedComposition({ ...before, segments: before.segments.map(s => s.id === props.segmentId ? { ...s, content } : s) });
          const edits = diffFeedComposition(before, composition); local.current = composition; lastEmitted.current = JSON.stringify(composition); hasLocalTyping.current = true;
          if (edits.length) latest.current.onEdit(edits);
        }
        latest.current.onSelection(feedSelectionFromEditor(next, props.segmentId, local.current));
      },
    });
    viewRef.current = view;
    return () => { view.destroy(); viewRef.current = null; };
  }, [props.segmentId, t.editor]);
  useEffect(() => {
    const view = viewRef.current; if (!view) return;
    const serialized = JSON.stringify(props.composition);
    const preserveTyping = props.pendingLocalSave && hasLocalTyping.current;
    if (!preserveTyping && serialized !== lastEmitted.current && serialized !== JSON.stringify(local.current)) {
      const segment = props.composition.segments.find(s => s.id === props.segmentId); if (!segment) return;
      const doc = feedSchema.nodeFromJSON({ type: 'doc', content: segment.content });
      if (!doc.eq(view.state.doc)) view.updateState(EditorState.create({ schema: feedSchema, doc, plugins: view.state.plugins }));
    }
    if (!preserveTyping) local.current = props.composition;
    if (!props.pendingLocalSave) hasLocalTyping.current = false;
    view.setProps({ editable: () => !latest.current.readOnly }); view.dispatch(view.state.tr.setMeta(decorationKey, true));
  }, [props.composition, props.threads, props.draftAnchor, props.readOnly, props.pendingLocalSave, props.segmentId]);
  function format(action: FeedFormatAction) {
    const view = viewRef.current; if (!view) return;
    if (action === 'link') { void (async () => { const view = viewRef.current; if (!view) return; const href = await promptDialog({ title: t.link, placeholder: t.linkPlaceholder, confirmLabel: t.accept, cancelLabel: t.cancel, allowEmpty: true }); if (href === null || (href && !/^https?:\/\//i.test(href))) return; try { if (href) new URL(href); else { view.dispatch(view.state.tr.removeMark(view.state.selection.from, view.state.selection.to, feedSchema.marks.link!)); return; } toggleMark(feedSchema.marks.link!, { href })(view.state, view.dispatch); view.focus(); } catch { /* Invalid URL leaves the selected content unchanged. */ } })(); return; }
    if (action === 'bold' || action === 'italic') toggleMark(feedSchema.marks[action]!)(view.state, view.dispatch);
    else {
      const command = action === 'heading' ? setBlockType(feedSchema.nodes.heading!, { level: 2 }) : action === 'blockquote' ? wrapIn(feedSchema.nodes.blockquote!) : wrapInList(feedSchema.nodes[action]!);
      command(view.state, view.dispatch);
    }
    view.focus();
  }
  function placeholder(action: FeedPlaceholderAction) {
    const view = viewRef.current; if (!view) return;
    const selected = feedSelectionFromEditor(view.state, props.segmentId, local.current); const convert = action.startsWith('convert'); if (convert && selected.target.kind === 'post') return;
    try {
      const edits = insertFeedPlaceholder(local.current, selected, action.endsWith('Image') ? 'image' : 'text', convert);
      const slot = edits.flatMap(edit => edit.kind === 'insertBlock' ? [edit.node] : edit.kind === 'replaceBlock' ? edit.replacement : []).find(node => node.type === 'generationPlaceholder');
      if (slot) insertSlot(edits, slot.attrs.id);
    } catch { /* Non-text atoms cannot be converted to notes. */ }
  }
  // Insert and continue in one editor transaction, including when there is no
  // trailing paragraph. The ordinary diff still emits canonical typed edits.
  function insertSlot(edits: FeedEdit[], slotId: string, ownHistory = false) {
    const view = viewRef.current; if (!view || latest.current.readOnly) return;
    let composition = applyFeedEdits(local.current, edits).composition;
    const found = locateFeedNode(composition, props.segmentId, slotId);
    const next = found.siblings[found.index + 1];
    if (!next || !['paragraph', 'heading'].includes(next.type)) composition = applyFeedEdits(composition, [{ kind: 'insertBlock', segmentId: props.segmentId, parentId: found.parentId, afterId: slotId, node: feedParagraph('') }]).composition;
    const segment = composition.segments.find(item => item.id === props.segmentId)!;
    const doc = feedSchema.nodeFromJSON({ type: 'doc', content: segment.content });
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    let after = 0;
    tr.doc.descendants((node, pos) => { if (node.attrs.id === slotId) after = pos + node.nodeSize; });
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    view.dispatch(ownHistory ? closeHistory(tr) : tr); view.focus();
  }
  function insertSlashBlock(command: FeedSlashCommand, query: FeedSlashQuery) {
    const view = viewRef.current;
    if (!view || latest.current.readOnly || view.composing || JSON.stringify(readFeedSlashQuery(view.state)) !== JSON.stringify(query)) return;
    const block = view.state.selection.$from.parent;
    if (command === 'text' || command === 'image') {
      const node: FeedNode = { type: 'generationPlaceholder', attrs: { id: query.blockId, kind: command, brief: '', briefRevision: 0, references: [] } };
      insertSlot([{ kind: 'replaceBlock', segmentId: props.segmentId, blockId: query.blockId, preimage: cleanNode(block), replacement: [node] }], query.blockId, true);
    } else {
      const paragraph: FeedNode = { type: 'paragraph', attrs: { id: query.blockId }, content: [] };
      let node: FeedNode = paragraph;
      if (command.startsWith('heading')) node = { type: 'heading', attrs: { id: query.blockId, level: Number(command.slice(-1)) }, content: [] };
      else if (command === 'blockquote') node = { type: 'blockquote', attrs: { id: crypto.randomUUID() }, content: [paragraph] };
      else if (command === 'bulletList' || command === 'orderedList') {
        const content: FeedNode[] = [{ type: 'listItem', attrs: { id: crypto.randomUUID() }, content: [paragraph] }];
        node = command === 'orderedList' ? { type: 'orderedList', attrs: { id: crypto.randomUUID(), start: 1 }, content }
          : { type: 'bulletList', attrs: { id: crypto.randomUUID() }, content };
      }
      const from = view.state.selection.$from.before();
      const tr = view.state.tr.replaceWith(from, view.state.selection.$from.after(), feedSchema.nodeFromJSON(node));
      tr.setSelection(TextSelection.near(tr.doc.resolve(from + 1)));
      view.dispatch(closeHistory(tr)); view.focus();
    }
    setSlash(null);
  }
  function continueAfterSlot(slotId: string) {
    const view = viewRef.current; if (!view || latest.current.readOnly) return;
    let after: number | undefined;
    view.state.doc.descendants((node, pos) => { if (node.attrs.id === slotId) after = pos + node.nodeSize; });
    if (after === undefined) return;
    const tr = view.state.tr;
    if (!tr.doc.resolve(after).nodeAfter?.isTextblock) tr.insert(after, feedSchema.nodeFromJSON(feedParagraph('')));
    tr.setSelection(TextSelection.create(tr.doc, after + 1));
    view.dispatch(tr); view.focus();
  }
  function blockAction(action: FeedBlockAction) {
    const view = viewRef.current; if (!view) return;
    const selected = feedSelectionFromEditor(view.state, props.segmentId, local.current); const blockId = selected.caret?.blockId ?? (selected.target.kind === 'block' ? selected.target.blockId : undefined); if (!blockId) return;
    const { node, siblings, index, parentId } = locateFeedNode(local.current, props.segmentId, blockId);
    if (action === 'duplicate') latest.current.onEdit([{ kind: 'insertBlock', segmentId: props.segmentId, parentId, afterId: blockId, node: duplicateFeedNode(node) }]);
    else if (action === 'deleteBlock') { let position: number | undefined; view.state.doc.descendants((item, pos) => { if (item.attrs.id === blockId) position = pos; }); if (position !== undefined) view.dispatch(view.state.tr.delete(position, position + feedSchema.nodeFromJSON(node).nodeSize)); }
    else if ((action === 'moveUp' && index > 0) || (action === 'moveDown' && index < siblings.length - 1)) latest.current.onEdit([{ kind: 'moveBlock', segmentId: props.segmentId, blockId, parentId, afterId: action === 'moveUp' ? siblings[index - 2]?.attrs.id ?? null : siblings[index + 1]!.attrs.id }]);
  }
  return <div ref={frameRef} className={`${styles.canvas} relative`} data-feed-segment-editor>
    <FeedEditorToolbar disabled={props.readOnly} active={formatting} onFormat={format} onPlaceholder={placeholder} onBlock={blockAction} focusEditor={() => viewRef.current?.focus()} onAction={props.onAction} />
    {slash && viewRef.current && !props.readOnly ? <FeedSlashMenu ref={slashMenu} view={viewRef.current} query={slash} onSelect={insertSlashBlock} onDismiss={dismissSlash} /> : null}
    <div ref={host} className={styles.surface} />
    {selectionTop !== null && !props.readOnly ? <div className={`absolute left-2 right-2 z-20 ${selectionBelow ? '' : '-translate-y-full'}`} style={{ top: selectionTop }}><FeedSelectionActions onAction={props.onAction} /></div> : null}
    {props.generation ? slotMounts.map(mount => {
      // The visible editor can be ahead of the saved parent composition. Its
      // node snapshot owns rendering; persistence only gates remote actions.
      const node = mount.node;
      if (node.type === 'image') return createPortal(<FeedGenerationImage workspaceId={props.generation!.workspaceId} fileId={node.attrs.fileId} alt={node.attrs.alt ?? ''} />, mount.dom, mount.id);
      if (node.type !== 'generationPlaceholder') return null;
      let savedNode: FeedNode | undefined;
      try { savedNode = locateFeedNode(props.composition, props.segmentId, mount.id).node; } catch { /* A newly inserted marker is still saving. */ }
      const pending = props.generation!.pending || Boolean(props.pendingLocalSave) || !savedNode || canonicalFeedValue(node) !== canonicalFeedValue(savedNode);
      return createPortal(<GenerationPlaceholder slot={node.attrs} segmentId={props.segmentId} controls={{ ...props.generation!, pending }} onEdit={props.onEdit} onContinue={() => continueAfterSlot(mount.id)}
        onSelect={() => { const view = viewRef.current; if (!view) return; let position: number | undefined; view.state.doc.descendants((node, pos) => { if (node.attrs.id === mount.id) position = pos; }); if (position !== undefined && (!(view.state.selection instanceof NodeSelection) || view.state.selection.from !== position)) view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, position))); }} />, mount.dom, mount.id);
    }) : null}

  </div>;
}

/** The accepted outline, including inline images, in document order. */
export function FeedCompositionPreview({ composition, workspaceId }: { composition: FeedComposition; workspaceId: string }) {
  const renderInline = (node: Extract<FeedNode, { type: 'paragraph' | 'heading' }>) => (node.content ?? []).map((part, index) => {
    if (part.type === 'hardBreak') return <br key={index} />;
    let text: import('react').ReactNode = part.text;
    for (const mark of part.marks ?? []) text = mark.type === 'bold' ? <strong>{text}</strong> : mark.type === 'italic' ? <em>{text}</em> : <a href={mark.attrs.href} rel="noopener noreferrer" className="underline">{text}</a>;
    return <span key={index}>{text}</span>;
  });
  const render = (node: FeedNode): import('react').ReactNode => {
    if (node.type === 'generationPlaceholder') return null;
    if (node.type === 'image') return <figure key={node.attrs.id} data-block-id={node.attrs.id}><FeedGenerationImage workspaceId={workspaceId} fileId={node.attrs.fileId} alt={node.attrs.alt ?? ''} /></figure>;
    if (node.type === 'paragraph') return <p key={node.attrs.id} data-block-id={node.attrs.id}>{renderInline(node)}</p>;
    if (node.type === 'heading') return <div key={node.attrs.id} data-block-id={node.attrs.id} role="heading" aria-level={node.attrs.level} className="text-xl font-semibold">{renderInline(node)}</div>;
    if (node.type === 'bulletList') return <ul className="list-disc pl-5" key={node.attrs.id} data-block-id={node.attrs.id}>{node.content.map(render)}</ul>;
    if (node.type === 'orderedList') return <ol className="list-decimal pl-5" start={node.attrs.start} key={node.attrs.id} data-block-id={node.attrs.id}>{node.content.map(render)}</ol>;
    if (node.type === 'listItem') return <li key={node.attrs.id} data-block-id={node.attrs.id}>{node.content.map(render)}</li>;
    return <blockquote className="border-l-2 pl-4" key={node.attrs.id} data-block-id={node.attrs.id}>{node.content.map(render)}</blockquote>;
  };
  return <div className="space-y-6 break-words [&_p]:my-3 [&_figure]:my-4">{composition.segments.map(segment => <section key={segment.id}>{segment.content.map(render)}</section>)}</div>;
}
