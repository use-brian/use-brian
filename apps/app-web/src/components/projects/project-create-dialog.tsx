"use client";

/**
 * Shared Project creation (project-shared-spaces.md, D20-D23): a name plus an
 * optional Participants picker grouped into People and Assistants. The creator
 * is the owner; the workspace's primary Brian starts selected and can be
 * cleared; nothing else is preselected. No Brief, Department, clearance or
 * restricted/unrestricted choice. The server applies exactly this selection.
 * [COMP:app-web/project-shared-journey]
 */
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useT } from "@/lib/i18n/client";
import { createContextProject, type ContextProject } from "@/lib/api/context-scopes";

export type ProjectPersonOption = { userId: string; name: string };
export type ProjectAssistantOption = { id: string; name: string; kind?: string | null };

export function ProjectCreateDialog({ workspaceId, meId, people, assistants, onCreated, onCancel }: {
  workspaceId: string;
  meId: string;
  people: ProjectPersonOption[];
  assistants: ProjectAssistantOption[];
  onCreated: (project: ContextProject) => void;
  onCancel: () => void;
}) {
  const t = useT().contextScope.sharedProjects;
  const primary = assistants.find(row => row.kind === "primary") ?? null;
  const [name, setName] = useState("");
  const [userIds, setUserIds] = useState<string[]>([]);
  // D21: the one primary Brian is visibly preselected and deselectable.
  const [assistantIds, setAssistantIds] = useState<string[]>(primary ? [primary.id] : []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const toggle = (list: string[], id: string, on: boolean) => on ? [...new Set([...list, id])] : list.filter(value => value !== id);

  async function submit() {
    if (!name.trim() || busy) return;
    setBusy(true);
    setError(null);
    try {
      onCreated(await createContextProject(workspaceId, { name: name.trim(), participants: { userIds, assistantIds } }));
    } catch (cause) {
      const code = cause instanceof Error ? cause.message : "";
      setError(code === "project_assistant_unavailable" ? t.assistantUnavailable : t.updateFailed);
    } finally { setBusy(false); }
  }

  return <form aria-label={t.createTitle} className="space-y-4 rounded-xl border border-border p-4"
    onSubmit={event => { event.preventDefault(); void submit(); }}>
    <h2 className="text-sm font-medium">{t.createTitle}</h2>
    <input aria-label={t.createTitle} value={name} onChange={event => setName(event.target.value)} maxLength={200} disabled={busy}
      className="h-11 md:h-9 w-full rounded-lg border border-border bg-background px-3 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-ring md:text-sm" />
    <div className="grid gap-4 sm:grid-cols-2">
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">{t.people}</legend>
        <p className="text-sm">{t.you}</p>
        {people.filter(person => person.userId !== meId).map(person => <label key={person.userId} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
          <Checkbox checked={userIds.includes(person.userId)} disabled={busy}
            onCheckedChange={value => setUserIds(list => toggle(list, person.userId, Boolean(value)))} />{person.name}
        </label>)}
      </fieldset>
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-muted-foreground">{t.assistants}</legend>
        {assistants.map(assistant => <label key={assistant.id} className="flex min-h-11 items-center gap-2 text-sm md:min-h-8">
          <Checkbox checked={assistantIds.includes(assistant.id)} disabled={busy}
            onCheckedChange={value => setAssistantIds(list => toggle(list, assistant.id, Boolean(value)))} />{assistant.name}
        </label>)}
        <p className="text-xs text-muted-foreground">{primary ? t.primaryPreselected : t.noPrimary}</p>
      </fieldset>
    </div>
    {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
    <div className="flex flex-wrap justify-end gap-2">
      <Button type="button" variant="ghost" className="max-sm:min-h-11" onClick={onCancel} disabled={busy}>{t.cancel}</Button>
      <Button type="submit" className="max-sm:min-h-11" disabled={busy || !name.trim()}><Plus aria-hidden className="size-4" />{t.create}</Button>
    </div>
  </form>;
}
