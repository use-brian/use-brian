"use client";
import { Button } from '@/components/ui/button';
import { Tooltip } from '@/components/ui/tooltip';
import { Check, CheckCheck, MessageSquarePlus, PencilLine, Send, Sparkles, Undo2, X } from 'lucide-react';
/** Anchored discussion and reviewed edits share the composition command path. [COMP:app-web/feed-composition-editor] */
import { useEffect, useState, type ReactNode } from 'react';
import type { FeedAnchor, FeedCommand, FeedComposition, FeedEdit, FeedTarget } from '@use-brian/shared';
import { feedText, inlineText, proposeFeedReplacement } from '@use-brian/doc-model';
import { useT } from '@/lib/i18n/client';
import { useCachedResource } from '@/lib/surface-cache';
import { feedCollaborationCacheKey } from '@/lib/surface-prefetch';
import { feedCachedJson, feedPaintFirst, readFeedCachedJson } from '@/lib/offline/feed-cache';
import { feedCollaborationPath, type FeedCollaborationSnapshot, type FeedCommentThread, type FeedDraftSuggestion } from '@/lib/feed-collaboration';
import { Skeleton } from '@/components/skeleton';
export type FeedCommentComposer = { kind: 'comment' | 'suggest'; anchor: FeedAnchor; parentId?: string; threadId?: string };
export type FeedCommentPanelProps = {
  workspaceId: string; assistantId: string; assistantName: string; sessionId: string;
  composition: FeedComposition; revision: number; snapshot?: FeedCollaborationSnapshot | null;
  loading?: boolean; error?: unknown; pending: boolean; offline: boolean; readOnly: boolean;
  composer: FeedCommentComposer | null; onComposer: (value: FeedCommentComposer | null) => void;
  selectedThread: string | null; onThread: (id: string) => void; selection?: FeedTarget;
  onAskBrian: (threadId: string) => void;
  onCommand: (commands: FeedCommand[], optimisticEdits?: FeedEdit[]) => Promise<boolean>;
  focused?: boolean;
  onRefresh: () => void; reviewHeader?: ReactNode;
};
export function DraftCommentPanel(props: FeedCommentPanelProps) {
  const t = useT().feedCollaboration; const tr = useT().feedReview;
  const [filter, setFilter] = useState<'open' | 'resolved' | 'all'>('open');
  const threads = props.snapshot?.threads ?? [];
  const active = threads.find(thread => thread.id === props.selectedThread);
  const canWrite = !props.readOnly && !props.pending;
  useEffect(() => { if (active?.resolved) setFilter('all'); }, [active?.id, active?.resolved]);
  const suggestions = (props.snapshot?.suggestions ?? []).filter(item => !props.focused || item.threadId === props.selectedThread);
  const visible = threads.filter(thread => props.focused ? thread.id === props.selectedThread : filter === 'all' || thread.resolved === (filter === 'resolved'));
  return <section aria-label={t.comments} className="space-y-4" data-feed-review-panel>
    {props.reviewHeader}
    {!props.focused ? <div className="flex items-center gap-2">
      <div className="flex flex-1 rounded-lg border border-border bg-muted/60 p-0.5" role="group" aria-label={t.comments}>
        {(['open', 'resolved', 'all'] as const).map(value => <Button key={value} type="button" aria-pressed={filter === value} variant="ghost" size="sm" className="min-h-11 md:min-h-8 flex-1 rounded-md px-2 text-xs text-muted-foreground aria-pressed:bg-background aria-pressed:text-foreground aria-pressed:shadow-xs" onClick={() => setFilter(value)}>{t[value]}</Button>)}
      </div>
      <Tooltip label={t.comment}><Button type="button" variant="outline" size="icon" aria-label={t.comment} className="size-11 md:size-9" disabled={!canWrite} onClick={() => props.onComposer({ kind: 'comment', anchor: { target: { kind: 'post' }, quote: '', sourceRevision: props.revision, state: 'attached' } })}><MessageSquarePlus className="size-4" aria-hidden /></Button></Tooltip>
    </div> : null}
    {props.pending ? <p role="status" className="text-sm text-muted-foreground">{t.pending}</p> : null}
    {props.error ? <div role="alert" className="text-sm"><p>{t.loadFailed}</p><Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" onClick={props.onRefresh}>{t.retry}</Button></div> : null}
    {props.loading && !props.snapshot ? <Skeleton className="h-36 w-full" /> : null}
    {props.composer ? <CommentComposer key={`${props.composer.parentId ?? ''}:${props.composer.threadId ?? ''}:${JSON.stringify(props.composer.anchor.target)}`} {...props} composer={props.composer} /> : null}
    {!visible.length && props.snapshot ? <p className="text-sm text-muted-foreground">{t.noComments}</p> : null}
    {visible.map(thread => <article key={thread.id} data-feed-comment-id={thread.id} className={`space-y-3 ${props.focused ? '' : 'border-b border-border pb-4'}`}>
      <button type="button" aria-expanded={active?.id === thread.id} className="w-full min-h-11 rounded-md text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring" onClick={() => props.onThread(thread.id)}>
        <span className="font-medium">{thread.authorKind === 'assistant' ? t.brian : (thread.authorName ?? `${t.author} ${thread.authorUserId.slice(0, 8)}`)}</span>
        <blockquote className="mt-2 line-clamp-3 whitespace-pre-wrap border-l-2 pl-2">{thread.anchor.quote || t.post}</blockquote>
      </button>
      {props.snapshot?.reviewFindings?.filter(item => item.threadId === thread.id).map(item => <div className="text-xs text-muted-foreground space-y-1" key={item.runId}><p>{tr[item.finding.priority]} · {item.finding.dimensions.map(dimension => tr[dimension]).join(', ')}</p>{item.finding.sources?.map(source => <p key={source.id}>{source.link && /^https?:\/\//i.test(source.link) ? <a href={source.link} target="_blank" rel="noopener noreferrer" className="underline">{source.title}</a> : source.title}{source.date ? ` (${source.date.slice(0, 10)})` : ''}</p>)}</div>)}
      {thread.anchor.state !== 'attached' ? <p className="inline-flex rounded-md bg-amber-100/70 px-2 py-1 text-xs font-medium text-amber-800 dark:bg-amber-900/30 dark:text-amber-300">{thread.anchor.state === 'detached' ? t.detached : t.stale}</p> : null}
      {active?.id === thread.id ? <>
        <ThreadMessages {...props} thread={thread} />
        <div className="flex items-center gap-2 border-t border-border/60 pt-3">
          <Button variant="default" size="sm" className="min-h-11 md:min-h-8" disabled={!canWrite || props.offline} onClick={() => props.onAskBrian(thread.id)}><Sparkles aria-hidden />{t.askBrian}</Button>
          <Tooltip label={t.suggest}><Button variant="outline" size="icon" className="size-11 md:size-8" aria-label={t.suggest} disabled={!canWrite || thread.anchor.state !== 'attached'} onClick={() => props.onComposer({ kind: 'suggest', anchor: thread.anchor, threadId: thread.id })}><PencilLine className="size-4" aria-hidden /></Button></Tooltip>
          <Tooltip label={thread.resolved ? t.reopen : t.resolve}><Button variant="ghost" size="icon" className="ml-auto size-11 md:size-8 text-muted-foreground" aria-label={thread.resolved ? t.reopen : t.resolve} disabled={!canWrite} onClick={() => void props.onCommand([{ kind: 'resolve', threadId: thread.id, resolved: !thread.resolved }])}>{thread.resolved ? <Undo2 className="size-4" aria-hidden /> : <CheckCheck className="size-4" aria-hidden />}</Button></Tooltip>
        </div>
        {thread.anchor.state !== 'attached' ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 w-full whitespace-normal" disabled={!canWrite || !props.selection || props.selection.kind === 'post'} onClick={() => props.selection && void props.onCommand([{ kind: 'reattach', threadId: thread.id, target: props.selection }])}>{t.reattach}</Button> : null}
      </> : null}
    </article>)}
    <h3 className="text-sm font-semibold">{t.suggestions}</h3>
    {suggestions.map(suggestion => <Suggestion key={suggestion.id} {...props} suggestion={suggestion} />)}
    {props.snapshot && !suggestions.length ? <p className="text-sm text-muted-foreground">{t.noSuggestions}</p> : null}
  </section>;
}
function CommentComposer(props: FeedCommentPanelProps & { composer: FeedCommentComposer }) {
  const t = useT().feedCollaboration; const [text, setText] = useState(''); const [reason, setReason] = useState(''); const [error, setError] = useState(false);
  const { composer } = props; const blocked = props.readOnly || props.pending || composer.anchor.sourceRevision !== props.revision;
  async function submit() {
    setError(false);
    try {
      const identity = crypto.randomUUID();
      const commands: FeedCommand[] = composer.kind === 'comment' ? [composer.threadId ? { kind: 'reply', threadId: composer.threadId, text } : { kind: 'comment', threadId: identity, target: composer.anchor.target, text }] : [{ kind: 'propose', suggestionId: identity, edits: proposeFeedReplacement(props.composition, composer.anchor.target, text), rationale: reason, parentId: composer.parentId, threadId: composer.threadId }];
      if (await props.onCommand(commands)) { props.onComposer(null); if (composer.kind === 'comment') props.onThread(composer.threadId ?? identity); } else setError(true);
    } catch { setError(true); }
  }
  return <form className="space-y-3" onSubmit={event => { event.preventDefault(); void submit(); }}>
    <div role="group" aria-label={t.commentOrSuggest} className="flex gap-1 rounded-lg border p-1">
      {(['comment', 'suggest'] as const).map(kind => <Button key={kind} type="button" variant="ghost" size="sm" className="min-h-11 md:min-h-8 flex-1 aria-pressed:bg-muted" aria-pressed={composer.kind === kind} onClick={() => props.onComposer({ ...composer, kind })}>{t[kind]}</Button>)}
    </div>
    <blockquote className="max-h-32 overflow-y-auto whitespace-pre-wrap border-l-2 pl-2 text-sm" aria-label={t.selection}>{composer.anchor.quote || t.post}</blockquote>
    <textarea autoFocus className="w-full min-h-28 rounded-md border bg-background p-2 text-base" aria-label={composer.kind === 'comment' ? t.commentPlaceholder : t.replacementPlaceholder} placeholder={composer.kind === 'comment' ? t.commentPlaceholder : t.replacementPlaceholder} value={text} onChange={event => setText(event.target.value)} />
    {composer.kind === 'suggest' ? <textarea className="w-full min-h-20 rounded-md border bg-background p-2 text-base" aria-label={t.reasonPlaceholder} placeholder={t.reasonPlaceholder} value={reason} onChange={event => setReason(event.target.value)} /> : null}
    {blocked ? <p role="status" className="text-sm">{t.syncFirst}</p> : null}
    {error ? <p role="alert" className="text-sm">{t.loadFailed}</p> : null}
    <div className="flex gap-2"><Button type="submit" variant="default" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={blocked || (composer.kind === 'comment' && !text.trim())}><Send aria-hidden />{t.send}</Button><Button type="button" variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" onClick={() => props.onComposer(null)}>{t.cancel}</Button></div>
  </form>;
}
type ThreadMessage = { id: string; role: string; content: Array<{ type: string; text?: string }>; senderUserId?: string; senderName?: string; sequence: number };
function ThreadMessages(props: FeedCommentPanelProps & { thread: FeedCommentThread }) {
  const t = useT().feedCollaboration; const [reply, setReply] = useState(''); const [older, setOlder] = useState<ThreadMessage[]>([]);
  const path = feedCollaborationPath(props.assistantId, props.sessionId) + `/threads/${props.thread.id}/messages`;
  const key = feedCollaborationCacheKey(props.workspaceId, props.assistantId, props.sessionId, props.thread.id);
  const resource = useCachedResource<{ messages: ThreadMessage[] }>(key, () => feedPaintFirst(key, () => readFeedCachedJson(path), () => feedCachedJson(path)));
  useEffect(() => { void resource.refresh(); }, [props.snapshot?.copy?.sequence, resource.refresh]);
  const messages = [...new Map([...older, ...(resource.data?.messages ?? [])].map(message => [message.id, message])).values()].sort((a, b) => a.sequence - b.sequence);
  return <div className="space-y-3">
    {resource.loading && !resource.data ? <Skeleton className="h-24 w-full" /> : null}
    {resource.error ? <p role="alert" className="text-sm">{t.loadFailed}<Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" onClick={() => void resource.refresh()}>{t.retry}</Button></p> : null}
    {messages.length >= 50 && messages[0]!.sequence > 1 ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" onClick={() => void feedCachedJson<{ messages: ThreadMessage[] }>(`${path}?before=${messages[0]!.sequence}`).then(result => setOlder(current => [...result.messages, ...current]))}>{t.earlier}</Button> : null}
    {messages.map(message => <div key={message.id} className="text-sm"><p className="font-medium">{message.role === 'assistant' ? t.brian : message.senderName ?? `${t.author} ${message.senderUserId?.slice(0, 8) ?? ''}`}</p><p className="whitespace-pre-wrap break-words">{message.content.filter(block => block.type === 'text').map(block => block.text ?? '').join('\n')}</p></div>)}
    <form onSubmit={event => { event.preventDefault(); void props.onCommand([{ kind: 'reply', threadId: props.thread.id, text: reply }]).then(ok => { if (ok) setReply(''); }); }} className="space-y-2">
      <textarea className="w-full min-h-20 rounded-md border bg-background p-2 text-base" aria-label={t.reply} value={reply} onChange={event => setReply(event.target.value)} />
      <Button type="submit" variant="default" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={props.readOnly || props.pending || !reply.trim()}><Send aria-hidden />{t.reply}</Button>
    </form>
  </div>;
}
function Suggestion(props: FeedCommentPanelProps & { suggestion: FeedDraftSuggestion }) {
  const t = useT().feedCollaboration; const suggestion = props.suggestion;
  const before = suggestion.edits.map(edit => edit.kind === 'replaceText' ? edit.preimage.map(inlineText).join('\n') : edit.kind === 'replaceBlock' ? feedText(edit.preimage) : '').filter(Boolean).join('\n\n');
  const after = suggestion.edits.map(edit => edit.kind === 'replaceText' ? edit.replacement.map(inlineText).join('\n') : edit.kind === 'replaceBlock' ? edit.replacement.map(feedText).join('\n') : edit.kind === 'insertBlock' ? feedText(edit.node) : '').filter(Boolean).join('\n\n');
  const target: FeedTarget = suggestion.edits[0]?.kind === 'replaceText' ? { kind: 'range', spans: suggestion.edits[0].spans } : suggestion.edits[0] && 'blockId' in suggestion.edits[0] ? { kind: 'block', segmentId: suggestion.edits[0].segmentId, blockId: suggestion.edits[0].blockId } : { kind: 'post' };
  const blocked = props.readOnly || props.pending; const proposed = ['proposed', 'deferred'].includes(suggestion.status);
  return <article className="space-y-3 rounded-lg border p-3" data-feed-suggestion={suggestion.id}>
    <p className="text-sm font-medium">{suggestion.authorKind === 'assistant' ? t.brian : t.author}</p>
    <div className="rounded-lg bg-muted/40 p-3 text-sm"><p className="mb-1 text-xs font-semibold text-muted-foreground">{t.before}</p><p className="whitespace-pre-wrap break-words">{before}</p></div>
    <div className="rounded-lg bg-emerald-50/60 p-3 text-sm dark:bg-emerald-950/25"><p className="mb-1 text-xs font-semibold text-emerald-700 dark:text-emerald-400">{t.after}</p><p className="whitespace-pre-wrap break-words">{after}</p></div>
    {suggestion.sourceProposal?.imageBrief ? <div className="text-sm"><p className="font-medium">{t.imageBrief}</p><p className="whitespace-pre-wrap">{suggestion.sourceProposal.imageBrief}</p></div> : null}
    {suggestion.rationale ? <p className="text-sm whitespace-pre-wrap">{suggestion.rationale}</p> : null}
    <div className="flex flex-wrap gap-2">
      {proposed ? <><Button variant="default" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={blocked} onClick={() => void props.onCommand([{ kind: 'decide', suggestionId: suggestion.id, outcome: 'accepted', reasonThreadId: suggestion.threadId ?? undefined }], suggestion.edits)}><Check aria-hidden />{t.accept}</Button>
        <Button variant="destructive" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={blocked} onClick={() => void props.onCommand([{ kind: 'decide', suggestionId: suggestion.id, outcome: 'rejected', reasonThreadId: suggestion.threadId ?? undefined }])}><X aria-hidden />{t.reject}</Button>
        <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={blocked} onClick={() => props.onComposer({ kind: 'suggest', anchor: { target, quote: before, sourceRevision: props.revision, state: 'attached' }, parentId: suggestion.id, threadId: suggestion.threadId ?? undefined })}><PencilLine aria-hidden />{t.refine}</Button></> : <p className="text-sm">{suggestion.status === 'accepted' ? t.accepted : suggestion.status === 'rejected' ? t.rejected : t.undone}</p>}
      {suggestion.status === 'accepted' && suggestion.acceptanceReceipt ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={blocked} onClick={() => void props.onCommand([{ kind: 'undo', revision: suggestion.acceptanceReceipt!.revision }])}><Undo2 aria-hidden />{t.undo}</Button> : null}
    </div>
  </article>;
}
