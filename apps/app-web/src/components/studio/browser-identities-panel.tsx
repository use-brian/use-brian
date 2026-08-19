"use client";

/**
 * Assistant-centric browser identity selection. Browser profile lifecycle
 * remains in the Browsers mini app; this panel owns only discoverability and
 * the acting assistant's routing note.
 *
 * [COMP:app-web/browser-identities]
 */
import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { type Sensitivity } from "@/components/sensitivity-badge";
import {
  listBrowserProfiles,
  updateBrowserProfile,
  type BrowserProfile,
} from "@/lib/api/computer";

export function manageableBrowserProfiles(profiles: BrowserProfile[]): BrowserProfile[] {
  return profiles.filter((profile) => profile.canManage === true);
}

/** Mirrors the `public < internal < confidential` ladder the runtime gates on. */
const CLEARANCE_RANK: Record<Sensitivity, number> = {
  public: 1,
  internal: 2,
  confidential: 3,
};

/**
 * The runtime gate this toggle is a UI for (`canUseProfile`, core
 * `sandbox/profiles.ts`): enablement alone does not grant use. A toggle that
 * reports "granted" for a grant the gate refuses is the bug this exists to
 * prevent - on 2026-08-19 an `internal` assistant was enabled for a
 * `confidential` profile four times, and every surface said it had worked.
 *
 * Since migration 451 the rung only gates WORKSPACE-scoped profiles. An
 * owner-scoped profile has no clearance to fail, so warning about one would be
 * a false alarm about a state that cannot occur.
 */
export function clearanceCovers(
  assistantClearance: Sensitivity | null | undefined,
  profileClearance: Sensitivity,
  scope: BrowserProfile["scope"] = "workspace",
): boolean {
  if (scope === "owner") return true;
  // Unknown clearance never fabricates a warning: the runtime gate is the
  // authority and a missing value here is a loading state, not a denial.
  if (!assistantClearance) return true;
  return CLEARANCE_RANK[profileClearance] <= CLEARANCE_RANK[assistantClearance];
}

function ProfileIcon({ backend }: { backend: BrowserProfile["defaultBackend"] }) {
  return backend === "cloud" ? (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7">
      <path strokeLinecap="round" strokeLinejoin="round" d="M7.5 18.5h9a4 4 0 0 0 .7-7.94A5.5 5.5 0 0 0 6.8 9.2 4.7 4.7 0 0 0 7.5 18.5Z" />
    </svg>
  ) : (
    <svg aria-hidden viewBox="0 0 24 24" className="size-4" fill="none" stroke="currentColor" strokeWidth="1.7">
      <rect x="4" y="5" width="16" height="11" rx="1.5" />
      <path strokeLinecap="round" d="M2.8 19h18.4" />
    </svg>
  );
}

type BrowserIdentityListProps = {
  profiles: BrowserProfile[];
  assistantId: string;
  /** The acting assistant's rung; undefined while the parent is still loading. */
  assistantClearance?: Sensitivity;
  drafts: Record<string, string>;
  savingId: string | null;
  savedId: string | null;
  errorId: string | null;
  onToggle: (profile: BrowserProfile, available: boolean) => void;
  onDraftChange: (profileId: string, note: string) => void;
  onSave: (profile: BrowserProfile) => void;
};

/** Exported as a pure view so the authorization and note states are SSR-testable. */
export function BrowserIdentityList({
  profiles,
  assistantId,
  assistantClearance,
  drafts,
  savingId,
  savedId,
  errorId,
  onToggle,
  onDraftChange,
  onSave,
}: BrowserIdentityListProps) {
  const t = useT();
  return (
    <div className="space-y-2">
      {profiles.map((profile) => {
        const available = profile.enabledAssistantIds.includes(assistantId);
        const savedNote = profile.assistantRoutingNotes?.[assistantId] ?? "";
        const draft = drafts[profile.id] ?? savedNote;
        const noteChanged = draft.trim() !== savedNote.trim();
        const saving = savingId === profile.id;
        // Enabled but out of clearance is the silent failure: the toggle reads
        // ON, the runtime refuses, and every remedy on offer is "enable it".
        const outOfClearance = !clearanceCovers(
          assistantClearance,
          profile.clearance,
          profile.scope,
        );
        return (
          <section key={profile.id} className="rounded-xl border border-border bg-card px-4 py-3">
            <div className="flex items-center gap-3">
              <span className="grid size-8 shrink-0 place-items-center rounded-lg bg-muted text-muted-foreground">
                <ProfileIcon backend={profile.defaultBackend} />
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <h4 className="truncate text-sm font-medium">{profile.name}</h4>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] text-muted-foreground">
                    {profile.defaultBackend === "cloud"
                      ? t.assistant.toolsTab.browserIdentitiesRemote
                      : t.assistant.toolsTab.browserIdentitiesLocal}
                  </span>
                </div>
                <p className="mt-0.5 text-xs text-muted-foreground">
                  {t.assistant.toolsTab.browserIdentitiesAvailable}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={available}
                aria-label={`${t.assistant.toolsTab.browserIdentitiesAvailable}: ${profile.name}`}
                disabled={saving}
                onClick={() => onToggle(profile, !available)}
                className={`relative inline-flex h-5 w-9 shrink-0 rounded-full border-2 border-transparent transition-colors disabled:opacity-50 ${
                  available ? "bg-primary" : "bg-muted"
                }`}
              >
                <span
                  className={`pointer-events-none inline-block size-4 rounded-full bg-background shadow-sm transition-transform ${
                    available ? "translate-x-4" : "translate-x-0"
                  }`}
                />
              </button>
            </div>

            {outOfClearance ? (
              <p className="mt-2 rounded-lg bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
                {format(t.assistant.toolsTab.browserIdentitiesClearanceBlocked, {
                  profile: t.manage.sensitivity[profile.clearance],
                  assistant: assistantClearance
                    ? t.manage.sensitivity[assistantClearance]
                    : "",
                })}{" "}
                {t.assistant.toolsTab.browserIdentitiesClearanceRemedy}
              </p>
            ) : null}

            {available ? (
              <div className="mt-3 border-t border-border pt-3">
                <label htmlFor={`browser-note-${profile.id}`} className="text-xs font-medium">
                  {t.assistant.toolsTab.browserIdentitiesWhenToUse}
                </label>
                <textarea
                  id={`browser-note-${profile.id}`}
                  value={draft}
                  maxLength={500}
                  rows={2}
                  onChange={(event) => onDraftChange(profile.id, event.target.value)}
                  placeholder={t.assistant.toolsTab.browserIdentitiesPlaceholder}
                  className="mt-1.5 block w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none transition-shadow placeholder:text-muted-foreground/70 focus:ring-1 focus:ring-ring"
                />
                <div className="mt-2 flex min-h-7 items-center justify-end gap-2">
                  {errorId === profile.id ? (
                    <span className="mr-auto text-xs text-destructive">
                      {t.assistant.toolsTab.browserIdentitiesUpdateFailed}
                    </span>
                  ) : savedId === profile.id && !noteChanged ? (
                    <span className="mr-auto text-xs text-muted-foreground">
                      {t.assistant.toolsTab.browserIdentitiesSaved}
                    </span>
                  ) : null}
                  {noteChanged ? (
                    <button
                      type="button"
                      disabled={saving}
                      onClick={() => onSave(profile)}
                      className="h-7 rounded-md bg-action px-3 text-xs font-medium text-action-foreground disabled:opacity-50"
                    >
                      {saving
                        ? t.assistant.toolsTab.browserIdentitiesSaving
                        : t.assistant.toolsTab.browserIdentitiesSave}
                    </button>
                  ) : null}
                </div>
              </div>
            ) : errorId === profile.id ? (
              <p className="mt-2 text-xs text-destructive">
                {t.assistant.toolsTab.browserIdentitiesUpdateFailed}
              </p>
            ) : null}
          </section>
        );
      })}
    </div>
  );
}

export function BrowserIdentitiesPanel({
  assistantId,
  assistantClearance,
  workspaceId,
}: {
  assistantId: string;
  assistantClearance?: Sensitivity;
  workspaceId: string | null;
}) {
  const t = useT();
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "unconfigured" }
    | { kind: "ready"; profiles: BrowserProfile[] }
    | { kind: "error" }
  >({ kind: "loading" });
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [savingId, setSavingId] = useState<string | null>(null);
  const [savedId, setSavedId] = useState<string | null>(null);
  const [errorId, setErrorId] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setState({ kind: "unconfigured" });
      return;
    }
    try {
      const result = await listBrowserProfiles(workspaceId);
      if (!result.configured) {
        setState({ kind: "unconfigured" });
        return;
      }
      const profiles = manageableBrowserProfiles(result.profiles);
      setState({ kind: "ready", profiles });
      setDrafts(
        Object.fromEntries(
          profiles.map((profile) => [
            profile.id,
            profile.assistantRoutingNotes?.[assistantId] ?? "",
          ]),
        ),
      );
    } catch {
      setState({ kind: "error" });
    }
  }, [assistantId, workspaceId]);

  useEffect(() => {
    void load();
  }, [load]);

  const replaceProfile = useCallback((updated: BrowserProfile) => {
    setState((current) =>
      current.kind === "ready"
        ? {
            kind: "ready",
            profiles: current.profiles.map((profile) =>
              profile.id === updated.id ? updated : profile,
            ),
          }
        : current,
    );
  }, []);

  const toggle = useCallback(
    async (profile: BrowserProfile, available: boolean) => {
      setSavingId(profile.id);
      setSavedId(null);
      setErrorId(null);
      const enabledAssistantIds = available
        ? Array.from(new Set([...profile.enabledAssistantIds, assistantId]))
        : profile.enabledAssistantIds.filter((id) => id !== assistantId);
      replaceProfile({ ...profile, enabledAssistantIds });
      const ok = await updateBrowserProfile(profile.id, { enabledAssistantIds }).catch(() => false);
      setSavingId(null);
      if (!ok) {
        setErrorId(profile.id);
        void load();
      }
    },
    [assistantId, load, replaceProfile],
  );

  const saveNote = useCallback(
    async (profile: BrowserProfile) => {
      const note = (drafts[profile.id] ?? "").trim();
      const assistantRoutingNotes = { ...(profile.assistantRoutingNotes ?? {}) };
      if (note) assistantRoutingNotes[assistantId] = note;
      else delete assistantRoutingNotes[assistantId];

      setSavingId(profile.id);
      setSavedId(null);
      setErrorId(null);
      const ok = await updateBrowserProfile(profile.id, { assistantRoutingNotes }).catch(() => false);
      setSavingId(null);
      if (!ok) {
        setErrorId(profile.id);
        return;
      }
      replaceProfile({ ...profile, assistantRoutingNotes });
      setDrafts((current) => ({ ...current, [profile.id]: note }));
      setSavedId(profile.id);
    },
    [assistantId, drafts, replaceProfile],
  );

  const profilesHref = workspaceId ? `/w/${workspaceId}/computer/profiles` : "#";

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          {t.assistant.toolsTab.browserIdentitiesDescription}
        </p>
        {workspaceId ? (
          <Link
            href={profilesHref}
            className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
          >
            {t.assistant.toolsTab.browserIdentitiesManage}
            <svg aria-hidden viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path strokeLinecap="round" strokeLinejoin="round" d="M5.25 3.75h7v7M12 4 4 12" />
            </svg>
          </Link>
        ) : null}
      </div>

      {state.kind === "loading" ? (
        <p className="py-8 text-center text-xs text-muted-foreground">
          {t.assistant.toolsTab.browserIdentitiesLoading}
        </p>
      ) : state.kind === "unconfigured" ? (
        <p className="rounded-xl border border-dashed border-border px-4 py-8 text-center text-xs text-muted-foreground">
          {t.assistant.toolsTab.browserIdentitiesUnconfigured}
        </p>
      ) : state.kind === "error" ? (
        <p className="rounded-xl border border-destructive/30 px-4 py-8 text-center text-xs text-destructive">
          {t.assistant.toolsTab.browserIdentitiesLoadFailed}
        </p>
      ) : state.profiles.length === 0 ? (
        <div className="rounded-xl border border-dashed border-border px-4 py-8 text-center">
          <p className="text-xs text-muted-foreground">
            {t.assistant.toolsTab.browserIdentitiesEmpty}
          </p>
          <Link href={profilesHref} className="mt-2 inline-block text-xs font-medium text-primary hover:underline">
            {t.assistant.toolsTab.browserIdentitiesManage}
          </Link>
        </div>
      ) : (
        <BrowserIdentityList
          profiles={state.profiles}
          assistantId={assistantId}
          assistantClearance={assistantClearance}
          drafts={drafts}
          savingId={savingId}
          savedId={savedId}
          errorId={errorId}
          onToggle={(profile, available) => void toggle(profile, available)}
          onDraftChange={(profileId, note) => {
            setDrafts((current) => ({ ...current, [profileId]: note }));
            setSavedId((current) => (current === profileId ? null : current));
          }}
          onSave={(profile) => void saveNote(profile)}
        />
      )}
    </div>
  );
}
