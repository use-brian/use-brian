"use client";

/** Read ownership for editable routing metadata. [COMP:app-web/office-template-routing] */
import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { OfficeTemplateRoutingDraft } from "@use-brian/office-model";
import { Skeleton } from "@/components/skeleton";
import { useT } from "@/lib/i18n/client";
import { useOptionalWorkspaceContext } from "@/lib/workspace-context";
import { getOfficeTemplateRouting, saveOfficeTemplateRouting, OfficeApiError } from "@/lib/office/api";
import { officeMetadataRemaining } from "@/lib/office/metadata";
import { useOfficeMetadataResource } from "@/lib/office/surface-cache";
import { invalidateSurfaceCache, readSurfaceCache } from "@/lib/surface-cache";
import { officeRoutingCacheKey } from "@/lib/surface-prefetch";
import type { TemplateRoutingInspectorState } from "./template-routing-inspector";

export function TemplateRoutingBoundary({ templateId, initialRouting, onStateChange, children }: {
  templateId: string;
  initialRouting?: OfficeTemplateRoutingDraft;
  onStateChange?: (state: TemplateRoutingInspectorState) => void;
  children: (routing: OfficeTemplateRoutingDraft, save: (draft: OfficeTemplateRoutingDraft) => Promise<OfficeTemplateRoutingDraft>, identity: string, saved: boolean) => ReactNode;
}) {
  const t = useT().office;
  const workspace = useOptionalWorkspaceContext();
  const viewerId = workspace?.me.id ?? "";
  const key = workspace && viewerId ? officeRoutingCacheKey(workspace.workspaceId, viewerId, templateId) : null;
  const read = useOfficeMetadataResource(key, viewerId, () => getOfficeTemplateRouting(templateId), initialRouting);
  // An identical renewal preserves local edits; changed server content starts a
  // new draft. Expiry/denial unmounts the draft, including its pending callbacks.
  const signature = read.data ? JSON.stringify(read.data) : null;
  const owner = useRef<object | null>(null);
  const [savedSignature, setSavedSignature] = useState<string | null>(null);
  const available = Boolean(read.data);
  useLayoutEffect(() => {
    owner.current = available ? {} : null;
    setSavedSignature(null);
    return () => { owner.current = null; };
  }, [key, available]);
  useLayoutEffect(() => {
    if (!read.data) onStateChange?.({ready: false, dirty: false, saving: false});
  }, [read.data, onStateChange]);

  async function save(draft: OfficeTemplateRoutingDraft): Promise<OfficeTemplateRoutingDraft> {
    const started = owner.current;
    const current = () => Boolean(started && started === owner.current && key &&
      officeMetadataRemaining(readSurfaceCache(key).data, viewerId) > 0 &&
      JSON.stringify(readSurfaceCache(key).data) === signature);
    const requireCurrent = () => {
      if (current()) return;
      if (started && started === owner.current && key && officeMetadataRemaining(readSurfaceCache(key).data, viewerId) <= 0) invalidateSurfaceCache(key);
      throw new Error("office_projection_expired");
    };
    requireCurrent();
    try { await saveOfficeTemplateRouting(templateId, draft); }
    catch (error) {
      if (current() && key && error instanceof OfficeApiError && [401, 403, 404].includes(error.status)) invalidateSurfaceCache(key);
      throw error;
    }
    requireCurrent();
    // A renewal already in flight may have read before the PUT. Drain it before
    // starting the readback; deduplication must not label an older GET as saved.
    if (key && readSurfaceCache(key).revalidating) {
      await read.refresh();
      requireCurrent();
    }
    // PUT JSON cannot grant another metadata lifetime. Only the guarded GET can.
    const value = await read.refresh();
    if (!started || started !== owner.current || !key || !value || readSurfaceCache(key).data !== value || officeMetadataRemaining(value, viewerId) <= 0) throw new Error("office_projection_expired");
    setSavedSignature(JSON.stringify(value));
    return value;
  }

  if (!read.data) return read.error
    ? <div className="space-y-3 p-3" data-template-routing="failed"><p role="alert" className="text-sm text-destructive">{t.routingLoadFailed}</p><button type="button" className="min-h-8 max-sm:min-h-11 rounded border px-3 text-sm" onClick={() => void read.refresh()}>{t.routingRetry}</button></div>
    : <div data-template-routing="loading" aria-busy="true" aria-label={t.routingLoading} className="space-y-3 p-3"><Skeleton className="h-8 w-2/3"/><Skeleton className="h-24 w-full"/><Skeleton className="h-48 w-full"/></div>;
  return children(read.data, save, `${key}:${signature}`, savedSignature === signature);
}
