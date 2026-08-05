"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FileCheck2, FileText, History, MessageSquare, PanelRightClose, PanelRightOpen, Presentation, Sparkles } from "lucide-react";
import type { OfficeCommand } from "@use-brian/office-model";
import { PresenceAvatars } from "@/components/doc/presence-avatars";
import { OfficeJobActivity } from "./job-activity";
import { DocumentEditor } from "./document-editor";
import { PresentationEditor } from "./presentation-editor";
import { OfficeComments } from "./comments/office-comments";
import { OfficeReview } from "./office-review";
import { useT } from "@/lib/i18n/client";
import { compileOfficeTemplateDraft, getOfficeArtifact, getOfficeSnapshot, listOfficeVersions, OfficeApiError, submitOfficeCommand, syncOfficeOfflineCommands, type OfficeArtifact, type OfficeCommentThread, type OfficeLiveSnapshot } from "@/lib/office/api";
import { useCollabProvider } from "@/lib/collab/use-collab-provider";
import { usePresence, usePublishPresenceActivity, usePublishPresenceIdentity } from "@/lib/collab/use-presence";
import { getUserInfo } from "@/lib/user";
import { appendOfficeCommand, applyOfficeUpdate, yDocToSnapshot } from "@use-brian/office-model";
import { appendOfflineCommand, classifyOfficeReconnect, listOfflineJournal, loadOfflinePackage, removeOfflineJournalEntry, removeOfflinePackage, type OfficeOfflineStatus } from "@/lib/office/offline";
import { OfficeTopbar } from "./office-topbar";
import { cn } from "@/lib/utils";

export function OfficeEditorShell({ workspaceId, artifactId }: { workspaceId: string; artifactId: string }) {
  const t = useT().office;
  const [artifact, setArtifact] = useState<OfficeArtifact | null | undefined>();
  const [live, setLive] = useState<OfficeLiveSnapshot | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [panel, setPanel] = useState<"activity" | "comments" | "history" | "review">("activity");
  const [panelOpen, setPanelOpen] = useState(true);
  const [versions, setVersions] = useState<Array<{ id: string; version: number; summary: string; origin: string; createdAt: string }>>([]);
  const [suggestMode, setSuggestMode] = useState(false);
  const [templateCompileState, setTemplateCompileState] = useState<"idle" | "queued" | "failed">("idle");
  const [cachedUpdate, setCachedUpdate] = useState<Uint8Array | null>(null);
  const [cachedComments, setCachedComments] = useState<OfficeCommentThread[] | null>(null);
  const [offlineCopyAt, setOfflineCopyAt] = useState<string | null>(null);
  const [reconnectStatus, setReconnectStatus] = useState<OfficeOfflineStatus>("synced");
  const templateId = useSearchParams().get("templateId");
  const collab = useCollabProvider(artifact?.lifecycleState !== undefined && artifact.lifecycleState !== "active" ? null : `office:${artifactId}`);
  const currentUser = getUserInfo();
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
        try { setLive(await getOfficeSnapshot(artifactId)); } catch { if (nextArtifact.job && !["failed", "cancelled"].includes(nextArtifact.job.status)) timer = setTimeout(load, 1500); }
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
        setVersions(cached.payload.history);
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
  }, [artifactId]);
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
  const Icon = artifact.family === "document" ? FileText : Presentation;
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
  const editorRole = artifact.lifecycleState === "active" ? artifact.role : "view" as const;
  const editor = live?.snapshot.family === "document" ? <DocumentEditor snapshot={live.snapshot} baseVersion={live.baseVersion} role={editorRole} suggestMode={suggestMode} onCommand={(command) => void apply(command)} onSelectTargets={setTargets} /> : live?.snapshot.family === "presentation" ? <PresentationEditor snapshot={live.snapshot} baseVersion={live.baseVersion} role={editorRole} suggestMode={suggestMode} onCommand={(command) => void apply(command)} onSelectTargets={setTargets} /> : <p className="m-auto text-sm text-muted-foreground">{t.running}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OfficeTopbar workspaceId={workspaceId} breadcrumbs={[{ label: artifact.title }]} right={<div className="flex items-center gap-2"><Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden /><PresenceAvatars users={presence} /></div>} />
      {offlineCopyAt ? <div className="border-b bg-amber-50 px-4 py-2 text-xs text-amber-950">{reconnectStatus === "needs_attention" ? t.offlineNeedsAttention : t.offlineCopy.replace("{time}", new Date(offlineCopyAt).toLocaleString())}</div> : null}
      {artifact.mode === "template" ? <div className="flex items-center justify-between gap-3 border-b bg-amber-50 px-4 py-2 text-xs font-medium text-amber-950"><span>{t.templateMode}</span>{templateId ? <button type="button" disabled={templateCompileState === "queued" || !live} className="rounded bg-amber-950 px-3 py-1.5 text-amber-50 disabled:opacity-50" onClick={() => { setTemplateCompileState("queued"); void compileOfficeTemplateDraft({ templateId, workspaceId, draftArtifactId: artifactId }).catch(() => setTemplateCompileState("failed")); }}>{templateCompileState === "queued" ? t.templateCompiling : templateCompileState === "failed" ? t.templateCompileFailed : t.templateAdmit}</button> : null}</div> : null}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="flex min-h-0 flex-1 overflow-hidden bg-muted/30">{editor}</main>
        <aside className={cn("shrink-0 overflow-y-auto border-t bg-background transition-[width] lg:border-l lg:border-t-0", panelOpen ? "w-full lg:w-72" : "w-full lg:w-12")} data-office-panel={panelOpen ? "open" : "collapsed"}>
          {panelOpen ? <>
            <div className="flex items-center justify-between gap-2 border-b p-2">
              <div className="flex min-w-0 items-center gap-2"><span className="flex size-7 shrink-0 items-center justify-center rounded-md bg-blue-50 text-blue-600"><Sparkles className="size-3.5" aria-hidden /></span><div className="min-w-0"><p className="truncate text-xs font-semibold">{t.brian}</p><p className="truncate text-[11px] text-muted-foreground">{t.workspaceAssistant}</p></div></div>
              <button type="button" onClick={() => setPanelOpen(false)} aria-label={t.collapseAssistantPanel} title={t.collapseAssistantPanel} className="rounded p-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"><PanelRightClose className="size-4" /></button>
            </div>
            <div className="grid grid-cols-4 border-b p-1">
              <PanelButton active={panel === "activity"} label={t.brian} icon={<Sparkles className="size-3" />} onClick={() => setPanel("activity")} />
              <PanelButton active={panel === "comments"} label={t.comments} icon={<MessageSquare className="size-3" />} onClick={() => setPanel("comments")} />
              <PanelButton active={panel === "history"} label={t.history} icon={<History className="size-3" />} onClick={() => { setPanel("history"); if (!offlineCopyAt) void listOfficeVersions(artifactId).then(setVersions); }} />
              <PanelButton active={panel === "review"} label={t.review} icon={<FileCheck2 className="size-3" />} onClick={() => setPanel("review")} />
            </div>
            {artifact.role === "edit" ? <label className="flex items-center gap-2 border-b p-3 text-xs"><input type="checkbox" checked={suggestMode} onChange={(event) => setSuggestMode(event.target.checked)} />{t.suggestMode}</label> : null}
            {panel === "activity" ? <OfficeJobActivity jobId={artifact.job?.id} onOpenComments={() => setPanel("comments")} /> : null}
            {panel === "comments" ? <div className="p-3"><OfficeComments artifactId={artifactId} version={artifact.version} targetIds={targets} anchorKind={artifact.family === "document" ? "block" : "object"} canComment={artifact.role !== "view"} offline={collab.status === "disconnected" || Boolean(offlineCopyAt)} initialThreads={cachedComments ?? undefined} /></div> : null}
            {panel === "history" ? <ol className="space-y-3 p-3">{versions.map((version) => <li key={version.id} className="border-l-2 pl-3 text-sm"><p>{version.summary}</p><span className="text-xs text-muted-foreground">{version.origin} · {version.version}</span></li>)}</ol> : null}
            {panel === "review" ? <OfficeReview artifact={artifact} artifactId={artifactId} workspaceId={workspaceId} selectedObjectIds={targets} onLifecycle={setArtifact} offlineCopy={Boolean(offlineCopyAt)} /> : null}
          </> : <div className="flex items-center gap-1 p-1 lg:flex-col">
            <button type="button" onClick={() => setPanelOpen(true)} aria-label={t.expandAssistantPanel} title={t.expandAssistantPanel} className="rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground"><PanelRightOpen className="size-4" /></button>
            <CompactPanelButton active={panel === "activity"} label={t.brian} icon={<Sparkles className="size-4" />} onClick={() => { setPanel("activity"); setPanelOpen(true); }} />
            <CompactPanelButton active={panel === "comments"} label={t.comments} icon={<MessageSquare className="size-4" />} onClick={() => { setPanel("comments"); setPanelOpen(true); }} />
            <CompactPanelButton active={panel === "history"} label={t.history} icon={<History className="size-4" />} onClick={() => { setPanel("history"); setPanelOpen(true); if (!offlineCopyAt) void listOfficeVersions(artifactId).then(setVersions); }} />
            <CompactPanelButton active={panel === "review"} label={t.review} icon={<FileCheck2 className="size-4" />} onClick={() => { setPanel("review"); setPanelOpen(true); }} />
          </div>}
        </aside>
      </div>
    </div>
  );
}

function PanelButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick(): void }) { return <button type="button" onClick={onClick} className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1.5 text-xs ${active ? "bg-muted font-medium" : "text-muted-foreground"}`}>{icon}{label}</button>; }
function CompactPanelButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick(): void }) { return <button type="button" onClick={onClick} aria-label={label} title={label} className={cn("rounded p-2 text-muted-foreground hover:bg-muted hover:text-foreground", active && "bg-muted text-foreground")}>{icon}</button>; }
