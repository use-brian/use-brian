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
 * - `POST /api/account/avatar` (multipart `file`) uploads a profile photo.
 * - `DELETE /api/account/avatar` removes it.
 *
 * After any of these, callers should re-pull the `user` cookie via the
 * `/api/auth/refresh` bridge so the chrome (sidebar, switcher) updates without
 * a full reload.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** 5 MB — mirrors the backend cap on `POST /api/account/avatar`. */
export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

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
export async function uploadAvatar(file: File): Promise<boolean> {
  const form = new FormData();
  form.append("file", file);
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

// ── Connected accounts (Telegram linking) ─────────────────────
// Settings → Account → Connected accounts. Wire contracts:
// - `GET    /api/account/linked-accounts` lists linked provider identities.
// - `DELETE /api/account/linked-accounts/:id` unlinks one.
// - `POST   /api/account/telegram/link-code` mints a 6-char code bound to
//   the user's first-owned assistant and returns the official bot's
//   @username for the t.me deep link (null when unresolvable).
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

export type TelegramLinkCode = {
  code: string;
  expiresAt: string;
  botUsername: string | null;
};

/** Mint a Telegram link code. Resolves `null` on failure. */
export async function createTelegramLinkCode(): Promise<TelegramLinkCode | null> {
  try {
    const res = await authFetch(`${API_URL}/api/account/telegram/link-code`, {
      method: "POST",
    });
    if (!res.ok) return null;
    return (await res.json()) as TelegramLinkCode;
  } catch {
    return null;
  }
}

export type WhatsappLinkCode = {
  code: string;
  expiresAt: string;
  /** The official number to send the code to — always present on success. */
  officialNumber: string;
};

/**
 * Mint a WhatsApp link code. Resolves `null` on failure, including the
 * hosted-only 503 (OSS) and the 503 raised when the official bot isn't paired
 * — in both cases there is nowhere to send a code, so there is no code.
 */
export async function createWhatsappLinkCode(): Promise<WhatsappLinkCode | null> {
  try {
    const res = await authFetch(`${API_URL}/api/account/whatsapp/link-code`, {
      method: "POST",
    });
    if (!res.ok) return null;
    return (await res.json()) as WhatsappLinkCode;
  } catch {
    return null;
  }
}
