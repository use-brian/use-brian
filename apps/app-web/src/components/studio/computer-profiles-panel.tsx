"use client";

/** [COMP:app-web/computer-profiles] Owner-private grants, independent of chat context. */
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { type ComputerProfile, type ComputerProfileAssistantPatch, updateComputerProfileAssistant, useComputerProfiles } from "@/lib/api/computer-profiles";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { ListSurfaceSkeleton } from "@/components/chrome/surface-skeleton";

type CapabilityControl = {
  enabled: boolean;
  pending: boolean;
  onChange: (enabled: boolean) => Promise<boolean>;
};
type PanelProps = {
  workspaceId: string | null;
  assistantId: string;
  capability?: CapabilityControl;
  onManageCapability?: () => void;
};
export function ComputerProfilesPanel({ workspaceId, assistantId, ...props }: PanelProps) {
  return workspaceId ? <ProfileGrants key={`${workspaceId}:${assistantId}`} workspaceId={workspaceId} assistantId={assistantId} {...props} /> : null;
}
function ProfileGrants({ workspaceId, assistantId, capability, onManageCapability }: PanelProps & { workspaceId: string }) {
  const t = useT().computerProfiles;
  const { profiles, error, refresh } = useComputerProfiles(workspaceId);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const [capabilityFailed, setCapabilityFailed] = useState(false);
  const changingCapability = useRef(false);
  async function changeCapability(enabled: boolean) {
    if (!capability || capability.pending || changingCapability.current) return;
    changingCapability.current = true; setCapabilityFailed(false);
    try {
      const ok = await capability.onChange(enabled);
      if (alive.current) setCapabilityFailed(!ok);
    } catch { if (alive.current) setCapabilityFailed(true); }
    finally { changingCapability.current = false; }
  }
  const alive = useRef(true); const writing = useRef(false);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  async function save(profile: ComputerProfile, patch: ComputerProfileAssistantPatch) {
    if (writing.current || !profile.canManage) return;
    writing.current = true; setSaving(true); setFailed(false);
    try {
      await updateComputerProfileAssistant(profile.id, assistantId, patch);
      if (alive.current) { await refresh(); setDrafts(old => { const next = { ...old }; delete next[profile.id]; return next; }); }
    } catch { if (alive.current) setFailed(true); }
    finally { writing.current = false; if (alive.current) setSaving(false); }
  }
  return <section className="space-y-3" aria-label={t.title}>
    <h3 className="font-medium">{t.title}</h3>
    <p className="text-sm text-muted-foreground">{t.privateHelp}</p>
    <p className="text-sm text-muted-foreground">{t.capabilityHelp}</p>
    {capability ? <label className="flex min-h-11 items-center gap-3 text-sm">
      <Checkbox aria-label={t.capabilityToggle} checked={capability.enabled} disabled={capability.pending} onCheckedChange={enabled => void changeCapability(enabled)} />{t.capabilityToggle}
    </label> : onManageCapability ? <Button className="min-h-11" variant="outline" onClick={onManageCapability}>{t.manageCapability}</Button> : null}
    {capabilityFailed ? <p role="alert" className="text-sm text-destructive">{t.capabilityError}</p> : null}
    <p className="text-sm">{t.chatHelp}</p>
    <Link className="inline-flex min-h-11 items-center text-sm underline" href={`/w/${workspaceId}/computer/native`}>{t.title}</Link>
    {error || failed ? <p role="alert" className="text-sm text-destructive">{t.error} <Button className="min-h-11" variant="outline" onClick={() => void refresh()}>{t.retry}</Button></p> : null}
    {!profiles && !error ? <ListSurfaceSkeleton /> : profiles?.length === 0 ? <p>{t.empty}</p> : null}
    {profiles?.map(profile => {
      const enabled = profile.enabledAssistantIds.includes(assistantId);
      const savedNote = profile.assistantRoutingNotes?.[assistantId] ?? "";
      const draft = drafts[profile.id] ?? savedNote;
      return <section key={profile.id} className="space-y-3 rounded-xl border border-border bg-card px-4 py-3">
        <div className="flex flex-wrap items-center justify-between gap-3"><h4 className="break-all text-sm font-medium">{profile.name}</h4><span className="text-sm text-muted-foreground">{profile.connected ? t.online : t.offline}</span></div>
        <label className="flex min-h-11 items-center gap-3 text-sm"><Checkbox aria-label={`${t.available}: ${profile.name}`} checked={enabled} disabled={saving} onCheckedChange={checked => void save(profile, { enabled: checked })} />{t.available}</label>
        <label className="block space-y-1 text-sm"><span>{t.notes}</span><textarea className="min-h-24 w-full rounded-md border bg-background p-3 text-base" maxLength={2000} value={draft} disabled={saving} onChange={event => setDrafts(old => ({ ...old, [profile.id]: event.target.value }))} /></label>
        <Button className="min-h-11" variant="outline" disabled={saving || draft === savedNote} onClick={() => void save(profile, { routingNote: draft.trim() })}>{t.save}</Button>
      </section>;
    })}
  </section>;
}
