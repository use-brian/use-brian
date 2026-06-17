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

import { Suspense, useEffect, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams, useParams } from "next/navigation";
import { useT } from "@/lib/i18n/client";
import { useWorkspaces } from "@/contexts/workspace-context";
import {
  listAssistants,
  createAssistant,
  type StudioAssistantSummary,
} from "@/lib/api/studio";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { AssistantDetail } from "@/components/studio/assistant-detail";
import { SensitivityBadge, type Sensitivity } from "@/components/sensitivity-badge";
import { onAssistantsChanged } from "@/lib/sidebar-cache";
import { cn } from "@/lib/utils";

export default function StudioAssistantsPage() {
  return (
    <Suspense fallback={<div className="text-sm text-muted-foreground">…</div>}>
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
  const [assistants, setAssistants] = useState<StudioAssistantSummary[] | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const assistantHref = (id: string) =>
    `/w/${routeWs}/studio/assistants?assistant=${encodeURIComponent(id)}`;

  useEffect(() => {
    if (!activeId) return;
    let cancelled = false;
    void (async () => {
      const list = await listAssistants(activeId);
      if (!cancelled) setAssistants(list);
    })();
    return () => {
      cancelled = true;
    };
  }, [activeId]);

  // Subscribe to sidebar-cache so edits in <AssistantDetail> (rename, icon
  // regenerate, clearance change) flip the rail row immediately. The cache
  // is global; we only merge changes for ids already in our list.
  useEffect(() => {
    return onAssistantsChanged((cached) => {
      setAssistants((prev) => {
        if (!prev) return prev;
        let changed = false;
        const next = prev.map((a) => {
          const c = cached.find((x) => x.id === a.id);
          if (!c) return a;
          const nextName = c.name ?? a.name;
          const nextIconSeed = typeof c.iconSeed === "number" ? c.iconSeed : a.iconSeed;
          const nextClearance = c.clearance ?? a.clearance;
          if (
            nextName === a.name &&
            nextIconSeed === a.iconSeed &&
            nextClearance === a.clearance
          ) return a;
          changed = true;
          return { ...a, name: nextName, iconSeed: nextIconSeed, clearance: nextClearance };
        });
        return changed ? next : prev;
      });
    });
  }, []);

  function handleCreated(created: StudioAssistantSummary) {
    setShowCreate(false);
    // Optimistic insert so the new row renders before the detail's own fetch
    // round-trips; the rail only needs id/name/icon.
    setAssistants((prev) =>
      prev && !prev.some((a) => a.id === created.id) ? [...prev, created] : prev,
    );
    router.push(assistantHref(created.id));
  }

  // The rail is scoped to `activeId`. When the detail's Settings tab moves an
  // assistant into a different workspace (or out of any workspace), drop it
  // from the rail immediately.
  function handleAssistantWorkspaceChanged(
    assistantId: string,
    workspaceId: string | null,
  ) {
    if (workspaceId === activeId) return;
    setAssistants((prev) =>
      prev ? prev.filter((a) => a.id !== assistantId) : prev,
    );
  }

  if (!activeId || assistants === null) {
    return <div className="text-sm text-muted-foreground">…</div>;
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
            className="inline-flex items-center gap-1.5 text-sm font-medium px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:bg-primary/90 transition-colors"
          >
            <span aria-hidden>+</span>
            {t.studioPage.assistants.newCta}
          </button>
        </div>
      ) : (
        <div className="flex flex-col md:flex-row gap-6">
          <aside className="w-full md:w-56 shrink-0 self-start">
            <h2 className="px-1 mb-2 text-xs font-medium uppercase tracking-wider text-muted-foreground">
              {t.studioPage.sections.assistants}
            </h2>
            <ul className="flex flex-col gap-0.5">
              {assistants.map((a) => (
                <li key={a.id}>
                  <Link
                    href={assistantHref(a.id)}
                    aria-current={a.id === selectedId ? "page" : undefined}
                    className={cn(
                      "flex items-center gap-2 px-2 py-1.5 rounded text-sm transition-colors",
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

          <div className="flex-1 min-w-0">
            {selectedId && (
              <AssistantDetail
                key={selectedId}
                id={selectedId}
                onWorkspaceChanged={handleAssistantWorkspaceChanged}
              />
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
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState("");

  async function submit() {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    setError("");
    try {
      const created = await createAssistant(workspaceId, trimmed);
      onCreated(created);
    } catch (e) {
      setError(e instanceof Error ? e.message : t.studioPage.assistants.createError);
      setCreating(false);
    }
  }

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/40" onClick={onClose} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
        <div
          className="bg-popover border border-border rounded-2xl shadow-2xl w-full max-w-sm p-6 space-y-4"
          onClick={(e) => e.stopPropagation()}
        >
          <h3 className="text-base font-semibold">
            {t.studioPage.assistants.createTitle}
          </h3>
          <input
            type="text"
            value={name}
            autoFocus
            maxLength={100}
            onChange={(e) => {
              setName(e.target.value);
              setError("");
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") void submit();
            }}
            placeholder={t.studioPage.assistants.createPlaceholder}
            className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2.5 focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
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
              className="text-sm font-medium px-4 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors"
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
