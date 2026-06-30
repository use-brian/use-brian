/**
 * Workspace detail API client (app-web).
 *
 * Wraps `GET /api/workspaces/:workspaceId` (the detail fetch) and
 * `PATCH /api/workspaces/:workspaceId` (settings update). The fields surfaced
 * here are the subset other modules need a typed handle on — today the
 * `defaultRecordingBlueprintId` (migration 291): the workspace's default
 * recording blueprint that the recording upload picker pre-selects and the
 * settings modal sets.
 *
 * The settings/members sections still fetch the broader detail shape inline via
 * `authFetch`; this client is the typed seam for the blueprint-default round-
 * trips (get to pre-select, patch to persist). See
 * docs/plans/workspace-default-recording-blueprint.md §D3/§D4.
 */
import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

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
