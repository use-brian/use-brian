"use client";
import { Button, buttonVariants } from '@/components/ui/button';
/** Native confirmation, provenance and governed learning. [COMP:app-web/feed-learned-decisions] */
import { useRef, useState } from 'react';
import type { FeedLearnedDecisions as Learned, FeedLearningCommandRequest } from '@use-brian/shared';
import { useLocale, useT } from '@/lib/i18n/client';
import { authFetch } from '@/lib/auth-fetch';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
import { feedCollaborationPath } from '@/lib/feed-collaboration';
import { feedPostPath, type FeedPlatform } from '@/lib/feed-nav';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { ListSurfaceSkeleton } from '@/components/chrome/surface-skeleton';
const control = buttonVariants({ variant: 'outline', size: 'sm', className: 'min-h-11 md:min-h-8 whitespace-normal text-left' });
type Command = FeedLearningCommandRequest['command'];
export function useFeedLearningActions(assistantId: string, sessionId: string, revision: number, refresh: () => void, linkedinPreviewHash?: string) {
  const locale = useLocale(); const [busy, setBusy] = useState(false); const [error, setError] = useState(false);
  const retained = useRef<{ key: string; mutationId: string } | null>(null);
  async function request(suffix: string, value: Record<string, unknown>, identity = true): Promise<boolean> {
    if (busy) return false;
    const key = JSON.stringify({ assistantId, sessionId, suffix, value });
    if (retained.current?.key !== key) retained.current = { key, mutationId: crypto.randomUUID() };
    setBusy(true); setError(false);
    try {
      const response = await authFetch(`${publicRuntimeConfig().apiUrl ?? 'http://localhost:4000'}${feedCollaborationPath(assistantId, sessionId)}${suffix}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...value, ...(identity ? { mutationId: retained.current.mutationId } : {}) }) });
      if (!response.ok) throw new Error('Feed learning request failed');
      retained.current = null; refresh(); return true;
    } catch { setError(true); refresh(); return false; } finally { setBusy(false); }
  }
  return { busy, error, confirm: (reviewRunId?: string) => request('/confirmation', { expectedRevision: revision, locale, reviewRunId, linkedinPreviewHash }), command: (confirmationId: string, command: Command) => request('/learning/commands', { expectedRevision: revision, confirmationId, command }), retry: (runId: string) => request(`/runs/${runId}/retry`, {}, false) };
}
export type FeedLearningActions = ReturnType<typeof useFeedLearningActions>;
type Editor = { confirmationId: string; kind: 'remember' | 'editRule' | 'editSummary' | 'editVoice'; id?: string; text: string; detail: string };
export function FeedLearnedDecisions(props: {
  workspaceId: string; sessionId: string; platform: FeedPlatform; revision: number;
  data?: Learned | null; loading: boolean; error?: unknown; disabled: boolean; offline: boolean; unfinished: boolean;
  reviewRunId?: string; actions: FeedLearningActions; onRefresh: () => void; onThread: (id: string) => void;
}) {
  const t = useT().feedLearning; const tc = useT().feedCollaboration; const tr = useT().feedReview; const tg = useT().feedGeneration;
  const [editor, setEditor] = useState<Editor | null>(null);
  const unavailable = props.disabled || props.offline || props.loading || Boolean(props.error) || props.actions.busy;
  const current = props.data?.confirmations.find(item => item.current);
  async function governed(confirmationId: string, command: Command, label: string) {
    if (await confirmDialog({ title: label, description: t.governanceExplanation, confirmLabel: label, cancelLabel: tc.cancel })) await props.actions.command(confirmationId, command);
  }
  async function saveEditor() {
    if (!editor?.text.trim()) return;
    const command: Command = editor.kind === 'remember' ? { action: 'remember', rule: editor.text } : editor.kind === 'editRule' ? { action: 'editRule', ruleId: editor.id!, rule: editor.text } : editor.kind === 'editVoice' ? { action: 'editVoice', memoryId: editor.id!, summary: editor.text, detail: editor.detail } : { action: 'editSummary', summary: editor.text, detail: editor.detail };
    if (await props.actions.command(editor.confirmationId, command)) setEditor(null);
  }
  const sourceLinks = (ids: string[], confirmationId: string, revoked: boolean) => (
        <ul className="mt-2 space-y-2 text-xs">{ids.map(id => { const source = props.data?.sources.find(source => source.id === id); return source ? <li key={id} className="break-words"><span>{t.source}: {source.actorName ?? t.unknownAuthor}{source.revision !== null ? ` · ${t.revision} ${source.revision}` : ''}</span><div className="flex flex-wrap gap-2">{source.sessionId === props.sessionId && source.threadId ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" onClick={() => props.onThread(source.threadId!)}>{t.openSource}</Button> : source.sessionId ? <a className={control} href={feedPostPath(props.workspaceId, props.platform, source.sessionId)}>{t.openSource}</a> : null}{source.canRetract && !revoked ? <Button variant="destructive" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(confirmationId, { action: 'retractSource', eventId: source.id }, t.retract)}>{t.retract}</Button> : null}</div></li> : null; })}</ul>
  );
  return <section className="min-w-0 space-y-3 rounded-lg border p-3" aria-label={t.title}>
    <h3 className="text-sm font-semibold">{t.title}</h3>
    <p className="text-sm text-muted-foreground">{t.explanation}</p>
    <p role="status" className="text-sm">{current ? t.confirmed : t.notConfirmed}</p>
    <Button variant="default" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable || !props.data?.canConfirm || Boolean(current) || props.unfinished} onClick={async () => { if (await confirmDialog({ title: t.confirm, description: t.confirmExplanation, confirmLabel: t.confirm, cancelLabel: tc.cancel })) await props.actions.confirm(props.reviewRunId); }}>{t.confirm}</Button>
    {props.unfinished ? <p className="text-sm">{tg.unfinished}</p> : null}
    {props.offline ? <p role="status" className="text-sm">{t.offline}</p> : props.disabled ? <p role="status" className="text-sm">{tc.syncFirst}</p> : null}
    {props.loading && !props.data ? <ListSurfaceSkeleton rows={3} /> : null}
    {props.error || props.actions.error ? <p role="alert" className="text-sm">{t.failed}<Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={props.offline || props.actions.busy} onClick={props.onRefresh}>{tc.retry}</Button></p> : null}
    {props.data?.privateSourcesOmitted ? <p role="status" className="text-sm">{t.privateOmitted}</p> : null}
    {editor ? <form className="space-y-2 rounded-md border p-2" onSubmit={event => { event.preventDefault(); void saveEditor(); }}>
      <label className="block text-sm">{editor.kind === 'editSummary' ? t.summary : t.instruction}<textarea autoFocus className="min-h-24 w-full rounded-md border bg-background p-2 text-base" maxLength={editor.kind === 'editSummary' ? 1200 : 280} value={editor.text} onChange={event => setEditor({ ...editor, text: event.target.value })} disabled={unavailable} /></label>
      {editor.kind === 'editSummary' || editor.kind === 'editVoice' ? <label className="block text-sm">{t.detail}<textarea className="min-h-24 w-full rounded-md border bg-background p-2 text-base" maxLength={editor.kind === 'editVoice' ? 4000 : 8000} value={editor.detail} onChange={event => setEditor({ ...editor, detail: event.target.value })} disabled={unavailable} /></label> : null}
      <div className="flex flex-wrap gap-2"><Button variant="default" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable || !editor.text.trim()} type="submit">{t.save}</Button><Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" type="button" onClick={() => setEditor(null)}>{tc.cancel}</Button></div>
    </form> : null}
    {props.data?.confirmations.map(item => <article key={item.id} className="min-w-0 space-y-3 border-t pt-3" data-feed-confirmation={item.id}>
      <p className="text-sm font-medium">{t.revision} {item.revision}: {item.revoked ? t.revoked : item.current ? t.confirmed : t.previous}</p>
      {item.run ? <div className="space-y-1 text-sm"><p>{t.synthesis}: {tr[item.run.status]}</p>{item.run.status === 'unknown_outcome' ? <p>{tr.unknownExplanation}</p> : null}{!item.revoked && ['failed', 'cancelled'].includes(item.run.status) && item.run.error !== 'cancelled_after_dispatch' && item.run.attempts < 3 ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void props.actions.retry(item.run!.id)}>{tc.retry}</Button> : null}</div> : null}
      {item.summary ? <div className="space-y-2"><h4 className="text-sm font-medium">{t.summary}</h4><p className="whitespace-pre-wrap break-words text-sm">{item.summary.text}</p>
        {item.summary.correction ? <p className="whitespace-pre-wrap break-words text-sm">{item.summary.correction}</p> : null}
        <details><summary className="min-h-11 cursor-pointer py-3 text-sm">{t.decisions}</summary><ul className="space-y-2 text-sm">{item.summary.decisions.map((decision, i) => <li key={i} className="break-words">{decision.statement}</li>)}</ul></details>
        {item.summary.conflicts.length ? <div><h4 className="text-sm font-medium">{t.conflicts}</h4><ul className="space-y-2 text-sm">{item.summary.conflicts.map((conflict, i) => <li key={i}>{conflict.statement}</li>)}</ul></div> : null}
        {item.summary.unresolved.length ? <div><h4 className="text-sm font-medium">{t.unresolved}</h4><ul className="space-y-2 text-sm">{item.summary.unresolved.map((question, i) => <li key={i}>{question}</li>)}</ul></div> : null}
        {sourceLinks(item.summary.sourceEventIds, item.id, item.revoked)}
        {item.summary.canEdit && !item.revoked ? <div className="flex flex-wrap gap-2"><Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(item.id, { action: 'scopeSummary', scope: item.summary!.postOnly ? 'future' : 'post' }, item.summary!.postOnly ? t.futureReference : t.onlyThisPost)}>{item.summary.postOnly ? t.futureReference : t.onlyThisPost}</Button><Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => setEditor({ confirmationId: item.id, kind: 'editSummary', text: item.summary!.text, detail: item.summary!.correction ?? '' })}>{t.edit}</Button><Button variant="destructive" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(item.id, { action: 'forgetSummary' }, t.forget)}>{t.forget}</Button></div> : null}
      </div> : <p className="text-sm text-muted-foreground">{t.noSummary}</p>}
      {typeof item.coverage.included === 'number' ? <p className="text-xs text-muted-foreground">{t.coverage}: {item.coverage.included}/{String(item.coverage.eligible ?? item.coverage.included)}; {t.omitted}: {String(item.coverage.omitted ?? 0)}</p> : null}
      {props.data?.canConfirm && !item.revoked ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => setEditor({ confirmationId: item.id, kind: 'remember', text: '', detail: '' })}>{t.remember}</Button> : null}
      {item.artifacts.map(artifact => <details key={artifact.id} className="min-w-0 rounded-md border p-2" data-feed-artifact={artifact.id}>
        <summary className="min-h-11 cursor-pointer break-words py-2 text-sm">{artifact.kind === 'voice' ? t.voice : t.rule}: {artifact.erased ? t.erased : artifact.text} ({t[artifact.status]})</summary>
        <p className="text-xs text-muted-foreground">{t.scope}: {artifact.scope.platform}, {artifact.scope.postFormat}{artifact.scope.brandId ? ` · ${t.brand}` : ''}</p>
        {artifact.canEdit && !item.revoked ? <div className="mt-2 flex flex-wrap gap-2">
          {!['retired', 'rejected', 'forgotten'].includes(artifact.status) ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => setEditor({ confirmationId: item.id, kind: artifact.kind === 'voice' ? 'editVoice' : 'editRule', id: artifact.id, text: artifact.text, detail: '' })}>{t.edit}</Button> : null}
          {artifact.kind === 'rule' && artifact.status === 'suggested' ? <Button variant="default" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(item.id, { action: 'decideRule', ruleId: artifact.id, decision: 'approve' }, t.approve)}>{t.approve}</Button> : null}
          {artifact.kind === 'rule' && ['retired','rejected'].includes(artifact.status) ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(item.id, { action: 'decideRule', ruleId: artifact.id, decision: 'restore' }, t.restore)}>{t.restore}</Button> : null}
          {artifact.kind === 'rule' && ['active','suggested'].includes(artifact.status) ? <Button variant="destructive" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(item.id, { action: 'decideRule', ruleId: artifact.id, decision: 'dismiss' }, t.dismiss)}>{t.dismiss}</Button> : null}
          {artifact.status !== 'forgotten' ? <Button variant="destructive" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(item.id, artifact.kind === 'rule' ? { action: 'decideRule', ruleId: artifact.id, decision: 'forget' } : { action: 'forgetVoice', memoryId: artifact.id }, t.forget)}>{t.forget}</Button> : null}
          {artifact.canPromote && artifact.kind === 'rule' && artifact.status === 'active' ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(item.id, { action: 'scopeRule', ruleId: artifact.id, scope: 'brand_voice' }, t.promote)}>{t.promote}</Button> : null}
          {artifact.kind === 'voice' && artifact.status === 'active' ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(item.id, { action: 'scopeVoice', memoryId: artifact.id, scope: 'member' }, t.narrow)}>{t.narrow}</Button> : null}
        </div> : null}
          {artifact.status === 'active' && props.data?.canConfirm && !item.revoked ? <Button variant="outline" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(item.id, artifact.kind === 'rule' ? { action: 'scopeRule', ruleId: artifact.id, scope: 'post' } : { action: 'scopeVoice', memoryId: artifact.id, scope: 'post' }, t.postOnly)}>{t.postOnly}</Button> : null}
        {sourceLinks(artifact.sourceEventIds, item.id, item.revoked)}
      </details>)}
      {!item.revoked && props.data?.canConfirm ? <Button variant="destructive" size="sm" className="min-h-11 md:min-h-8 whitespace-normal" disabled={unavailable} onClick={() => void governed(item.id, { action: 'revoke' }, t.revoke)}>{t.revoke}</Button> : null}
    </article>)}
  </section>;
}
