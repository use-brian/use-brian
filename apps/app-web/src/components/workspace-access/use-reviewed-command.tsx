"use client";
/** Shared confirmation lifetime and safe retry. [COMP:app-web/workspace-access] */
import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {useT} from '@/lib/i18n/client';
import {useWorkspaceContext} from '@/lib/workspace-context';
import {confirmDialog} from '@/components/ui/confirm-dialog';
import {ORGANIZATION_CHANGED_EVENT} from '@/lib/api/workspace-access';
import {WORKSPACE_IDENTITY_REFRESH_EVENT} from '@/lib/workspace-identity-events';
import {invalidateSurfaceCache} from '@/lib/surface-cache';

type Review = {id:string;payloadHash:string;validForMs:number};
type Pending<C,V> = { command:C; description:string; review:V; confirmed: boolean };

export function useReviewedCommand<C,V extends Review,R>(options:{
  workspaceId:string;contextKey?:string;cachePrefix:string;
  prepare:(command:C,version:string|undefined,signal:AbortSignal)=>Promise<V|null>;
  apply:(review:V)=>Promise<R>;renderReview:(review:V)=>ReactNode;
  onApplied?:(result:R,isCurrent:()=>boolean)=>void|Promise<void>;
  errorMessage?:(code:string)=>string|undefined;
  labels?:{loadError:string;saveError:string;stale:string;confirmTitle:string};
}) {
  const {workspaceId,contextKey='',onApplied}=options;
  const t={...useT().workspaceAccess,...options.labels};
  const { me } = useWorkspaceContext();
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retryAvailable, setRetryAvailable] = useState(false);
  const pending = useRef<Pending<C,V> | null>(null), running = useRef(false), confirmation = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const applied = useRef(onApplied); applied.current = onApplied;
  const cancelReview = useCallback(() => { confirmation.current?.abort(); }, []);
  useEffect(() => {
    generation.current++;
    // A different principal must never inherit an unresolved receipt.
    pending.current = null; setRetryAvailable(false); setError('');
    const invalidate = (event: Event) => {
      const detail = (event as CustomEvent<{ workspaceId?: string }>).detail;
      if (!detail?.workspaceId || detail.workspaceId === workspaceId) cancelReview();
    };
    const visible = () => { if (document.visibilityState === 'visible') cancelReview(); };
    window.addEventListener(ORGANIZATION_CHANGED_EVENT, invalidate);
    window.addEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT, invalidate);
    window.addEventListener('focus', cancelReview);
    document.addEventListener('visibilitychange', visible);
    return () => {
      generation.current++;
      cancelReview();
      window.removeEventListener(ORGANIZATION_CHANGED_EVENT, invalidate);
      window.removeEventListener(WORKSPACE_IDENTITY_REFRESH_EVENT, invalidate);
      window.removeEventListener('focus', cancelReview);
      document.removeEventListener('visibilitychange', visible);
    };
  }, [workspaceId, me.id, contextKey, cancelReview]);

  async function save(command:C, description: string, policyRevision?: string): Promise<R|null> {
    if (running.current) return null;
    if (pending.current && JSON.stringify(pending.current.command) !== JSON.stringify(command)) { setError(t.pendingChange); return null; }
    running.current = true; setBusy(true); setError('');
    const controller = new AbortController(); confirmation.current = controller;
    const currentGeneration = generation.current;
    const isCurrent = () => currentGeneration === generation.current;
    let expiry: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!pending.current) {
        if (controller.signal.aborted || !isCurrent()) return null;
        const started = performance.now();
        const review = await options.prepare(command,policyRevision,controller.signal);
        if(!review)return null;
        if (controller.signal.aborted || !isCurrent()) return null;
        const remaining = Math.min(review.validForMs, 30_000) - (performance.now() - started);
        if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('access_review_expired');
        pending.current = { command, description, review, confirmed: false };
        expiry = setTimeout(() => { controller.abort(); if (isCurrent()) setError(t.reviewExpired); }, remaining);
      }
      const active = pending.current;
      if (!active.confirmed) {
        const confirmed = await confirmDialog({ signal: controller.signal, title: t.confirmTitle, description: active.description, content: options.renderReview(active.review), confirmLabel: t.confirm, cancelLabel: t.cancel });
        if (!isCurrent()) return null;
        if (!confirmed || controller.signal.aborted) { pending.current = null; return null; }
        active.confirmed = true;
      }
      clearTimeout(expiry); expiry = undefined;
      const result = await options.apply(active.review);
      if (!isCurrent()) return null;
      pending.current = null; setRetryAvailable(false);
      invalidateSurfaceCache(`${options.cachePrefix}:${workspaceId}:`);
      try { await applied.current?.(result, isCurrent); } catch { if (isCurrent()) setError(t.loadError); }
      return isCurrent() ? result : null;
    } catch (cause) {
      if (!isCurrent()) return null;
      const code = cause instanceof Error ? cause.message : '';
      if (['organization_conflict', 'access_policy_conflict', 'access_review_expired', 'access_review_changed', 'not_found', 'unauthorized', 'migration_expired', 'migration_not_active', 'migration_actor_required', 'migration_item_applied'].includes(code)) pending.current = null;
      setRetryAvailable(Boolean(pending.current?.confirmed));
      setError(options.errorMessage?.(code) ?? (['organization_conflict', 'request_review_stale', 'access_policy_conflict'].includes(code) ? t.stale : code === 'access_review_expired' ? t.reviewExpired : code === 'departmental_enforcement_incomplete' ? t.notReady : t.saveError));
      return null;
    } finally {
      clearTimeout(expiry);
      if (confirmation.current === controller) confirmation.current = null;
      running.current = false; setBusy(false);
    }
  }
  async function retry() { const active = pending.current; return active ? save(active.command, active.description) : null; }
  // Explicit lifecycle changes may revoke an outstanding migration review.
  const discardReview = () => { cancelReview(); pending.current = null; setRetryAvailable(false); setError(''); };
  return { save, retry, busy, error, retryAvailable, cancelReview, discardReview, clearError: () => setError('') };
}

