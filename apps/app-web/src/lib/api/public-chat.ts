/**
 * Public-chat SDK — anonymous chat with an assistant behind a chat-link
 * token (`/c/[token]`). Like `public-share.ts`, these calls use a PLAIN
 * `fetch` (no authFetch, no Authorization header): access is by the
 * link token in the URL, and the visitor has no account.
 *
 * Spec: docs/architecture/features/public-chat-link.md.
 * [COMP:app-web/public-chat-page]
 */

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Base URL for a fetch that may run on the SERVER (the `/c/[token]` route
 * is an SSR Server Component). A relative URL has no origin to resolve
 * against on the server; `||` (not `??`) because NEXT_PUBLIC_API_URL is
 * the empty string in dev. Mirrors `public-share.ts`.
 */
function fetchApiBase(): string {
  if (typeof window !== "undefined") return API_URL;
  return process.env.NEXT_PUBLIC_API_URL || "http://localhost:4000";
}

export type PublicChatMeta = {
  assistantName: string;
  assistantIconSeed: number;
  assistantBio: string | null;
};

export type PublicChatMessage = {
  id: string;
  role: "user" | "assistant";
  content: string;
  createdAt: string;
};

/** Link meta for the page header. Null on 404 (revoked/unknown/disabled). */
export async function getPublicChatMeta(token: string): Promise<PublicChatMeta | null> {
  try {
    const res = await fetch(`${fetchApiBase()}/api/public/chat/${encodeURIComponent(token)}`, {
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as PublicChatMeta;
  } catch {
    return null;
  }
}

export async function getPublicChatHistory(
  token: string,
  visitorId: string,
): Promise<PublicChatMessage[]> {
  try {
    const res = await fetch(
      `${fetchApiBase()}/api/public/chat/${encodeURIComponent(token)}/messages?visitorId=${encodeURIComponent(visitorId)}`,
      { cache: "no-store" },
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { messages: PublicChatMessage[] };
    return data.messages ?? [];
  } catch {
    return [];
  }
}

export type PublicChatSendResult =
  | { ok: true; reply: string }
  | { ok: false; error: "link_budget_exhausted" | "budget_exhausted" | "link_not_found" | "rate_limited" | "failed" };

/** One synchronous chat turn. The backend runs the full model turn before
 *  responding, so this can take tens of seconds — the caller owns the
 *  pending UI. */
export async function sendPublicChatMessage(
  token: string,
  visitorId: string,
  message: string,
): Promise<PublicChatSendResult> {
  try {
    const res = await fetch(
      `${fetchApiBase()}/api/public/chat/${encodeURIComponent(token)}/messages`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ visitorId, message }),
      },
    );
    if (res.ok) {
      const data = (await res.json()) as { reply: string };
      return { ok: true, reply: data.reply };
    }
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (body.error === "link_budget_exhausted") return { ok: false, error: "link_budget_exhausted" };
    if (body.error === "budget_exhausted") return { ok: false, error: "budget_exhausted" };
    if (body.error === "link_not_found") return { ok: false, error: "link_not_found" };
    if (res.status === 429) return { ok: false, error: "rate_limited" };
    return { ok: false, error: "failed" };
  } catch {
    return { ok: false, error: "failed" };
  }
}
