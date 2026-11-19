'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { authFetch, getAccessToken } from '@/lib/auth-fetch';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
import { useT } from '@/lib/i18n/client';
import { buildDelegatedLoginUrl, primaryAuthUrl } from '@/lib/primary-auth';
import { getUserInfo } from '@/lib/user';

const reviewSchema = z.object({
  status: z.enum(['pending', 'approved', 'active', 'expired', 'revoked', 'cancelled']),
  mode: z.enum(['automatic', 'pairing']),
  workspaceId: z.string().uuid().optional(),
  workspaces: z.array(z.object({ id: z.string().uuid(), name: z.string() })),
  expiresAt: z.string().datetime({ offset: true }).optional(),
  code: z.string().regex(/^\d{8}$/).optional(),
  codeExpiresAt: z.string().datetime({ offset: true }).optional(),
});
type Review = z.infer<typeof reviewSchema>;

function signInForRequest(id: string) {
  const next = new URL('/memory-access', window.location.origin);
  next.hash = new URLSearchParams({ request: id }).toString();
  window.location.assign(buildDelegatedLoginUrl(primaryAuthUrl() ?? window.location.origin, next.href));
}

async function requestAccess(id: string, action: 'review' | 'approve' | 'decline' | 'revoke', workspaceId?: string) {
  const url = `${publicRuntimeConfig().apiUrl}/api/agent-memory/temporary-access/${id}/${action}`;
  const response = await authFetch(url, { method: 'POST', cache: 'no-store', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workspaceId ? { workspaceId } : {}) });
  if (response.status === 401) signInForRequest(id);
  if (!response.ok) throw new Error('memory_access_unavailable');
  return response.json();
}

export default function MemoryAccessPage() {
  const copy = useT().temporaryMemoryAccess;
  const [review, setReview] = useState<Review>();
  const [workspace, setWorkspace] = useState('');
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const version = useRef(0);
  const requestId = useRef('');
  const load = useCallback(async () => {
    const generation = ++version.current;
    const raw = new URLSearchParams(location.hash.slice(1)).get('request');
    const parsed = z.string().uuid().safeParse(raw);
    const next = parsed.success ? parsed.data : '';
    if (requestId.current !== next) setWorkspace('');
    requestId.current = next;
    setReview(undefined); setError(false); setBusy(false);
    if (document.hidden) return;
    try {
      if (!next) throw new Error('missing_request');
      if (!getAccessToken() && !getUserInfo()) { signInForRequest(next); return; }
      const result = reviewSchema.parse(await requestAccess(next, 'review'));
      if (generation !== version.current) return;
      setReview(result);
      setWorkspace(selected => result.workspaceId ?? (result.workspaces.some(w => w.id === selected) ? selected : result.workspaces[0]?.id ?? ''));
    } catch { if (generation === version.current) setError(true); }
  }, []);
  useEffect(() => {
    void load();
    window.addEventListener('hashchange', load); document.addEventListener('visibilitychange', load);
    return () => { version.current++; window.removeEventListener('hashchange', load); document.removeEventListener('visibilitychange', load); };
  }, [load]);
  useEffect(() => {
    const deadlines = [review?.expiresAt, review?.codeExpiresAt].filter((v): v is string => Boolean(v)).map(Date.parse).filter(t => t > Date.now());
    if (!deadlines.length) return;
    const timer = window.setTimeout(() => void load(), Math.min(...deadlines) - Date.now() + 100);
    return () => window.clearTimeout(timer);
  }, [review, load]);
  async function act(action: 'approve' | 'decline' | 'revoke') {
    if (busy || !review) return;
    const generation = version.current;
    setBusy(true); setError(false);
    try {
      await requestAccess(requestId.current, action, action === 'approve' ? workspace : undefined);
      if (generation === version.current) await load();
    } catch {
      if (generation === version.current) { setReview(undefined); setError(true); setBusy(false); }
    }
  }
  const allowed = review?.status === 'active' || review?.status === 'approved';
  const pairing = review?.status === 'approved' && review.mode === 'pairing';
  const chosen = review?.workspaces.find(w => w.id === workspace);
  return <main className="grid min-h-dvh place-items-center bg-background px-4 py-8"><section className="w-full max-w-md space-y-5 rounded-xl border border-border bg-card p-6" aria-busy={busy}>
    <h1 className="text-xl font-semibold">{copy.title}</h1>
    {!review && !error && <div role="status" aria-label={copy.loading} className="h-16 animate-pulse rounded bg-muted" />}
    {error && <><p role="alert">{copy.error}</p><Button variant="outline" className="max-sm:min-h-11" onClick={() => void load()}>{copy.retry}</Button></>}
    {review?.status === 'pending' && <>
      <p>{copy.permission}</p>
      {review.workspaces.length > 0 ? <div className="space-y-2"><label htmlFor="memory-access-workspace">{copy.workspace}</label>
        <Select value={workspace} onValueChange={v => setWorkspace(v ?? '')} disabled={busy || Boolean(review.workspaceId)}>
          <SelectTrigger id="memory-access-workspace" className="max-sm:min-h-11 w-full"><SelectValue>{chosen?.name}</SelectValue></SelectTrigger>
          <SelectContent>{review.workspaces.map(w => <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>)}</SelectContent>
        </Select></div> : <p>{copy.noWorkspace}</p>}
      <div className="flex flex-wrap gap-2"><Button className="max-sm:min-h-11" disabled={busy || !chosen} onClick={() => void act('approve')}>{copy.approve}</Button>
        <Button className="max-sm:min-h-11" variant="outline" disabled={busy} onClick={() => void act('decline')}>{copy.cancel}</Button></div>
    </>}
    {allowed && review && <>
      <p className="break-words font-medium">{chosen?.name}</p>
      {review.expiresAt && <p>{copy.expires} <time dateTime={review.expiresAt}>{new Date(review.expiresAt).toLocaleString()}</time></p>}
      <p>{pairing ? copy.pairing : copy.resume}</p>
      {pairing && (review.code && review.codeExpiresAt && Date.parse(review.codeExpiresAt) > Date.now() ? <><output className="select-all font-mono text-2xl tracking-widest">{review.code}</output><p>{copy.codeExpiry} <time dateTime={review.codeExpiresAt}>{new Date(review.codeExpiresAt).toLocaleTimeString()}</time></p></> : <Button className="max-sm:min-h-11" disabled={busy} onClick={() => void act('approve')}>{copy.newCode}</Button>)}
      <Button className="max-sm:min-h-11" variant="outline" disabled={busy} onClick={() => void act('revoke')}>{copy.revoke}</Button>
    </>}
    {review && ['expired','revoked','cancelled'].includes(review.status) && <p role="status">{copy[review.status as 'expired'|'revoked'|'cancelled']}</p>}
  </section></main>;
}
