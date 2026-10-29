"use client";

/** Owner-reviewed shared source setup. [COMP:app-web/attended-source-setup] */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ApplicationManagementCommand, ApplicationManagementResult, AttendedConnectorSetupInput } from '@use-brian/shared';
import { useWorkspaceContext } from '@/lib/workspace-context';
import { useT } from '@/lib/i18n/client';
import { useCachedResource, invalidateSurfaceCache } from '@/lib/surface-cache';
import { projectionRemainingMs, useProtectedProjection } from '@/lib/use-protected-projection';
import { applicationManagementCacheKey, ApplicationManagementError, executeApplicationManagement, fetchApplicationManagement } from '@/lib/api/applications';
import { WORKSPACE_IDENTITY_REFRESH_EVENT } from '@/lib/workspace-identity-events';
import { ORGANIZATION_CHANGED_EVENT } from '@/lib/api/workspace-access';
import { authFetch } from '@/lib/auth-fetch';
import { publicRuntimeConfig } from '@/lib/runtime-public-config';
import { Button } from '@/components/ui/button';
import { confirmDialog } from '@/components/ui/confirm-dialog';

const fieldClass = 'min-h-8 max-sm:min-h-11 w-full rounded-md border border-border bg-background px-3 py-2 text-base md:text-sm';
const pretty = (value: unknown) => JSON.stringify(value, null, 2);
type Review = { result: ApplicationManagementResult; input: AttendedConnectorSetupInput; assistantId: string; expiresAt: number; reviewId: string };

export function AttendedSourceSetup({ instanceId, onCredentialsSaved }: { instanceId: string; onCredentialsSaved: () => void }) {
  const { workspaceId, me, role } = useWorkspaceContext();
  const t = useT().attendedSourceSetup;
  if (role !== 'owner') return <p className="text-sm text-muted-foreground">{t.ownerOnly}</p>;
  return <OwnerSetup key={`${workspaceId}:${me.id}:${instanceId}:${role}`} workspaceId={workspaceId} viewerId={me.id} instanceId={instanceId} onCredentialsSaved={onCredentialsSaved} />;
}

function OwnerSetup({ workspaceId, viewerId, instanceId, onCredentialsSaved }: { workspaceId: string; viewerId: string; instanceId: string; onCredentialsSaved: () => void }) {
  const t = useT().attendedSourceSetup;
  const key = `${applicationManagementCacheKey(workspaceId, viewerId)}:connector:${instanceId}`;
  const [token, setToken] = useState(''), [busy, setBusy] = useState(false), [uncertain, setUncertain] = useState(false);
  const [message, setMessage] = useState(''), [identity, setIdentity] = useState<ApplicationManagementResult | null>(null), [review, setReview] = useState<Review | null>(null);
  const [tenant, setTenant] = useState(''), [audience, setAudience] = useState(''), [sourceBaseUrl, setSourceBaseUrl] = useState('');
  const [probeTool, setProbeTool] = useState(''), [probeJson, setProbeJson] = useState('{}');
  const [actionTools, setActionTools] = useState(''), [idempotencyKey, setIdempotencyKey] = useState('');
  const preparedReview = useRef<Review | null>(null);
  const epoch = useRef(0), alive = useRef(true), pending = useRef(false), dialog = useRef<AbortController | null>(null);
  const purge = useCallback(() => { epoch.current++; dialog.current?.abort(); pending.current = false; setBusy(false); setToken(''); setReview(null); setIdentity(null); setMessage(''); setTenant(''); setAudience(''); setSourceBaseUrl(''); setProbeTool(''); setProbeJson('{}'); setActionTools(''); setIdempotencyKey(''); }, []);
  const resource = useCachedResource(key, () => fetchApplicationManagement(workspaceId, viewerId, undefined, undefined, instanceId), { expiresInMs: projectionRemainingMs });
  const data = useProtectedProjection(key, resource.data, purge, resource.refresh);
  useEffect(() => {
    alive.current = true;
    const changed = (event: Event) => { const w = (event as CustomEvent<{workspaceId?: string}>).detail?.workspaceId; if (w && w !== workspaceId) return; preparedReview.current = null; purge(); invalidateSurfaceCache(key); };
    window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT, changed); window.addEventListener(ORGANIZATION_CHANGED_EVENT, changed);
    return () => { alive.current = false; preparedReview.current = null; epoch.current++; dialog.current?.abort(); window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT, changed); window.removeEventListener(ORGANIZATION_CHANGED_EVENT, changed); };
  }, [key, workspaceId, purge]);
  useEffect(() => {
    const candidate = preparedReview.current;
    if (!candidate || !data) return;
    // First refresh installs the profile created by our own review. Present the
    // receipt only after the protected projection accepts that new metadata.
    const current = data.sources.items.find(item => item.id === candidate.result.profileId);
    if (current?.status === 'pending' && candidate.expiresAt > Date.now()) {
      preparedReview.current = null;
      setReview(candidate);
    }
  }, [data]);
  useEffect(() => {
    if (!review) return;
    const timer = setTimeout(() => { dialog.current?.abort(); setReview(null); setMessage(t.expired); }, Math.max(0, review.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [review, t.expired]);
  const blocked = busy || uncertain || !data;
  const sources = data?.sources.items.filter(item => item.connectorInstanceId === instanceId) ?? [];
  const liveSources = sources.filter(item => item.status !== 'revoked');
  const source = liveSources[0] ?? sources[0];
  const activeProfileId = typeof review?.result.profileId === 'string' ? review.result.profileId : source?.attendedProfile ? source.id : null;
  const status = !data ? (resource.error ? t.unavailable : t.loading) : !source ? t.notConfigured : liveSources.length > 1 ? t.unavailable : source.status === 'qualified' ? (source.attendedProfile?.startsWith('attended_governed_') ? t.qualified : t.unavailable) : source.status === 'pending' ? t.pending : source.status === 'revoked' ? t.revoked : t.unavailable;

  async function run(work: () => Promise<void>) {
    if (pending.current || blocked) return;
    pending.current = true; setBusy(true); setMessage('');
    const generation = epoch.current;
    try { await work(); }
    catch (error) {
      if (!alive.current || generation !== epoch.current) return;
      setReview(null);
      if (error instanceof ApplicationManagementError && error.uncertain) { setUncertain(true); setMessage(t.uncertain); }
      else setMessage(t.unavailable);
    } finally { if (alive.current && generation === epoch.current) { pending.current = false; setBusy(false); } }
  }
  async function command(command: ApplicationManagementCommand) {
    const generation = epoch.current;
    const result = await executeApplicationManagement(workspaceId, command);
    if (!alive.current || generation !== epoch.current) return null;
    return result;
  }
  async function saveCredentials() {
    const generation = epoch.current;
    let response: Response;
    try { response = await authFetch(`${publicRuntimeConfig().apiUrl ?? 'http://localhost:4000'}/api/workspaces/${encodeURIComponent(workspaceId)}/connectors/${encodeURIComponent(instanceId)}/credentials`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ authType: 'bearer', bearerToken: token }), cache: 'no-store' }); }
    catch { throw new ApplicationManagementError('effect_uncertain', true); }
    if (!alive.current || generation !== epoch.current) return;
    setToken(''); setReview(null);
    if (!response.ok) { if ([401,403,404].includes(response.status)) invalidateSurfaceCache(key); throw new ApplicationManagementError('access_unavailable', response.status >= 500); }
    setMessage(t.credentialsSaved); onCredentialsSaved(); await resource.refresh();
  }
  async function prepareReview() {
    let probeInput: Record<string, unknown>;
    try { const value: unknown = JSON.parse(probeJson); if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(); probeInput = value as Record<string, unknown>; }
    catch { setMessage(t.invalidJson); return; }
    const assistantId = data!.actor.assistantId;
    const input: AttendedConnectorSetupInput = { instanceId, tenant: tenant.trim(), audience: audience.trim(), sourceBaseUrl: sourceBaseUrl.trim(), probeTool: probeTool.trim(), probeInput,
      ...(actionTools.trim() ? { actions: { tools: actionTools.split('\n').map(value => value.trim()).filter(Boolean), idempotencyMetadataKey: idempotencyKey.trim() } } : {}) };
    const result = await command({ kind: 'connector.source.review', assistantId, input });
    if (!result) return;
    if (typeof result.reviewId !== 'string' || typeof result.expiresAt !== 'string' || result.connectorInstanceId !== instanceId || result.workspaceId !== workspaceId || result.userId !== viewerId || result.assistantId !== assistantId || !Number.isFinite(Date.parse(result.expiresAt))) throw new Error('Invalid review');
    preparedReview.current = { result, input, assistantId, reviewId: result.reviewId, expiresAt: Date.parse(result.expiresAt) };
    await resource.refresh();
  }
  async function apply() {
    if (!review || blocked || review.expiresAt <= Date.now() || dialog.current && !dialog.current.signal.aborted) return;
    const selected = review, generation = epoch.current;
    const controller = new AbortController(); dialog.current?.abort(); dialog.current = controller;
    const accepted = await confirmDialog({ signal: controller.signal, title: t.apply, description: t.confirm, confirmLabel: t.apply, cancelLabel: t.cancel,
      content: <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{pretty({ ...selected.result, input: selected.input })}</pre> });
    dialog.current = null;
    if (!accepted || controller.signal.aborted || generation !== epoch.current || selected.expiresAt <= Date.now()) return;
    await run(async () => { const result = await command({ kind: 'connector.source.apply', assistantId: selected.assistantId, reviewId: selected.reviewId }); if (!result) return; setReview(null); setMessage(result.state === 'qualified' ? t.qualified : t.unavailable); await resource.refresh(); });
  }
  async function revoke() {
    if (!activeProfileId || blocked) return;
    const generation = epoch.current, controller = new AbortController();
    dialog.current?.abort(); dialog.current = controller;
    const accepted = await confirmDialog({ signal: controller.signal, title: t.revoke, description: t.revokeHint, confirmLabel: t.revoke, cancelLabel: t.cancel });
    dialog.current = null;
    if (!accepted || controller.signal.aborted || generation !== epoch.current) return;
    await run(async () => { const result = await command({ kind: 'connector.source.revoke', profileId: activeProfileId }); if (!result) return; setReview(null); await resource.refresh(); });
  }
  async function refresh() { const generation = epoch.current; const refreshed = await resource.refresh(); if (alive.current && generation === epoch.current && refreshed) { setUncertain(false); setMessage(''); setReview(null); } }
  const fields = [[t.tenant, tenant, setTenant], [t.audience, audience, setAudience], [t.sourceBaseUrl, sourceBaseUrl, setSourceBaseUrl], [t.probeTool, probeTool, setProbeTool]] as const;
  return <section className="min-w-0 space-y-3 rounded-lg border border-border p-4 text-sm" aria-label={t.title}>
    <h3 className="font-semibold">{t.title}</h3><p>{t.boundary}</p><p role="status">{review ? t.pending : status}</p>
    {message && <p role="alert">{message}</p>}
    <Button className="max-sm:min-h-11" disabled={busy} onClick={() => void refresh()}>{t.refresh}</Button>
    {data && <>
      {!review && <>
      <label className="block">{t.bearer}<input className={fieldClass} type="password" autoComplete="new-password" value={token} disabled={blocked || !!review} onChange={event => setToken(event.target.value)} /></label>
      <Button className="max-sm:min-h-11" disabled={blocked || !!review || !token || /[\r\n]/.test(token)} onClick={() => void run(saveCredentials)}>{t.saveCredentials}</Button>
      <Button className="max-sm:min-h-11" disabled={blocked || !!review} onClick={() => void run(async () => { const result = await command({ kind: 'connector.identity.prepare', assistantId: data.actor.assistantId }); if (result) setIdentity(result); })}>{t.prepare}</Button>
      {identity && <div><p>{t.publicMaterial}</p><pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs">{pretty(identity)}</pre></div>}
      <fieldset disabled={blocked || !!review} className="space-y-3">
        {fields.map(([label, value, setValue]) => <label key={label} className="block">{label}<input className={fieldClass} value={value} onChange={event => setValue(event.target.value)} /></label>)}
        <label className="block">{t.probeInput}<textarea className={fieldClass} value={probeJson} onChange={event => setProbeJson(event.target.value)} /></label>
        <details><summary className="min-h-8 max-sm:min-h-11 cursor-pointer">{t.actions}</summary><p>{t.actionsHint}</p><label className="block">{t.actionTools}<textarea className={fieldClass} value={actionTools} onChange={event => setActionTools(event.target.value)} /></label><label className="block">{t.idempotencyKey}<input className={fieldClass} value={idempotencyKey} onChange={event => setIdempotencyKey(event.target.value)} /></label></details>
      </fieldset>
      </>}
      {!review && <Button className="max-sm:min-h-11" disabled={blocked || liveSources.length > 0 || !identity || !tenant.trim() || !audience.trim() || !sourceBaseUrl.trim() || !probeTool.trim() || !!actionTools.trim() && !idempotencyKey.trim()} onClick={() => void run(prepareReview)}>{t.review}</Button>}
      {review && <><p>{t.mapping}</p><pre className="max-h-80 overflow-auto whitespace-pre-wrap break-all text-xs">{pretty({ ...review.result, input: review.input })}</pre><Button className="max-sm:min-h-11" disabled={blocked} onClick={() => void apply()}>{t.apply}</Button></>}
      {activeProfileId && (review || source?.status !== 'revoked') && <Button className="max-sm:min-h-11" variant="outline" disabled={blocked} onClick={() => void revoke()}>{t.revoke}</Button>}
    </>}
  </section>;
}
