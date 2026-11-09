"use client";

/** Workspace credential administration. [COMP:app-web/external-approvals] */
import { useEffect, useRef, useState } from 'react';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { useT } from '@/lib/i18n/client';
import { Button } from '@/components/ui/button';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { confirmDialog } from '@/components/ui/confirm-dialog';
import { useToast } from '@/components/ui/use-toast';
import { SurfaceSkeletonFor } from '@/components/chrome/surface-skeleton';
import { useCachedResource, invalidateSurfaceCache } from '@/lib/surface-cache';
import { externalApprovalSourcesCacheKey, externalApprovalDestinationsCacheKey } from '@/lib/surface-prefetch';
import { listAssistants } from '@/lib/api/studio';

import { createExternalApprovalSource, listExternalApprovalSources, listExternalApprovalDestinations, rotateExternalApprovalSource, revokeExternalApprovalSource, ExternalApprovalSourceError, type ExternalApprovalSourceInput } from '@/lib/api/external-approval-sources';

export function ExternalApprovalsSection() {
  const { workspaceId, role, me } = useWorkspaceContext();
  const t = useT().externalApprovals;
  if (role !== 'owner' && role !== 'admin') return <p role="status">{t.adminOnly}</p>;
  // Keyed lifetime prevents old promises from writing into a new workspace or viewer.
  return <ExternalApprovalsAdmin key={`${workspaceId}:${me.id}:${role}`} workspaceId={workspaceId} viewerId={me.id} />;
}
function ExternalApprovalsAdmin({ workspaceId, viewerId }: {workspaceId: string; viewerId: string}) {
  const t = useT().externalApprovals;
  const { toast, feedback } = useToast();
  const alive = useRef(false);
  const controller = useRef<AbortController | null>(null);
  useEffect(() => {
    alive.current = true;
    controller.current = new AbortController();
    return () => { alive.current = false; controller.current?.abort(); };
  }, []);
  const key = externalApprovalSourcesCacheKey(workspaceId, viewerId);
  const resource = useCachedResource(key, async () => {
    const [sources, assistants] = await Promise.all([
      listExternalApprovalSources(workspaceId), listAssistants(workspaceId, {requireSuccess: true}),
    ]);
    return {sources, assistants};
  });
  const [draft, setDraft] = useState<ExternalApprovalSourceInput>({name:'', assistantId:'', destinationId:''});
  const validAssistant = resource.data?.assistants.some(a => a.id === draft.assistantId) && resource.error === undefined;
  const destinations = useCachedResource(validAssistant ? externalApprovalDestinationsCacheKey(workspaceId, viewerId, draft.assistantId) : null,
    () => listExternalApprovalDestinations(workspaceId, draft.assistantId));
  const refresh = async () => { await Promise.all([resource.refresh(), destinations.refresh()]); };
  useEffect(() => {
    const recover = () => { void resource.refresh(); void destinations.refresh(); };
    window.addEventListener('online', recover);
    window.addEventListener('focus', recover);
    return () => { window.removeEventListener('online', recover); window.removeEventListener('focus', recover); };
  }, [resource.refresh, destinations.refresh]);
  function errorMessage(cause: unknown, loading = false) {
    if (cause instanceof ExternalApprovalSourceError) {
      if (cause.status === 401) return t.signInAgain;
      if (cause.status === 403) return t.accessDenied;
      if (cause.status === 409) return t.destinationChanged;
      if (cause.status === 404) return t.unavailable;
    }
    return loading ? t.loadFailed : t.failed;
  }
  const [secret, setSecret] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const locked = useRef(false);
  async function mutate(kind: 'create' | 'rotate' | 'revoke', sourceId?: string) {
    if (locked.current || secret) return;
    locked.current = true;
    setBusy(true);
    setError(null);
    try {
      if (kind !== 'create') {
        const accepted = await confirmDialog({ title: kind === 'rotate' ? t.rotate : t.revoke, description: kind === 'rotate' ? t.rotateConfirm : t.revokeConfirm, confirmLabel: kind === 'rotate' ? t.rotate : t.revoke, cancelLabel: t.cancel, variant: 'destructive', signal: controller.current?.signal });
        if (!accepted || !alive.current) return;
      }
      if (kind === 'revoke') await revokeExternalApprovalSource(workspaceId, sourceId!);
      else {
        const result = kind === 'create' ? await createExternalApprovalSource(workspaceId, draft) : await rotateExternalApprovalSource(workspaceId, sourceId!);
        if (!alive.current) return;
        // Only component memory. Never pass the issuance response to any cache.
        setSecret(result.token);
        if (kind === 'create') setDraft({name:'', assistantId:'', destinationId:''});
      }
      if (!alive.current) return;
      invalidateSurfaceCache(key);
      toast(t.saved);
    } catch (cause) {
      if (!alive.current) return;
      setError(errorMessage(cause));
      if (kind === 'create' && cause instanceof ExternalApprovalSourceError && cause.status === 409) {
        setDraft(current => ({...current, destinationId:''}));
        void destinations.refresh();
      }
    } finally {
      if (alive.current) { setBusy(false); locked.current = false; }
    }
  }
  async function copy() {
    if (!secret) return;
    try { await navigator.clipboard.writeText(secret); if (alive.current) toast(t.copied); }
    catch { if (alive.current) toast(t.copyFailed); }
  }
  const data = resource.data;
  const canCreate = !!draft.name.trim() && validAssistant && destinations.error === undefined && destinations.data?.destinations.some(d => d.id === draft.destinationId && d.assistantId === draft.assistantId);
  const disabled = busy || !!secret;
  const picker = (label: string, value: string, options: {id:string;label:string}[], change: (value:string) => void) => <div className="space-y-1"><span className="text-sm">{label}</span><Select value={value || null} onValueChange={v => change(v ?? '')} disabled={disabled}><SelectTrigger aria-label={label} className="min-h-11 w-full text-base"><SelectValue placeholder={t.choose} /></SelectTrigger><SelectContent>{options.map(o => <SelectItem className="min-h-11 whitespace-normal break-all text-base" key={o.id} value={o.id}>{o.label}</SelectItem>)}</SelectContent></Select></div>;
  return <section className="space-y-4 min-w-0">
    <h2 className="text-lg font-semibold">{t.title}</h2><p className="text-sm text-muted-foreground">{t.description}</p>
    {feedback}
    {secret && <div className="rounded border p-3 space-y-2" role="region" aria-label={t.credential}>
      <p>{t.once}</p><code className="block break-all select-all">{secret}</code>
      <div className="flex flex-wrap gap-2"><Button className="min-h-11" onClick={() => void copy()}>{t.copy}</Button><Button className="min-h-11" onClick={() => setSecret(null)}>{t.dismiss}</Button></div>
    </div>}
    {error && <div role="alert" className="space-y-2"><p>{error}</p><Button className="min-h-11" onClick={() => void refresh()}>{t.retry}</Button></div>}
    {resource.error !== undefined && <div role="alert"><p>{errorMessage(resource.error, true)}</p><Button className="min-h-11" onClick={() => void refresh()}>{t.retry}</Button></div>}
    {!data && resource.loading && <SurfaceSkeletonFor surface="studio" chrome={false} />}
    {data && <>
      <form className="space-y-3" onSubmit={e => {e.preventDefault(); if (canCreate && !disabled) void mutate('create');}}>
        <label className="block space-y-1"><span>{t.name}</span><input className="min-h-11 w-full rounded border px-3 text-base" value={draft.name} disabled={disabled} maxLength={120} onChange={e => setDraft({...draft, name:e.target.value})} /></label>
        {picker(t.assistant, draft.assistantId, data.assistants.map(a => ({id:a.id,label:a.name})), assistantId => setDraft({...draft, assistantId, destinationId:''}))}
        <p className="text-sm text-muted-foreground">{t.audiencePolicy}</p>
        {validAssistant && <>
          <Button type="button" className="min-h-11" onClick={() => void destinations.refresh()}>{t.refreshDestinations}</Button>
          {destinations.loading && <SurfaceSkeletonFor surface="studio" chrome={false} />}
          {destinations.error !== undefined && <p role="alert">{errorMessage(destinations.error, true)}</p>}
          {destinations.data && <>
            {picker(t.notification, draft.destinationId, destinations.data.destinations.filter(d => d.assistantId === draft.assistantId), destinationId => setDraft({...draft, destinationId}))}
            {destinations.data.destinations.length === 0 && <p>{t.noDestinations}</p>}
            <ul className="space-y-2 text-sm">{destinations.data.connections.filter(c => !c.available).map(c => <li className="break-words" key={c.id}>
              <span className="font-medium">{c.label}</span>: {c.reason === 'unsupported_transport' ? t.unsupportedTransport : t.noConversation}
            </li>)}</ul>
          </>}
        </>}
        <Button type="submit" className="min-h-11" disabled={disabled || !canCreate}>{t.create}</Button>
      </form>
      <p className="text-sm text-muted-foreground">{t.immutable}</p>
      {data.sources.length === 0 && <p>{t.empty}</p>}
      <ul className="space-y-3">{data.sources.map(source => <li className="rounded border p-3 space-y-2 break-words" key={source.id}>
        <h3 className="font-medium">{source.name}</h3>
        <dl className="text-sm space-y-1">
          <div><dt>{t.sourceId}</dt><dd className="break-all font-mono">{source.id}</dd></div>
          <div><dt>{t.prefix}</dt><dd className="break-all font-mono">{source.prefix}</dd></div>
          <div><dt>{t.assistant}</dt><dd>{data.assistants.find(a => a.id === source.assistantId)?.name ?? source.assistantId}</dd></div>
          <div><dt>{t.audience}</dt><dd>{source.audience === 'conversation_members' ? t.audiencePolicy : source.approverUserId ? `${t.legacyApprover}: ${source.approverUserId}` : t.audiencePolicy}</dd></div>
          <div><dt>{t.notification}</dt><dd className="break-all">{source.channelType === 'web' ? `${t.web}: ${source.destinationSessionId ?? source.channelId}` : `${source.channelType}: ${source.channelId}${source.threadRef ? ` #${source.threadRef}` : ''}`}{source.channelIntegrationId ? ` (${source.channelIntegrationId})` : ''}</dd></div>
        </dl>
        {source.revokedAt ? <p>{t.revoked}</p> : <div className="flex flex-wrap gap-2"><Button className="min-h-11" disabled={disabled} onClick={() => void mutate('rotate',source.id)}>{t.rotate}</Button><Button className="min-h-11" variant="destructive" disabled={disabled} onClick={() => void mutate('revoke',source.id)}>{t.revoke}</Button></div>}
      </li>)}</ul>
    </>}
  </section>;
}
