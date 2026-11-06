"use client";
/** Brian and Assistant workspace consent. [COMP:app-web/workspace-consent] */
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { useT } from '@/lib/i18n/client';
import { fetchWorkspaceConsent, decideWorkspaceConsent, workspaceConsentSignInUrl, type WorkspaceConsentReview } from '@/lib/api/workspace-consent';
type State = { kind: 'loading' | 'error' } | { kind: 'ready' | 'submitting'; review: WorkspaceConsentReview };
export function WorkspaceConsent() {
  const dictionary = useT(), t = dictionary.applicationConsent, copy = dictionary.workspaceConsent;
  const params = useSearchParams(), req = params?.get('req') ?? '', assistantId = params?.get('assistant') ?? undefined;
  const [state, setState] = useState<State>({ kind: 'loading' }), [workspaceId, setWorkspaceId] = useState('');
  const [scope, setScope] = useState<'read' | 'read_write'>('read'), [workspaceAccess, setWorkspaceAccess] = useState(true);
  const generation = useRef(0);
  useEffect(() => {
    let controller: AbortController | undefined;
    const clear = () => { generation.current++; controller?.abort(); setState({ kind: 'loading' }); };
    const load = () => {
      clear(); if (document.hidden) return;
      controller = new AbortController(); const version = generation.current;
      fetchWorkspaceConsent(req, assistantId, controller.signal).then(review => {
        if (version !== generation.current) return;
        setWorkspaceId(review.workspaces[0]?.id ?? ''); setScope(review.scope); setWorkspaceAccess(review.workspaceAccessAvailable);
        setState({ kind: 'ready', review });
      }, error => {
        if (version !== generation.current) return;
        if (error instanceof Error && error.message === 'workspace_signin_required') {
          try { window.location.assign(workspaceConsentSignInUrl(req, assistantId)); return; } catch { /* Show unavailable. */ }
        }
        setState({ kind: 'error' });
      });
    };
    const visibility = () => { if (document.hidden) clear(); else load(); };
    load(); document.addEventListener('visibilitychange', visibility);
    return () => { generation.current++; controller?.abort(); document.removeEventListener('visibilitychange', visibility); };
  }, [req, assistantId]);
  async function decide(decision: 'allow' | 'deny') {
    if (state.kind !== 'ready') return;
    const version = generation.current, review = state.review; setState({ kind: 'submitting', review });
    try {
      const redirect = await decideWorkspaceConsent(req, assistantId, review, { workspaceId, decision, grantedScope: scope, workspaceAccess });
      if (version === generation.current) window.location.assign(redirect);
    } catch { if (version === generation.current) setState({ kind: 'error' }); }
  }
  return <main className="min-h-dvh flex items-center justify-center bg-background px-4 py-8"><section className="w-full max-w-lg min-w-0 rounded-xl border border-border bg-card p-6 space-y-5">
    <h1 className="text-lg font-semibold">{copy.title}</h1>
    {state.kind === 'loading' && <p role="status">{t.loading}</p>}
    {state.kind === 'error' && <p role="alert">{t.unavailable}</p>}
    {'review' in state && <>
      <p className="break-all font-medium">{state.review.clientName ?? t.unnamed}</p>
      <p>{copy.explanation}</p>
      <label className="block space-y-2"><span>{t.workspace}</span><Select value={workspaceId} onValueChange={value => setWorkspaceId(value ?? '')} disabled={state.kind === 'submitting'}>
        <SelectTrigger className="max-sm:min-h-11 w-full text-base"><SelectValue>{state.review.workspaces.find(w => w.id === workspaceId)?.name ?? copy.noWorkspaces}</SelectValue></SelectTrigger>
        <SelectContent>{state.review.workspaces.map(w => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}</SelectContent>
      </Select></label>
      <label className="block space-y-2"><span>{t.scope}</span><Select value={scope} onValueChange={value => setScope(value === 'read_write' ? 'read_write' : 'read')} disabled={state.kind === 'submitting'}>
        <SelectTrigger className="max-sm:min-h-11 w-full text-base"><SelectValue>{scope === 'read' ? t.read : t.readWrite}</SelectValue></SelectTrigger>
        <SelectContent><SelectItem value="read">{t.read}</SelectItem>{state.review.scope === 'read_write' && <SelectItem value="read_write">{t.readWrite}</SelectItem>}</SelectContent>
      </Select></label>
      {state.review.workspaceAccessAvailable && <label className="flex max-sm:min-h-11 items-start gap-3 py-2"><Checkbox checked={workspaceAccess} onCheckedChange={setWorkspaceAccess} disabled={state.kind === 'submitting' || state.review.workspaceAccessRequired} /><span><span className="block font-medium">{dictionary.apiKeys.workspaceAccessLabel}</span><span>{dictionary.apiKeys.workspaceAccessDescription}</span></span></label>}
      <div className="flex gap-3"><Button className="max-sm:min-h-11 flex-1" disabled={state.kind === 'submitting' || !workspaceId} onClick={() => void decide('allow')}>{state.kind === 'submitting' ? t.submitting : t.allow}</Button><Button className="max-sm:min-h-11 flex-1" variant="outline" disabled={state.kind === 'submitting' || !workspaceId} onClick={() => void decide('deny')}>{t.deny}</Button></div>
    </>}
  </section></main>;
}
