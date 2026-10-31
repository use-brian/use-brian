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

/** A recoverable account prerequisite or request failure, distinct from 503. */
export class ChannelLinkCodeError extends Error {
  constructor(readonly code: "no_assistant" | "request_failed") {
    super(code);
    this.name = "ChannelLinkCodeError";
  }
}

/** Mint a link code. Only 503 means linking is unavailable on this installation. */
export async function createChannelLinkCode(
  codeEndpoint: string,
): Promise<ChannelLinkCode | null> {
  const res = await authFetch(`${API_URL}${codeEndpoint}`, { method: "POST" });
  if (res.status === 503) return null;
  if (!res.ok) {
    const body = await res.json().catch(() => null) as { error?: string } | null;
    throw new ChannelLinkCodeError(
      res.status === 409 && body?.error === "no_assistant" ? "no_assistant" : "request_failed",
    );
  }
  return (await res.json()) as ChannelLinkCode;
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

/**
 * One of the caller's own WeChat connections (per bot, per workspace). WeChat
 * links are channel-scoped: never collapsed into one global WeChat link.
 * See docs/architecture/channels/wechat.md → "Staff identity".
 */
export type WechatBinding = {
  bindingId: string;
  workspaceId: string;
  channelId: string;
  channelName: string | null;
  state: "linked" | "revoked" | "pairing_replaced" | "access_removed";
  linkedAt: string;
  revokedAt: string | null;
};

/** Owner/admin per-channel summary. Members never receive this. */
export type WechatChannelSummary = {
  channelId: string;
  channelName: string | null;
  state: "linked" | "unlinked" | "revoked" | "conflict";
  account: { id: string; name: string | null; email: string | null } | null;
  linkedAt: string | null;
};

export type ChannelIdentities = {
  /** Providers whose sender was matched to this account by email. */
  emailMatches: ChannelEmailMatch[];
  /** Per-channel email-matching status; only returned to workspace admins. */
  emailMatching: ChannelEmailMatching[];
  /** True when the caller is an owner/admin of the requested workspace. */
  emailMatchingVisible: boolean;
  /** The caller's own WeChat connections. */
  wechatBindings: WechatBinding[];
  /** Per WeChat channel linked/unlinked/revoked/conflict; owners/admins only. */
  wechatChannels: WechatChannelSummary[];
};

/** `GET /api/account/channel-identities`. Resolves empty lists on failure. */
export async function getChannelIdentities(
  workspaceId?: string | null,
): Promise<ChannelIdentities> {
  const empty: ChannelIdentities = {
    emailMatches: [], emailMatching: [], emailMatchingVisible: false, wechatBindings: [], wechatChannels: [],
  };
  try {
    const qs = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
    const res = await authFetch(`${API_URL}/api/account/channel-identities${qs}`);
    if (!res.ok) return empty;
    const data = (await res.json()) as Partial<ChannelIdentities>;
    return {
      emailMatches: data.emailMatches ?? [],
      emailMatching: data.emailMatching ?? [],
      emailMatchingVisible: data.emailMatchingVisible === true,
      wechatBindings: data.wechatBindings ?? [],
      wechatChannels: data.wechatChannels ?? [],
    };
  } catch {
    return empty;
  }
}

export type WechatLinkCodeResult =
  | { ok: true; code: string; expiresAt: string; channelName: string | null }
  | { ok: false; reason: "not_found" | "linked_elsewhere" | "conflict" | "rate_limited" | "unavailable" | "error" };

/**
 * Mint a WeChat link code for the signed-in account on ONE channel. The
 * person sends `LINK <code>` from the WeChat account that paired that bot.
 */
export async function createWechatLinkCode(
  workspaceId: string,
  channelId: string,
): Promise<WechatLinkCodeResult> {
  try {
    const res = await authFetch(`${API_URL}/api/account/wechat/link-code`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspaceId, channelId }),
    });
    if (res.ok) return { ok: true, ...((await res.json()) as { code: string; expiresAt: string; channelName: string | null }) };
    if (res.status === 503) return { ok: false, reason: "unavailable" };
    const data = (await res.json().catch(() => ({}))) as { code?: string };
    const reason = data.code === "linked_elsewhere" || data.code === "conflict" || data.code === "rate_limited" || data.code === "not_found"
      ? data.code
      : "error";
    return { ok: false, reason };
  } catch {
    return { ok: false, reason: "error" };
  }
}

/** Disconnect one of the caller's own WeChat connections. */
export async function revokeWechatBinding(bindingId: string): Promise<boolean> {
  try {
    const res = await authFetch(`${API_URL}/api/account/wechat/bindings/${encodeURIComponent(bindingId)}`, {
      method: "DELETE",
    });
    return res.ok;
  } catch {
    return false;
  }
}
