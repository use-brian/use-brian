import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * SDK for teamspaces — the Notion-style page containers above the doc
 * page tree (docs/architecture/features/teamspaces.md).
 *
 * Thin typed wrappers around `packages/api/src/routes/teamspaces.ts`,
 * following the `authFetch` pattern of `views.ts`. Management errors
 * carry a machine-readable `code` (the server's `{error}` body) via
 * `TeamspaceApiError` so the settings modal can map them to friendly
 * i18n copy instead of surfacing raw HTTP text.
 *
 * [COMP:app-web/teamspaces-sdk]
 */

import { authFetch } from "@/lib/auth-fetch";
import {
  teamspaceMetadataSchema,
  teamspaceSchema,
  type Teamspace,
  type TeamspaceMetadata,
} from "@use-brian/shared/teamspaces";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type { Teamspace, TeamspaceMetadata };
export type TeamspaceSensitivity = TeamspaceMetadata["sensitivity"];

/** One roster row from `GET /teamspaces/:id/members`. */
export type TeamspaceMember = {
  userId: string;
  name: string | null;
  email: string | null;
  /** WORKSPACE role — teamspaces have no per-teamspace roles (v1). */
  role: "owner" | "admin" | "member";
  clearance: TeamspaceSensitivity;
  addedAt: string;
};

/**
 * Error carrying the server's `{error}` code (e.g.
 * `sensitivity_exceeds_clearance`, `member_below_sensitivity`,
 * `target_clearance_below_sensitivity`, `insufficient_clearance`) so
 * callers can render a specific message.
 */
export class TeamspaceApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "TeamspaceApiError";
    this.status = status;
    this.code = code;
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let code: string | null = null;
    let text = "";
    try {
      text = await res.text();
      const parsed = JSON.parse(text) as { error?: unknown };
      if (typeof parsed.error === "string") code = parsed.error;
    } catch {
      // Non-JSON body — keep the raw text for the message.
    }
    throw new TeamspaceApiError(
      res.status,
      code,
      `HTTP ${res.status}${text ? `: ${text}` : ""}`,
    );
  }
  return (await res.json()) as T;
}

/** Teamspaces the caller belongs to in this workspace (General first). */
export async function listTeamspaces(workspaceId: string): Promise<Teamspace[]> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/teamspaces`,
  );
  const data = await json<{ teamspaces?: unknown }>(res);
  return teamspaceSchema.array().parse(data.teamspaces ?? []);
}

/** Create a teamspace; the creator is auto-joined server-side. */
export async function createTeamspace(
  workspaceId: string,
  params: {
    name: string;
    icon?: string;
    description?: string;
    sensitivity?: TeamspaceSensitivity;
  },
): Promise<Teamspace> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${workspaceId}/teamspaces`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(params),
    },
  );
  return teamspaceSchema.parse(await json<unknown>(res));
}

/** Patch metadata or link/unlink a Team (clearance-gated). */
export async function updateTeamspace(
  teamspaceId: string,
  patch: {
    name?: string;
    icon?: string | null;
    description?: string;
    sensitivity?: TeamspaceSensitivity;
    workspaceGroupId?: string | null;
  },
): Promise<TeamspaceMetadata> {
  const res = await authFetch(`${API_URL}/api/teamspaces/${teamspaceId}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(patch),
  });
  return teamspaceMetadataSchema.parse(await json<unknown>(res));
}

/** Delete a non-default teamspace — its pages move to General. */
export async function deleteTeamspace(teamspaceId: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/teamspaces/${teamspaceId}`, {
    method: "DELETE",
  });
  await json<{ ok: boolean }>(res);
}

/** Roster for the settings modal's Members tab. */
export async function listTeamspaceMembers(
  teamspaceId: string,
): Promise<TeamspaceMember[]> {
  const res = await authFetch(
    `${API_URL}/api/teamspaces/${teamspaceId}/members`,
  );
  const data = await json<{ members: TeamspaceMember[] }>(res);
  return data.members ?? [];
}

/** Add a workspace member — 409 when their clearance sits below the tier. */
export async function addTeamspaceMember(
  teamspaceId: string,
  userId: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/teamspaces/${teamspaceId}/members`,
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId }),
    },
  );
  if (!res.ok) await json<never>(res);
}

/** Remove a member. Removing YOURSELF is a leave (any member, non-default). */
export async function removeTeamspaceMember(
  teamspaceId: string,
  userId: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/teamspaces/${teamspaceId}/members/${userId}`,
    { method: "DELETE" },
  );
  await json<{ ok: boolean }>(res);
}
