"use client";

/** Discoverable Feed blocks, with the editor retaining its caret. [COMP:app-web/feed-slash-menu] */
import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from 'react';
import { Heading1, Heading2, Heading3, ImagePlus, List, ListOrdered, Quote, TextCursorInput, Type, X } from 'lucide-react';
import type { EditorState } from '@tiptap/pm/state';
import type { EditorView } from '@tiptap/pm/view';
import { Button } from '@/components/ui/button';
import { Popover, PopoverContent } from '@/components/ui/popover';
import { useT } from '@/lib/i18n/client';

const items = [
  { id: 'text', icon: TextCursorInput, aliases: ['text', 'placeholder', 'generate', 'ai'] },
  { id: 'image', icon: ImagePlus, aliases: ['image', 'picture', 'photo', 'placeholder', 'generate', 'ai'] },
  { id: 'paragraph', icon: Type, aliases: ['paragraph', 'body', 'plain'] },
  { id: 'heading1', icon: Heading1, aliases: ['heading', 'h1', 'title'] },
  { id: 'heading2', icon: Heading2, aliases: ['heading', 'h2', 'subtitle'] },
  { id: 'heading3', icon: Heading3, aliases: ['heading', 'h3'] },
  { id: 'bulletList', icon: List, aliases: ['bullet', 'list', 'ul'] },
  { id: 'orderedList', icon: ListOrdered, aliases: ['number', 'list', 'ordered', 'ol'] },
  { id: 'blockquote', icon: Quote, aliases: ['quote', 'blockquote'] },
] as const;
export type FeedSlashCommand = typeof items[number]['id'];
export type FeedSlashQuery = { from: number; to: number; blockId: string; query: string };
export type FeedSlashMenuHandle = { onKeyDown: (event: KeyboardEvent) => boolean };

export function readFeedSlashQuery(state: EditorState): FeedSlashQuery | null {
  const { empty, $from } = state.selection;
  if (!empty || !['paragraph', 'heading'].includes($from.parent.type.name) || $from.parentOffset !== $from.parent.content.size) return null;
  const match = /^\/([\p{L}\p{N}_-]{0,40})$/u.exec($from.parent.textContent);
  return match ? { from: $from.start(), to: $from.pos, blockId: String($from.parent.attrs.id), query: match[1]! } : null;
}

export const FeedSlashMenu = forwardRef<FeedSlashMenuHandle, {
  view: EditorView; query: FeedSlashQuery;
  onSelect: (command: FeedSlashCommand, query: FeedSlashQuery) => void;
  onDismiss: () => void;
}>(function FeedSlashMenu({ view, query, onSelect, onDismiss }, ref) {
  const t = useT().feedSlash;
  const id = useId(); const popup = useRef<HTMLDivElement>(null);
  const [selected, setSelected] = useState(0);
  const options = useMemo(() => items.filter(item => [t[item.id], ...item.aliases].some(value => value.toLocaleLowerCase().includes(query.query.toLocaleLowerCase()))), [query.query, t]);
  const active = Math.min(selected, options.length - 1);
  const anchor = useMemo(() => ({
    contextElement: view.dom,
    getBoundingClientRect: () => {
      try { const rect = view.coordsAtPos(query.to); return new DOMRect(rect.left, rect.top, 1, rect.bottom - rect.top); }
      catch { return view.dom.getBoundingClientRect(); }
    },
  }), [view, query.to]);
  useEffect(() => setSelected(0), [query.query]);
  useEffect(() => {
    const attrs = { 'aria-autocomplete': 'list', 'aria-haspopup': 'listbox', 'aria-expanded': 'true', 'aria-controls': id,
      ...(options[active] ? { 'aria-activedescendant': `${id}-${options[active].id}` } : {}) };
    for (const [key, value] of Object.entries(attrs)) view.dom.setAttribute(key, value);
    // Scroll only the popup's contents; never move the document while browsing.
    const option = popup.current?.querySelector<HTMLElement>('[aria-selected=true]');
    if (option && popup.current) {
      const row = option.getBoundingClientRect(); const bounds = popup.current.getBoundingClientRect();
      if (row.bottom > bounds.bottom) popup.current.scrollTop += row.bottom - bounds.bottom;
      else if (row.top < bounds.top) popup.current.scrollTop -= bounds.top - row.top;
    }
    return () => { for (const key of Object.keys(attrs)) view.dom.removeAttribute(key); };
  }, [view, id, active, options]);
  function onKeyDown(event: KeyboardEvent) {
    if (event.isComposing || view.composing) return false;
    if (event.key === 'Escape') { onDismiss(); view.focus(); return true; }
    if (event.key === 'Tab') { onDismiss(); return false; }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (options.length) setSelected((active + (event.key === 'ArrowDown' ? 1 : -1) + options.length) % options.length);
      return true;
    }
    if (event.key === 'Enter' && options[active]) { onSelect(options[active].id, query); return true; }
    return false;
  }
  useImperativeHandle(ref, () => ({ onKeyDown }));
  return <Popover open onOpenChange={open => { if (!open) onDismiss(); }}>
    <PopoverContent ref={popup} anchor={anchor} align="start" initialFocus={false} finalFocus={false}
      className="w-80 max-w-[calc(100vw-1rem)] gap-1 p-1.5" data-feed-slash-menu
      onKeyDown={event => { if (onKeyDown(event.nativeEvent)) { event.preventDefault(); event.stopPropagation(); } }}>
      <div className="flex items-center justify-between pl-2 text-xs text-muted-foreground">
        <span>{t.title}</span><Button variant="ghost" size="icon" className="max-sm:size-11" aria-label={t.close}
          onMouseDown={event => event.preventDefault()} onClick={() => { onDismiss(); view.focus(); }}><X className="size-4" aria-hidden /></Button>
      </div>
      <div id={id} role="listbox" aria-label={t.title}>
        {options.map((item, index) => <Button key={item.id} id={`${id}-${item.id}`} type="button" role="option" aria-selected={index === active}
          variant="ghost" className="max-sm:min-h-11 h-auto w-full justify-start gap-3 whitespace-normal px-3 py-2 text-left aria-selected:bg-accent"
          onMouseDown={event => event.preventDefault()} onPointerMove={event => { if (event.pointerType === 'mouse') setSelected(index); }}
          onClick={() => onSelect(item.id, query)}>
          <item.icon className="size-4 shrink-0" aria-hidden /><span><span className="block">{t[item.id]}</span>
            {item.id === 'text' || item.id === 'image' ? <span className="block text-xs font-normal text-muted-foreground">{t[`${item.id}Hint`]}</span> : null}</span>
        </Button>)}
        {!options.length ? <p role="status" className="p-3 text-sm text-muted-foreground">{t.empty}</p> : null}
      </div>
      <p className="px-2 py-1 text-xs text-muted-foreground">{t.keys}</p>
    </PopoverContent>
  </Popover>;
});
