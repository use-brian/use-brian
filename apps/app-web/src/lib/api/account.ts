import { publicRuntimeConfig } from "@/lib/runtime-public-config";
/**
 * Account SDK (app-web) — profile name + avatar.
 *
 * Ported from the inline `authFetch` calls in
 * `apps/web/src/app/(app)/settings/account/page.tsx` (app consolidation §5a —
 * Settings). app-web's settings live in the SettingsModal, so the page's
 * inline calls are extracted into this SDK, same convention as
 * `lib/api/usage.ts` / `lib/api/studio.ts`.
 *
 * All wire contracts match apps/web:
 * - `PATCH /api/account/profile` `{ name }` updates the display name.
 * - `POST /api/account/avatar` (multipart `file` + active `workspaceId`) uploads a profile photo.
 * - `DELETE /api/account/avatar` removes it.
 *
 * After any of these, callers should re-pull the profile-bearing `user` cookie.
 * Dev/OSS can use the local `/api/auth/refresh` bridge; hosted app-web must use
 * the primary site's top-level `refresh-and-return` round trip.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = publicRuntimeConfig().apiUrl ?? "http://localhost:4000";

/** 5 MB — mirrors the backend cap on `POST /api/account/avatar`. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

export type ProfileRefreshPlan =
  | { kind: "local" }
  | { kind: "redirect"; url: string };

/**
 * Decide how app-web must refresh the profile-bearing `user` cookie after an
 * account mutation. Hosted app-web cannot call its own refresh route: only the
 * primary site may rotate the shared `.usebrian.ai` cookies, so it needs a
 * top-level refresh-and-return round trip. Dev and OSS own their cookies
 * locally and can use the same-origin POST bridge without navigating away.
 */
export function planProfileRefresh(
  primaryAuthOrigin: string | null,
  currentUrl: string,
): ProfileRefreshPlan {
  if (!primaryAuthOrigin) return { kind: "local" };
  const url = new URL("/api/auth/refresh-and-return", primaryAuthOrigin);
  url.searchParams.set("next", currentUrl);
  return { kind: "redirect", url: url.toString() };
}

/** Update the user's display name. Resolves `true` on success. */
export async function updateDisplayName(name: string): Promise<boolean> {
  const res = await authFetch(`${API_URL}/api/account/profile`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name }),
  });
  return res.ok;
}

/** Upload a profile photo (multipart). Resolves `true` on success. */
export async function uploadAvatar(file: File, workspaceId: string): Promise<boolean> {
  const form = new FormData();
  form.append("file", file);
  form.append("workspaceId", workspaceId);
  const res = await authFetch(`${API_URL}/api/account/avatar`, {
    method: "POST",
    body: form,
  });
  return res.ok;
}

/** Remove the current profile photo. Resolves `true` on success. */
export async function removeAvatar(): Promise<boolean> {
  const res = await authFetch(`${API_URL}/api/account/avatar`, {
    method: "DELETE",
  });
  return res.ok;
}

// ── Revocable device sessions ──────────────────────────────────

export type AccountSession = {
  id: string;
  deviceLabel: string;
  userAgent: string | null;
  ipAddress: string | null;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  current: boolean;
};

export async function listAccountSessions(): Promise<AccountSession[] | null> {
  try {
    const res = await authFetch(`${API_URL}/api/account/sessions`);
    if (!res.ok) return null;
    const body = (await res.json()) as { sessions?: AccountSession[] };
    return body.sessions ?? [];
  } catch {
    return null;
  }
}

export async function revokeAccountSession(sessionId: string): Promise<boolean> {
  try {
    const res = await authFetch(
      `${API_URL}/api/account/sessions/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export async function revokeCurrentAccountSession(): Promise<boolean> {
  try {
    const res = await authFetch(`${API_URL}/api/account/sessions/current`, {
      method: "DELETE",
    });
    return res.ok;
  } catch {
    return false;
  }
}

export async function revokeAllAccountSessions(): Promise<boolean> {
  try {
    const res = await authFetch(`${API_URL}/api/account/sessions`, {
      method: "DELETE",
    });
    return res.ok;
  } catch {
    return false;
  }
}

// ── Connected accounts (Telegram / Slack / WhatsApp / Feishu linking) ──
// Settings → Account → Connected accounts. Wire contracts:
// - `GET    /api/account/linked-accounts` lists linked provider identities.
// - `DELETE /api/account/linked-accounts/:id` unlinks one.
// - Link codes are minted through `createChannelLinkCode(codeEndpoint)`
//   below, with the endpoint taken from the `CHANNEL_IDENTITY` registry
//   (@use-brian/shared), so every channel shares one row component.
// See docs/architecture/platform/auth.md → "Linked accounts".

export type LinkedAccount = {
  id: string;
  provider: string;
  providerId: string;
  providerMetadata: Record<string, unknown> | null;
  linkedAt: string;
};

/** List the user's linked provider accounts. Resolves `[]` on failure. */
export async function listLinkedAccounts(): Promise<LinkedAccount[]> {
  try {
    const res = await authFetch(`${API_URL}/api/account/linked-accounts`);
    if (!res.ok) return [];
    const data = (await res.json()) as { linkedAccounts?: LinkedAccount[] };
    return data.linkedAccounts ?? [];
  } catch {
    return [];
  }
}

/** Unlink a provider account by row id. Resolves `true` on success. */
export async function unlinkAccount(id: string): Promise<boolean> {
  const res = await authFetch(
    `${API_URL}/api/account/linked-accounts/${encodeURIComponent(id)}`,
    { method: "DELETE" },
  );
  return res.ok;
}

// ── Channel identities (unified connect surface) ─────────────────────
// Spec: docs/plans/channel-identity-binding.md §4. One response shape for
// every channel's link code, so Settings and the Studio channel footer share
// one row component driven by `CHANNEL_IDENTITY` (@use-brian/shared).

export type ChannelLinkCode = {
  code: string;
  expiresAt: string;
  /** Telegram: the bot that receives `/start <code>` (deep link). */
  botUsername?: string | null;
  /** WhatsApp: the official number to send the code to. */
  officialNumber?: string | null;
};

/**
 * Mint a link code at a registry `codeEndpoint`. Resolves `null` on any
 * non-OK response (503 no store or no bot on this installation, 409 no
 * assistant), which the row shows as "not available here".
 */
export async function createChannelLinkCode(
  codeEndpoint: string,
): Promise<ChannelLinkCode | null> {
  try {
    const res = await authFetch(`${API_URL}${codeEndpoint}`, { method: "POST" });
    if (!res.ok) return null;
    return (await res.json()) as ChannelLinkCode;
  } catch {
    return null;
  }
}

export type ChannelEmailMatch = {
  provider: string;
  providerId: string;
  displayName: string | null;
};

export type ChannelEmailMatching = {
  channelId: string;
  status: "on" | "off";
  reason: string | null;
  missingScopes: string[];
  providerCode: string | null;
  at: string;
};

export type ChannelIdentities = {
  /** Providers whose sender was matched to this account by email. */
  emailMatches: ChannelEmailMatch[];
  /** Per-channel email-matching status; only returned to workspace admins. */
  emailMatching: ChannelEmailMatching[];
  /** True when the caller is an owner/admin of the requested workspace. */
  emailMatchingVisible: boolean;
};

/** `GET /api/account/channel-identities`. Resolves empty lists on failure. */
export async function getChannelIdentities(
  workspaceId?: string | null,
): Promise<ChannelIdentities> {
  const empty: ChannelIdentities = { emailMatches: [], emailMatching: [], emailMatchingVisible: false };
  try {
    const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    const res = await authFetch(`${API_URL}/api/account/channel-identities${qs}`);
    if (!res.ok) return empty;
    const data = (await res.json()) as Partial<ChannelIdentities>;
    return {
      emailMatches: data.emailMatches ?? [],
      emailMatching: data.emailMatching ?? [],
      emailMatchingVisible: data.emailMatchingVisible === true,
    };
  } catch {
    return empty;
  }
}
