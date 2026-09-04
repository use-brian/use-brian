import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Custom Home app API client (app-web).
 *
 * `GET /api/home-apps/:appId/session` is the frame's mount payload: whether
 * the app may render at all, and if so the signed entry URL plus the bridge
 * token to hand it. Everything else an app does goes over the bridge, not
 * through this module.
 *
 * [COMP:app-web/home-app-frame]
 */

import type { AppScopes } from "@use-brian/brian-app";
import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

export type HomeAppSession = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  status: "active" | "disabled" | "needs_consent";
  syncError: string | null;
  lastSyncedAt: string | null;
  /** False → the frame renders a reason panel instead of the iframe. */
  renderable: boolean;
  requestedScopes: AppScopes | null;
  grantedScopes: AppScopes | null;
  /** Present only when renderable. */
  entryUrl?: string;
  bridgeToken?: string;
  bridgeTokenTtlMs?: number;
};

/** Returns `null` on any failure — the frame shows a not-found panel. */
export async function fetchHomeAppSession(
  appId: string,
): Promise<HomeAppSession | null> {
  try {
    const res = await authFetch(
      `${API_URL}/api/home-apps/${encodeURIComponent(appId)}/session`,
    );
    if (!res.ok) return null;
    return (await res.json()) as HomeAppSession;
  } catch {
    return null;
  }
}

/** One custom app as the Studio section and the app-bar see it. */
export type CustomHomeApp = {
  id: string;
  name: string;
  description: string | null;
  icon: string | null;
  kind: "github" | "assistant" | "upload";
  status: "active" | "disabled" | "needs_consent";
  /**
   * Whether the strip may render it — `status='active'` AND a live grant.
   * This is where the T3 drift rule surfaces: an app whose re-synced manifest
   * widened its scopes drops to `needs_consent`, goes non-renderable, and
   * leaves the strip until an admin re-grants.
   */
  renderable: boolean;
  repo: string | null;
  branch: string;
  lastSyncedAt: string | null;
  syncError: string | null;
  requestedScopes: AppScopes | null;
  grantedScopes: AppScopes | null;
  maxClearance: "public" | "internal" | "confidential" | null;
  dailyCallLimit: number;
  dailyUsed: number;
};

/** The workspace's custom apps. `[]` on any failure — the strip degrades to
 *  its built-ins rather than losing navigation entirely. */
export async function listCustomHomeApps(
  workspaceId: string,
): Promise<CustomHomeApp[]> {
  try {
    const res = await authFetch(
      `${API_URL}/api/home-apps?workspaceId=${encodeURIComponent(workspaceId)}`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as CustomHomeApp[];
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Grant an app the scopes its manifest asks for, activating it. */
export async function grantCustomHomeApp(
  appId: string,
  opts: { maxClearance?: "public" | "internal" | "confidential" | null } = {},
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/home-apps/${encodeURIComponent(appId)}/grant`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ maxClearance: opts.maxClearance ?? null }),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Grant failed: ${res.status}`);
  }
}

/**
 * Enable, disable, or revoke consent. Revoking (`needs_consent`) CLEARS the
 * grant server-side, so re-activating later cannot silently restore powers
 * nobody re-approved.
 */
export async function setCustomHomeAppStatus(
  appId: string,
  status: "active" | "disabled" | "needs_consent",
): Promise<void> {
  const res = await authFetch(`${API_URL}/api/home-apps/${encodeURIComponent(appId)}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ status }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Update failed: ${res.status}`);
  }
}

/** Remove an app and its stored bundle. */
export async function deleteCustomHomeApp(appId: string): Promise<void> {
  const res = await authFetch(`${API_URL}/api/home-apps/${encodeURIComponent(appId)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Remove failed: ${res.status}`);
  }
}

/**
 * Import an app from a repository. The FIRST SYNC RUNS INLINE server-side, so
 * a rejection here is the real validation result — the caller can show the
 * author exactly what is wrong with their bundle rather than "added, check
 * back in 15 minutes".
 */
export async function importCustomHomeAppFromGithub(params: {
  workspaceId: string;
  repo: string;
  branch: string;
  rootPath: string;
  connectorInstanceId: string | null;
}): Promise<void> {
  const res = await authFetch(`${API_URL}/api/home-apps/github`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Import failed: ${res.status}`);
  }
}

/**
 * Import an app from a zip bundle. Extraction, validation, and the consent
 * gate all run server-side; a rejection here is the real validation result.
 */
export async function importCustomHomeAppZip(
  workspaceId: string,
  file: File,
): Promise<void> {
  const form = new FormData();
  form.set("workspaceId", workspaceId);
  form.set("file", file);
  const res = await authFetch(`${API_URL}/api/home-apps/import`, {
    method: "POST",
    body: form,
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Import failed: ${res.status}`);
  }
}

/**
 * Download the stored bundle as a zip. Fetched (not an anchor href) because
 * the credential rides the Authorization header, then handed to the browser
 * as an object-URL download.
 */
export async function exportCustomHomeApp(appId: string, name: string): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/home-apps/${encodeURIComponent(appId)}/export`,
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Export failed: ${res.status}`);
  }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${name.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || "app"}.zip`;
  anchor.click();
  URL.revokeObjectURL(url);
}

/** Sync now. Resolves to whether the app just dropped to `needs_consent`. */
export async function syncCustomHomeApp(
  appId: string,
): Promise<{ droppedToNeedsConsent: boolean }> {
  const res = await authFetch(
    `${API_URL}/api/home-apps/${encodeURIComponent(appId)}/sync`,
    { method: "POST" },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Sync failed: ${res.status}`);
  }
  const body = (await res.json()) as { droppedToNeedsConsent?: boolean };
  return { droppedToNeedsConsent: body.droppedToNeedsConsent === true };
}
