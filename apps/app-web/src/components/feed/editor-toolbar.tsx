"use client";

/** Compact, selection-preserving editing controls. [COMP:app-web/feed-editor-toolbar] */
import { useId, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Baseline, Bold, ChevronDown, CopyPlus, Heading2, ImagePlus, Italic, Link2, List, ListOrdered, MoreHorizontal, MessageSquarePlus, Sparkles, Plus, Quote, Replace, TextCursorInput, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { Tooltip } from '@/components/ui/tooltip';
import { useT } from '@/lib/i18n/client';

export type FeedFormatAction = 'bold' | 'italic' | 'heading' | 'bulletList' | 'orderedList' | 'blockquote' | 'link';
export type FeedPlaceholderAction = 'insertText' | 'insertImage' | 'convertText' | 'convertImage';
export type FeedBlockAction = 'moveUp' | 'moveDown' | 'duplicate' | 'deleteBlock';
const formats = [
  ['bold', Bold], ['italic', Italic], ['heading', Heading2], ['bulletList', List],
  ['orderedList', ListOrdered], ['blockquote', Quote], ['link', Link2],
] as const;
const menuItem = 'min-h-11 md:min-h-9';

export function FeedEditorToolbar(props: {
  disabled?: boolean;
  active: Partial<Record<FeedFormatAction, boolean>>;
  onFormat: (action: FeedFormatAction) => void;
  onPlaceholder: (action: FeedPlaceholderAction) => void;
  onBlock: (action: FeedBlockAction) => void;
  focusEditor: () => void;
  onAction: (action: 'comment' | 'suggest' | 'ask') => void;
}) {
  const t = useT().feedCollaboration;
  const tg = useT().feedGeneration;
  const applied = useRef(false);
  const [formatsOpen, setFormatsOpen] = useState(false);
  const formatGroupId = useId();
  const menuFocus = () => {
    if (!applied.current) return true;
    applied.current = false;
    props.focusEditor();
    return false;
  };
  return <div role="toolbar" aria-label={t.editor} className="flex flex-wrap items-center gap-1 border-b border-border/60 py-1" data-feed-editor-toolbar
    onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key) || !event.currentTarget.contains(event.target as Node)) return;
      const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)')]
        .filter(button => button.checkVisibility?.() !== false);
      const index = buttons.indexOf(event.target as HTMLButtonElement);
      if (index < 0 || !buttons.length) return;
      event.preventDefault();
      const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : (index + (event.key === 'ArrowRight' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next]?.focus();
    }}>
    <Button type="button" variant="ghost" size="sm" className="h-11 gap-1.5 px-2 md:hidden"
      disabled={props.disabled} aria-expanded={formatsOpen} aria-controls={formatGroupId}
      onMouseDown={event => event.preventDefault()} onClick={() => setFormatsOpen(open => !open)}>
      <Baseline aria-hidden />{t.formatting}<ChevronDown aria-hidden />
    </Button>
    <div id={formatGroupId} role="group" aria-label={t.formatting}
      className={`order-last w-full flex-wrap items-center gap-0.5 md:order-none md:flex md:w-auto ${formatsOpen ? 'flex' : 'hidden'}`}>
      {formats.map(([action, Icon]) => <Tooltip key={action} label={t[action]}>
        <Button type="button" variant="ghost" size="icon" aria-label={t[action]} aria-pressed={Boolean(props.active[action])}
          disabled={props.disabled} className="size-11 md:size-8 rounded-md text-muted-foreground hover:bg-background aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs"
          onMouseDown={event => event.preventDefault()} onClick={() => props.onFormat(action)}><Icon className="size-4" aria-hidden /></Button>
      </Tooltip>)}
    </div>
    <span aria-hidden className="mx-1 hidden h-5 w-px bg-border md:block" />
    <DropdownMenu onOpenChange={open => { if (open) applied.current = false; }}>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="sm" disabled={props.disabled} className="h-11 md:h-8 gap-1.5 px-2" />}>
        <Plus className="size-4" aria-hidden />{t.insert}<ChevronDown className="size-3" aria-hidden />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" finalFocus={menuFocus} className="max-w-[calc(100vw-2rem)]">
        {([['insertText', TextCursorInput], ['insertImage', ImagePlus], ['convertText', Replace], ['convertImage', Replace]] as const).map(([action, Icon], index) => <div key={action}>
          {index === 2 ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem className={menuItem} onClick={() => { applied.current = true; props.onPlaceholder(action); }}><Icon aria-hidden />{tg[action]}</DropdownMenuItem>
        </div>)}
      </DropdownMenuContent>
    </DropdownMenu>
    <DropdownMenu onOpenChange={open => { if (open) applied.current = false; }}>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon" aria-label={t.documentActions} title={t.documentActions} disabled={props.disabled} className="size-11 md:size-8 text-muted-foreground" />}><MessageSquarePlus className="size-4" aria-hidden /></DropdownMenuTrigger>
      <DropdownMenuContent finalFocus={() => !applied.current} className="max-w-[calc(100vw-2rem)]">
        {([['comment', MessageSquarePlus], ['ask', Sparkles]] as const).map(([action, Icon]) => <DropdownMenuItem key={action} className={menuItem} onClick={() => { applied.current = true; props.onAction(action); }}><Icon aria-hidden />{action === 'ask' ? t.askBrian : t.commentOrSuggest}</DropdownMenuItem>)}
      </DropdownMenuContent>
    </DropdownMenu>
    <DropdownMenu onOpenChange={open => { if (open) applied.current = false; }}>
      <DropdownMenuTrigger render={<Button type="button" variant="ghost" size="icon" aria-label={t.blockMenu} title={t.blockMenu} disabled={props.disabled} className="ml-auto size-11 md:size-8 text-muted-foreground" />}><MoreHorizontal className="size-4" aria-hidden /></DropdownMenuTrigger>
      <DropdownMenuContent finalFocus={menuFocus} className="max-w-[calc(100vw-2rem)]">
        {([['moveUp', ArrowUp], ['moveDown', ArrowDown], ['duplicate', CopyPlus], ['deleteBlock', Trash2]] as const).map(([action, Icon]) => <div key={action}>
          {action === 'deleteBlock' ? <DropdownMenuSeparator /> : null}
          <DropdownMenuItem className={menuItem} variant={action === 'deleteBlock' ? 'destructive' : 'default'} onClick={() => { applied.current = true; props.onBlock(action); }}><Icon aria-hidden />{t[action]}</DropdownMenuItem>
        </div>)}
      </DropdownMenuContent>
    </DropdownMenu>
  </div>;
}

/** Selection actions are also reachable from the persistent toolbar menu. */
export function FeedSelectionActions({ onAction }: { onAction: (action: 'comment' | 'suggest' | 'ask') => void }) {
  const t = useT().feedCollaboration;
  return <div role="group" aria-label={t.documentActions} className="flex w-fit max-w-full flex-wrap items-center gap-1 rounded-lg border border-border bg-background p-1 shadow-lg" data-feed-selection-actions>
    <Button type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-8" onMouseDown={event => event.preventDefault()} onClick={() => onAction('comment')}><MessageSquarePlus aria-hidden />{t.commentOrSuggest}</Button>
    <Button type="button" size="sm" className="min-h-11 md:min-h-8" onMouseDown={event => event.preventDefault()} onClick={() => onAction('ask')}><Sparkles aria-hidden />{t.askBrian}</Button>
  </div>;
}
