"use client";

import { useEffect, useState } from "react";
import { useSearchParams } from "next/navigation";
import { FileText, History, MessageSquare, Presentation } from "lucide-react";
import type { OfficeCommand } from "@use-brian/office-model";
import { OperatorTopbar } from "@/components/operator/operator-topbar";
import { PresenceAvatars } from "@/components/doc/presence-avatars";
import { OfficeJobActivity } from "./job-activity";
import { DocumentEditor } from "./document-editor";
import { PresentationEditor } from "./presentation-editor";
import { OfficeComments } from "./comments/office-comments";
import { useT } from "@/lib/i18n/client";
import { compileOfficeTemplateDraft, getOfficeArtifact, getOfficeSnapshot, listOfficeVersions, submitOfficeCommand, type OfficeArtifact, type OfficeLiveSnapshot } from "@/lib/office/api";
import { useCollabProvider } from "@/lib/collab/use-collab-provider";
import { usePresence, usePublishPresenceActivity, usePublishPresenceIdentity } from "@/lib/collab/use-presence";
import { getUserInfo } from "@/lib/user";
import { appendOfficeCommand, yDocToSnapshot } from "@use-brian/office-model";

export function OfficeEditorShell({ workspaceId, artifactId }: { workspaceId: string; artifactId: string }) {
  const t = useT().office;
  const [artifact, setArtifact] = useState<OfficeArtifact | null | undefined>();
  const [live, setLive] = useState<OfficeLiveSnapshot | null>(null);
  const [targets, setTargets] = useState<string[]>([]);
  const [panel, setPanel] = useState<"activity" | "comments" | "history">("activity");
  const [versions, setVersions] = useState<Array<{ id: string; version: number; summary: string; origin: string; createdAt: string }>>([]);
  const [suggestMode, setSuggestMode] = useState(false);
  const [templateCompileState, setTemplateCompileState] = useState<"idle" | "queued" | "failed">("idle");
  const templateId = useSearchParams().get("templateId");
  const collab = useCollabProvider(`office:${artifactId}`);
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
        setSuggestMode(nextArtifact.role === "comment");
        try { setLive(await getOfficeSnapshot(artifactId)); } catch { if (nextArtifact.job && !["failed", "cancelled"].includes(nextArtifact.job.status)) timer = setTimeout(load, 1500); }
      } catch { if (active) setArtifact(null); }
    };
    void load();
    return () => { active = false; if (timer) clearTimeout(timer); };
  }, [artifactId]);
  useEffect(() => {
    const doc = collab.doc;
    if (!doc || !collab.synced) return;
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
  }, [collab.doc, collab.synced]);
  if (artifact === undefined) return <div className="flex flex-1 flex-col"><OperatorTopbar app="office" /><p className="m-auto text-sm text-muted-foreground">{t.editorLoading}</p></div>;
  if (artifact === null) return <div className="flex flex-1 flex-col"><OperatorTopbar app="office" /><p className="m-auto text-sm text-destructive">{t.editorFailed}</p></div>;
  const Icon = artifact.family === "document" ? FileText : Presentation;
  async function apply(command: OfficeCommand) {
    if (!live) return;
    if (!suggestMode && artifact!.role === "edit" && collab.doc && collab.synced) {
      appendOfficeCommand(collab.doc, command);
      return;
    }
    const result = await submitOfficeCommand(artifactId, live.seq, command, suggestMode || artifact!.role === "comment" ? "suggest" : "apply");
    if ("snapshot" in result) setLive(result);
  }
  const editor = live?.snapshot.family === "document" ? <DocumentEditor snapshot={live.snapshot} baseVersion={live.baseVersion} role={artifact.role} suggestMode={suggestMode} onCommand={(command) => void apply(command)} onSelectTargets={setTargets} /> : live?.snapshot.family === "presentation" ? <PresentationEditor snapshot={live.snapshot} baseVersion={live.baseVersion} role={artifact.role} suggestMode={suggestMode} onCommand={(command) => void apply(command)} onSelectTargets={setTargets} /> : <p className="m-auto text-sm text-muted-foreground">{t.running}</p>;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <OperatorTopbar app="office" center={<div className="flex min-w-0 items-center gap-2 px-2"><Icon className="size-4 shrink-0" aria-hidden /><span className="truncate text-sm font-medium">{artifact.title}</span></div>} right={<PresenceAvatars users={presence} />} />
      {artifact.mode === "template" ? <div className="flex items-center justify-between gap-3 border-b bg-amber-50 px-4 py-2 text-xs font-medium text-amber-950"><span>{t.templateMode}</span>{templateId ? <button type="button" disabled={templateCompileState === "queued" || !live} className="rounded bg-amber-950 px-3 py-1.5 text-amber-50 disabled:opacity-50" onClick={() => { setTemplateCompileState("queued"); void compileOfficeTemplateDraft({ templateId, workspaceId, draftArtifactId: artifactId }).catch(() => setTemplateCompileState("failed")); }}>{templateCompileState === "queued" ? t.templateCompiling : templateCompileState === "failed" ? t.templateCompileFailed : t.templateAdmit}</button> : null}</div> : null}
      <div className="flex min-h-0 flex-1 flex-col lg:flex-row">
        <main className="flex min-h-0 flex-1 overflow-hidden bg-muted/30">{editor}</main>
        <aside className="w-full border-t bg-background lg:w-80 lg:border-l lg:border-t-0">
          <div className="flex border-b p-1">
            <PanelButton active={panel === "activity"} label={t.activity} icon={<FileText className="size-3" />} onClick={() => setPanel("activity")} />
            <PanelButton active={panel === "comments"} label={t.comments} icon={<MessageSquare className="size-3" />} onClick={() => setPanel("comments")} />
            <PanelButton active={panel === "history"} label={t.history} icon={<History className="size-3" />} onClick={() => { setPanel("history"); void listOfficeVersions(artifactId).then(setVersions); }} />
          </div>
          {artifact.role === "edit" ? <label className="flex items-center gap-2 border-b p-3 text-xs"><input type="checkbox" checked={suggestMode} onChange={(event) => setSuggestMode(event.target.checked)} />{t.suggestMode}</label> : null}
          {panel === "activity" && artifact.job ? <OfficeJobActivity jobId={artifact.job.id} /> : null}
          {panel === "comments" ? <div className="p-4"><OfficeComments artifactId={artifactId} version={artifact.version} targetIds={targets} anchorKind={artifact.family === "document" ? "block" : "object"} canComment={artifact.role !== "view"} /></div> : null}
          {panel === "history" ? <ol className="space-y-3 p-4">{versions.map((version) => <li key={version.id} className="border-l-2 pl-3 text-sm"><p>{version.summary}</p><span className="text-xs text-muted-foreground">{version.origin} · {version.version}</span></li>)}</ol> : null}
        </aside>
      </div>
    </div>
  );
}

function PanelButton({ active, label, icon, onClick }: { active: boolean; label: string; icon: React.ReactNode; onClick(): void }) { return <button type="button" onClick={onClick} className={`flex flex-1 items-center justify-center gap-1 rounded px-2 py-1.5 text-xs ${active ? "bg-muted font-medium" : "text-muted-foreground"}`}>{icon}{label}</button>; }
