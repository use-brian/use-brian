"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { FileCheck2, FileSpreadsheet, FileText, MessageSquare, PanelRightClose, PanelRightOpen, Presentation, Route, Sparkles } from "lucide-react";
import type { OfficeCommand } from "@use-brian/office-model";
import { PresenceAvatars } from "@/components/doc/presence-avatars";
import { OfficeJobActivity } from "./job-activity";
import { DocumentEditor } from "./document-editor";
import { PresentationEditor } from "./presentation-editor";
import { SpreadsheetEditor } from "./spreadsheet-editor";
import { PresentationPresenter } from "./presentation-presenter";
import { OfficeComments } from "./comments/office-comments";
import { OfficeReview } from "./office-review";
import { OfficeStartRecovery } from "./office-start-recovery";
import { useT } from "@/lib/i18n/client";
import { compileOfficeTemplateDraft, getOfficeArtifact, getOfficeSnapshot, initializeOfficeTemplateDraft, isOfficeStartFailed, OfficeApiError, submitOfficeCommand, syncOfficeOfflineCommands, transitionOfficeLifecycle, waitForOfficeJob, type OfficeArtifact, type OfficeCommentThread, type OfficeLiveSnapshot } from "@/lib/office/api";
import { useCollabProvider } from "@/lib/collab/use-collab-provider";
import { usePresence, usePublishPresenceActivity, usePublishPresenceIdentity } from "@/lib/collab/use-presence";
import { getUserInfo } from "@/lib/user";
import { appendOfficeCommand, applyOfficeUpdate, yDocToSnapshot } from "@use-brian/office-model";
import { appendOfflineCommand, classifyOfficeReconnect, listOfflineJournal, loadOfflinePackage, removeOfflineJournalEntry, removeOfflinePackage, type OfficeOfflineStatus } from "@/lib/office/offline";
import { OfficeTopbar } from "./office-topbar";
import { cn } from "@/lib/utils";
import { TemplateRoutingInspector, type TemplateRoutingInspectorState } from "./template-routing-inspector";
import { chatDockSuppression } from "@/lib/chat-dock-suppress";

export function OfficeEditorShell({ workspaceId, artifactId }: { workspaceId: string; artifactId: string }) {
  const t = useT().office;
  const router = useRouter();
  const [artifact, setArtifact] = useState<OfficeArtifact | null | undefined>();
  const [live, setLive] = useState<OfficeLiveSnapshot | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [panel, setPanel] = useState<"activity" | "comments" | "review" | "routing">("activity");
  const [panelOpen, setPanelOpen] = useState(true);
  const [presentOpen, setPresentOpen] = useState(false);
  const [suggestMode, setSuggestMode] = useState(false);
  const [templateCompileState, setTemplateCompileState] = useState<"idle" | "queued" | "failed">("idle");
  const [cachedUpdate, setCachedUpdate] = useState<Uint8Array | null>(null);
  const [cachedComments, setCachedComments] = useState<OfficeCommentThread[] | null>(null);
  const [offlineCopyAt, setOfflineCopyAt] = useState<string | null>(null);
  const [reconnectStatus, setReconnectStatus] = useState<OfficeOfflineStatus>("synced");
  const [recoveryState, setRecoveryState] = useState<"idle" | "moving" | "failed">("idle");
  const [templateDraftFailed, setTemplateDraftFailed] = useState(false);
  const [templateRoutingState, setTemplateRoutingState] = useState<TemplateRoutingInspectorState>({ ready: false, dirty: false, saving: false });
  const templateId = useSearchParams().get("templateId");
  const collab = useCollabProvider(artifact && live && artifact.lifecycleState === "active" && !isOfficeStartFailed(artifact) ? `office:${artifactId}` : null);
  const currentUser = getUserInfo();
  useEffect(() => chatDockSuppression.suppress(), []);
  usePublishPresenceIdentity(collab.provider, currentUser);
  usePublishPresenceActivity(collab.provider);
  const presence = usePresence(collab.provider);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let active = true;
    const load = async () => {
      try {
        const nextArtifact = await getOfficeArtifact(artifactId);
        if (!active) return;
        setArtifact(nextArtifact);
        if (nextArtifact.lifecycleState !== "active") await removeOfflinePackage(artifactId).catch(() => undefined);
        setOfflineCopyAt(null);
        setCachedComments(null);
        setReconnectStatus("synced");
        setSuggestMode(nextArtifact.role === "comment");
        setTemplateDraftFailed(false);
        try {
          setLive(await getOfficeSnapshot(artifactId));
        } catch (error) {
          const uninitializedTemplate = nextArtifact.mode === "template" && templateId && error instanceof OfficeApiError && error.status === 409 && error.message === "artifact_not_ready";
          if (uninitializedTemplate) {
            try {
              setLive(await initializeOfficeTemplateDraft({ templateId, workspaceId, draftArtifactId: artifactId }));
              return;
            } catch {
              setTemplateDraftFailed(true);
            }
          }
          if (nextArtifact.job && !["failed", "cancelled"].includes(nextArtifact.job.status)) timer = setTimeout(load, 1500);
        }
      } catch (error) {
        if (!active) return;
        const denied = error instanceof OfficeApiError && [401, 403, 404].includes(error.status);
        if (denied) {
          await removeOfflinePackage(artifactId).catch(() => undefined);
          if (active) setArtifact(null);
          return;
        }
        const cached = await loadOfflinePackage(artifactId).catch(() => null);
        if (!active) return;
        if (!cached) { setArtifact(null); return; }
        setArtifact(cached.payload.artifact);
        setLive({ snapshot: cached.payload.snapshot, seq: cached.payload.seq, baseVersion: cached.payload.baseVersion });
        setCachedComments(cached.payload.comments);
        setCachedUpdate(Uint8Array.from(atob(cached.payload.yjsUpdate), (character) => character.charCodeAt(0)));
        setOfflineCopyAt(cached.savedAt);
        setReconnectStatus("offline");
        setSuggestMode(cached.payload.artifact.role === "comment");
      }
    };
    void load();
    const reconnect = () => { void load(); };
    window.addEventListener("online", reconnect);
    return () => { active = false; if (timer) clearTimeout(timer); window.removeEventListener("online", reconnect); };
  }, [artifactId, templateId, workspaceId]);
  useEffect(() => {
    if (!cachedUpdate || !collab.doc) return;
    applyOfficeUpdate(collab.doc, cachedUpdate);
    setCachedUpdate(null);
  }, [cachedUpdate, collab.doc]);
  useEffect(() => {
    const doc = collab.doc;
    if (!doc || (!collab.synced && !offlineCopyAt)) return;
    const refresh = () => {
      try {
        const snapshot = yDocToSnapshot(doc);
        setLive((previous) => ({
          snapshot,
          seq: previous?.seq ?? 0,
          baseVersion: previous?.baseVersion ?? 1,
        }));
      } catch {
        // A newly created artifact can connect before its first snapshot is
        // initialized. The generation/import poll above remains the fallback.
      }
    };
    refresh();
    doc.on("update", refresh);
    return () => doc.off("update", refresh);
  }, [collab.doc, collab.synced, offlineCopyAt]);
  useEffect(() => {
    if (artifact?.mode === "template" && artifact.family === "presentation" && templateId) {
      setPanel("routing");
      setPanelOpen(true);
    }
  }, [artifact?.family, artifact?.mode, templateId]);
  useEffect(() => {
    if (collab.status !== "connected" || !collab.synced) return;
    void listOfflineJournal(artifactId).then(async (entries) => {
      const commands = entries.filter((entry): entry is Extract<(typeof entries)[number], { kind: "command" }> => entry.kind === "command");
      if (commands.length === 0) return;
      const result = await syncOfficeOfflineCommands(artifactId, commands[0].expectedSeq, commands.map((entry) => entry.command));
      const classified = classifyOfficeReconnect(result);
      setReconnectStatus(classified.status);
      if (result.status === "synced") await Promise.all(commands.map(removeOfflineJournalEntry));
      if (classified.quarantine) {
        await removeOfflinePackage(artifactId).catch(() => undefined);
        setArtifact(null);
        setLive(null);
      }
    }).catch(() => undefined);
  }, [artifactId, collab.status, collab.synced]);
  if (artifact === undefined) return <div className="flex flex-1 flex-col"><OfficeTopbar workspaceId={workspaceId} breadcrumbs={[{ label: t.editorLoading }]} /><p className="m-auto text-sm text-muted-foreground">{t.editorLoading}</p></div>;
  if (artifact === null) return <div className="flex flex-1 flex-col"><OfficeTopbar workspaceId={workspaceId} breadcrumbs={[{ label: t.editorFailed }]} /><p className="m-auto text-sm text-destructive">{t.editorFailed}</p></div>;
  const Icon = artifact.family === "document" ? FileText : artifact.family === "presentation" ? Presentation : FileSpreadsheet;
  if (templateDraftFailed) return <div className="flex flex-1 flex-col"><OfficeTopbar workspaceId={workspaceId} breadcrumbs={[{ label: artifact.title }]} /><p className="m-auto text-sm text-destructive">{t.editorFailed}</p></div>;
  if (isOfficeStartFailed(artifact)) return <OfficeStartRecovery workspaceId={workspaceId} title={artifact.title} family={artifact.family} canTrash={artifact.role === "edit"} state={recoveryState} onTrash={() => {
    setRecoveryState("moving");
    void transitionOfficeLifecycle(artifactId, "trash", "Office creation did not start").then(() => router.push(`/w/${workspaceId}/office`)).catch(() => setRecoveryState("failed"));
  }} />;
  async function apply(command: OfficeCommand) {
    if (!live) return;
    if (artifact!.lifecycleState !== "active") return;
    if (!suggestMode && artifact!.role === "edit" && collab.doc && (collab.synced || offlineCopyAt)) {
      if (collab.status === "disconnected" || offlineCopyAt) {
        const offlineCommand = { ...command, origin: "offline" as const };
        await appendOfflineCommand({ artifactId, seq: Date.now() * 1_000 + Math.floor(Math.random() * 1_000), kind: "command", expectedSeq: live.seq, command: offlineCommand, createdAt: new Date().toISOString() });
        appendOfficeCommand(collab.doc, offlineCommand);
      } else appendOfficeCommand(collab.doc, command);
      return;
    }
    const result = await submitOfficeCommand(artifactId, live.seq, command, suggestMode || artifact!.role === "comment" ? "suggest" : "apply");
    if ("snapshot" in result) setLive(result);
  }
  async function refreshArtifact() {
    const [nextArtifact, nextLive] = await Promise.all([getOfficeArtifact(artifactId), getOfficeSnapshot(artifactId)]);
    setArtifact(nextArtifact);
    setLive(nextLive);
  }
  async function publishTemplate() {
    if (!templateId) return;
    setTemplateCompileState("queued");
    try {
      const queued = await compileOfficeTemplateDraft({ templateId, workspaceId, draftArtifactId: artifactId });
      const job = await waitForOfficeJob(queued.jobId);
      setTemplateCompileState(job.status === "completed" ? "idle" : "failed");
    } catch {
      setTemplateCompileState("failed");
    }
  }
  const editorRole = artifact.lifecycleState === "active" ? artifact.role : "view" as const;
  const editor = live?.snapshot.family === "document" ? <DocumentEditor snapshot={live.snapshot} baseVersion={live.baseVersion} role={editorRole} suggestMode={suggestMode} onCommand={(command) => void apply(command)} onSelectTargets={setTargets} /> : live?.snapshot.family === "presentation" ? <PresentationEditor snapshot={live.snapshot} baseVersion={live.baseVersion} role={editorRole} suggestMode={suggestMode} onCommand={(command) => void apply(command)} onSelectTargets={setTargets} /> : live?.snapshot.family === "spreadsheet" ? <SpreadsheetEditor snapshot={live.snapshot} baseVersion={live.baseVersion} role={editorRole} suggestMode={suggestMode} onCommand={(command) => void apply(command)} onSelectTargets={setTargets} /> : <p className="m-auto text-sm text-muted-foreground">{t.running}</p>;
  const showTemplateRouting = artifact.mode === "template" && live?.snapshot.family === "presentation" && Boolean(templateId);
  const templateRoutingBlocked = showTemplateRouting && (!templateRoutingState.ready || templateRoutingState.dirty || templateRoutingState.saving);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OfficeTopbar workspaceId={workspaceId} breadcrumbs={[{ label: artifact.title }]} right={<div className="flex items-center gap-2"><Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /><PresenceAvatars users={presence} /></div>} />
      {offlineCopyAt ? <div className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-950">{reconnectStatus === "needs_attention" ? t.offlineNeedsAttention : t.offlineCopy.replace("{time}", new Date(offlineCopyAt).toLocaleString())}</div> : null}
      {artifact.mode === "template" ? <div className="flex items-center justify-between gap-3 border-b bg-amber-50 px-4 py-2 text-xs font-medium text-amber-950"><span>{t.templateMode}</span>{templateId ? <button type="button" title={templateRoutingBlocked ? t.routingSaveBeforePublish : t.templateAdmit} disabled={templateCompileState === "queued" || !live || templateRoutingBlocked} className="rounded bg-amber-950 px-3 py-1.5 text-amber-50 disabled:opacity-50" onClick={() => void publishTemplate()}>{templateRoutingBlocked ? t.routingSaveBeforePublish : templateCompileState === "queued" ? t.templateCompiling : templateCompileState === "failed" ? t.templateCompileFailed : t.templateAdmit}</button> : null}</div> : null}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="flex min-h-0 flex-1 overflow-hidden bg-muted/30">{editor}</main>
        <aside className={cn("shrink-0 overflow-y-auto border-t bg-background transition-[width] lg:border-l lg:border-t-0", panelOpen ? showTemplateRouting && panel === "routing" ? "w-full lg:w-80" : "w-full lg:w-64" : "w-full lg:w-12")} data-office-panel={panelOpen ? "open" : "collapsed"}>
          {panelOpen ? <>
            <div className="flex items-center justify-between gap-2 border-b p-2">
              <div className="flex min-w-0 items-center gap-2"><span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600"><Sparkles className="size-3.5" aria-hidden /></span><div className="min-w-0"><p className="truncate text-xs font-semibold">{t.brian}</p><p className="truncate text-[11px] text-muted-foreground">{t.workspaceAssistant}</p></div></div>
              <button type="button" onClick={() => setPanelOpen(false)} aria-label={t.collapseAssistantPanel} title={t.collapseAssistantPanel} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><PanelRightClose className="size-4" /></button>
            </div>
            <div className={cn("grid border-b p-1", showTemplateRouting ? "grid-cols-4" : "grid-cols-3")}>
              {showTemplateRouting ? <PanelButton active={panel === "routing"} label={t.routing} icon={<Route className="size-3" />} onClick={() => setPanel("routing")} /> : null}
              <PanelButton active={panel === "activity"} label={t.brian} icon={<Sparkles className="size-3" />} onClick={() => setPanel("activity")} />
              <PanelButton active={panel === "comments"} label={t.comments} icon={<MessageSquare className="size-3" />} onClick={() => setPanel("comments")} />
              <PanelButton active={panel === "review"} label={t.fileActions} icon={<FileCheck2 className="size-3" />} onClick={() => setPanel("review")} />
            </div>
            {showTemplateRouting && live?.snapshot.family === "presentation" && templateId ? <div className={panel === "routing" ? "block" : "hidden"}><TemplateRoutingInspector templateId={templateId} snapshot={live.snapshot} selectedTargetIds={targets} onStateChange={setTemplateRoutingState} /></div> : null}
            {panel === "activity" ? <OfficeJobActivity jobId={artifact.job?.id} onOpenComments={() => setPanel("comments")} /> : null}
            {panel === "comments" ? <div className="p-3"><OfficeComments artifactId={artifactId} version={artifact.version} targetIds={targets} anchorKind={artifact.family === "document" ? "block" : artifact.family === "spreadsheet" ? "table_cell" : "object"} canComment={artifact.role !== "view"} offline={collab.status === "disconnected" || Boolean(offlineCopyAt)} initialThreads={cachedComments ?? undefined} onRevisionCompleted={refreshArtifact} /></div> : null}
            {panel === "review" ? <OfficeReview artifact={artifact} artifactId={artifactId} workspaceId={workspaceId} snapshot={live?.snapshot ?? undefined} selectedObjectIds={targets} onLifecycle={setArtifact} onPresent={() => setPresentOpen(true)} offlineCopy={Boolean(offlineCopyAt)} /> : null}
          </> : <div className="flex items-center gap-1 p-1 lg:flex-col">
            <button type="button" onClick={() => setPanelOpen(true)} aria-label={t.expandAssistantPanel} title={t.expandAssistantPanel} className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><PanelRightOpen className="size-4" /></button>
            {showTemplateRouting ? <CompactPanelButton active={panel === "routing"} label={t.routing} icon={<Route className="size-4" />} onClick={() => { setPanel("routing"); setPanelOpen(true); }} /> : null}
            <CompactPanelButton active={panel === "activity"} label={t.brian} icon={<Sparkles className="size-4" />} onClick={() => { setPanel("activity"); setPanelOpen(true); }} />
            <CompactPanelButton active={panel === "comments"} label={t.comments} icon={<MessageSquare className="size-4" />} onClick={() => { setPanel("comments"); setPanelOpen(true); }} />
            <CompactPanelButton active={panel === "review"} label={t.fileActions} icon={<FileCheck2 className="size-4" />} onClick={() => { setPanel("review"); setPanelOpen(true); }} />
          </div>}
        </aside>
      </div>
      {presentOpen && live?.snapshot.family === "presentation" ? <PresentationPresenter snapshot={live.snapshot} onClose={() => setPresentOpen(false)} /> : null}
    </div>
  );
}

function PanelButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick(): void }) { return <button type="button" onClick={onClick} className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1.5 text-xs ${active ? "bg-muted font-medium" : "text-muted-foreground"}`}>{icon}{label}</button>; }
function CompactPanelButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick(): void }) { return <button type="button" onClick={onClick} aria-label={label} title={label} className={cn("rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground", active && "bg-muted text-foreground")}>{icon}</button>; }
