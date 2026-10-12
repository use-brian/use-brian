"use client";

/**
 * Shared Project access (project-shared-spaces.md -> "Roster, owners and
 * revision", D17/D22/D26/D27). One roster of people and assistants with
 * owners flagged; the workspace owner's read oversight is shown separately and
 * cannot be removed here. Every action calls the same commands as Brian's
 * manageProjectAccess tool and presents the current revision, so a stale view
 * is refused and refreshed rather than overwriting a teammate's change.
 * For a legacy Project the workspace owner can review and apply a conversion;
 * nothing is preselected from old participation metadata.
 * [COMP:app-web/project-shared-journey]
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { SearchableSelect } from "@/components/ui/searchable-select";
import { confirmDialog } from "@/components/ui/confirm-dialog";
import { promptDialog } from "@/components/ui/prompt-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import {
  applyProjectConversion,
  previewProjectConversion,
  recoverProjectOwnership,
  removeProjectParticipant,
  setProjectOwner,
  setProjectParticipant,
  transferProjectOwnership,
  type ProjectConversionPreview,
  type ProjectPrincipal,
  type ProjectRoster,
} from "@/lib/api/context-scopes";
import type { ProjectAssistantOption, ProjectPersonOption } from "./project-create-dialog";

export function ProjectAccessPanel({ workspaceId, projectId, roster, people, assistants, meId, workspaceRole, sharedEnabled, onChanged }: {
  workspaceId: string;
  projectId: string;
  /** Null for a legacy (focus-only) Project. */
  roster: ProjectRoster | null;
  people: ProjectPersonOption[];
  assistants: ProjectAssistantOption[];
  meId: string;
  workspaceRole: "owner" | "admin" | "member";
  sharedEnabled: boolean;
  onChanged: () => Promise<unknown> | void;
}) {
  const t = useT().contextScope.sharedProjects;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pick, setPick] = useState({ user: "", assistant: "" });
  const [convertUsers, setConvertUsers] = useState<string[]>([]);
  const [convertAssistants, setConvertAssistants] = useState<string[]>([]);
  const [preview, setPreview] = useState<ProjectConversionPreview | null>(null);
  const nameOf = (id: string) => people.find(person => person.userId === id)?.name ?? assistants.find(a => a.id === id)?.name ?? id;

  async function run(action: () => Promise<unknown>) {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(code === "project_revision_stale" ? t.stale
        : code === "project_last_owner" || code === "project_owner_edge_required" ? t.lastOwner
        : code === "project_owner_required" || code === "project_not_found" ? t.notAllowed
        : code === "project_assistant_unavailable" ? t.assistantUnavailable : t.updateFailed);
    } finally {
      setBusy(false);
      await onChanged();
    }
  }

  // ── Legacy Project: reviewed conversion (workspace owner only, §15.3) ──
  if (!roster) {
    if (workspaceRole !== "owner" || !sharedEnabled) return null;
    const toggle = (list: string[], id: string, on: boolean) => on ? [...new Set([...list, id])] : list.filter(v => v !== id);
    return <section className="space-y-3 rounded-xl border border-border p-4">
      <h2 className="text-sm font-medium">{t.convertTitle}</h2>
      <p className="text-sm text-muted-foreground">{t.convertDescription}</p>
      <div className="grid gap-4 sm:grid-cols-2">
        <fieldset className="space-y-2"><legend className="text-xs font-medium text-muted-foreground">{t.people}</legend>
          {people.filter(person => person.userId !== meId).map(person => <label key={person.userId} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
            <Checkbox checked={convertUsers.includes(person.userId)} disabled={busy}
              onCheckedChange={value => { setPreview(null); setConvertUsers(list => toggle(list, person.userId, Boolean(value))) }} />{person.name}
          </label>)}
        </fieldset>
        <fieldset className="space-y-2"><legend className="text-xs font-medium text-muted-foreground">{t.assistants}</legend>
          {assistants.map(assistant => <label key={assistant.id} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
            <Checkbox checked={convertAssistants.includes(assistant.id)} disabled={busy}
              onCheckedChange={value => { setPreview(null); setConvertAssistants(list => toggle(list, assistant.id, Boolean(value))) }} />{assistant.name}
          </label>)}
        </fieldset>
      </div>
      {preview ? <div className="space-y-1 text-sm">
        <p>{format(t.convertSummary, { owner: nameOf(preview.ownerUserId), count: preview.userIds.length + preview.assistantIds.length })}</p>
        <p className="text-muted-foreground">{format(t.linkedUnchanged, { count: Object.values(preview.linkedMaterial).reduce((sum, n) => sum + n, 0) })}</p>
      </div> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" className="max-sm:min-h-11" disabled={busy}
          onClick={() => void run(async () => setPreview(await previewProjectConversion(workspaceId, projectId, { userIds: convertUsers, assistantIds: convertAssistants })))}>
          {t.convertPreview}
        </Button>
        <Button className="max-sm:min-h-11" disabled={busy || !preview}
          onClick={() => preview && void run(() => applyProjectConversion(workspaceId, projectId, { userIds: convertUsers, assistantIds: convertAssistants,
            idempotencyKey: crypto.randomUUID(), requestHash: preview.requestHash }))}>
          {t.convertApply}
        </Button>
      </div>
    </section>;
  }

  const isOwner = roster.myRole === "owner";
  const revision = roster.revision;
  const memberIds = new Set(roster.members.map(m => m.principal.id));
  const peopleRows = roster.members.filter(m => m.principal.kind === "user");
  const assistantRows = roster.members.filter(m => m.principal.kind === "assistant");
  const owners = peopleRows.filter(m => m.isOwner);

  async function remove(principal: ProjectPrincipal) {
    if (!await confirmDialog({ title: t.removeConfirmTitle, description: t.removeConfirmDescription, confirmLabel: t.remove, cancelLabel: t.cancel })) return;
    await run(() => removeProjectParticipant(workspaceId, projectId, principal, revision));
  }
  async function transfer(userId: string, name: string) {
    if (!await confirmDialog({ title: t.transferConfirmTitle, description: format(t.transferConfirmDescription, { name }), confirmLabel: t.transfer, cancelLabel: t.cancel })) return;
    await run(() => transferProjectOwnership(workspaceId, projectId, userId, revision));
  }
  async function recover() {
    const reason = await promptDialog({ title: t.recoverTitle, description: t.recoverDescription, placeholder: t.recoverReason, confirmLabel: t.recover, cancelLabel: t.cancel, multiline: true });
    if (!reason?.trim()) return;
    await run(() => recoverProjectOwnership(workspaceId, projectId, { reason: reason.trim(), expectedRevision: revision }));
  }

  const row = (member: ProjectRoster["members"][number]) => {
    const name = member.name ?? member.email ?? member.principal.id;
    const mine = member.principal.kind === "user" && member.principal.id === meId;
    return <li key={`${member.principal.kind}:${member.principal.id}`} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
      <span className="min-w-0 break-words">{name}{member.isOwner ? <span className="ml-2 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{t.roleOwner}</span> : null}</span>
      {isOwner ? <span className="flex flex-wrap gap-1">
        {member.principal.kind === "user" && !mine ? <Button variant="ghost" size="sm" className="max-sm:min-h-11" disabled={busy}
          onClick={() => void run(() => setProjectOwner(workspaceId, projectId, member.principal.id, !member.isOwner, revision))}>
          {member.isOwner ? t.removeOwner : t.makeOwner}</Button> : null}
        {member.principal.kind === "user" && !mine && !member.isOwner && owners.some(o => o.principal.id === meId) ? <Button variant="ghost" size="sm" className="max-sm:min-h-11"
          disabled={busy} onClick={() => void transfer(member.principal.id, name)}>{t.transfer}</Button> : null}
        {!member.isOwner ? <Button variant="ghost" size="sm" className="max-sm:min-h-11" disabled={busy} onClick={() => void remove(member.principal)}>{t.remove}</Button> : null}
      </span> : null}
    </li>;
  };

  return <section aria-label={t.accessTitle} className="space-y-4 rounded-xl border border-border p-4">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h2 className="text-sm font-medium">{t.accessTitle}</h2>
      <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
        {roster.myRole === "owner" ? t.roleOwner : roster.myRole === "participant" ? t.roleParticipant : t.roleOversight}
      </span>
    </div>
    <p className="text-sm text-muted-foreground">{t.accessDescription}</p>
    <div className="grid gap-4 md:grid-cols-2">
      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t.people}</h3>
        <ul className="divide-y divide-border">{peopleRows.map(row)}</ul>
        {isOwner ? <div className="mt-2 flex gap-2">
          <SearchableSelect value={pick.user} onValueChange={user => setPick(p => ({ ...p, user }))} aria-label={t.addPerson}
            items={people.filter(p => !memberIds.has(p.userId)).map(p => ({ value: p.userId, label: p.name }))}
            placeholder={t.addPlaceholder} searchPlaceholder={t.addPerson} emptyMessage={t.addPerson} className="w-full sm:w-56" disabled={busy} />
          <Button variant="outline" className="max-sm:min-h-11" disabled={busy || !pick.user}
            onClick={() => void run(async () => { await setProjectParticipant(workspaceId, projectId, { kind: "user", id: pick.user }, revision); setPick(p => ({ ...p, user: "" })) })}>
            {t.addPerson}</Button>
        </div> : null}
      </div>
      <div>
        <h3 className="text-xs font-medium text-muted-foreground">{t.assistants}</h3>
        {assistantRows.length ? <ul className="divide-y divide-border">{assistantRows.map(row)}</ul> : <p className="py-2 text-sm text-muted-foreground">{t.emptyAssistants}</p>}
        {isOwner ? <div className="mt-2 flex gap-2">
          <SearchableSelect value={pick.assistant} onValueChange={assistant => setPick(p => ({ ...p, assistant }))} aria-label={t.addAssistant}
            items={assistants.filter(a => !memberIds.has(a.id)).map(a => ({ value: a.id, label: a.name }))}
            placeholder={t.addPlaceholder} searchPlaceholder={t.addAssistant} emptyMessage={t.addAssistant} className="w-full sm:w-56" disabled={busy} />
          <Button variant="outline" className="max-sm:min-h-11" disabled={busy || !pick.assistant}
            onClick={() => void run(async () => { await setProjectParticipant(workspaceId, projectId, { kind: "assistant", id: pick.assistant }, revision); setPick(p => ({ ...p, assistant: "" })) })}>
            {t.addAssistant}</Button>
        </div> : null}
      </div>
    </div>
    <div className="rounded-lg bg-muted/40 p-3" data-testid="project-oversight">
      <h3 className="text-xs font-medium">{t.oversightTitle}</h3>
      <p className="mt-1 text-sm text-muted-foreground">{t.oversightDescription}</p>
      <ul className="mt-2 text-sm">{roster.oversight.map(o => <li key={o.userId}>{o.name ?? o.userId} <span className="text-xs text-muted-foreground">({t.readOnly})</span></li>)}</ul>
    </div>
    {workspaceRole === "owner" && !isOwner ? <Button variant="outline" className="max-sm:min-h-11" disabled={busy} onClick={() => void recover()}>{t.recover}</Button> : null}
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
  </section>;
}
