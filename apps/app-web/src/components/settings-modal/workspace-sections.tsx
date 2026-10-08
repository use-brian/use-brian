"use client";


import { publicRuntimeConfig } from "@/lib/runtime-public-config";
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
 * iconSeed, iconUrl) come straight from the `GET /api/workspaces/:id` detail fetch
 * here, and the icon-regenerate path updates local state via `refetch()`
 * instead of pushing into a switcher list. Because the route context is a
 * static snapshot, a successful rename must also broadcast
 * `emitWorkspaceRenamed` (picked up by `WorkspaceContextProvider` + the
 * switcher's cached list) and patch the ported-surface adapter cache via
 * `updateWorkspace` — otherwise the top-left chrome shows the old name
 * until a full reload.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ReactNode,
} from "react";
import { authFetch } from "@/lib/auth-fetch";
import {
  setWorkspaceDefaultBlueprint,
  setWorkspaceInboxRetention,
  setWorkspaceTranscriptionScript,
  transferWorkspaceOwnership,
  uploadWorkspaceIcon,
  removeWorkspaceIcon,
  MAX_WORKSPACE_ICON_BYTES,
  WorkspaceApiError,
  type ChineseScriptPref,
} from "@/lib/api/workspaces";
import { listCustomPageTemplates } from "@/lib/api/views";
import { buildBlueprintPickerItems } from "@/lib/blueprints";
import type { CustomPageTemplateSummary } from "@use-brian/doc-model";
import { getUserInfo } from "@/lib/user";
import { isPhoneViewport } from "@/lib/viewport";
import {
  useWorkspaceContext,
  emitWorkspaceIconChanged,
  emitWorkspaceRenamed,
} from "@/lib/workspace-context";
import { updateWorkspace } from "@/contexts/workspace-context";
import { readSurfaceCache, useCachedResource, SurfaceCacheEvictionError } from "@/lib/surface-cache";
import { openWorkspaceSettings,type SettingsMemberTarget } from '@/lib/workspace-settings-events';
import { workspaceDetailCacheKey } from "@/lib/surface-prefetch";
import { Skeleton } from "@/components/skeleton";
import { canDeleteWorkspace } from "@/lib/workspace-permissions";
import { TeamAvatar } from "@/components/team-avatar";
import { InternalLinkControl } from "@/components/internal-link-control";
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
import { confirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { ArrowLeft, ChevronRight, Crown, MoreHorizontal, Search, ShieldCheck, UserPlus, UserRound, X } from "lucide-react";
import { Chip, OrgAvatar } from "@/components/organization/org-visuals";
import { Dialog } from "@base-ui/react/dialog";
import { AlertDialog } from "@base-ui/react/alert-dialog";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/** Sentinel for "ingest only / no default" in the recording-default picker —
 *  threaded to the backend as `null`. */
const BLUEPRINT_INGEST_ONLY = "__ingest_only__";

/** Sentinel for "Auto (provider default)" in the transcript Chinese-script
 *  picker — threaded to the backend as `null` (clears the preference). */
const SCRIPT_AUTO = "__auto__";

// Inbox retention (migration 426). Presets rather than a free-form number: the
// setting answers "how long should this nag me", which nobody has a 47-day
// opinion about. `__never__` maps to a null window (never prune).
const RETENTION_NEVER = "__never__";
const RETENTION_PRESETS = [7, 30, 90, 365] as const;
// Mirrors DEFAULT_INBOX_RETENTION_DAYS in `packages/core/src/doc/inbox-types.ts`
// (re-declared, not imported — the core barrel pulls in fs-using modules that
// break the browser bundle, same constraint as the inbox SDK's wire types).
// Only used to pre-select the picker; the server is authoritative.
const DEFAULT_INBOX_RETENTION_DAYS = 30;

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
  /**
   * Whether the invitation email left the server — present only for
   * `status: "invited"`. `failed` / `not_configured` mean the link above is
   * the only way the invitee will get in, so the row says so.
   */
  emailStatus?: "sent" | "failed" | "not_configured";
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
  role: "owner" | "admin" | "member";
  /** Echoed by the detail endpoint (spread of the full workspace row). */
  iconSeed?: number | null;
  /** Versioned public proxy URL for an uploaded workspace picture. */
  iconUrl?: string | null;
  /**
   * The workspace default recording blueprint (migration 291) — a
   * `workspace_page_templates` id carrying an `extraction` spec, or `null` for
   * none (ingest-only). Spread from the full workspace row by the detail route.
   */
  defaultRecordingBlueprintId?: string | null;
  /**
   * Workspace transcription preferences (migration 332), spread from the
   * workspace row by the detail route. Only `chineseScript` is surfaced in
   * the UI; the language hint stays assistant-only.
   */
  transcriptionPrefs?: { chineseScript?: "traditional" | "simplified" };
  /**
   * Doc Inbox retention window in days (migration 426), or `null` to never
   * prune. Spread from the workspace row by the detail route.
   */
  inboxRetentionDays?: number | null;
  members: Member[];
};

/**
 * The workspace detail row (`GET /api/workspaces/:id`) both sections read,
 * served from the surface cache (instant-navigation contract N1): reopening
 * Settings paints the name and the roster on the first frame and revalidates
 * behind it, and General + Members share ONE slot
 * (`workspaceDetailCacheKey`), so a role change made in one is what the
 * other paints next. `workspace_config` marks the slot stale through the
 * spine map. `refetch` resolves once the fresh row is in the cache (callers
 * await it after a mutation). A failed revalidation keeps the row on screen:
 * the fetcher returns the previous value instead of rejecting, so a stale
 * entry never re-runs against a broken endpoint. A cold failure reports
 * `data: null` with `loading` false, and the next mount retries once.
 *
 * Private to this module: its test drives it through `WorkspaceMembersSection`
 * rather than reaching the hook directly, so there is nothing to export.
 */
function useWorkspaceDetail(workspaceId: string | null) {
  const key = workspaceId ? workspaceDetailCacheKey(workspaceId) : null;
  const entry = useCachedResource<WorkspaceDetail>(key, async () => {
    const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`);
    if (res.ok) return (await res.json()) as WorkspaceDetail;
    if([401,403,404].includes(res.status))throw new SurfaceCacheEvictionError(new Error('workspace_unavailable'));
    const previous = key ? readSurfaceCache<WorkspaceDetail>(key).data : undefined;
    if (previous !== undefined) return previous;
    throw new Error(`HTTP ${res.status}`);
  });
  const { refresh } = entry;
  const coldFailure = entry.data === undefined && entry.error !== undefined;
  useEffect(() => {
    // A section reopened after a failed cold load retries once; the hook
    // itself never retries a cold failure (a mounted surface must not hammer
    // a broken endpoint).
    if (key && coldFailure) void refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const refetch = useCallback(async () => {
    await refresh();
  }, [refresh]);

  return {
    data: entry.data ?? null,
    loading: key !== null && entry.loading,
    refetch,
  };
}

/**
 * Geometry-matched frame for the General / Members sections while the detail
 * row is cold: the identity row (icon + name + role), then roster rows. Never
 * a "Loading..." sentence (N4).
 */
function WorkspaceSectionSkeleton() {
  return (
    <div className="space-y-6 animate-fade-in" aria-busy="true" aria-hidden="true">
      <div className="flex items-center gap-4">
        <Skeleton className="size-14 shrink-0 rounded-xl" />
        <div className="flex-1 space-y-2">
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-3 w-1/3" />
        </div>
      </div>
      <div className="space-y-1.5">
        {Array.from({ length: 3 }).map((_, i) => (
          <div key={i} className="flex items-center gap-2.5 rounded-lg bg-muted/30 px-3 py-2">
            <Skeleton className="size-7 shrink-0 rounded-full" />
            <Skeleton className="h-3.5" style={{ width: `${40 + ((i * 17) % 30)}%` }} />
            <Skeleton className="ml-auto h-5 w-14 rounded-full" />
          </div>
        ))}
      </div>
    </div>
  );
}

// ── ws-general ──────────────────────────────────────────────

export function WorkspaceGeneralSection({ onWorkspaceDeleted }: { onWorkspaceDeleted: () => void }) {
  const t = useT();
  const ctx = useWorkspaceContext();
  const { data, loading, refetch } = useWorkspaceDetail(ctx.workspaceId);

  const [editing, setEditing] = useState(false);
  const [nameInput, setNameInput] = useState("");
  const [regenerating, setRegenerating] = useState(false);
  const [uploadingIcon, setUploadingIcon] = useState(false);
  const [removingIcon, setRemovingIcon] = useState(false);
  const [iconStatus, setIconStatus] = useState<
    { kind: "success" | "error"; text: string } | null
  >(null);
  const iconInputRef = useRef<HTMLInputElement>(null);
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [flushOpen, setFlushOpen] = useState(false);
  const [flushResult, setFlushResult] = useState<number | null>(null);
  const [flushError, setFlushError] = useState(false);
  const [transferTarget, setTransferTarget] = useState("");
  const [transferOpen, setTransferOpen] = useState(false);
  const [transferDone, setTransferDone] = useState(false);
  const [transferError, setTransferError] = useState<string | null>(null);
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

  // Transcript Chinese-script preference (migration 332). The picker value is
  // the script, or the Auto sentinel for "no preference" (provider default).
  const [scriptPref, setScriptPref] = useState<string>(SCRIPT_AUTO);
  const [scriptSaving, setScriptSaving] = useState(false);
  const [scriptError, setScriptError] = useState("");

  // Inbox retention window (migration 426). The picker value is the day count
  // as a string, or the Never sentinel.
  const [retention, setRetention] = useState<string>(String(DEFAULT_INBOX_RETENTION_DAYS));
  const [retentionSaving, setRetentionSaving] = useState(false);
  const [retentionError, setRetentionError] = useState("");

  useEffect(() => {
    if (data) {
      setNameInput(data.name);
      setPurposeInput(data.purpose ?? "");
      setBlueprintId(data.defaultRecordingBlueprintId ?? BLUEPRINT_INGEST_ONLY);
      setScriptPref(data.transcriptionPrefs?.chineseScript ?? SCRIPT_AUTO);
      // `undefined` (an older API that doesn't send the field) falls back to
      // the default rather than to Never, so the picker matches what the
      // server would actually do. Only an explicit `null` means Never.
      setRetention(
        data.inboxRetentionDays === null
          ? RETENTION_NEVER
          : String(data.inboxRetentionDays ?? DEFAULT_INBOX_RETENTION_DAYS),
      );
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

  if (!data) {
    // Cold slot: the section's frame while the row loads; a plain error line
    // only once the load has ended with nothing (the next open retries).
    return loading ? (
      <WorkspaceSectionSkeleton />
    ) : (
      <div className="text-sm text-destructive">{t.workspaceDetailInline.networkError}</div>
    );
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

  // Persist the transcript Chinese-script preference. Same immediate-persist
  // pattern as the blueprint picker; the Auto sentinel clears to `null`.
  async function changeScriptPref(next: string) {
    if (!data || scriptSaving) return;
    const value = next || SCRIPT_AUTO;
    const prev = scriptPref;
    setScriptPref(value);
    setScriptError("");
    if (value === (data.transcriptionPrefs?.chineseScript ?? SCRIPT_AUTO)) return;
    setScriptSaving(true);
    try {
      await setWorkspaceTranscriptionScript(
        data.id,
        value === SCRIPT_AUTO ? null : (value as ChineseScriptPref),
      );
      await refetch();
    } catch (e) {
      // Roll the selection back so the picker doesn't lie about persisted state.
      setScriptPref(prev);
      setScriptError(
        e instanceof WorkspaceApiError ? e.message : t.transcriptionScript.saveFailed,
      );
    } finally {
      setScriptSaving(false);
    }
  }

  // Persist the Inbox retention window. Same immediate-persist + roll-back
  // pattern as the pickers above; the Never sentinel clears to `null`.
  async function changeRetention(next: string) {
    if (!data || retentionSaving) return;
    const value = next || String(DEFAULT_INBOX_RETENTION_DAYS);
    const prev = retention;
    setRetention(value);
    setRetentionError("");
    const current =
      data.inboxRetentionDays === null
        ? RETENTION_NEVER
        : String(data.inboxRetentionDays ?? DEFAULT_INBOX_RETENTION_DAYS);
    if (value === current) return;
    setRetentionSaving(true);
    try {
      await setWorkspaceInboxRetention(
        data.id,
        value === RETENTION_NEVER ? null : Number(value),
      );
      await refetch();
    } catch (e) {
      // Roll the selection back so the picker doesn't lie about persisted state.
      setRetention(prev);
      setRetentionError(
        e instanceof WorkspaceApiError ? e.message : t.inboxRetention.saveFailed,
      );
    } finally {
      setRetentionSaving(false);
    }
  }

  async function pickWorkspaceIcon(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = "";
    if (!data || !file) return;
    if (file.size > MAX_WORKSPACE_ICON_BYTES) {
      setIconStatus({
        kind: "error",
        text: t.workspaceDetailInline.iconTooLarge,
      });
      return;
    }
    if (
      ![
        "image/png",
        "image/jpeg",
        "image/webp",
        "image/gif",
        "image/avif",
      ].includes(file.type.toLowerCase())
    ) {
      setIconStatus({
        kind: "error",
        text: t.workspaceDetailInline.iconUnsupported,
      });
      return;
    }

    setUploadingIcon(true);
    setIconStatus(null);
    try {
      const updated = await uploadWorkspaceIcon(data.id, file);
      const detail = {
        workspaceId: data.id,
        iconSeed: data.iconSeed ?? null,
        iconUrl: updated.iconUrl,
      };
      emitWorkspaceIconChanged(detail);
      updateWorkspace(data.id, {
        iconSeed: detail.iconSeed,
        iconUrl: detail.iconUrl,
      });
      await refetch();
      setIconStatus({
        kind: "success",
        text: t.workspaceDetailInline.iconUpdated,
      });
    } catch {
      setIconStatus({
        kind: "error",
        text: t.workspaceDetailInline.iconUpdateFailed,
      });
    } finally {
      setUploadingIcon(false);
    }
  }

  async function removeCustomIcon() {
    if (!data || removingIcon) return;
    const ok = await confirmDialog({
      title: t.workspaceDetailInline.removeIconTitle,
      description: t.workspaceDetailInline.removeIconConfirm,
      confirmLabel: t.workspaceDetailInline.removeIcon,
      cancelLabel: t.workspaceDetailInline.cancel,
      variant: "destructive",
    });
    if (!ok) return;

    setRemovingIcon(true);
    setIconStatus(null);
    try {
      await removeWorkspaceIcon(data.id);
      const detail = {
        workspaceId: data.id,
        iconSeed: data.iconSeed ?? null,
        iconUrl: null,
      };
      emitWorkspaceIconChanged(detail);
      updateWorkspace(data.id, {
        iconSeed: detail.iconSeed,
        iconUrl: null,
      });
      await refetch();
      setIconStatus({
        kind: "success",
        text: t.workspaceDetailInline.iconRemoved,
      });
    } catch {
      setIconStatus({
        kind: "error",
        text: t.workspaceDetailInline.iconRemoveFailed,
      });
    } finally {
      setRemovingIcon(false);
    }
  }

  // Admins can reroll the deterministic pixel landmark while it is visible.
  async function regenerateIcon() {
    if (!data || regenerating) return;
    setRegenerating(true);
    setIconStatus(null);
    try {
      const res = await authFetch(
        `${API_URL}/api/workspaces/${data.id}/regenerate-icon`,
        { method: "POST" },
      );
      if (!res.ok) throw new Error("regenerate_failed");
      const body = (await res.json()) as { iconSeed?: number };
      const nextSeed = body.iconSeed ?? data.iconSeed ?? null;
      const detail = {
        workspaceId: data.id,
        iconSeed: nextSeed,
        iconUrl: data.iconUrl ?? null,
      };
      emitWorkspaceIconChanged(detail);
      updateWorkspace(data.id, {
        iconSeed: nextSeed,
        iconUrl: detail.iconUrl,
      });
      await refetch();
      setIconStatus({
        kind: "success",
        text: t.workspaceDetailInline.iconGenerated,
      });
    } catch {
      setIconStatus({
        kind: "error",
        text: t.workspaceDetailInline.iconGenerateFailed,
      });
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

  // Transfer ownership to another member (owner-only; the server re-checks
  // inside the store transaction). On success the acting user is demoted to
  // admin, so the refetch collapses this whole owner-only Advanced area.
  async function transferOwnership() {
    if (!data || !transferTarget) return;
    setTransferError(null);
    try {
      await transferWorkspaceOwnership(data.id, transferTarget, API_URL);
      setTransferDone(true);
      setTransferTarget("");
      await refetch();
    } catch (err) {
      setTransferError(transferErrorText(err, t));
    } finally {
      setTransferOpen(false);
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
        <div className="flex items-start gap-4">
          <TeamAvatar
            id={data.id}
            name={data.name}
            iconSeed={data.iconSeed}
            iconUrl={data.iconUrl}
            size="lg"
          />

          <div className="min-w-0 flex-1 space-y-2">
            {/* Name + role */}
            <div className="flex min-w-0 items-center gap-2">
              {editing ? (
                <>
                  <input
                    type="text"
                    value={nameInput}
                    onChange={(e) => setNameInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && rename()}
                    className="flex-1 text-[16px] md:text-sm bg-muted/50 border border-border rounded-lg px-3 py-1.5"
                    autoFocus={!isPhoneViewport()}
                    maxLength={100}
                  />
                  <button onClick={rename} className="max-sm:min-h-11 max-sm:px-2 text-xs font-medium text-primary hover:underline">
                    {t.workspaceDetailInline.save}
                  </button>
                  <button
                    onClick={() => {
                      setEditing(false);
                      setNameInput(data.name);
                    }}
                    className="max-sm:min-h-11 max-sm:px-2 text-xs text-muted-foreground hover:underline"
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

            {isAdmin && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                <input
                  ref={iconInputRef}
                  type="file"
                  accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
                  className="hidden"
                  onChange={pickWorkspaceIcon}
                />
                <button
                  type="button"
                  onClick={() => iconInputRef.current?.click()}
                  disabled={uploadingIcon || removingIcon || regenerating}
                  className="text-[12px] text-primary hover:underline disabled:opacity-50"
                >
                  {uploadingIcon
                    ? t.workspaceDetailInline.iconUploading
                    : t.workspaceDetailInline.uploadIcon}
                </button>
                {data.iconUrl ? (
                  <button
                    type="button"
                    onClick={removeCustomIcon}
                    disabled={uploadingIcon || removingIcon || regenerating}
                    className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {removingIcon
                      ? t.workspaceDetailInline.iconRemoving
                      : t.workspaceDetailInline.removeIcon}
                  </button>
                ) : (
                  <button
                    type="button"
                    onClick={regenerateIcon}
                    disabled={uploadingIcon || removingIcon || regenerating}
                    className="text-[12px] text-muted-foreground hover:text-foreground disabled:opacity-50"
                  >
                    {regenerating
                      ? t.workspaceDetailInline.iconGenerating
                      : t.workspaceDetailInline.regenerateIcon}
                  </button>
                )}
              </div>
            )}

            {iconStatus && (
              <p
                className={
                  iconStatus.kind === "success"
                    ? "text-[12px] text-primary"
                    : "text-[12px] text-red-400"
                }
              >
                {iconStatus.text}
              </p>
            )}
          </div>
        </div>
      </div>

      <div className="border-t border-border pt-6">
        <InternalLinkControl
          workspaceId={data.id}
          canManage={isAdmin}
          showCopy
        />
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
              className="max-sm:min-h-11 max-sm:px-2 text-xs text-muted-foreground hover:text-foreground shrink-0"
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
              autoFocus={!isPhoneViewport()}
              className="w-full text-[16px] md:text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 resize-none outline-none"
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
                  className="max-sm:min-h-11 max-sm:px-2 text-xs text-muted-foreground hover:underline disabled:opacity-50"
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

      {/* Transcript Chinese-script preference (migration 332) — how Chinese is
          written in future recording transcripts. Admins set it; the picker
          change persists immediately. Auto = provider default (no conversion). */}
      {isAdmin && (
        <div className="border-t border-border pt-6 space-y-2">
          <h3 className="text-sm font-medium">{t.transcriptionScript.heading}</h3>
          <p className="text-[12px] text-muted-foreground">
            {t.transcriptionScript.description}
          </p>
          <div className="pt-1">
            <Select
              value={scriptPref}
              items={[
                { value: SCRIPT_AUTO, label: t.transcriptionScript.auto },
                { value: "traditional", label: t.transcriptionScript.traditional },
                { value: "simplified", label: t.transcriptionScript.simplified },
              ]}
              onValueChange={(v) => void changeScriptPref(v ?? SCRIPT_AUTO)}
              disabled={scriptSaving}
            >
              <SelectTrigger
                className="bg-muted/50 w-56"
                aria-label={t.transcriptionScript.heading}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SCRIPT_AUTO}>{t.transcriptionScript.auto}</SelectItem>
                <SelectItem value="traditional">{t.transcriptionScript.traditional}</SelectItem>
                <SelectItem value="simplified">{t.transcriptionScript.simplified}</SelectItem>
              </SelectContent>
            </Select>
          </div>
          {scriptError && (
            <div className="text-[12px] text-red-400">{scriptError}</div>
          )}
        </div>
      )}

      {/* Inbox retention (migration 426) — how long an item keeps asking for
          attention before it ages out. A read-time filter, so widening it
          brings older items back; nothing is deleted either way. */}
      {isAdmin && (
        <div className="border-t border-border pt-6 space-y-2">
          <h3 className="text-sm font-medium">{t.inboxRetention.heading}</h3>
          <p className="text-[12px] text-muted-foreground">
            {t.inboxRetention.description}
          </p>
          <div className="pt-1">
            <Select
              value={retention}
              items={[
                ...RETENTION_PRESETS.map((days) => ({
                  value: String(days),
                  label: t.inboxRetention.days.replace("{count}", String(days)),
                })),
                { value: RETENTION_NEVER, label: t.inboxRetention.never },
              ]}
              onValueChange={(v) =>
                void changeRetention(v ?? String(DEFAULT_INBOX_RETENTION_DAYS))
              }
              disabled={retentionSaving}
            >
              <SelectTrigger
                className="bg-muted/50 w-56"
                aria-label={t.inboxRetention.heading}
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {RETENTION_PRESETS.map((days) => (
                  <SelectItem key={days} value={String(days)}>
                    {t.inboxRetention.days.replace("{count}", String(days))}
                  </SelectItem>
                ))}
                <SelectItem value={RETENTION_NEVER}>
                  {t.inboxRetention.never}
                </SelectItem>
              </SelectContent>
            </Select>
          </div>
          {retentionError && (
            <div className="text-[12px] text-red-400">{retentionError}</div>
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
              {/* Transfer ownership (workspaces.md → "Ownership transfer").
                  Owner-only, and only meaningful with another
                  member to hand the workspace to. Consequential rather than
                  destructive, but it still goes through the type-to-confirm
                  gate: it moves billing responsibility and cannot be undone
                  by the acting user. */}
              {(
                  <div className="space-y-3">
                    <p className="text-[13px] text-muted-foreground">
                      {t.workspaceDetailInline.transferOwnershipDescription}
                    </p>
                    {!data.members.some((m) => m.userId !== data.ownerUserId) && (
                      <p className="text-[13px] text-muted-foreground">
                        {t.workspaceDetailInline.transferOwnershipNeedsMember}
                      </p>
                    )}
                    {/* Wraps at 390px (responsive contract M8): the Select
                        and the button stack instead of squeezing. */}
                    <div className="flex flex-wrap items-center gap-2">
                      <Select
                        value={transferTarget}
                        items={data.members
                          .filter((m) => m.userId !== data.ownerUserId)
                          .map((m) => ({
                            value: m.userId,
                            label: m.userName ?? m.email ?? m.userId,
                          }))}
                        onValueChange={(v) => {
                          setTransferTarget(v ?? "");
                          setTransferError(null);
                          setTransferDone(false);
                        }}
                      >
                        <SelectTrigger className="bg-muted/50 w-56">
                          <SelectValue
                            placeholder={t.workspaceDetailInline.transferOwnershipSelect}
                          />
                        </SelectTrigger>
                        <SelectContent>
                          {data.members
                            .filter((m) => m.userId !== data.ownerUserId)
                            .map((m) => (
                              <SelectItem key={m.userId} value={m.userId}>
                                {m.userName ?? m.email ?? m.userId}
                              </SelectItem>
                            ))}
                        </SelectContent>
                      </Select>
                      <button
                        type="button"
                        onClick={() => setTransferOpen(true)}
                        disabled={!transferTarget}
                        className="text-sm font-medium border border-border px-4 py-2 rounded-lg hover:bg-muted transition-colors disabled:opacity-50"
                      >
                        {t.workspaceDetailInline.transferOwnershipTitle}
                      </button>
                    </div>
                    {transferDone && (
                      <p className="text-[13px] text-muted-foreground">
                        {t.workspaceDetailInline.transferOwnershipDone}
                      </p>
                    )}
                    {transferError && (
                      <p className="text-[13px] text-red-400">{transferError}</p>
                    )}
                  </div>
                )}

              {/* Reset content while keeping the workspace and its settings. */}
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

              {canDeleteWorkspace(data.role) && (
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
      <TypeToConfirmDialog
        open={transferOpen}
        workspaceName={data.name}
        title={t.workspaceDetailInline.transferOwnershipDialogTitle}
        description={format(t.workspaceDetailInline.transferOwnershipConfirm, {
          name:
            data.members.find((m) => m.userId === transferTarget)?.userName ??
            data.members.find((m) => m.userId === transferTarget)?.email ??
            "",
        })}
        confirmLabel={t.workspaceDetailInline.transferOwnershipTitle}
        onCancel={() => setTransferOpen(false)}
        onConfirm={transferOwnership}
      />
    </div>
  );
}

// The readable line for a failed ownership transfer: the server's own
// message when it sent one (the Free-plan recipient cap is a real outcome the
// owner has to read), the generic failure otherwise, and the network line when
// the request never got an answer.
function transferErrorText(err: unknown, t: ReturnType<typeof useT>): string {
  if (err instanceof WorkspaceApiError) {
    return err.message || t.workspaceDetailInline.transferOwnershipFailed;
  }
  return t.workspaceDetailInline.networkError;
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
            autoFocus={!isPhoneViewport()}
            className="mt-2 w-full text-[16px] md:text-sm bg-muted/50 border border-border rounded-lg px-3 py-1.5"
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

export function WorkspaceMembersSection({memberTarget,clearMember,selectMember,managementEnabled=true,renderMemberAccess}:{renderMemberAccess?:(member:Member)=>ReactNode;memberTarget?:SettingsMemberTarget;clearMember?:()=>void;selectMember?:(memberId:string)=>void;managementEnabled?:boolean}={}) {
  const t = useT();
  const ctx = useWorkspaceContext();
  const { data, loading, refetch } = useWorkspaceDetail(ctx.workspaceId);

  const directory = Boolean(selectMember && renderMemberAccess);
  const [search, setSearch] = useState("");
  const [roleFilter, setRoleFilter] = useState("all");
  const [inviteOpen, setInviteOpen] = useState(false);
  const detailHeadingRef = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    if (directory && memberTarget && isPhoneViewport()) detailHeadingRef.current?.focus();
  }, [directory, memberTarget?.memberId, loading]);
  useEffect(() => { setInviteOpen(false); }, [memberTarget?.memberId]);
  // Invite form state.
  const [emails, setEmails] = useState("");
  const [inviteRole, setInviteRole] = useState<"member" | "admin">("member");
  const [inviteMessage, setInviteMessage] = useState("");
  const [sending, setSending] = useState(false);
  const [inviteError, setInviteError] = useState("");
  const [results, setResults] = useState<InviteResult[] | null>(null);
  const [copiedLink, setCopiedLink] = useState<string | null>(null);
  const [pending, setPending] = useState<PendingInvitation[]>([]);
  // Ownership transfer from a member row's menu (same route and confirm gate
  // as General -> Advanced; workspaces.md -> "Ownership transfer").
  const [transferTarget, setTransferTarget] = useState<string | null>(null);
  const [transferError, setTransferError] = useState<string | null>(null);

  const currentUser = getUserInfo();

  // Pending invitations live next to the roster. Fetched on mount + after
  // any invite/resend/revoke so the list stays in sync without a reload.
  const workspaceId = ctx.workspaceId;
  const canLoadInvitations = managementEnabled && (!memberTarget || directory) && (data?.role === "owner" || data?.role === "admin");
  const fetchPending = useCallback(async () => {
    if (!workspaceId || !canLoadInvitations) {
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
  }, [workspaceId, canLoadInvitations]);

  useEffect(() => {
    void fetchPending();
  }, [fetchPending]);

  if (!data) {
    // Cold slot: the section's frame while the row loads; a plain error line
    // only once the load has ended with nothing (the next open retries).
    return loading ? (
      <WorkspaceSectionSkeleton />
    ) : (
      <div className="text-sm text-destructive">{t.workspaceDetailInline.networkError}</div>
    );
  }

  const isOwner = data.role === "owner";
  const isAdmin = data.role === "admin" || isOwner;
  const shownMembers=memberTarget && !directory
    ? memberTarget.workspaceId===ctx.workspaceId?data.members.filter(m=>m.userId===memberTarget.memberId):[]
    : data.members.filter(m => (!search.trim() || `${m.userName ?? ""} ${m.email ?? ""}`.toLocaleLowerCase().includes(search.trim().toLocaleLowerCase())) && (roleFilter === "all" || m.role === roleFilter));
  const selectedMember = memberTarget?.workspaceId === ctx.workspaceId ? data.members.find(m => m.userId === memberTarget.memberId) : undefined;

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
    setInviteOpen(true);
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

  async function revokeInvite(invitationId: string, email: string) {
    if (!data) return;
    // A 44px Revoke beside Resend is one mis-tap from a destructive write on a
    // phone; the teamspace modal already confirms the same action.
    const ok = await confirmDialog({
      title: t.workspaceDetailInline.revokeInviteConfirmTitle,
      description: format(t.workspaceDetailInline.revokeInviteConfirmBody, { email }),
      confirmLabel: t.workspaceDetailInline.revokeInviteConfirm,
      cancelLabel: t.workspaceDetailInline.cancel,
      variant: "destructive",
    });
    if (!ok) return;
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

  // On success the caller is demoted to admin, so the refetch drops every
  // owner-only row menu in this section.
  async function transferOwnership() {
    if (!data || !transferTarget) return;
    setTransferError(null);
    try {
      await transferWorkspaceOwnership(data.id, transferTarget, API_URL);
      await refetch();
    } catch (err) {
      setTransferError(transferErrorText(err, t));
    } finally {
      setTransferTarget(null);
    }
  }

  async function removeMember(userId: string, name: string) {
    if (!data) return;
    const ok = await confirmDialog({
      title: t.workspaceDetailInline.removeMemberConfirmTitle,
      description: format(t.workspaceDetailInline.removeMemberConfirmBody, { name }),
      confirmLabel: t.workspaceDetailInline.removeMemberConfirm,
      cancelLabel: t.workspaceDetailInline.cancel,
      variant: "destructive",
    });
    if (!ok) return;
    try {
      await authFetch(`${API_URL}/api/workspaces/${data.id}/members/${userId}`, {
        method: "DELETE",
      });
      await refetch();
    } catch {
      // ignore
    }
  }

  const memberActions = (m: Member) => isOwner && managementEnabled && m.role !== "owner" && (
                <DropdownMenu>
                  <DropdownMenuTrigger
                    render={
                      <button
                        type="button"
                        aria-label={format(t.workspaceDetailInline.rowActionsAria, {
                          name: m.userName ?? m.email ?? m.userId,
                        })}
                        className="inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted sm:size-7"
                      >
                        <MoreHorizontal className="size-4" aria-hidden />
                      </button>
                    }
                  />
                  <DropdownMenuContent align="end">
                    <DropdownMenuItem
                      onClick={() =>
                        changeRole(m.userId, m.role === "admin" ? "member" : "admin")
                      }
                    >
                      {m.role === "admin"
                        ? t.workspaceDetailInline.demoteToMember
                        : t.workspaceDetailInline.promoteToAdmin}
                    </DropdownMenuItem>
                    {(
                      <DropdownMenuItem
                        onClick={() => {
                          setTransferError(null);
                          setTransferTarget(m.userId);
                        }}
                      >
                        {t.workspaceDetailInline.transferOwnershipTitle}
                      </DropdownMenuItem>
                    )}
                    <DropdownMenuSeparator />
                    <DropdownMenuItem
                      variant="destructive"
                      onClick={() => removeMember(m.userId, m.userName ?? m.email ?? "")}
                    >
                      {t.workspaceDetailInline.remove}
                    </DropdownMenuItem>
                  </DropdownMenuContent>
                </DropdownMenu>
              );

  return (
    <div className="min-w-0 space-y-5">
      <div className={`flex flex-wrap items-center justify-between gap-3 ${directory && memberTarget ? "max-md:hidden" : ""}`}>
        <div><h2 className="flex items-center gap-2.5 text-xl font-semibold tracking-tight">{directory ? t.organization.peopleTab : memberTarget ? t.organization.memberDetails : t.chrome.settingsModal.workspace.members}
          {(!memberTarget || directory) && <span className="rounded-md bg-muted px-2 py-0.5 text-xs font-medium tabular-nums text-muted-foreground">{data.members.length}</span>}</h2>
          {directory && <p className="mt-1 text-sm text-muted-foreground">{t.organization.peopleDirectoryHint}</p>}
        </div>
        {!directory && memberTarget ? <Button size="sm" className="max-sm:min-h-11" variant="outline" onClick={clearMember??(()=>openWorkspaceSettings('ws-organization'))}><ArrowLeft aria-hidden className="size-3.5"/>{clearMember?t.organization.showAllMembers:t.workspaceAccess.organization}</Button> : null}
        {isAdmin && managementEnabled && (!memberTarget || directory) ? <Button className="max-sm:min-h-11" onClick={() => setInviteOpen(true)}><UserPlus aria-hidden className="size-4"/>{t.workspaceDetailInline.inviteHeading}</Button> : null}
      </div>
      {!directory && memberTarget && !shownMembers.length ? <p role="status" className="text-sm">{t.organization.memberUnavailable}</p> : null}
      <div className={directory && memberTarget ? "grid min-w-0 items-start gap-6 md:grid-cols-[minmax(0,1fr)_minmax(0,1.15fr)]" : "min-w-0"}>
      {isAdmin && managementEnabled && (!memberTarget || directory) && (
        <Dialog.Root open={inviteOpen} onOpenChange={open => { if (!sending) setInviteOpen(open); }}>
          <Dialog.Portal>
            <Dialog.Backdrop className="fixed inset-0 z-50 bg-black/30 backdrop-blur-sm"/>
            <Dialog.Popup className="fixed left-1/2 top-1/2 z-50 max-h-[90dvh] w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-border bg-background p-6 shadow-xl">
          <div className="mb-5 flex items-start justify-between gap-3">
            <div><Dialog.Title className="text-lg font-semibold">{t.workspaceDetailInline.inviteHeading}</Dialog.Title>
            <Dialog.Description className="mt-1 text-sm text-muted-foreground">{format(t.workspaceDetailInline.inviteDescription, { workspace: data.name })}</Dialog.Description></div>
            <Dialog.Close disabled={sending} aria-label={t.workspaceAccess.close} className="flex size-11 shrink-0 items-center justify-center rounded-lg hover:bg-muted sm:size-8"><X aria-hidden className="size-4"/></Dialog.Close>
          </div>
          <div className="space-y-4">
          <label className="grid gap-1.5 text-sm font-medium">{t.organization.inviteEmails}
          <textarea
            value={emails}
            onChange={(e) => {
              setEmails(e.target.value);
              setInviteError("");
            }}
            placeholder={t.workspaceDetailInline.inviteEmailsPlaceholder}
            rows={2}
            // No autofocus on a phone (responsive contract M4): inert on iOS,
            // and on Android it pops the keyboard over the section picker
            // before the user has read the form.
            autoFocus={!isPhoneViewport()}
            className="w-full text-[16px] md:text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 resize-none outline-none"
          />
          </label>
          <label className="grid gap-1.5 text-sm font-medium"><span>{t.workspaceAccess.workspaceRole}</span>
            <Select
              value={inviteRole}
              onValueChange={(v) => setInviteRole((v ?? "member") as "member" | "admin")}
            >
              <SelectTrigger className="min-h-11 w-full bg-muted/50 sm:min-h-9" aria-label={t.workspaceAccess.workspaceRole}>
                <SelectValue>{inviteRole === "admin" ? t.workspaceAccess.admin : t.workspaceAccess.memberRole}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="member">{t.workspaceDetailInline.member}</SelectItem>
                <SelectItem value="admin">{t.workspaceDetailInline.admin}</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <details className="text-sm"><summary className="flex min-h-11 cursor-pointer items-center text-muted-foreground sm:min-h-8">{t.organization.addInviteMessage}</summary>
          <textarea
            aria-label={t.organization.addInviteMessage}
            value={inviteMessage}
            onChange={(e) => setInviteMessage(e.target.value)}
            placeholder={t.workspaceDetailInline.inviteMessagePlaceholder}
            rows={2}
            maxLength={1000}
            className="w-full text-[16px] md:text-sm bg-muted/50 border border-border rounded-lg px-3 py-2 resize-none outline-none"
          />
          </details>
          <button
            onClick={sendInvites}
            disabled={sending || !emails.trim()}
            className="min-h-8 max-sm:min-h-11 w-full text-sm font-medium bg-action text-action-foreground px-3 py-2 rounded-lg hover:bg-action/90 transition-colors disabled:opacity-50"
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
                  <div className="min-w-0">
                    <div className="truncate">{r.email}</div>
                    {r.status === "invited" && r.emailStatus && (
                      <div
                        className={
                          r.emailStatus === "failed"
                            ? "text-[11px] text-destructive"
                            : "text-[11px] text-muted-foreground"
                        }
                      >
                        {r.emailStatus === "sent"
                          ? t.workspaceDetailInline.inviteEmailSent
                          : r.emailStatus === "failed"
                            ? t.workspaceDetailInline.inviteEmailFailed
                            : t.workspaceDetailInline.inviteEmailNotConfigured}
                      </div>
                    )}
                  </div>
                  {r.status === "invited" && r.link ? (
                    <button
                      onClick={() => copyLink(r.link!)}
                      className="min-h-11 shrink-0 text-primary hover:underline sm:min-h-8"
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
            </Dialog.Popup>
          </Dialog.Portal>
        </Dialog.Root>
      )}
      <div className={`min-w-0 space-y-4 ${directory && memberTarget ? "max-md:hidden" : ""}`}>
      {(!memberTarget || directory) && <div className="flex flex-wrap gap-2">
        <label className="relative min-w-0 flex-1 basis-full sm:basis-40"><Search aria-hidden className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"/>
          <input type="search" aria-label={t.organization.searchPeople} placeholder={t.organization.searchPeople} value={search} onChange={event => setSearch(event.target.value)} className="min-h-11 w-full rounded-lg border border-border bg-background py-2 pl-9 pr-3 text-[16px] outline-none focus-visible:ring-2 focus-visible:ring-ring md:min-h-9 md:text-sm"/>
        </label>
        <Select value={roleFilter} onValueChange={value => setRoleFilter(value ?? "all")}>
          <SelectTrigger aria-label={t.workspaceAccess.workspaceRole} className="min-h-11 w-auto min-w-36 md:min-h-9"><SelectValue>{roleFilter === "all" ? t.organization.allRoles : roleFilter === "owner" ? t.workspaceAccess.owner : roleFilter === "admin" ? t.workspaceAccess.admin : t.workspaceAccess.memberRole}</SelectValue></SelectTrigger>
          <SelectContent><SelectItem value="all">{t.organization.allRoles}</SelectItem><SelectItem value="owner">{t.workspaceAccess.owner}</SelectItem><SelectItem value="admin">{t.workspaceAccess.admin}</SelectItem><SelectItem value="member">{t.workspaceAccess.memberRole}</SelectItem></SelectContent>
        </Select>
      </div>}

      {/* Pending invitations */}
      {isAdmin && managementEnabled && (!memberTarget || directory) && pending.length > 0 && (
        <details className="rounded-xl border border-border px-4 py-1">
          <summary className="min-h-8 max-sm:min-h-11 cursor-pointer py-3 text-sm text-muted-foreground">
            {format(t.workspaceDetailInline.pendingHeading, { count: pending.length })}
          </summary>
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
                  {/* One per-row menu (the share dialog's RoleMenu shape)
                      instead of two 11px links 8px apart: a 44px trigger on a
                      phone, and Revoke sits behind a menu AND its confirm. */}
                  <div className="flex items-center gap-2 shrink-0">
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        render={
                          <button
                            type="button"
                            aria-label={format(t.workspaceDetailInline.rowActionsAria, {
                              name: inv.email,
                            })}
                            className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted sm:size-7"
                          >
                            <MoreHorizontal className="size-4" aria-hidden />
                          </button>
                        }
                      />
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem onClick={() => resendInvite(inv.email, inv.role)}>
                          {t.workspaceDetailInline.resend}
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => revokeInvite(inv.id, inv.email)}
                        >
                          {t.workspaceDetailInline.revoke}
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </div>
                </div>
              );
            })}
          </div>
        </details>
      )}

      {/* One keyboard-operable selection button per row, separate from its action menu. */}
      <section className="space-y-3">
        {/* The stat tiles already count members; the label stays visible only to separate the roster from pending invitations. */}
        <h3 className={isAdmin && managementEnabled && !memberTarget && pending.length > 0 ? "flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-muted-foreground" : "sr-only"}>
          {format(t.workspaceDetailInline.membersHeader, { count: shownMembers.length })}
        </h3>
        {transferError && (
          <p role="alert" className="text-[13px] text-red-400">{transferError}</p>
        )}
        {!shownMembers.length && (!memberTarget || directory) ? <p role="status" className="rounded-xl border border-dashed border-border p-8 text-center text-sm text-muted-foreground">{t.organization.noPeopleMatch}</p> : null}
        <ul aria-label={t.organization.peopleTab} className="divide-y divide-border overflow-hidden rounded-xl border border-border bg-card">
          {shownMembers.map((m) => {
            const display = m.userName ?? m.email ?? t.organization.unnamedPerson;
            const role = m.role === "owner" ? t.workspaceAccess.owner : m.role === "admin" ? t.workspaceAccess.admin : t.workspaceAccess.memberRole;
            return (
            <li
              key={m.userId}
              className={`group flex min-w-0 items-center gap-1 pr-2 transition-colors ${directory && m.userId === memberTarget?.memberId ? "bg-muted" : "hover:bg-muted/40"}`}
            >
              <button type="button" disabled={!selectMember || (!directory && Boolean(memberTarget))} aria-current={directory && m.userId === memberTarget?.memberId ? "true" : undefined}
                onClick={() => selectMember?.(m.userId)} className="flex min-h-[76px] min-w-0 flex-1 items-center gap-3 p-4 text-left outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:cursor-default">
                <OrgAvatar name={display} seed={m.userId} size={36}/>
                <span className="min-w-0 flex-1">
                  <span className="flex min-w-0 items-center gap-1.5 text-sm font-medium"><span className="truncate">{display}</span>{m.email === currentUser?.email && <span className="shrink-0 text-xs font-normal text-muted-foreground">{t.workspaceDetailInline.you}</span>}</span>
                  {m.email && m.userName && m.email !== m.userName ? <span className="mt-0.5 block truncate text-xs text-muted-foreground">{m.email}</span> : null}
                  <span className="mt-1 block text-xs text-muted-foreground sm:hidden">{role}</span>
                </span>
                <span className="hidden shrink-0 sm:block"><Chip icon={m.role === "owner" ? Crown : m.role === "admin" ? ShieldCheck : UserRound}>{role}</Chip></span>
                {selectMember && <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground"/>}
              </button>
              {memberActions(m)}
            </li>
            );
          })}
        </ul>
      </section>
      </div>
      {directory && memberTarget ? <section aria-label={t.organization.memberDetails} className="min-w-0 outline-none rounded-xl border border-border bg-card md:sticky md:top-0">
        <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-2">
          <h3 ref={detailHeadingRef} tabIndex={-1} className="text-sm font-medium focus-visible:shadow-none">{t.organization.memberDetails}</h3>
          <Button size="sm" variant="ghost" className="max-sm:min-h-11" onClick={clearMember}><ArrowLeft aria-hidden className="size-3.5"/>{t.organization.showAllMembers}</Button>
        </div>
        {selectedMember ? <>
          <div className="flex min-w-0 items-center gap-3 px-5 py-5">
            <OrgAvatar name={selectedMember.userName || selectedMember.email || t.organization.unnamedPerson} seed={selectedMember.userId} size={44}/>
            <div className="min-w-0 flex-1"><h3 className="break-words text-base font-semibold">{selectedMember.userName || selectedMember.email || t.organization.unnamedPerson}</h3>
              {selectedMember.userName && selectedMember.email && selectedMember.userName !== selectedMember.email ? <p className="break-all text-sm text-muted-foreground">{selectedMember.email}</p> : null}
              <p className="mt-1 text-xs text-muted-foreground">{selectedMember.role === "owner" ? t.workspaceAccess.owner : selectedMember.role === "admin" ? t.workspaceAccess.admin : t.workspaceAccess.memberRole}</p>
            </div>
            {memberActions(selectedMember)}
          </div>
          <div className="border-t border-border p-5">{renderMemberAccess?.(selectedMember)}</div>
        </> : <p role="status" className="p-5 text-sm text-muted-foreground">{t.organization.memberUnavailable}</p>}
      </section> : null}
      </div>
      <TypeToConfirmDialog
        open={transferTarget !== null}
        workspaceName={data.name}
        title={t.workspaceDetailInline.transferOwnershipDialogTitle}
        description={format(t.workspaceDetailInline.transferOwnershipConfirm, {
          name:
            data.members.find((m) => m.userId === transferTarget)?.userName ??
            data.members.find((m) => m.userId === transferTarget)?.email ??
            "",
        })}
        confirmLabel={t.workspaceDetailInline.transferOwnershipTitle}
        onCancel={() => setTransferTarget(null)}
        onConfirm={transferOwnership}
      />
    </div>
  );
}
