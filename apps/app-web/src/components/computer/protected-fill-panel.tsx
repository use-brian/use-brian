"use client";

import { useEffect, useRef, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import { fetchCrmDirectories } from "@/lib/api/crm";
import { getComputerTask, type ComputerTask } from "@/lib/api/computer";
import { useCachedResource } from "@/lib/surface-cache";
import { crmRegionCacheKey } from "@/lib/surface-prefetch";
import { createProtectedReferences, protectedFields, protectedReferenceHandoff, protectedScope, type ProtectedField, type ProtectedReferences } from "@/lib/api/protected-browser-fill";

/** [COMP:app-web/protected-fill] Human-only source selection, never a model tool. */
export function ProtectedFillPanel(props: { task: ComputerTask; workspaceId: string; sessionId: string }) {
  // Reset consent and references whenever the authoritative task binding changes.
  return <Panel key={JSON.stringify([props.workspaceId, props.sessionId, props.task.taskId, props.task.profileId, props.task.destinationOrigin, props.task.connectionState, props.task.backend, props.task.status, props.task.workspaceId])} {...props} />;
}

function Panel({ task, workspaceId, sessionId }: { task: ComputerTask; workspaceId: string; sessionId: string }) {
  const t = useT().protectedFill;
  const scope = protectedScope(task, workspaceId, sessionId);
  const directory = useCachedResource(crmRegionCacheKey(workspaceId, "lookups"), () => fetchCrmDirectories(workspaceId));
  const [entityId, setEntityId] = useState("");
  const [fields, setFields] = useState<ProtectedField[]>([]);
  const [approved, setApproved] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [result, setResult] = useState<ProtectedReferences | null>(null);
  const [expired, setExpired] = useState(false);
  const [copied, setCopied] = useState(false);
  const mounted = useRef(true);
  const sending = useRef(false);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (!result) return;
    const timer = setTimeout(() => setExpired(true), Math.max(0, result.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [result]);
  const contacts = directory.data?.contacts ?? [];
  function reset() { setApproved(false); setResult(null); setCopied(false); setFailed(false); }
  async function issue() {
    if (!scope || !approved || !fields.length || !contacts.some(c => c.id === entityId) || sending.current) return;
    sending.current = true; setBusy(true); setFailed(false); setResult(null); setCopied(false);
    try {
      // Revalidate live task linkage immediately before creation, not just cached paint.
      const fresh = await getComputerTask(sessionId);
      if (!mounted.current || !fresh || JSON.stringify(protectedScope(fresh, workspaceId, sessionId)) !== JSON.stringify(scope)) throw new Error();
      const next = await createProtectedReferences(scope, entityId, fields);
      if (mounted.current) { setResult(next); setExpired(false); }
    } catch { if (mounted.current) setFailed(true); }
    finally { sending.current = false; if (mounted.current) setBusy(false); }
  }
  async function copy() {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(protectedReferenceHandoff(result));
      if (mounted.current) setCopied(true);
    } catch { if (mounted.current) setFailed(true); }
  }
  return <details className="shrink-0 rounded-lg border p-3 text-sm">
    <summary className="min-h-11 cursor-pointer font-medium">{t.title}</summary>
    <div className="max-h-[60dvh] space-y-3 overflow-y-auto pt-2">
      <p>{t.disclosure}</p>
      <p>{t.completion}</p>
      <p className="break-all">{t.destination}: {scope?.destinationOrigin ?? t.unavailable}</p>
      <p className="break-all">{t.profile}: {task.profileId ?? t.unavailable}</p>
      {!scope && <p role="status">{t.bindingRequired}</p>}
      {!directory.data && !directory.error ? <ListSurfaceSkeleton rows={2} /> : <SearchableSelect
        value={entityId} onValueChange={value => { setEntityId(value); reset(); }}
        items={contacts.map(c => ({ value: c.id, label: c.name }))}
        placeholder={t.record} searchPlaceholder={t.search} emptyMessage={t.empty}
        aria-label={t.record} disabled={busy || !scope} className="min-h-11 text-base"
      />}
      <fieldset disabled={busy || !scope}>
        <legend>{t.fields}</legend>
        <div className="flex flex-wrap gap-x-4">
          {protectedFields.map(field => <label key={field} className="flex min-h-11 items-center gap-2">
            <Checkbox checked={fields.includes(field)} disabled={busy || !scope} onCheckedChange={checked => {
              setFields(current => checked ? [...current, field] : current.filter(f => f !== field)); reset();
            }} />{t[field]}
          </label>)}
        </div>
      </fieldset>
      <label className="flex min-h-11 items-center gap-2">
        <Checkbox checked={approved} disabled={busy || !scope} onCheckedChange={setApproved} />{t.approve}
      </label>
      <button type="button" className="min-h-11 rounded border px-3 disabled:opacity-50" disabled={!scope || busy || !approved || !entityId || !fields.length} onClick={() => void issue()}>{t.issue}</button>
      {(failed || directory.error) ? <p role="alert">{t.error}</p> : null}
      {result && <div className="space-y-2" role="status">
        <p>{expired ? t.expired : t.handoff}</p>
        <button type="button" className="min-h-11 rounded border px-3 disabled:opacity-50" disabled={expired} onClick={() => void copy()}>{copied ? t.copied : t.copy}</button>
      </div>}
    </div>
  </details>;
}
