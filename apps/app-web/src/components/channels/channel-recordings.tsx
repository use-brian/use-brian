"use client";

/** [COMP:app-web/channel-recordings] Exact conversation destinations and reviewed shared-text recovery. */
import { useState } from "react";
import Link from "next/link";
import { useT, format } from "@/lib/i18n/client";
import { useCachedResource, markSurfaceCacheStale } from "@/lib/surface-cache";
import { surfaceDataKey, channelRecordingsCacheKey, channelsCacheKey } from "@/lib/surface-prefetch";
import { getChannelRecordings, confirmRecordingOwner, updateChannelRecording, type ChannelRecording, previewLegacyGroupRecovery, restoreLegacyGroupContext, type LegacyGroupRecoveryCandidate } from "@/lib/api/channels";
import { listContextProjects, type ContextProject } from "@/lib/api/context-scopes";
import { dispatchChatSessionsRefresh } from "@/lib/chat-session-events";
import { Button } from "@/components/ui/button";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { Skeleton } from "@/components/skeleton";

export function ChannelRecordingsPanel({ workspaceId, channelId }: { workspaceId: string; channelId: string }) {
  const t = useT().channelRecordings;
  const state = useCachedResource(channelRecordingsCacheKey(workspaceId, channelId), () => getChannelRecordings(workspaceId, channelId));
  const projects = useCachedResource(surfaceDataKey("projects", workspaceId), () => listContextProjects(workspaceId, true));
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  async function claim() {
    if (!await confirmDialog({ title: t.confirmOwner, description: t.confirmOwnerHint, confirmLabel: t.confirmOwner })) return;
    setBusy(true); setError(false);
    try { await confirmRecordingOwner(workspaceId, channelId); await state.refresh(); }
    catch { setError(true); } finally { setBusy(false); }
  }
  return <section className="space-y-3 rounded-lg border p-4">
    <h3 className="text-sm font-medium">{t.title}</h3>
    <p className="text-sm text-muted-foreground">{t.hint}</p>
    <p className="text-sm text-muted-foreground">{t.limits}</p>
    {state.loading && <Skeleton className="h-11 w-full" />}
    {(state.error || error) && <p role="alert" className="text-sm text-destructive">{t.failed}</p>}
    {state.data?.ownership === "needs_confirmation" && <><p className="text-sm">{t.needsOwner}</p>
      <Button className="max-sm:min-h-11" disabled={busy} onClick={() => void claim()}>{t.confirmOwner}</Button></>}
    {state.data?.ownership === "other" && <p className="text-sm text-muted-foreground">{t.otherOwner}</p>}
    {state.data?.ownership === "mine" && <>
      {state.data.recordings.length === 0 && <p className="text-sm text-muted-foreground">{t.empty}</p>}
      {state.data.recordings.map(row => <RecordingRow key={`${row.id}:${row.revision}`} row={row} projects={projects.data ?? []}
        workspaceId={workspaceId} channelId={channelId} refresh={state.refresh} />)}
    </>}
    {state.data && state.data.ownership !== "other" && <LegacyGroupRecovery key={channelRecordingsCacheKey(workspaceId, channelId)} workspaceId={workspaceId} channelId={channelId} refresh={state.refresh} />}
    <p className="text-sm text-muted-foreground">{t.history}</p>
  </section>;
}

function RecordingRow({ row, projects, workspaceId, channelId, refresh }: {
  row: ChannelRecording; projects: ContextProject[]; workspaceId: string; channelId: string; refresh: () => Promise<unknown>;
}) {
  const t = useT().channelRecordings;
  const [destination, setDestination] = useState(row.destination === "personal" ? "personal" : row.projectId ?? "general");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const items = [{ value: "personal", label: t.personal }, { value: "general", label: t.general },
    ...projects.filter(p => p.status === "active" && p.shared?.status === "active" && (p.shared.myRole === "owner" || p.shared.myRole === "participant"))
      .map(p => ({ value: p.id, label: p.name }))];
  async function save(enabled: boolean) {
    const label = items.find(item => item.value === destination)?.label;
    if (enabled && !label) { setFailed(true); return; }
    if (!await confirmDialog({ title: enabled ? t.save : t.stop,
      description: format(t.preview, { conversation: row.conversationId, destination: enabled && label ? label : t.stopped }),
      confirmLabel: enabled ? t.save : t.stop })) return;
    setBusy(true); setFailed(false);
    try {
      await updateChannelRecording(workspaceId, channelId, row, { enabled,
        destination: !enabled ? row.destination : destination === "personal" ? "personal" : "workspace",
        projectId: !enabled ? row.projectId : destination === "personal" || destination === "general" ? null : destination });
      await refresh(); dispatchChatSessionsRefresh(workspaceId);
    } catch { setFailed(true); } finally { setBusy(false); }
  }
  return <div className="space-y-2 border-t pt-3">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="break-all text-sm font-medium">{row.conversationId}</p>
      <span className="text-xs text-muted-foreground">{row.enabled ? t.recording : t.stopped}</span>
    </div>
    {row.sessionId && <Link className="inline-flex min-h-8 max-sm:min-h-11 items-center text-sm underline" href={`/w/${workspaceId}/chat?s=${row.sessionId}${row.destination === "workspace" ? "&v=workspace" : ""}`}>{t.open}</Link>}
    <SearchableSelect aria-label={t.destination} value={destination} onValueChange={setDestination} items={items} disabled={busy}
      placeholder={t.destination} searchPlaceholder={t.search} emptyMessage={t.noProjects} />
    <div className="flex flex-wrap gap-2">
      <Button className="max-sm:min-h-11" disabled={busy} onClick={() => void save(true)}>{t.save}</Button>
      {row.enabled && <Button className="max-sm:min-h-11" variant="outline" disabled={busy} onClick={() => void save(false)}>{t.stop}</Button>}
    </div>
    {failed && <p role="alert" className="text-sm text-destructive">{t.failed}</p>}
  </div>;
}

/** A preview is fetched only on request; restoration reviews one exact session snapshot. */
function LegacyGroupRecovery({ workspaceId, channelId, refresh }: {
  workspaceId: string; channelId: string; refresh: () => Promise<unknown>;
}) {
  const t = useT().channelRecordings;
  const [candidates, setCandidates] = useState<LegacyGroupRecoveryCandidate[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const [restored, setRestored] = useState(false);
  async function review() {
    setBusy(true); setFailed(false); setRestored(false);
    try { setCandidates((await previewLegacyGroupRecovery(workspaceId, channelId)).candidates); }
    catch { setFailed(true); setCandidates(null); } finally { setBusy(false); }
  }
  async function restore(candidate: LegacyGroupRecoveryCandidate) {
    setBusy(true);
    try {
      if (!await confirmDialog({ title: t.restoreContext, confirmLabel: t.restoreContext,
        description: format(t.restoreConfirm, { conversation: candidate.conversationId,
          title: candidate.title ?? t.untitledGroup, count: String(candidate.messageCount), skipped: String(candidate.skippedMessageCount) }) })) return;
      setFailed(false); setRestored(false);
      try {
        await restoreLegacyGroupContext(workspaceId, channelId, { sessionId: candidate.sessionId, snapshotToken: candidate.snapshotToken });
      } catch {
        // Effects may be uncertain or the snapshot may be stale. Review again before any retry.
        setCandidates(null); setFailed(true); return;
      }
      setCandidates(current => current?.filter(row => row.sessionId !== candidate.sessionId) ?? null);
      setRestored(true);
      markSurfaceCacheStale(channelsCacheKey(workspaceId));
      markSurfaceCacheStale(channelRecordingsCacheKey(workspaceId, channelId));
      dispatchChatSessionsRefresh(workspaceId);
      await refresh().catch(() => undefined);
    } finally { setBusy(false); }
  }
  return <div className="space-y-3 border-t pt-3">
    <h4 className="text-sm font-medium">{t.recoveryTitle}</h4>
    <p className="text-sm text-muted-foreground">{t.recoveryHint}</p>
    <Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={() => void review()}>{t.reviewContext}</Button>
    {busy && <Skeleton className="h-11 w-full" />}
    {failed && <p role="alert" className="text-sm text-destructive">{t.recoveryFailed}</p>}
    {restored && <p role="status" className="text-sm">{t.contextRestored}</p>}
    {candidates?.length === 0 && !restored && <p className="text-sm text-muted-foreground">{t.noRecovery}</p>}
    {candidates?.map(candidate => <div key={`${candidate.sessionId}:${candidate.snapshotToken}`} className="space-y-2 rounded-md border p-3 text-sm">
      <p className="break-words font-medium">{candidate.title ?? t.untitledGroup}</p>
      <dl className="space-y-1 break-words">
        <div><dt className="inline text-muted-foreground">{t.recoveryConversation}: </dt><dd className="inline break-all">{candidate.conversationId}</dd></div>
        <div><dt className="inline text-muted-foreground">{t.recoveryAssistant}: </dt><dd className="inline">{candidate.assistantName ?? candidate.assistantId}</dd></div>
        <div><dt className="inline text-muted-foreground">{t.recoveryMessages}: </dt><dd className="inline">{candidate.messageCount}</dd></div>
        <div><dt className="inline text-muted-foreground">{t.recoverySkipped}: </dt><dd className="inline">{candidate.skippedMessageCount}</dd></div>
        <div><dt className="inline text-muted-foreground">{t.recoveryAudience}: </dt><dd className="inline">{t.originalGroup}</dd></div>
        <div><dt className="inline text-muted-foreground">{t.recoveryLabels}: </dt><dd className="inline">{[candidate.sensitivity, ...candidate.compartments, candidate.projectName ?? candidate.projectId].filter(Boolean).join(", ")}</dd></div>
      </dl>
      <Button className="max-sm:min-h-11" disabled={busy} onClick={() => void restore(candidate)}>{t.restoreContext}</Button>
    </div>)}
  </div>;
}
