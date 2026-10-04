"use client";

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { createAssistant, type StudioAssistantSummary } from "@/lib/api/studio";
import { ASSISTANT_PROFILES, assistantProfileById, type AssistantProfile } from "@use-brian/shared/assistant-profiles";
import { isPhoneViewport } from "@/lib/viewport";
import { fetchDepartments, DEPARTMENTS_CHANGED_EVENT } from "@/lib/api/departments";
import { useWorkspaceContext } from "@/lib/workspace-context";
import { useCachedResource } from "@/lib/surface-cache";
import { departmentDirectoryCacheKey } from "@/lib/surface-prefetch";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";

/** Add Assistant, including its department audience. [COMP:app-web/studio-assistants] */
export function CreateAssistantModal({
  workspaceId,
  onClose,
  onCreated,
}: {
  workspaceId: string;
  onClose: () => void;
  onCreated: (a: StudioAssistantSummary) => void;
}) {
  const t = useT();
  const [name, setName] = useState("");
  const [mission, setMission] = useState("");
  const { me } = useWorkspaceContext();
  const [placement, setPlacement] = useState("workspace");
  const departments = useCachedResource(departmentDirectoryCacheKey(workspaceId, me.id), () => fetchDepartments(workspaceId));
  const refreshDepartments = departments.refresh;
  useEffect(() => {
    const refresh = () => { void refreshDepartments(); };
    window.addEventListener(DEPARTMENTS_CHANGED_EVENT, refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(DEPARTMENTS_CHANGED_EVENT, refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [refreshDepartments]);
  const placements = (departments.data?.departments ?? []).filter(d => d.status === "active" && d.isOwner && d.myClearance);
  const placementAvailable = placement === "workspace" || (!departments.error && placements.some(d => d.departmentId === placement));

  // null = start blank (the intake interview will offer itself on first
  // owner chat); a profile id = seed the whole charter from the community
  // registry (growth loop Phase 2).
  const [profileId, setProfileId] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  // Card strings: dictionary entry for built-in ids, registry English
  // fallback for community additions the dictionaries don't know.
  function profileCard(p: AssistantProfile): { title: string; tagline: string } {
    const known = (t.studioPage.assistants.profiles as Record<string, { title: string; tagline: string } | undefined>)[p.id];
    return known ?? { title: p.fallbackTitle, tagline: p.fallbackTagline };
  }

  const selectedProfile = profileId ? assistantProfileById(profileId) : null;
  const selectedProfileTagline = selectedProfile
    ? profileCard(selectedProfile).tagline
    : t.studioPage.assistants.profileBlankTagline;

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || creating || !placementAvailable) return;
    setCreating(true);
    setError("");
    try {
      // The charter seed at birth is the capture the growth loop reads:
      // profile seed if picked, overridden by an explicitly typed mission.
      const profile = profileId ? assistantProfileById(profileId) : null;
      const charter = profile
        ? { ...profile.charter, ...(mission.trim() ? { mission: mission.trim() } : {}) }
        : mission.trim()
          ? { mission: mission.trim() }
          : undefined;
      const created = await createAssistant(workspaceId, trimmed, charter, placement === "workspace" ? null : placement);
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.studioPage.assistants.createError);
      setCreating(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4">
        <div
          className="bg-popover border border-border rounded-2xl shadow-2xl w-full max-w-lg max-h-[calc(100dvh-2rem)] overflow-y-auto p-4 sm:p-6 space-y-3"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="text-base font-semibold">
            {t.studioPage.assistants.createTitle}
          </h3>
          {/* Profile picker — community charter archetypes (@use-brian/shared
              assistant-profiles registry). Picking one seeds the full charter;
              Blank leaves it empty so the setup interview offers itself on the
              owner's first chat. */}
          <div>
            <div className="text-[12px] font-medium text-muted-foreground mb-1.5">
              {t.studioPage.assistants.profilePickerLabel}
            </div>
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-1.5">
              <button
                type="button"
                onClick={() => setProfileId(null)}
                aria-pressed={profileId === null}
                title={t.studioPage.assistants.profileBlankTitle}
                className={`min-w-0 max-sm:min-h-11 text-left border rounded-lg px-2.5 py-2 transition-colors ${
                  profileId === null ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                }`}
              >
                <div className="truncate whitespace-nowrap text-[12px] sm:text-[13px] font-medium leading-tight">
                  ✨ {t.studioPage.assistants.profileBlankTitle}
                </div>
              </button>
              {ASSISTANT_PROFILES.map((p) => {
                const card = profileCard(p);
                return (
                  <button
                    key={p.id}
                    type="button"
                    onClick={() => setProfileId(p.id)}
                    aria-pressed={profileId === p.id}
                    title={card.title}
                    className={`min-w-0 max-sm:min-h-11 text-left border rounded-lg px-2.5 py-2 transition-colors ${
                      profileId === p.id ? "border-primary bg-primary/5" : "border-border hover:bg-muted/50"
                    }`}
                  >
                    <div className="truncate whitespace-nowrap text-[12px] sm:text-[13px] font-medium leading-tight">
                      {p.emoji} {card.title}
                    </div>
                  </button>
                );
              })}
            </div>
            <p
              data-assistant-profile-description
              aria-live="polite"
              className="mt-1.5 min-h-8 text-[11px] leading-4 text-muted-foreground"
            >
              {selectedProfileTagline}
            </p>
          </div>
          <input
            type="text"
            value={name}
            autoFocus={!isPhoneViewport()}
            maxLength={100}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder={t.studioPage.assistants.createPlaceholder}
            className="w-full text-[16px] md:text-sm bg-muted/50 border border-border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
          <div>
            <input
              type="text"
              value={mission}
              maxLength={300}
              onChange={(e) => setMission(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") void submit();
              }}
              placeholder={t.studioPage.assistants.createMissionPlaceholder}
              className="w-full text-[16px] md:text-sm bg-muted/50 border border-border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <p className="text-[11px] text-muted-foreground mt-1.5">
              {t.studioPage.assistants.createMissionHint}
            </p>
          </div>
          <div className="space-y-1.5">
            <label htmlFor="assistant-placement" className="text-sm font-medium">{t.studioPage.assistants.placementLabel}</label>
            <Select value={placement} onValueChange={(value) => { if (value) setPlacement(value); }}>
              <SelectTrigger id="assistant-placement" className="w-full min-h-8 max-sm:min-h-11">
                <SelectValue>{placement === "workspace" ? t.studioPage.assistants.placementWorkspace : placements.find(d => d.departmentId === placement)?.name ?? t.studioPage.assistants.placementUnavailable}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="workspace">{t.studioPage.assistants.placementWorkspace}</SelectItem>
                {placement !== "workspace" && !placements.some(d => d.departmentId === placement) && <SelectItem value={placement} disabled>{t.studioPage.assistants.placementUnavailable}</SelectItem>}
                {placements.map(d => <SelectItem key={d.departmentId} value={d.departmentId}>{d.name}</SelectItem>)}
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">{placement === "workspace" ? t.studioPage.assistants.placementWorkspaceHint : t.studioPage.assistants.placementDepartmentHint}</p>
            {departments.error !== undefined && <button type="button" onClick={() => void refreshDepartments()} className="text-xs text-destructive min-h-8 max-sm:min-h-11">{t.studioPage.assistants.placementLoadError}</button>}
            {!placementAvailable && <p role="alert" className="text-xs text-destructive">{t.studioPage.assistants.placementUnavailable}</p>}
          </div>
          {error && <div className="text-xs text-destructive">{error}</div>}
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="max-sm:min-h-11 text-sm font-medium px-4 py-2 rounded-lg border border-border text-muted-foreground hover:bg-muted transition-colors"
            >
              {t.studioPage.assistants.createCancel}
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!name.trim() || creating || !placementAvailable}
              className="max-sm:min-h-11 text-sm font-medium px-4 py-2 rounded-lg bg-action text-action-foreground hover:bg-action/90 disabled:opacity-50 transition-colors"
            >
              {creating
                ? t.studioPage.assistants.createSubmitting
                : t.studioPage.assistants.createSubmit}
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
