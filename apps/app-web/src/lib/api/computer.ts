/**
 * SDK for the computer-use web surface (app-web).
 *
 * Wraps `authFetch` over the routes mounted at `/api/computer` in
 * `packages/api/src/boot.ts`:
 *
 *   GET    /api/computer/tasks?workspaceId=            caller's live tasks (shell pill)
 *   GET    /api/computer/tasks/:sessionId              active task summary
 *   POST   /api/computer/tasks/:sessionId/resume       resume for Take-Over
 *   GET    /api/computer/tasks/:sessionId/frame        one screencast frame
 *   POST   /api/computer/tasks/:sessionId/input        relay a click/key/scroll
 *   POST   /api/computer/tasks/:sessionId/captured     vault the signed-in session (into a profile)
 *   POST   /api/computer/tasks/:sessionId/complete     close-to-stop
 *   POST   /api/computer/sessions/:sessionId/backend   live backend toggle (R2-3)
 *   GET    /api/computer/profiles?workspaceId=         Profile-Management list (R2-4)
 *   POST   /api/computer/profiles                      create a profile
 *   POST   /api/computer/profiles/:id/login            start a user-initiated sign-in task (owner only)
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

/**
 * Take-Over input events. `frameW`/`frameH` are the pixel size of the frame
 * the client mapped coordinates against - the stream bridge rescales to the
 * real viewport (stream frames are size-capped, so frame px != viewport px).
 * `move` exists only on the duplex WebSocket path: hover relay is too chatty
 * for per-event HTTP, and the API relay route does not accept it.
 */
export type TakeoverInput =
  | { kind: "click"; x: number; y: number; frameW?: number; frameH?: number }
  | { kind: "move"; x: number; y: number; frameW?: number; frameH?: number }
  | { kind: "key"; text: string }
  | { kind: "scroll"; deltaY: number }
  // Take-over toolbar: Back / Forward / Reload / address-bar navigation (§5).
  | { kind: "navigate"; action: "back" | "forward" | "reload" | "goto"; url?: string };

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

export type ComputerTaskSummary = {
  taskId: string;
  sessionId: string;
  status: "running" | "paused";
  profileId: string | null;
  injectedSite: string | null;
  createdAt: number;
  lastActivityAt: number;
};

/**
 * The caller's live browser tasks in a workspace — the discovery surface the
 * shell pill polls. Empty array on any failure: discovery chrome must never
 * take a surface down.
 */
export async function listActiveComputerTasks(
  workspaceId: string,
): Promise<ComputerTaskSummary[]> {
  const res = await authFetch(
    `${API_URL}/api/computer/tasks?workspaceId=${encodeURIComponent(workspaceId)}`,
  ).catch(() => null);
  if (!res?.ok) return [];
  const body = (await res.json().catch(() => null)) as { tasks?: ComputerTaskSummary[] } | null;
  return body?.tasks ?? [];
}

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

export type TakeoverStreamSession = {
  framesUrl: string;
  inputUrl: string;
  /** Duplex WebSocket (binary frames down, JSON input up). Absent from older backends. */
  wsUrl?: string;
};

/**
 * Mint the live-stream session: the API (the auth gate) starts the in-sandbox
 * bridge and returns capability URLs on the sandbox host. Null = backend
 * without streaming (or a mint failure) - the caller stays on polled frames.
 */
export async function mintComputerStreamSession(
  sessionId: string,
): Promise<TakeoverStreamSession | null> {
  const res = await authFetch(
    `${API_URL}/api/computer/tasks/${encodeURIComponent(sessionId)}/stream-session`,
    { method: "POST" },
  );
  if (!res.ok) return null;
  return (await res.json()) as TakeoverStreamSession;
}

/** Direct-to-sandbox input over the stream session (no API hop). */
export async function sendStreamInput(inputUrl: string, event: TakeoverInput): Promise<boolean> {
  const res = await fetch(inputUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(event),
  }).catch(() => null);
  return res !== null && res.ok;
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

/**
 * "Sign in to a site" (owner only): opens a cloud browser task bound to the
 * profile and returns the synthetic session id for the Take-Over live view
 * (`/w/<ws>/computer/<sessionId>?flow=login&site=<site>`), where the user
 * signs in and captures the session into the profile.
 */
export async function startProfileLogin(
  profileId: string,
  url: string,
): Promise<{ sessionId: string; site: string | null } | null> {
  const res = await authFetch(
    `${API_URL}/api/computer/profiles/${encodeURIComponent(profileId)}/login`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url }),
    },
  );
  if (!res.ok) return null;
  return (await res.json()) as { sessionId: string; site: string | null };
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

// ── "My Browser" — local backend extension pairing ───────────────
// Routes mounted at /api/browser-extension in boot.ts (my-browser.md).
// The extension drives the user's own Chrome via the relay; pairing links
// that Chrome to the caller's account with a short-lived token.

export type BrowserExtensionStatus = {
  /** The relay is configured on this deployment (BROWSER_RELAY_URL set). */
  configured: boolean;
  /** The caller's extension is currently connected to the relay. */
  connected: boolean;
};

/** Poll target for the connect surface. Never throws — a status probe must
 *  never take the Settings panel down. */
export async function getBrowserExtensionStatus(): Promise<BrowserExtensionStatus> {
  const res = await authFetch(`${API_URL}/api/browser-extension/status`).catch(() => null);
  if (!res?.ok) return { configured: false, connected: false };
  return (await res
    .json()
    .catch(() => ({ configured: false, connected: false }))) as BrowserExtensionStatus;
}

export type BrowserExtensionPairing = {
  pairingToken: string;
  relayUrl: string;
  expiresInSeconds: number;
};

/**
 * Mint a short-lived pairing token bound to {user, workspace}. The user pastes
 * it (with `relayUrl`) into the extension popup once. Returns null when the
 * relay is not configured on this deployment (503) or on any failure.
 */
export async function pairBrowserExtension(
  workspaceId: string,
): Promise<BrowserExtensionPairing | null> {
  const res = await authFetch(`${API_URL}/api/browser-extension/pair`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ workspaceId }),
  }).catch(() => null);
  if (!res?.ok) return null;
  return (await res.json().catch(() => null)) as BrowserExtensionPairing | null;
}

/** The workspace's active plan id — used only to gate the connect surface
 *  (D3: hosted paid only). Returns null on any failure so the gate fails open
 *  to "not gated" rather than blocking a paying user on a flaky fetch. */
export async function getWorkspacePlan(workspaceId: string): Promise<string | null> {
  const res = await authFetch(
    `${API_URL}/api/billing/subscription?workspace_id=${encodeURIComponent(workspaceId)}`,
  ).catch(() => null);
  if (!res?.ok) return null;
  const body = (await res.json().catch(() => null)) as { plan?: string } | null;
  return body?.plan ?? null;
}
