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
import { externalApprovalSourcesCacheKey } from '@/lib/surface-prefetch';
import { listAssistants } from '@/lib/api/studio';
import { listWorkspaceMemberOptions } from '@/lib/api/workflow';
import { createExternalApprovalSource, listExternalApprovalSources, rotateExternalApprovalSource, revokeExternalApprovalSource, ExternalApprovalSourceError, type ExternalApprovalSourceInput } from '@/lib/api/external-approval-sources';

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
    const [sources, assistants, members] = await Promise.all([
      listExternalApprovalSources(workspaceId), listAssistants(workspaceId, {requireSuccess: true}),
      listWorkspaceMemberOptions(workspaceId, {throwOnError: true}),
    ]);
    return {sources, assistants, members};
  });
  const [draft, setDraft] = useState<ExternalApprovalSourceInput>({name:'', assistantId:'', approverUserId:'', notification:'web'});
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
        if (kind === 'create') setDraft({name:'', assistantId:'', approverUserId:'', notification:'web'});
      }
      if (!alive.current) return;
      invalidateSurfaceCache(key);
      toast(t.saved);
    } catch (cause) {
      if (!alive.current) return;
      setError(cause instanceof ExternalApprovalSourceError
        ? [401,403].includes(cause.status) ? t.adminOnly
          : cause.status === 409 ? t.verifiedUnavailable
          : cause.status === 404 ? t.unavailable : t.failed
        : t.failed);
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
  const canCreate = !!data && !!draft.name.trim() && data.assistants.some(a => a.id === draft.assistantId) && data.members.some(m => m.id === draft.approverUserId);
  const disabled = busy || !!secret;
  const picker = (label: string, value: string, options: {id:string;label:string}[], change: (value:string) => void) => <div className="space-y-1"><span className="text-sm">{label}</span><Select value={value || null} onValueChange={v => change(v ?? '')} disabled={disabled}><SelectTrigger aria-label={label} className="min-h-11 w-full text-base"><SelectValue placeholder={t.choose} /></SelectTrigger><SelectContent>{options.map(o => <SelectItem className="min-h-11 text-base" key={o.id} value={o.id}>{o.label}</SelectItem>)}</SelectContent></Select></div>;
  return <section className="space-y-4 min-w-0">
    <h2 className="text-lg font-semibold">{t.title}</h2><p className="text-sm text-muted-foreground">{t.description}</p>
    {feedback}
    {secret && <div className="rounded border p-3 space-y-2" role="region" aria-label={t.credential}>
      <p>{t.once}</p><code className="block break-all select-all">{secret}</code>
      <div className="flex flex-wrap gap-2"><Button className="min-h-11" onClick={() => void copy()}>{t.copy}</Button><Button className="min-h-11" onClick={() => setSecret(null)}>{t.dismiss}</Button></div>
    </div>}
    {error && <div role="alert" className="space-y-2"><p>{error}</p><Button className="min-h-11" onClick={() => void resource.refresh()}>{t.retry}</Button></div>}
    {resource.error !== undefined && <div role="alert"><p>{t.loadFailed}</p><Button className="min-h-11" onClick={() => void resource.refresh()}>{t.retry}</Button></div>}
    {!data && resource.loading && <SurfaceSkeletonFor surface="studio" chrome={false} />}
    {data && <>
      <form className="space-y-3" onSubmit={e => {e.preventDefault(); if (canCreate && !disabled) void mutate('create');}}>
        <label className="block space-y-1"><span>{t.name}</span><input className="min-h-11 w-full rounded border px-3 text-base" value={draft.name} disabled={disabled} maxLength={120} onChange={e => setDraft({...draft, name:e.target.value})} /></label>
        {picker(t.assistant, draft.assistantId, data.assistants.map(a => ({id:a.id,label:a.name})), assistantId => setDraft({...draft, assistantId}))}
        {picker(t.approver, draft.approverUserId, data.members, approverUserId => setDraft({...draft, approverUserId}))}
        {picker(t.notification, draft.notification, [{id:'web',label:t.web},{id:'verified_channel',label:t.verifiedChannel}], notification => setDraft({...draft, notification:notification as ExternalApprovalSourceInput['notification']}))}
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
          <div><dt>{t.approver}</dt><dd>{data.members.find(m => m.id === source.approverUserId)?.label ?? source.approverUserId}</dd></div>
          <div><dt>{t.notification}</dt><dd className="break-all">{source.channelType === 'web' ? t.web : `${source.channelType}: ${source.channelId}`}{source.channelIntegrationId ? ` (${source.channelIntegrationId})` : ''}</dd></div>
        </dl>
        {source.revokedAt ? <p>{t.revoked}</p> : <div className="flex flex-wrap gap-2"><Button className="min-h-11" disabled={disabled} onClick={() => void mutate('rotate',source.id)}>{t.rotate}</Button><Button className="min-h-11" variant="destructive" disabled={disabled} onClick={() => void mutate('revoke',source.id)}>{t.revoke}</Button></div>}
      </li>)}</ul>
    </>}
  </section>;
}
