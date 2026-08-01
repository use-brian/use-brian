/**
 * Room pins SDK (multiplayer chat P1b, T14/T16) — the chip row's fetchers
 * over `GET/POST/DELETE /api/sessions/:id/pins`. Labels resolve server-side
 * under the session's clearance; a `null` label is the unavailable state,
 * rendered rather than hidden.
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

export type SessionPinKind =
  | "page"
  | "task"
  | "contact"
  | "company"
  | "deal"
  | "file"
  | "url"
  | "instruction";

export type SessionPinRow = {
  id: string;
  kind: SessionPinKind;
  refId: string | null;
  url: string | null;
  text: string | null;
  label: string | null;
  position: number;
  addedByUserId: string | null;
  addedByName: string | null;
  createdAt: string;
};

export async function listSessionPins(sessionId: string): Promise<SessionPinRow[]> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/pins`,
  );
  if (!res.ok) throw new Error(`Failed to load pins (${res.status})`);
  return (await res.json()) as SessionPinRow[];
}

export async function addSessionPin(
  sessionId: string,
  pin:
    | { kind: Exclude<SessionPinKind, "url" | "instruction">; refId: string }
    | { kind: "url"; url: string }
    | { kind: "instruction"; text: string },
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/pins`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(pin),
    },
  );
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `Pin failed: ${res.status}`);
  }
}

export async function removeSessionPin(
  sessionId: string,
  pinId: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/sessions/${encodeURIComponent(sessionId)}/pins/${encodeURIComponent(pinId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Unpin failed: ${res.status}`);
}
