import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Workspace detail API client (app-web).
 *
 * Wraps `GET /api/workspaces/:workspaceId` (the detail fetch) and
 * `PATCH /api/workspaces/:workspaceId` (settings update). The fields surfaced
 * here are the subset other modules need a typed handle on — the
 * `defaultRecordingBlueprintId` (migration 291): the workspace's default
 * recording blueprint that the recording upload picker pre-selects and the
 * settings modal sets — and the transcript Chinese-script preference
 * (`transcription_prefs.chineseScript`, migration 332) the settings modal
 * General section sets.
 *
 * The settings/members sections still fetch the broader detail shape inline via
 * `authFetch`; this client is the typed seam for the blueprint-default round-
 * trips (get to pre-select, patch to persist). See
 * docs/architecture/brain/structural-synthesis.md §D3/§D4.
 */
import {
  normalizeHomeApps,
  type HomeAppEntry,
} from "@use-brian/shared/home-apps";
import { authFetch } from "@/lib/auth-fetch";
import { getUserInfo } from "@/lib/user";
import type { WorkspacePickerItem } from "@/lib/workspace-picker";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/** Mirrors the backend cap on `POST /api/workspaces/:workspaceId/icon`. */
export const MAX_WORKSPACE_ICON_BYTES = 5 * 1024 * 1024;

export type WorkspaceIconUpdate = { iconUrl: string | null };

export type WorkspacePickerPreferencePatch = {
  pinned?: boolean;
  hidden?: boolean;
  opened?: true;
};

export type WorkspacePickerPreferenceState = Pick<
  WorkspacePickerItem,
  "pickerPinnedAt" | "pickerHiddenAt" | "pickerLastOpenedAt"
>;

/**
 * Persist the acting member's picker organization. This updates only the
 * membership row; it never changes workspace lifecycle or access.
 */
export async function updateWorkspacePickerPreferences(
  workspaceId: string,
  patch: WorkspacePickerPreferencePatch,
  apiUrl = API_URL,
): Promise<WorkspacePickerPreferenceState> {
  const res = await authFetch(
    `${apiUrl}/api/workspaces/${encodeURIComponent(workspaceId)}/picker-preferences`,
    {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
      keepalive: patch.opened === true,
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new WorkspaceApiError(
      body.error ?? "Could not update workspace navigation",
      res.status,
    );
  }
  const body = (await res.json()) as WorkspacePickerPreferenceState;
  return {
    pickerPinnedAt: body.pickerPinnedAt ?? null,
    pickerHiddenAt: body.pickerHiddenAt ?? null,
    pickerLastOpenedAt: body.pickerLastOpenedAt ?? null,
  };
}

/** Upload and activate a custom workspace picture. Admin/owner only. */
export async function uploadWorkspaceIcon(
  workspaceId: string,
  file: File,
): Promise<WorkspaceIconUpdate> {
  const form = new FormData();
  form.append("file", file);
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/icon`,
    { method: "POST", body: form },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string;
      detail?: string;
    };
    throw new WorkspaceApiError(
      body.detail ?? body.error ?? "Could not update the workspace icon",
      res.status,
    );
  }
  const body = (await res.json()) as WorkspaceIconUpdate;
  return { iconUrl: body.iconUrl ?? null };
}

/** Remove the custom picture and reveal the generated landmark fallback. */
export async function removeWorkspaceIcon(
  workspaceId: string,
): Promise<WorkspaceIconUpdate> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/icon`,
    { method: "DELETE" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new WorkspaceApiError(
      body.error ?? "Could not remove the workspace icon",
      res.status,
    );
  }
  return { iconUrl: null };
}

/** The blueprint-relevant slice of the workspace detail response. */
export type WorkspaceDefaultBlueprint = {
  id: string;
  /**
   * The workspace default recording blueprint — a `workspace_page_templates`
   * id carrying an `extraction` spec, or `null` for none (ingest-only).
   */
  defaultRecordingBlueprintId: string | null;
};

/**
 * Fetch the workspace's default recording blueprint id (and id). Returns `null`
 * on any non-OK response so callers degrade to "no default" rather than throw —
 * the picker / settings pre-select is non-critical chrome.
 */
export async function getWorkspaceDefaultBlueprint(
  workspaceId: string,
): Promise<WorkspaceDefaultBlueprint | null> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`);
  if (!res.ok) return null;
  const body = (await res.json()) as Partial<WorkspaceDefaultBlueprint>;
  return {
    id: body.id ?? workspaceId,
    defaultRecordingBlueprintId: body.defaultRecordingBlueprintId ?? null,
  };
}

/** Error carrying the backend's message (e.g. the 400 blueprint validation). */
export class WorkspaceApiError extends Error {
  readonly status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "WorkspaceApiError";
    this.status = status;
  }
}

/**
 * PATCH the workspace's default recording blueprint. `templateId` is a blueprint
 * template id, or `null` to clear it (ingest-only). The backend validates the
 * template is a same-workspace blueprint and 400s otherwise — surfaced as a
 * `WorkspaceApiError`.
 */
export async function setWorkspaceDefaultBlueprint(
  workspaceId: string,
  templateId: string | null,
): Promise<WorkspaceDefaultBlueprint> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ defaultRecordingBlueprintId: templateId }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new WorkspaceApiError(body.error ?? "Could not update the workspace", res.status);
  }
  const body = (await res.json()) as Partial<WorkspaceDefaultBlueprint>;
  return {
    id: body.id ?? workspaceId,
    defaultRecordingBlueprintId: body.defaultRecordingBlueprintId ?? null,
  };
}

/** The Chinese-script half of `workspaces.transcription_prefs` (migration 332). */
export type ChineseScriptPref = "traditional" | "simplified";

/**
 * PATCH the workspace's transcript Chinese-script preference. `script` is
 * `'traditional' | 'simplified'`, or `null` to clear back to Auto (provider
 * default). Admin/owner only — the backend enforces and 403s otherwise,
 * surfaced as a `WorkspaceApiError`. Returns the persisted value.
 */
export async function setWorkspaceTranscriptionScript(
  workspaceId: string,
  script: ChineseScriptPref | null,
): Promise<ChineseScriptPref | null> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ transcriptionPrefs: { chineseScript: script } }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new WorkspaceApiError(body.error ?? "Could not update the workspace", res.status);
  }
  const body = (await res.json()) as {
    transcriptionPrefs?: { chineseScript?: ChineseScriptPref };
  };
  return body.transcriptionPrefs?.chineseScript ?? null;
}

// ── Doc Inbox retention (migration 426) ────────────────────────────────

/**
 * PATCH the workspace's Inbox retention window. `days` is a whole number of
 * days, or `null` to never prune. Admin/owner only — the backend enforces and
 * 403s otherwise, surfaced as a `WorkspaceApiError`.
 *
 * The window is a read-time filter, so widening it restores older items;
 * nothing is deleted by narrowing it. Returns the persisted value.
 */
export async function setWorkspaceInboxRetention(
  workspaceId: string,
  days: number | null,
): Promise<number | null> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inboxRetentionDays: days }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new WorkspaceApiError(body.error ?? "Could not update the workspace", res.status);
  }
  const body = (await res.json()) as { inboxRetentionDays?: number | null };
  return body.inboxRetentionDays ?? null;
}

// ── Home apps (migration 385) ──────────────────────────────────────────

/**
 * Fetch the workspace's Home app-bar config. Unknown entries are filtered
 * client-side too (`normalizeHomeApps`), so a strip written by a newer server
 * degrades to the apps this build knows rather than rendering a dead icon.
 *
 * Returns the DEFAULT strip on any failure — the app-bar is chrome on every
 * authenticated surface, so a config read that fails must never take the shell
 * down or leave the user with no navigation.
 */
export async function getWorkspaceHomeApps(
  workspaceId: string,
): Promise<HomeAppEntry[]> {
  try {
    const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`);
    if (!res.ok) return normalizeHomeApps(null);
    const body = (await res.json()) as { homeApps?: unknown };
    return normalizeHomeApps(body.homeApps);
  } catch {
    return normalizeHomeApps(null);
  }
}

/**
 * PATCH the workspace's Home app-bar config. Admin/owner only — the backend
 * enforces and 403s otherwise, surfaced as a `WorkspaceApiError`. The server
 * emits `workspace_config` on success, so every other tab, device, and teammate
 * repairs its strip from this one write.
 */
export async function setWorkspaceHomeApps(
  workspaceId: string,
  homeApps: readonly HomeAppEntry[],
): Promise<HomeAppEntry[]> {
  const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ homeApps }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new WorkspaceApiError(body.error ?? "Could not update the workspace", res.status);
  }
  const body = (await res.json()) as { homeApps?: unknown };
  return normalizeHomeApps(body.homeApps);
}

/** The caller's role in a workspace, or `null` when it could not be resolved. */
export type WorkspaceRole = "owner" | "admin" | "member";

/**
 * The caller's own role in a workspace, read off the detail response's member
 * list. Returns `null` when the fetch fails or the caller is not in the list —
 * callers should treat `null` as "not an admin", so a failed probe never
 * *grants* an affordance it cannot back up (the server enforces regardless).
 */
export async function getWorkspaceRole(
  workspaceId: string,
): Promise<WorkspaceRole | null> {
  try {
    const me = getUserInfo();
    if (!me?.id) return null;
    const res = await authFetch(`${API_URL}/api/workspaces/${workspaceId}`);
    if (!res.ok) return null;
    const body = (await res.json()) as {
      members?: Array<{ userId?: string; role?: WorkspaceRole }>;
    };
    return body.members?.find((m) => m.userId === me.id)?.role ?? null;
  } catch {
    return null;
  }
}
