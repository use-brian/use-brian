"use client";

/**
 * Studio -> Assistants (app-web) — master-detail.
 *
 * Ported from `apps/web/src/app/(app)/studio/assistants/page.tsx`
 * (app consolidation §9 #5). Left rail lists every assistant in the active
 * workspace (this surface is already workspace-scoped via the route) and
 * offers a "New assistant" create modal. The right pane embeds
 * `<AssistantDetail>` for the selected assistant. Selection lives in the
 * `?assistant=` query param so the detail (and its tabs) stay deep-linkable.
 *
 * app-web deltas vs apps/web:
 *   - `activeId` comes from the app-web `useWorkspaces()` adapter, which
 *     is route-derived (`/w/[workspaceId]`), not a localStorage singleton.
 *   - Selection links are workspace-scoped (`/w/[workspaceId]/studio/...`).
 *   - Otherwise a faithful copy (sidebar-cache sync, optimistic insert,
 *     workspace-change row drop).
 *
 * Rendered inside the Studio full-page layout
 * (apps/app-web/src/app/w/[workspaceId]/studio/layout.tsx), NOT the doc
 * three-column page shell (consolidation §9 #5).
 *
 * [COMP:app-web/studio-assistants]
 */

import { Suspense, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, useParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { useWorkspaces } from "@/contexts/workspace-context";
import { createAssistant, type StudioAssistantSummary } from "@/lib/api/studio";
import {
  ASSISTANT_PROFILES,
  assistantProfileById,
  type AssistantProfile,
} from "@use-brian/shared/assistant-profiles";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { AssistantDetail, type AssistantSeed } from "@/components/studio/assistant-detail";
import { SensitivityBadge, type Sensitivity } from "@/components/sensitivity-badge";
import { BackButton } from "@/components/ui/back-button";
import { RailSurfaceSkeleton } from "@/components/chrome/surface-skeleton";
import { isPhoneViewport } from "@/lib/viewport";
import { cn } from "@/lib/utils";
import { useAssistantsData } from "./use-assistants-data";

/**
 * The rail row as the detail's first-frame header. The list endpoint types
 * `clearance` / `iconSeed` loosely (`string | null`); the header wants the
 * narrowed shape, so normalise here rather than widening the header type.
 */
function seedFor(row: StudioAssistantSummary | undefined): AssistantSeed | null {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    workspaceId: row.workspaceId,
    iconSeed: row.iconSeed ?? undefined,
    clearance: (row.clearance ?? undefined) as Sensitivity | undefined,
  };
}

export default function StudioAssistantsPage() {
  return (
    <Suspense fallback={<RailSurfaceSkeleton chrome={false} padded={false} />}>
      <StudioAssistants />
    </Suspense>
  );
}

function StudioAssistants() {
  const t = useT();
  const router = useRouter();
  const searchParams = useSearchParams();
  const params = useParams<{ workspaceId: string }>();
  const routeWs = params?.workspaceId ?? "";
  const { activeId } = useWorkspaces();
  // The rail reads the workspace's cached assistant list (instant-navigation
  // N1): a revisit paints on the first frame, the spine marks it stale, and
  // the sidebar-cache merge (rename / icon / clearance edits from the detail)
  // writes through the same key inside the hook.
  const { assistants, error: loadError, update } = useAssistantsData(activeId);
  const [showCreate, setShowCreate] = useState(false);
  // Phone single-pane (responsive contract M1 / M5): below `md` the rail and
  // the detail are two screens. A deep link (`?assistant=`) lands on the
  // detail; otherwise the rail shows first and a tapped row opens the
  // detail, with Back returning to the rail. Inert on `md+`.
  const [detailOpen, setDetailOpen] = useState(() => !!searchParams.get("assistant"));
  const detailRef = useRef<HTMLDivElement>(null);

  const assistantHref = (id: string) =>
    `/w/${routeWs}/studio/assistants?assistant=${encodeURIComponent(id)}`;

  function revealDetail() {
    setDetailOpen(true);
    // On `md+` the detail renders beside a rail that can outgrow the
    // viewport, so bring the pane into view as well.
    requestAnimationFrame(() => {
      detailRef.current?.scrollIntoView({ block: "start" });
    });
  }

  function handleCreated(created: StudioAssistantSummary) {
    setShowCreate(false);
    // Optimistic insert so the new row renders before the detail's own fetch
    // round-trips; the rail only needs id/name/icon.
    update((prev) =>
      prev.some((a) => a.id === created.id) ? prev : [...prev, created],
    );
    router.push(assistantHref(created.id));
    revealDetail();
  }

  // The rail is scoped to `activeId`. When the detail's Settings tab moves an
  // assistant into a different workspace (or out of any workspace), drop it
  // from the rail immediately.
  function handleAssistantWorkspaceChanged(
    assistantId: string,
    workspaceId: string | null,
  ) {
    if (workspaceId === activeId) return;
    update((prev) => prev.filter((a) => a.id !== assistantId));
  }

  if (!activeId || assistants === null) {
    // Cold: nothing cached for this workspace yet. A failed first load says
    // so; otherwise the rail skeleton holds the geometry (N4), never a
    // "Loading..." sentence.
    if (loadError) {
      return (
        <div className="text-sm text-muted-foreground border border-border rounded-md p-4">
          {t.studioPage.assistants.loadError}
        </div>
      );
    }
    return <RailSurfaceSkeleton chrome={false} padded={false} />;
  }

  // Selection: requested id if it resolves, else the first assistant.
  const requestedId = searchParams.get("assistant");
  const selectedId =
    assistants.length > 0
      ? (assistants.find((a) => a.id === requestedId)?.id ?? assistants[0].id)
      : null;

  return (
    <>
      {assistants.length === 0 ? (
        <div className="max-w-md border border-border rounded-md p-6 text-center space-y-3">
          <p className="text-sm text-muted-foreground">
            {t.studioPage.assistants.empty}
          </p>
          <button
            type="button"
            onClick={() => setShowCreate(true)}
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md bg-action text-action-foreground hover:bg-action/90 transition-colors"
          >
            <span aria-hidden>+</span>
            {t.studioPage.assistants.newCta}
          </button>
        </div>
      ) : (
        <div className="flex flex-col md:flex-row gap-6">
          <aside
            className={cn(
              "w-full md:w-56 shrink-0 self-start",
              detailOpen && "max-md:hidden",
            )}
          >
            <h2 className="px-1 mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t.studioPage.sections.assistants}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {assistants.map((a) => (
                <li key={a.id}>
                  <Link
                    href={assistantHref(a.id)}
                    onClick={() => setDetailOpen(true)}
                    aria-current={a.id === selectedId ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2 px-2 py-2.5 md:py-1.5 rounded text-sm transition-colors",
                      a.id === selectedId
                        ? "bg-muted font-medium"
                        : "text-muted-foreground hover:text-foreground hover:bg-muted",
                    )}
                  >
                    <AssistantAvatar
                      id={a.id}
                      name={a.name}
                      iconSeed={a.iconSeed ?? undefined}
                      size="sm"
                    />
                    <span className="flex-1 truncate min-w-0">{a.name}</span>
                    {a.clearance && (
                      <SensitivityBadge
                        tier={a.clearance as Sensitivity}
                        size="xs"
                      />
                    )}
                  </Link>
                </li>
              ))}
              <li>
                <button
                  type="button"
                  onClick={() => setShowCreate(true)}
                  className="w-full inline-flex items-center gap-2 px-2 py-1.5 rounded text-sm text-primary hover:bg-muted transition-colors"
                >
                  <span aria-hidden>+</span>
                  <span>{t.studioPage.assistants.newCta}</span>
                </button>
              </li>
            </ul>
          </aside>

          <div
            ref={detailRef}
            className={cn("flex-1 min-w-0", !detailOpen && "max-md:hidden")}
          >
            {selectedId && (
              <>
                <div className="mb-3 md:hidden">
                  <BackButton
                    label={t.studioPage.assistants.backToList}
                    onClick={() => setDetailOpen(false)}
                    className="min-h-8 max-sm:min-h-11"
                  />
                </div>
                <AssistantDetail
                  key={selectedId}
                  id={selectedId}
                  workspaceId={activeId}
                  seed={seedFor(assistants.find((a) => a.id === selectedId))}
                  onWorkspaceChanged={handleAssistantWorkspaceChanged}
                />
              </>
            )}
          </div>
        </div>
      )}

      {showCreate && (
        <CreateAssistantModal
          workspaceId={activeId}
          onClose={() => setShowCreate(false)}
          onCreated={handleCreated}
        />
      )}
    </>
  );
}

function CreateAssistantModal({
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
    if (!trimmed || creating) return;
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
      const created = await createAssistant(workspaceId, trimmed, charter);
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
          className="bg-popover border border-border rounded-2xl shadow-2xl w-full max-w-lg p-4 sm:p-6 space-y-3"
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
          {error && <div className="text-xs text-destructive">{error}</div>}
          <div className="flex gap-2 justify-end pt-2">
            <button
              type="button"
              onClick={onClose}
              className="text-sm font-medium px-4 py-2 rounded-lg border border-border text-muted-foreground hover:bg-muted transition-colors"
            >
              {t.studioPage.assistants.createCancel}
            </button>
            <button
              type="button"
              onClick={() => void submit()}
              disabled={!name.trim() || creating}
              className="text-sm font-medium px-4 py-2 rounded-lg bg-action text-action-foreground hover:bg-action/90 disabled:opacity-50 transition-colors"
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
