/**
 * SDK for the computer-use web surface (app-web).
 *
 * Wraps `authFetch` over the routes mounted at `/api/computer` in
 * `packages/api/src/boot.ts`:
 *
 *   GET    /api/computer/tasks/:sessionId              active task summary
 *   POST   /api/computer/tasks/:sessionId/resume       resume for Take-Over
 *   GET    /api/computer/tasks/:sessionId/frame        one screencast frame
 *   POST   /api/computer/tasks/:sessionId/input        relay a click/key/scroll
 *   POST   /api/computer/tasks/:sessionId/captured     vault the signed-in session (into a profile)
 *   POST   /api/computer/tasks/:sessionId/complete     close-to-stop
 *   POST   /api/computer/sessions/:sessionId/backend   live backend toggle (R2-3)
 *   GET    /api/computer/profiles?workspaceId=         Profile-Management list (R2-4)
 *   POST   /api/computer/profiles                      create a profile
 *   PATCH  /api/computer/profiles/:id                  update (owner only)
 *   DELETE /api/computer/profiles/:id                  delete (owner only)
 *   DELETE /api/computer/profiles/:id/sessions/:site   revoke one site's session
 *
 * Spec: docs/architecture/engine/computer-use.md §5, §7.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type ComputerTask = {
  taskId: string;
  status: "running" | "paused" | "completed" | "failed";
  profileId: string | null;
  injectedSite: string | null;
  workspaceId: string;
  createdAt: number;
};

export type TakeoverFrame = { data: string; mimeType: string };

export type TakeoverInput =
  | { kind: "click"; x: number; y: number }
  | { kind: "key"; text: string }
  | { kind: "scroll"; deltaY: number };

type VaultedSession = {
  site: string;
  capturedAt: string;
  lastUsedAt: string | null;
  status: "active" | "dead";
};

export type BrowserProfileClearance = "public" | "internal" | "confidential";
export type BrowserBackend = "local" | "cloud";

type BrowserSkillGrantSummary = {
  id: string;
  skillId: string;
  skillName: string;
  createdAt: string;
  lastUsedAt: string | null;
};

export type BrowserProfile = {
  id: string;
  workspaceId: string;
  ownerUserId: string;
  name: string;
  clearance: BrowserProfileClearance;
  enabledAssistantIds: string[];
  defaultBackend: BrowserBackend;
  proxyUrl: string | null;
  createdAt: string;
  updatedAt: string;
  sessions: VaultedSession[];
  /** Standing block grants on this identity (R2-2) - revocable here. */
  grants: BrowserSkillGrantSummary[];
};

export async function getComputerTask(sessionId: string): Promise<ComputerTask | null> {
  const res = await authFetch(`${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`computer task lookup failed (${res.status})`);
  return (await res.json()) as ComputerTask;
}

export async function resumeComputerTask(sessionId: string): Promise<void> {
  await authFetch(`${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/resume`, {
    method: "POST",
  });
}

export async function getComputerFrame(sessionId: string): Promise<TakeoverFrame | null> {
  const res = await authFetch(`${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/frame`);
  if (!res.ok || res.status === 204) return null;
  return (await res.json()) as TakeoverFrame;
}

export async function sendComputerInput(sessionId: string, event: TakeoverInput): Promise<boolean> {
  const res = await authFetch(`${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/input`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  });
  return res.ok;
}

/**
 * Vault the signed-in session into the task's browser profile. A task that
 * started identity-less answers 409 `profile_required` unless `profileId`
 * names the profile to bind.
 */
export async function markComputerSessionCaptured(
  sessionId: string,
  site: string,
  profileId?: string,
): Promise<{ ok: boolean; profileRequired: boolean }> {
  const res = await authFetch(
    `${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/captured`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(profileId ? { site, profileId } : { site }),
    },
  );
  return { ok: res.ok, profileRequired: res.status === 409 };
}

export async function completeComputerTask(
  sessionId: string,
  outcome: "completed" | "failed" = "completed",
): Promise<void> {
  await authFetch(`${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/complete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ outcome }),
  });
}

/** The live backend toggle (R2-3): null clears back to the profile default. */
export async function setComputerSessionBackend(
  sessionId: string,
  backend: BrowserBackend | null,
): Promise<boolean> {
  const res = await authFetch(
    `${API_URL}/api/computer/sessions/${encodeURIComponent(sessionId)}/backend`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ backend }),
    },
  );
  return res.ok;
}

// ── Profile-Management (R2-4) ────────────────────────────────────

export async function listBrowserProfiles(
  workspaceId: string,
): Promise<{ configured: boolean; profiles: BrowserProfile[] }> {
  const res = await authFetch(
    `${API_URL}/api/computer/profiles?workspaceId=${encodeURIComponent(workspaceId)}`,
  );
  if (!res.ok) throw new Error(`browser profiles list failed (${res.status})`);
  return (await res.json()) as { configured: boolean; profiles: BrowserProfile[] };
}

export async function createBrowserProfile(params: {
  workspaceId: string;
  name: string;
  clearance?: BrowserProfileClearance;
  defaultBackend?: BrowserBackend;
}): Promise<BrowserProfile | null> {
  const res = await authFetch(`${API_URL}/api/computer/profiles`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) return null;
  const body = (await res.json()) as { profile: Omit<BrowserProfile, "sessions" | "grants"> | null };
  return body.profile ? { ...body.profile, sessions: [], grants: [] } : null;
}

export async function updateBrowserProfile(
  profileId: string,
  patch: Partial<
    Pick<BrowserProfile, "name" | "clearance" | "defaultBackend" | "proxyUrl" | "enabledAssistantIds">
  >,
): Promise<boolean> {
  const res = await authFetch(`${API_URL}/api/computer/profiles/${encodeURIComponent(profileId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  return res.ok;
}

export async function deleteBrowserProfile(profileId: string): Promise<boolean> {
  const res = await authFetch(`${API_URL}/api/computer/profiles/${encodeURIComponent(profileId)}`, {
    method: "DELETE",
  });
  return res.ok;
}

export async function revokeProfileSession(profileId: string, site: string): Promise<boolean> {
  const res = await authFetch(
    `${API_URL}/api/computer/profiles/${encodeURIComponent(profileId)}/sessions/${encodeURIComponent(site)}`,
    { method: "DELETE" },
  );
  return res.ok;
}

/** Revoke a standing block grant on a profile (R2-2). */
export async function revokeProfileGrant(profileId: string, grantId: string): Promise<boolean> {
  const res = await authFetch(
    `${API_URL}/api/computer/profiles/${encodeURIComponent(profileId)}/grants/${encodeURIComponent(grantId)}`,
    { method: "DELETE" },
  );
  return res.ok;
}
