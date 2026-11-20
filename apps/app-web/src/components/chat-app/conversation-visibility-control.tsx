"use client";

/** [COMP:app-web/conversation-visibility] Capability-gated conversation settings. */
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { readWorkspaceMemberDirectory, getDirectoryViewerId } from "@/lib/api/mentions";
import { currentOfflineWriteAuthority, sameOfflineWriteAuthority } from "@/lib/offline/application-write-authority";
import { Eye } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Checkbox } from "@/components/ui/checkbox";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useT } from "@/lib/i18n/client";
import { useIsOffline } from "@/lib/offline/use-offline-sync";
import { updateConversationVisibility, raiseConversationCap, moveConversationProject, getChatSessionSummary, type ConversationSettingsResult, type DocSession } from "@/lib/api/sessions";
import { listContextProjects, type ContextProject } from "@/lib/api/context-scopes";
import { dispatchChatSessionsRefresh } from "@/lib/chat-session-events";

type Member = { userId: string; name: string | null };
export function ConversationVisibilityControl({ session, workspaceId }: { session: DocSession | null; workspaceId: string }) {
  const t = useT().chatApp.visibility, offline = useIsOffline();
  const [open, setOpen] = useState(false), [saving, setSaving] = useState(false), [error, setError] = useState<string | null>(null);
  const [updated, setUpdated] = useState<(Exclude<ConversationSettingsResult, { readable: false }> & { sessionId: string }) | null>(null);
  const [visibility, setVisibility] = useState<"workspace" | "configured_private">("configured_private");
  const [participants, setParticipants] = useState<string[]>([]), [members, setMembers] = useState<Member[]>([]);
  const [membersUnavailable, setMembersUnavailable] = useState(false), [projectsUnavailable, setProjectsUnavailable] = useState(false);
  const active = useRef({ sessionId: session?.id, workspaceId }); active.current = { sessionId: session?.id, workspaceId };
  const mounted = useRef(true); useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const [projects, setProjects] = useState<ContextProject[]>([]), [projectId, setProjectId] = useState("none");
  const metadata = updated && updated.sessionId === session?.id && updated.conversationVisibilityVersion >= (session?.conversationVisibilityVersion ?? 0) ? updated : session;
  const enabled = !!metadata?.conversationVisibility && metadata.conversationVisibilityVersion !== undefined && !!metadata.capabilities;
  useEffect(() => {
    if (!open || !enabled || !metadata) return;
    setVisibility(metadata.conversationVisibility === "workspace" ? "workspace" : "configured_private");
    setParticipants(metadata.participantUserIds ?? []);
    setProjectId(metadata.contextProjectId ?? session?.contextProjectId ?? "none");
    setError(null);
  }, [open, session?.id, metadata?.conversationVisibilityVersion, enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!open || !enabled) return;
    const controller = new AbortController();
    const authority = currentOfflineWriteAuthority(workspaceId);
    const current = () => !controller.signal.aborted && sameOfflineWriteAuthority(authority, currentOfflineWriteAuthority(workspaceId));
    setMembersUnavailable(false); setProjectsUnavailable(false);
    if (metadata?.capabilities?.canMoveProject) void listContextProjects(workspaceId).then(rows => {
      if (current()) setProjects(rows);
    }).catch(() => { if (current()) { setProjects([]); setProjectsUnavailable(true); } });
    void readWorkspaceMemberDirectory(workspaceId, getDirectoryViewerId()).then(directory => {
      if (current()) setMembers(directory.members.map(member => ({ userId: member.userId, name: member.name })));
    }).catch(() => { if (current()) { setMembers([]); setMembersUnavailable(true); } });
    return () => controller.abort();
  }, [open, enabled, workspaceId]);
  if (!enabled || !session || !metadata?.capabilities) return null;
  const caps = metadata.capabilities, privateKind = metadata.conversationVisibility === "private_by_kind";
  const known = new Map(members.map(member => [member.userId, member]));
  for (const id of metadata.participantUserIds ?? []) if (!known.has(id)) known.set(id, { userId: id, name: null });
  const mutate = async (operation: () => Promise<ConversationSettingsResult>) => {
    const owner = { sessionId: session.id, workspaceId, authority: currentOfflineWriteAuthority(workspaceId) };
    const current = () => mounted.current && active.current.sessionId === owner.sessionId && active.current.workspaceId === owner.workspaceId
      && sameOfflineWriteAuthority(owner.authority, currentOfflineWriteAuthority(workspaceId));
    setSaving(true); setError(null);
    try {
      const next = await operation();
      if (!current()) return;
      if (!("readable" in next)) setUpdated({ ...next, sessionId: session.id });
      dispatchChatSessionsRefresh(workspaceId); setOpen(false);
    } catch (failure) {
      if (!current()) return;
      const status = (failure as { status?: number })?.status;
      setError(status === 409 ? t.conflict : t.failed);
      if (status === 409) {
        dispatchChatSessionsRefresh(workspaceId);
        const fresh = await getChatSessionSummary(owner.sessionId);
        if (current() && fresh?.conversationVisibility && fresh.capabilities && fresh.conversationVisibilityVersion !== undefined && fresh.conversationCap) {
          setUpdated({ conversationVisibility: fresh.conversationVisibility, conversationVisibilityVersion: fresh.conversationVisibilityVersion,
            conversationCap: fresh.conversationCap, conversationCompartments: fresh.conversationCompartments ?? [], conversationProjectIds: fresh.conversationProjectIds ?? [],
            participantUserIds: fresh.participantUserIds ?? [], capabilities: fresh.capabilities, contextProjectId: fresh.contextProjectId, sessionId: owner.sessionId });
        }
      }
    } finally { if (current()) setSaving(false); }
  };
  const save = () => mutate(() => updateConversationVisibility(session.id, { expectedVersion: metadata.conversationVisibilityVersion!, visibility, participantUserIds: participants }));
  const currentProject = metadata.contextProjectId ?? session.contextProjectId ?? "none";
  const projectReadOnly = !caps.canMoveProject;
  const capOrder = ["public", "internal", "confidential"] as const;
  return <Popover open={open} onOpenChange={setOpen}>
    <PopoverTrigger aria-label={t.title} title={t.title} className="inline-flex min-h-11 md:min-h-8 min-w-11 items-center justify-center rounded-full text-muted-foreground hover:bg-muted md:min-h-8 md:min-w-8">
      <Eye className="size-4" aria-hidden />
    </PopoverTrigger>
    <PopoverContent align="end" className="max-h-[min(36rem,80dvh)] w-[min(24rem,calc(100vw-1rem))] overflow-y-auto p-4">
      <h2 className="text-sm font-medium">{t.title}</h2>
      <p className="mt-2 text-xs text-muted-foreground">{t.cap.replace("{cap}", metadata.conversationCap ? t.caps[metadata.conversationCap] : "")}</p>
      <p className="mt-1 text-xs text-muted-foreground">{t.boundaries.replace("{count}", String((metadata.conversationCompartments?.length ?? 0) + (metadata.conversationVisibility === "workspace" ? metadata.conversationProjectIds?.length ?? 0 : 0)))}</p>
      {privateKind ? <p className="mt-3 text-sm">{t.privateByKind}</p> : <>
        <div className="mt-3 flex gap-2" aria-label={t.title}>
          <Button size="sm" type="button" aria-pressed={visibility === "configured_private"} disabled={saving || offline || !caps.canNarrow && metadata.conversationVisibility !== "configured_private"} onClick={() => setVisibility("configured_private")} className="min-h-11 md:min-h-8 flex-1 rounded-lg border px-2 text-sm aria-pressed:bg-muted disabled:opacity-50">{t.private}</Button>
          <Button size="sm" type="button" aria-pressed={visibility === "workspace"} disabled={saving || offline || !caps.canWiden && metadata.conversationVisibility !== "workspace"} onClick={() => setVisibility("workspace")} className="min-h-11 md:min-h-8 flex-1 rounded-lg border px-2 text-sm aria-pressed:bg-muted disabled:opacity-50">{t.workspace}</Button>
        </div>
        {visibility === "configured_private" && <fieldset className="mt-3 space-y-1">
          <legend className="mb-1 text-xs font-medium">{t.participants}</legend>
          {[...known.values()].map(member => <label key={member.userId} className="flex min-h-11 md:min-h-8 items-center gap-3 text-sm">
            <Checkbox checked={participants.includes(member.userId)} disabled={saving || offline || membersUnavailable || !caps.canManageParticipants || !caps.canWiden && !(metadata.participantUserIds ?? []).includes(member.userId)} onCheckedChange={checked => setParticipants(current => checked === true ? [...new Set([...current, member.userId])] : current.filter(id => id !== member.userId))} />
            <span>{member.name ?? t.unnamedParticipant}</span>
          </label>)}
        </fieldset>}
        <p className="mt-3 text-xs text-muted-foreground">{visibility === "configured_private" ? t.narrowNotice : t.widenNotice}</p>
        {(caps.canNarrow || caps.canWiden || caps.canManageParticipants) && <Button size="sm" type="button" disabled={saving || offline || visibility === "configured_private" && membersUnavailable} onClick={() => void save()} className="mt-3 min-h-11 md:min-h-8 w-full rounded-lg bg-foreground px-3 text-sm text-background disabled:opacity-50">{saving ? t.saving : t.save}</Button>}
      </>}
      {caps.canRaiseCap && <fieldset className="mt-3 space-y-2">
        <legend className="text-xs font-medium">{t.raiseCap}</legend>
        <p className="text-xs text-muted-foreground">{t.capNotice}</p>
        <div className="flex flex-wrap gap-2">{capOrder.filter(cap => capOrder.indexOf(cap) > capOrder.indexOf(metadata.conversationCap!)).map(cap =>
          <Button size="sm" key={cap} type="button" disabled={saving || offline} onClick={() => void mutate(() => raiseConversationCap(session.id, { expectedVersion: metadata.conversationVisibilityVersion!, cap }))} className="min-h-11 md:min-h-8 rounded-lg border px-3 text-sm disabled:opacity-50">{t.caps[cap]}</Button>)}</div>
      </fieldset>}
      {caps.canMoveProject && <div className="mt-3 space-y-2">
        <label className="block text-xs font-medium" htmlFor={`conversation-project-${session.id}`}>{t.project}</label>
        <Select value={projectId} onValueChange={value => setProjectId(value ?? "none")} disabled={saving || offline || projectsUnavailable || projectReadOnly}>
          <SelectTrigger id={`conversation-project-${session.id}`} className="min-h-11 md:min-h-8 w-full"><SelectValue>{projectId === "none" ? t.noProject : projects.find(project => project.id === projectId)?.name ?? t.project}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="none">{t.noProject}</SelectItem>{projects.map(project => <SelectItem key={project.id} value={project.id}>{project.name}</SelectItem>)}</SelectContent>
        </Select>
        <p className="text-xs text-muted-foreground">{t.projectNotice}</p>
        <Button size="sm" type="button" disabled={saving || offline || projectsUnavailable || projectReadOnly || projectId === currentProject} onClick={() => void mutate(() => moveConversationProject(session.id, { expectedVersion: metadata.conversationVisibilityVersion!, projectId: projectId === "none" ? null : projectId }))} className="min-h-11 md:min-h-8 w-full rounded-lg border px-3 text-sm disabled:opacity-50">{t.saveProject}</Button>
      </div>}
      {membersUnavailable && <p role="status" className="mt-2 text-xs text-muted-foreground">{t.membersUnavailable}</p>}
      {projectsUnavailable && <p role="status" className="mt-2 text-xs text-muted-foreground">{t.projectsUnavailable}</p>}
      {error && <p role="alert" className="mt-2 text-sm">{error}</p>}
    </PopoverContent>
  </Popover>;
}
