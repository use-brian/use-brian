"use client";

/**
 * Slim workspace settings sections for the app-web settings modal.
 *
 * Ported from `apps/web/src/components/settings-modal/workspace-sections.tsx`.
 * Scoped to the *active* workspace from `useWorkspaceContext()`. Only
 * surfaces admin-style general/membership controls — functional config
 * (assistants, knowledge sources, connectors) lives back in `apps/web`
 * Studio; app-web deep-links there rather than reimplementing it.
 *
 * Adaptation note vs apps/web: that app has a workspace *list* context
 * (`useWorkspaces()` + `updateWorkspace()`); app-web only exposes a
 * single active workspace via `useWorkspaceContext()` → { workspaceId,
 * name, role, me }. All displayed workspace fields (name, role, purpose,
 * iconSeed) come straight from the `GET /api/workspaces/:id` detail fetch
 * here, and the icon-regenerate path updates local state via `refetch()`
 * instead of pushing into a switcher list. Because the route context is a
 * static snapshot, a successful rename must also broadcast
 * `emitWorkspaceRenamed` (picked up by `WorkspaceContextProvider` + the
 * switcher's cached list) and patch the ported-surface adapter cache via
 * `updateWorkspace` — otherwise the top-left chrome shows the old name
 * until a full reload.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { authFetch } from "@/lib/auth-fetch";
import {
  getLlmKeyStatus,
  setLlmKey,
  deleteLlmKey,
  LlmKeyUnavailableError,
  type LlmKeyStatus,
} from "@/lib/api/llm-keys";
import {
  setWorkspaceDefaultBlueprint,
  WorkspaceApiError,
} from "@/lib/api/workspaces";
import { listCustomPageTemplates } from "@/lib/api/views";
import { buildBlueprintPickerItems } from "@/lib/blueprints";
import type { CustomPageTemplateSummary } from "@use-brian/doc-model";
import { getUserInfo } from "@/lib/user";
import {
  useWorkspaceContext,
  emitWorkspaceRenamed,
} from "@/lib/workspace-context";
import { updateWorkspace } from "@/contexts/workspace-context";
import { canDeleteWorkspace } from "@/lib/workspace-permissions";
import { TeamAvatar } from "@/components/team-avatar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  SearchableSelect,
  type SearchableSelectItem,
} from "@/components/ui/searchable-select";
import { Button } from "@/components/ui/button";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Sentinel for "ingest only / no default" in the recording-default picker —
 *  threaded to the backend as `null`. */
const BLUEPRINT_INGEST_ONLY = "__ingest_only__";

type Member = {
  userId: string;
  role: "owner" | "admin" | "member";
  email?: string | null;
  userName?: string | null;
};

/** Per-email outcome returned by POST /:workspaceId/invitations. */
type InviteResult = {
  email: string;
  status: "invited" | "already_member" | "invalid";
  /** Accept link — present only for `status: "invited"` (copy-link fallback). */
  link?: string;
};

/** A pending (not accepted, not expired) invitation from GET /:workspaceId/invitations. */
type PendingInvitation = {
  id: string;
  email: string;
  role: "admin" | "member";
  createdAt: string;
  expiresAt: string;
};

type WorkspaceDetail = {
  id: string;
  name: string;
  purpose: string;
  ownerUserId: string;
  /** Auto-created Personal workspace — not user-deletable (the API 404s). */
  isPersonal: boolean;
  role: "owner" | "admin" | "member";
  /** Echoed by the detail endpoint (spread of the full workspace row). */
  iconSeed?: number | null;
  /**
   * The workspace default recording blueprint (migration 291) — a
   * `workspace_page_templates` id carrying an `extraction` spec, or `null` for
   * none (ingest-only). Spread from the full workspace row by the detail route.
   */
  defaultRecordingBlueprintId?: string | null;
  members: Member[];
};

function useWorkspaceDetail(workspaceId: string | null) {
  const [data, setData] = useState<WorkspaceDetail | null>(null);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    if (!workspaceId) {
      setData(null);
      setLoading(false);
      return;
    }
    try {
      const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`);
      if (res.ok) {
        const json = (await res.json()) as WorkspaceDetail;
        setData(json);
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    setLoading(true);
    void refetch();
  }, [refetch]);

  return { data, loading, refetch };
}

// ── ws-general ──────────────────────────────────────────────

export function WorkspaceGeneralSection({ onWorkspaceDeleted }: { onWorkspaceDeleted: () => void }) {
  const t = useT();
  const ctx = useWorkspaceContext();
  const { data, loading, refetch } = useWorkspaceDetail(ctx.workspaceId);

  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [flushOpen, setFlushOpen] = useState(false);
  const [flushResult, setFlushResult] = useState<number | null>(null);
  const [flushError, setFlushError] = useState(false);
  const [editingPurpose, setEditingPurpose] = useState(false);
  const [purposeInput, setPurposeInput] = useState("");
  const [purposeSaving, setPurposeSaving] = useState(false);
  const [purposeError, setPurposeError] = useState("");

  // Recording brief default (migration 291). The chosen value is a blueprint
  // template id, or the ingest-only sentinel. Workspace blueprints are fetched
  // once; the picker lists them after the sentinel.
  const [blueprintId, setBlueprintId] = useState<string>(BLUEPRINT_INGEST_ONLY);
  const [workspaceBlueprints, setWorkspaceBlueprints] = useState<
    CustomPageTemplateSummary[]
  >([]);
  const [blueprintSaving, setBlueprintSaving] = useState(false);
  const [blueprintError, setBlueprintError] = useState("");

  useEffect(() => {
    if (data) {
      setNameInput(data.name);
      setPurposeInput(data.purpose ?? "");
      setBlueprintId(data.defaultRecordingBlueprintId ?? BLUEPRINT_INGEST_ONLY);
    }
  }, [data]);

  const ctxWorkspaceId = ctx.workspaceId;
  useEffect(() => {
    if (!ctxWorkspaceId) return;
    let cancelled = false;
    listCustomPageTemplates(ctxWorkspaceId)
      .then((list) => {
        if (!cancelled) setWorkspaceBlueprints(list);
      })
      .catch(() => {
        // A roster fetch failure degrades to just the ingest-only item.
      });
    return () => {
      cancelled = true;
    };
  }, [ctxWorkspaceId]);

  const blueprintItems = useMemo<SearchableSelectItem[]>(() => {
    const ingestOnly: SearchableSelectItem = {
      value: BLUEPRINT_INGEST_ONLY,
      label: t.recordingDefault.ingestOnly,
    };
    return [ingestOnly, ...buildBlueprintPickerItems(workspaceBlueprints)];
  }, [t, workspaceBlueprints]);

  if (loading || !data) {
    return <div className="text-sm text-muted-foreground">{t.workspaceDetailInline.loading}</div>;
  }

  const isOwner = data.role === "owner";
  const isAdmin = data.role === "admin" || isOwner;

  async function rename() {
    if (!data) return;
    const next = nameInput.trim();
    if (!next || next === data.name) {
      setEditing(false);
      return;
    }
    try {
      const res = await authFetch(`${API_URL}/api/workspaces/${data.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: next }),
      });
      if (res.ok) {
        // Propagate beyond this modal: the route context is a static
        // snapshot, so the top-left chrome (and any other `ctx.name`
        // consumer) only updates via this broadcast; the adapter cache
        // keeps ported `useWorkspaces()` surfaces consistent too.
        emitWorkspaceRenamed({ workspaceId: data.id, name: next });
        updateWorkspace(data.id, { name: next });
        await refetch();
      }
    } finally {
      setEditing(false);
    }
  }

  async function savePurpose() {
    if (!data) return;
    const next = purposeInput.trim();
    if (next === (data.purpose ?? "")) {
      setEditingPurpose(false);
      setPurposeError("");
      return;
    }
    if (next.length < 10 || next.length > 500) {
      setPurposeError(t.workspaceDetailInline.purposeMinHint);
      return;
    }
    setPurposeSaving(true);
    setPurposeError("");
    try {
      const res = await authFetch(`${API_URL}/api/workspaces/${data.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ purpose: next }),
      });
      if (res.ok) {
        await refetch();
        setEditingPurpose(false);
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setPurposeError(err.error ?? t.workspaceDetailInline.purposeSaveFailed);
      }
    } catch {
      setPurposeError(t.workspaceDetailInline.networkError);
    } finally {
      setPurposeSaving(false);
    }
  }

  // Persist the recording brief default. The picker change drives this
  // immediately (no separate save button) — PATCH `{ defaultRecordingBlueprintId }`
  // with the chosen blueprint id, or `null` for the ingest-only sentinel.
  async function changeBlueprint(next: string) {
    if (!data || blueprintSaving) return;
    const value = next || BLUEPRINT_INGEST_ONLY;
    const prev = blueprintId;
    setBlueprintId(value);
    setBlueprintError("");
    if (value === (data.defaultRecordingBlueprintId ?? BLUEPRINT_INGEST_ONLY)) return;
    setBlueprintSaving(true);
    try {
      await setWorkspaceDefaultBlueprint(
        data.id,
        value === BLUEPRINT_INGEST_ONLY ? null : value,
      );
      await refetch();
    } catch (e) {
      // Roll the selection back so the picker doesn't lie about persisted state.
      setBlueprintId(prev);
      setBlueprintError(
        e instanceof WorkspaceApiError ? e.message : t.recordingDefault.saveFailed,
      );
    } finally {
      setBlueprintSaving(false);
    }
  }

  // Admins can reroll the deterministic pixel landmark. The new seed is
  // persisted server-side; we re-fetch the detail so the avatar repaints.
  // (apps/web also pushes the seed into its switcher list — app-web's
  // switcher re-fetches its own list on open, so that path is dropped.)
  async function regenerateIcon() {
    if (!data || regenerating) return;
    setRegenerating(true);
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${data.id}/regenerate-icon`,
        { method: "POST" },
      );
      if (res.ok) await refetch();
    } finally {
      setRegenerating(false);
    }
  }

  async function deleteWorkspace() {
    if (!data) return;
    try {
      const res = await authFetch(`${API_URL}/api/workspaces/${data.id}`, {
        method: "DELETE",
      });
      if (res.ok) onWorkspaceDeleted();
    } catch {
      // ignore
    }
  }

  async function flushWorkspace() {
    if (!data) return;
    setFlushError(false);
    try {
      const res = await authFetch(`${API_URL}/api/workspaces/${data.id}/data`, {
        method: "DELETE",
      });
      if (!res.ok) {
        setFlushError(true);
        return;
      }
      const body = (await res.json()) as { total?: number };
      setFlushResult(body.total ?? 0);
    } catch {
      setFlushError(true);
    } finally {
      setFlushOpen(false);
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t.chrome.settingsModal.workspace.general}</h2>

      <div className="border-t border-border pt-6">
        <div className="flex items-center gap-4">
          {/* Workspace icon — admins click to roll a new pixel landmark. */}
          {isAdmin ? (
            <button
              type="button"
              onClick={regenerateIcon}
              disabled={regenerating}
              title={t.workspaceDetailInline.regenerateIcon}
              aria-label={t.workspaceDetailInline.regenerateIcon}
              className="group relative shrink-0 cursor-pointer rounded-[10px] disabled:opacity-60"
            >
              <TeamAvatar id={data.id} name={data.name} iconSeed={data.iconSeed} size="lg" />
              <span className="absolute inset-0 flex items-center justify-center rounded-[10px] bg-black/40 opacity-0 transition-opacity group-hover:opacity-100">
                <svg
                  width="18"
                  height="18"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="white"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden
                >
                  <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2" />
                </svg>
              </span>
            </button>
          ) : (
            <TeamAvatar id={data.id} name={data.name} iconSeed={data.iconSeed} size="lg" />
          )}

          {/* Name + role */}
          <div className="flex min-w-0 flex-1 items-center gap-2">
            {editing ? (
              <>
                <input
                  type="text"
                  value={nameInput}
                  onChange={(e) => setNameInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && rename()}
                  className="flex-1 text-sm bg-muted/50 border border-border rounded-lg px-3 py-1.5"
                  autoFocus
                  maxLength={100}
                />
                <button onClick={rename} className="text-xs font-medium text-primary hover:underline">
                  {t.workspaceDetailInline.save}
                </button>
                <button
                  onClick={() => {
                    setEditing(false);
                    setNameInput(data.name);
                  }}
                  className="text-xs text-muted-foreground hover:underline"
                >
                  {t.workspaceDetailInline.cancel}
                </button>
              </>
            ) : (
              <>
                <span className="text-sm font-medium truncate">{data.name}</span>
                {isAdmin && (
                  <button
                    onClick={() => setEditing(true)}
                    className="text-xs text-muted-foreground hover:text-foreground shrink-0"
                  >
                    {t.workspaceDetailInline.edit}
                  </button>
                )}
                <span className="text-xs text-muted-foreground bg-muted px-2 py-0.5 rounded-full capitalize ml-auto shrink-0">
                  {data.role}
                </span>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Purpose — drives team-vs-personal memory scoping for this workspace. */}
      <div className="border-t border-border pt-6 space-y-2">
        <div className="flex items-center justify-between gap-2">
          <h3 className="text-sm font-medium">{t.workspaceDetailInline.purposeLabel}</h3>
          {isAdmin && !editingPurpose && (
            <button
              onClick={() => {
                setEditingPurpose(true);
                setPurposeError("");
              }}
              className="text-xs text-muted-foreground hover:text-foreground shrink-0"
            >
              {t.workspaceDetailInline.edit}
            </button>
          )}
        </div>
        <p className="text-[12px] text-muted-foreground">
          {t.workspaceDetailInline.purposeDescription}
        </p>

        {editingPurpose ? (
          <div className="space-y-2 pt-1">
            <textarea
              value={purposeInput}
              onChange={(e) => {
                setPurposeInput(e.target.value);
                setPurposeError("");
              }}
              placeholder={t.workspaceDetailInline.purposePlaceholder}
              rows={4}
              maxLength={500}
              autoFocus
              className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 resize-none outline-none focus:border-primary/60"
            />
            <div className="flex items-center justify-between gap-2">
              <div className="text-[11px] text-muted-foreground">
                {t.workspaceDetailInline.purposeMinHint}
              </div>
              <div className="flex items-center gap-2">
                <button
                  onClick={() => {
                    setEditingPurpose(false);
                    setPurposeInput(data.purpose ?? "");
                    setPurposeError("");
                  }}
                  disabled={purposeSaving}
                  className="text-xs text-muted-foreground hover:underline disabled:opacity-50"
                >
                  {t.workspaceDetailInline.cancel}
                </button>
                <button
                  onClick={savePurpose}
                  disabled={purposeSaving || purposeInput.trim().length < 10}
                  className="text-xs font-medium text-primary hover:underline disabled:opacity-50"
                >
                  {purposeSaving
                    ? t.workspaceDetailInline.purposeSaving
                    : t.workspaceDetailInline.save}
                </button>
              </div>
            </div>
            {purposeError && (
              <div className="text-[12px] text-red-400">{purposeError}</div>
            )}
          </div>
        ) : data.purpose ? (
          <p className="text-[13px] leading-relaxed whitespace-pre-wrap">
            {data.purpose}
          </p>
        ) : (
          <p className="text-[13px] italic text-muted-foreground">
            {t.workspaceDetailInline.purposeEmpty}
          </p>
        )}
      </div>

      {/* Recording brief default (migration 291) — the blueprint every
          recording auto-uses when no blueprint is explicitly picked. Admins
          set it; the picker change persists immediately. */}
      {isAdmin && (
        <div className="border-t border-border pt-6 space-y-2">
          <h3 className="text-sm font-medium">{t.recordingDefault.heading}</h3>
          <p className="text-[12px] text-muted-foreground">
            {t.recordingDefault.description}
          </p>
          <div className="pt-1 max-w-xs">
            <SearchableSelect
              value={blueprintId}
              onValueChange={(v) => void changeBlueprint(v)}
              items={blueprintItems}
              disabled={blueprintSaving}
              aria-label={t.recordingDefault.heading}
              searchPlaceholder={t.recordingDefault.searchPlaceholder}
              popupClassName="w-72"
            />
          </div>
          {blueprintError && (
            <div className="text-[12px] text-red-400">{blueprintError}</div>
          )}
        </div>
      )}

      {isOwner && (
        <div className="border-t border-border pt-6">
          {/* Destructive actions sit behind a collapsed disclosure so the
              landing view stays calm. Expanding it, then a type-to-confirm
              dialog, are the two speed bumps before an irreversible delete. */}
          <button
            type="button"
            onClick={() => setAdvancedOpen((v) => !v)}
            aria-expanded={advancedOpen}
            className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
              className={`transition-transform ${advancedOpen ? "rotate-90" : ""}`}
              aria-hidden
            >
              <path d="M6 4l4 4-4 4" />
            </svg>
            {t.workspaceDetailInline.advanced}
          </button>
          {advancedOpen && (
            <div className="mt-4 space-y-6">
              {/* Flush all workspace data. Works on every workspace including
                  the Personal one (which can never be deleted) — this is its
                  only full-reset path. */}
              <div className="space-y-3">
                <p className="text-[13px] text-muted-foreground">
                  {t.workspaceDetailInline.flushDataDescription}
                </p>
                <button
                  type="button"
                  onClick={() => setFlushOpen(true)}
                  className="text-sm font-medium border border-red-400/30 text-red-400 px-4 py-2 rounded-lg hover:bg-red-400/10 transition-colors"
                >
                  {t.workspaceDetailInline.flushDataTitle}
                </button>
                {flushResult !== null && (
                  <p className="text-[13px] text-muted-foreground">
                    {format(t.workspaceDetailInline.flushDataDone, {
                      count: flushResult,
                    })}
                  </p>
                )}
                {flushError && (
                  <p className="text-[13px] text-red-400">
                    {t.workspaceDetailInline.flushDataFailed}
                  </p>
                )}
              </div>

              {canDeleteWorkspace(data.role, data.isPersonal) ? (
                <div className="space-y-3">
                  <p className="text-[13px] text-muted-foreground">
                    {t.workspaceDetailInline.deleteWorkspaceDescription}
                  </p>
                  <button
                    type="button"
                    onClick={() => setDeleteOpen(true)}
                    className="text-sm font-medium border border-red-400/30 text-red-400 px-4 py-2 rounded-lg hover:bg-red-400/10 transition-colors"
                  >
                    {t.workspaceDetailInline.deleteWorkspace}
                  </button>
                </div>
              ) : (
                <p className="text-[13px] text-muted-foreground">
                  {t.workspaceDetailInline.deleteWorkspacePersonalBlocked}
                </p>
              )}
            </div>
          )}
        </div>
      )}

      <TypeToConfirmDialog
        open={deleteOpen}
        workspaceName={data.name}
        title={t.workspaceDetailInline.deleteWorkspaceDialogTitle}
        description={t.workspaceDetailInline.deleteWorkspaceConfirm}
        confirmLabel={t.workspaceDetailInline.deleteWorkspace}
        onCancel={() => setDeleteOpen(false)}
        onConfirm={deleteWorkspace}
      />
      <TypeToConfirmDialog
        open={flushOpen}
        workspaceName={data.name}
        title={t.workspaceDetailInline.flushDataDialogTitle}
        description={t.workspaceDetailInline.flushDataConfirm}
        confirmLabel={t.workspaceDetailInline.flushDataTitle}
        onCancel={() => setFlushOpen(false)}
        onConfirm={flushWorkspace}
      />
    </div>
  );
}

// Type-to-confirm dialog for the irreversible workspace-level destructive
// actions (delete workspace, flush workspace data). A portaled base-ui
// AlertDialog layered above the settings modal (z-[60]); it deliberately
// won't dismiss on outside-click, so the only ways out are an explicit
// Cancel or a confirm unlocked by typing the exact workspace name.
//
// Kept on base-ui AlertDialog rather than the app-web `confirmDialog`
// primitive: that primitive is a plain yes/no with no text-input affordance,
// and the type-to-confirm gate is load-bearing for these irreversible actions.
function TypeToConfirmDialog({
  open,
  workspaceName,
  title,
  description,
  confirmLabel,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  workspaceName: string;
  title: string;
  description: string;
  confirmLabel: string;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useT();
  const [input, setInput] = useState("");
  const [deleting, setDeleting] = useState(false);

  // Reset the typed value whenever the dialog reopens — "adjusting state
  // during render" per React docs, avoids a setState-in-effect.
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setInput("");
      setDeleting(false);
    }
  }

  const matches = input.trim() === workspaceName.trim();

  async function runDelete() {
    if (!matches || deleting) return;
    setDeleting(true);
    try {
      await onConfirm();
    } finally {
      setDeleting(false);
    }
  }

  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !deleting) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-[60] bg-background/80 backdrop-blur-sm transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl ring-1 ring-foreground/5 transition-all duration-150 data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95">
          <AlertDialog.Title className="text-base font-semibold text-foreground">
            {title}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {description}
          </AlertDialog.Description>
          <p className="mt-4 text-[13px] text-muted-foreground">
            {format(t.workspaceDetailInline.deleteWorkspaceTypePrompt, { name: workspaceName })}
          </p>
          <input
            type="text"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") void runDelete();
            }}
            placeholder={workspaceName}
            autoFocus
            className="mt-2 w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-1.5"
          />
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={deleting} onClick={onCancel}>
              {t.workspaceDetailInline.cancel}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={!matches || deleting}
              onClick={runDelete}
            >
              {confirmLabel}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}

// ── ws-members ──────────────────────────────────────────────

export function WorkspaceMembersSection() {
  const t = useT();
  const ctx = useWorkspaceContext();
  const { data, loading, refetch } = useWorkspaceDetail(ctx.workspaceId);

  // Invite form state.
  const [emails, setEmails] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteMessage, setInviteMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [results, setResults] = useState<InviteResult[] | null>(null);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingInvitation[]>([]);

  const currentUser = getUserInfo();

  // Pending invitations live next to the roster. Fetched on mount + after
  // any invite/resend/revoke so the list stays in sync without a reload.
  const workspaceId = ctx.workspaceId;
  const fetchPending = useCallback(async () => {
    if (!workspaceId) {
      setPending([]);
      return;
    }
    try {
      const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}/invitations`);
      if (res.ok) {
        const json = (await res.json()) as { invitations: PendingInvitation[] };
        setPending(json.invitations ?? []);
      }
    } catch {
      // Non-fatal — the roster still renders without the pending list.
    }
  }, [workspaceId]);

  useEffect(() => {
    void fetchPending();
  }, [fetchPending]);

  if (loading || !data) {
    return <div className="text-sm text-muted-foreground">{t.workspaceDetailInline.loading}</div>;
  }

  const isOwner = data.role === "owner";
  const isAdmin = data.role === "admin" || isOwner;

  async function sendInvites() {
    if (!data) return;
    const list = emails
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (list.length === 0) {
      setInviteError(t.workspaceDetailInline.inviteEmptyError);
      return;
    }
    setSending(true);
    setInviteError("");
    setResults(null);
    try {
      const res = await authFetch(`${API_URL}/api/workspaces/${data.id}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          emails: list,
          role: inviteRole,
          message: inviteMessage.trim() || undefined,
        }),
      });
      if (res.ok) {
        const json = (await res.json()) as { results: InviteResult[] };
        setResults(json.results ?? []);
        setEmails("");
        setInviteMessage("");
        await fetchPending();
        await refetch();
      } else {
        const err = (await res.json().catch(() => ({}))) as { error?: string };
        setInviteError(err.error ?? t.workspaceDetailInline.inviteFailed);
      }
    } catch {
      setInviteError(t.workspaceDetailInline.networkError);
    } finally {
      setSending(false);
    }
  }

  async function resendInvite(email: string, role: "admin" | "member") {
    if (!data) return;
    try {
      const res = await authFetch(`${API_URL}/api/workspaces/${data.id}/invitations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ emails: [email], role }),
      });
      if (res.ok) {
        const json = (await res.json()) as { results: InviteResult[] };
        setResults(json.results ?? []);
        await fetchPending();
      }
    } catch {
      // ignore — absence of a fresh result row is the failure signal
    }
  }

  async function revokeInvite(invitationId: string) {
    if (!data) return;
    try {
      await authFetch(`${API_URL}/api/workspaces/${data.id}/invitations/${invitationId}`, {
        method: "DELETE",
      });
      await fetchPending();
    } catch {
      // ignore
    }
  }

  async function copyLink(link: string) {
    try {
      await navigator.clipboard.writeText(link);
      setCopiedLink(link);
      window.setTimeout(() => setCopiedLink(null), 2000);
    } catch {
      // Clipboard may be unavailable (insecure context) — no-op.
    }
  }

  async function changeRole(userId: string, newRole: "admin" | "member") {
    if (!data) return;
    try {
      await authFetch(`${API_URL}/api/workspaces/${data.id}/members/${userId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ role: newRole }),
      });
      await refetch();
    } catch {
      // ignore
    }
  }

  async function removeMember(userId: string) {
    if (!data) return;
    try {
      await authFetch(`${API_URL}/api/workspaces/${data.id}/members/${userId}`, {
        method: "DELETE",
      });
      await refetch();
    } catch {
      // ignore
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t.chrome.settingsModal.workspace.members}</h2>

      {/* Invite panel — the primary action; the "Invite members" chrome
          button deep-links straight here. */}
      {isAdmin && (
        <div className="border-t border-border pt-6 space-y-3">
          <div>
            <h3 className="text-sm font-medium">{t.workspaceDetailInline.inviteHeading}</h3>
            <p className="text-[12px] text-muted-foreground mt-0.5">
              {format(t.workspaceDetailInline.inviteDescription, { workspace: data.name })}
            </p>
          </div>
          <textarea
            value={emails}
            onChange={(e) => {
              setEmails(e.target.value);
              setInviteError("");
            }}
            placeholder={t.workspaceDetailInline.inviteEmailsPlaceholder}
            rows={2}
            autoFocus
            className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 resize-none outline-none focus:border-primary/60"
          />
          <div className="flex items-center gap-2">
            <Select
              value={inviteRole}
              onValueChange={(v) => setInviteRole((v ?? "member") as "member" | "admin")}
            >
              <SelectTrigger className="bg-muted/50 w-36">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{t.workspaceDetailInline.member}</SelectItem>
                <SelectItem value="admin">{t.workspaceDetailInline.admin}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          <textarea
            value={inviteMessage}
            onChange={(e) => setInviteMessage(e.target.value)}
            placeholder={t.workspaceDetailInline.inviteMessagePlaceholder}
            rows={2}
            maxLength={1000}
            className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 resize-none outline-none focus:border-primary/60"
          />
          <button
            onClick={sendInvites}
            disabled={sending || !emails.trim()}
            className="w-full text-sm font-medium bg-primary text-primary-foreground px-3 py-2 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
          >
            {sending ? t.workspaceDetailInline.sending : t.workspaceDetailInline.sendInvite}
          </button>
          {inviteError && <div className="text-xs text-red-400">{inviteError}</div>}

          {results && results.length > 0 && (
            <div className="space-y-1 pt-1">
              {results.map((r) => (
                <div
                  key={r.email}
                  className="flex items-center justify-between gap-2 text-[12px]"
                >
                  <span className="truncate">{r.email}</span>
                  {r.status === "invited" && r.link ? (
                    <button
                      onClick={() => copyLink(r.link!)}
                      className="shrink-0 text-primary hover:underline"
                    >
                      {copiedLink === r.link
                        ? t.workspaceDetailInline.linkCopied
                        : t.workspaceDetailInline.copyLink}
                    </button>
                  ) : (
                    <span className="shrink-0 text-muted-foreground">
                      {r.status === "already_member"
                        ? t.workspaceDetailInline.statusAlreadyMember
                        : t.workspaceDetailInline.statusInvalid}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Pending invitations */}
      {isAdmin && pending.length > 0 && (
        <div className="border-t border-border pt-6 space-y-3">
          <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
            {format(t.workspaceDetailInline.pendingHeading, { count: pending.length })}
          </h3>
          <div className="space-y-1.5">
            {pending.map((inv) => {
              const days = Math.max(
                0,
                Math.ceil((+new Date(inv.expiresAt) - Date.now()) / 86_400_000),
              );
              return (
                <div
                  key={inv.id}
                  className="flex items-center justify-between py-2 px-3 rounded-lg bg-muted/30"
                >
                  <div className="min-w-0">
                    <div className="text-[13px] font-medium truncate">{inv.email}</div>
                    <div className="text-[11px] text-muted-foreground capitalize">
                      {inv.role} ·{" "}
                      {days <= 0
                        ? t.workspaceDetailInline.expiresToday
                        : format(t.workspaceDetailInline.expiresInDays, { days })}
                    </div>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <button
                      onClick={() => resendInvite(inv.email, inv.role)}
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                    >
                      {t.workspaceDetailInline.resend}
                    </button>
                    <button
                      onClick={() => revokeInvite(inv.id)}
                      className="text-[11px] text-red-400 hover:text-red-300"
                    >
                      {t.workspaceDetailInline.revoke}
                    </button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Current members */}
      <div className="border-t border-border pt-6 space-y-3">
        <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
          {format(t.workspaceDetailInline.membersHeader, { count: data.members.length })}
        </h3>
        <div className="space-y-1.5">
          {data.members.map((m) => (
            <div
              key={m.userId}
              className="flex items-center justify-between py-2 px-3 rounded-lg bg-muted/30"
            >
              <div className="flex items-center gap-2.5 min-w-0">
                <div className="w-7 h-7 rounded-full bg-primary/10 flex items-center justify-center text-[11px] font-bold text-primary shrink-0">
                  {(m.userName ?? m.email ?? "?").charAt(0).toUpperCase()}
                </div>
                <div className="min-w-0">
                  <div className="text-[13px] font-medium truncate">
                    {m.userName ?? m.email ?? "Unknown"}
                    {m.email === currentUser?.email && (
                      <span className="text-muted-foreground ml-1">{t.workspaceDetailInline.you}</span>
                    )}
                  </div>
                  {m.email && m.userName && (
                    <div className="text-[11px] text-muted-foreground truncate">{m.email}</div>
                  )}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-[11px] text-muted-foreground bg-muted px-2 py-0.5 rounded-full capitalize">
                  {m.role}
                </span>
                {isOwner && m.role !== "owner" && (
                  <>
                    <button
                      onClick={() => changeRole(m.userId, m.role === "admin" ? "member" : "admin")}
                      className="text-[11px] text-muted-foreground hover:text-foreground"
                      title={
                        m.role === "admin"
                          ? t.workspaceDetailInline.demoteToMember
                          : t.workspaceDetailInline.promoteToAdmin
                      }
                    >
                      {m.role === "admin"
                        ? t.workspaceDetailInline.demote
                        : t.workspaceDetailInline.promote}
                    </button>
                    <button
                      onClick={() => removeMember(m.userId)}
                      className="text-[11px] text-red-400 hover:text-red-300"
                    >
                      {t.workspaceDetailInline.remove}
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── ws-llm-key ──────────────────────────────────────────────
//
// Bring-your-own Gemini API key for the active workspace. The server only ever
// returns a masked status ({ provider, isSet, last4 }) — the raw key is
// write-only here (PUT to set/replace, DELETE to remove) and never rendered
// back. Owner/admin gated server-side: a 404 (BYO not configured) or 403 (not
// owner/admin) degrades to a disabled "not available" state instead of erroring.

export function WorkspaceLlmKeySection() {
  const t = useT();
  const ctx = useWorkspaceContext();
  const workspaceId = ctx.workspaceId;
  const tk = t.workspaceLlmKey;

  const [status, setStatus] = useState<LlmKeyStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [unavailable, setUnavailable] = useState(false);
  const [keyInput, setKeyInput] = useState("");
  const [saving, setSaving] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [error, setError] = useState("");
  const [confirmOpen, setConfirmOpen] = useState(false);

  const refetch = useCallback(async () => {
    if (!workspaceId) {
      setStatus(null);
      setLoading(false);
      return;
    }
    try {
      const s = await getLlmKeyStatus(workspaceId);
      setStatus(s);
      setUnavailable(false);
    } catch (e) {
      if (e instanceof LlmKeyUnavailableError) {
        setUnavailable(true);
        setStatus(null);
      } else {
        setError(tk.loadFailed);
      }
    } finally {
      setLoading(false);
    }
  }, [workspaceId, tk.loadFailed]);

  useEffect(() => {
    setLoading(true);
    void refetch();
  }, [refetch]);

  async function save() {
    if (!workspaceId) return;
    const next = keyInput.trim();
    if (!next || saving) return;
    setSaving(true);
    setError("");
    try {
      const s = await setLlmKey(workspaceId, next);
      setStatus(s);
      // Write-only: clear the input immediately; never echo the raw key back.
      setKeyInput("");
    } catch (e) {
      if (e instanceof LlmKeyUnavailableError) {
        setUnavailable(true);
      } else {
        setError(e instanceof Error ? e.message : tk.saveFailed);
      }
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!workspaceId || removing) return;
    setRemoving(true);
    setError("");
    try {
      await deleteLlmKey(workspaceId);
      await refetch();
    } catch (e) {
      if (e instanceof LlmKeyUnavailableError) {
        setUnavailable(true);
      } else {
        setError(tk.removeFailed);
      }
    } finally {
      setRemoving(false);
      setConfirmOpen(false);
    }
  }

  return (
    <div className="space-y-6">
      <h2 className="text-lg font-semibold">{t.chrome.settingsModal.workspace.llmKey}</h2>

      <div className="border-t border-border pt-6 space-y-3">
        <div>
          <h3 className="text-sm font-medium">{tk.heading}</h3>
          <p className="text-[12px] text-muted-foreground mt-0.5">{tk.description}</p>
        </div>

        {loading ? (
          <div className="text-sm text-muted-foreground">{t.workspaceDetailInline.loading}</div>
        ) : unavailable ? (
          <div className="rounded-lg bg-muted/30 px-3 py-2 text-[13px] text-muted-foreground">
            {tk.unavailable}
          </div>
        ) : (
          <>
            {/* Current masked status */}
            <div className="rounded-lg bg-muted/30 px-3 py-2 text-[13px]">
              {status?.isSet ? (
                <span className="font-medium">
                  {format(tk.keySet, { last4: status.last4 ?? "????" })}
                </span>
              ) : (
                <span className="text-muted-foreground">{tk.noKeySet}</span>
              )}
            </div>

            {/* Write-only key input + Save */}
            <div className="space-y-2 pt-1">
              <label className="block text-[12px] font-medium text-muted-foreground">
                {status?.isSet ? tk.replaceLabel : tk.setLabel}
              </label>
              <input
                type="password"
                value={keyInput}
                onChange={(e) => {
                  setKeyInput(e.target.value);
                  setError("");
                }}
                onKeyDown={(e) => e.key === "Enter" && save()}
                placeholder={tk.inputPlaceholder}
                autoComplete="off"
                spellCheck={false}
                className="w-full text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 outline-none focus:border-primary/60"
              />
              <div className="flex items-center gap-2">
                <button
                  onClick={save}
                  disabled={saving || !keyInput.trim()}
                  className="text-sm font-medium bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
                >
                  {saving ? t.workspaceDetailInline.purposeSaving : t.workspaceDetailInline.save}
                </button>
                {status?.isSet && (
                  <button
                    onClick={() => setConfirmOpen(true)}
                    disabled={removing}
                    className="text-sm font-medium border border-red-400/30 text-red-400 px-4 py-2 rounded-lg hover:bg-red-400/10 transition-colors disabled:opacity-50"
                  >
                    {tk.remove}
                  </button>
                )}
              </div>
            </div>

            {error && <div className="text-xs text-red-400">{error}</div>}

            <p className="text-[12px] text-muted-foreground pt-1 leading-relaxed">
              {tk.helper}
            </p>
          </>
        )}
      </div>

      <RemoveLlmKeyDialog
        open={confirmOpen}
        removing={removing}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={remove}
      />
    </div>
  );
}

// Confirm dialog for removing the workspace's Gemini key. Portaled base-ui
// AlertDialog layered above the settings modal (z-[60]), mirroring
// DeleteWorkspaceDialog — but a plain yes/no (no type-to-confirm gate, since
// removing the key is reversible).
function RemoveLlmKeyDialog({
  open,
  removing,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  removing: boolean;
  onCancel: () => void;
  onConfirm: () => Promise<void>;
}) {
  const t = useT();
  const tk = t.workspaceLlmKey;
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next && !removing) onCancel();
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop className="fixed inset-0 z-[60] bg-background/80 backdrop-blur-sm transition-opacity duration-150 data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
        <AlertDialog.Popup className="fixed left-1/2 top-1/2 z-[60] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-background p-6 shadow-xl ring-1 ring-foreground/5 transition-all duration-150 data-[starting-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:opacity-0 data-[ending-style]:scale-95">
          <AlertDialog.Title className="text-base font-semibold text-foreground">
            {tk.removeDialogTitle}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-2 text-sm leading-relaxed text-muted-foreground">
            {tk.removeConfirm}
          </AlertDialog.Description>
          <div className="mt-6 flex justify-end gap-2">
            <Button variant="outline" size="sm" disabled={removing} onClick={onCancel}>
              {t.workspaceDetailInline.cancel}
            </Button>
            <Button variant="destructive" size="sm" disabled={removing} onClick={onConfirm}>
              {tk.remove}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
