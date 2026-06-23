/**
 * WhatsApp read-only ingest SDK (app-web).
 *
 * Backs the Studio -> Ingestion "Connect WhatsApp (your number)" panel
 * ([COMP:app-web/studio-whatsapp-ingest]). The assistant silently reads
 * owner-enabled team groups into the brain and never sends - see
 * docs/plans/whatsapp-bring-your-own-number.md.
 *
 * Backend: packages/api-platform/src/routes/whatsapp-ingest-admin.ts
 *   - GET  /api/workspaces/:workspaceId/whatsapp            status + group inventory
 *   - POST /api/workspaces/:workspaceId/whatsapp/connect    SSE QR pairing
 *   - POST /api/workspaces/:workspaceId/whatsapp/groups/enable
 *   - POST /api/workspaces/:workspaceId/whatsapp/groups/disable
 *
 * The connect endpoint is POST-returning-SSE, so it is consumed with
 * `fetch` + a stream reader (EventSource is GET-only).
 */

import { authFetch } from "@/lib/auth-fetch";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/** Per-group routing: live extraction vs a weekday-9am digest. */
export type WhatsappGroupRouting = "realtime" | "scheduled";

export type WhatsappGroup = {
  chatJid: string;
  title: string | null;
  enabled: boolean;
  routing: WhatsappGroupRouting | null;
  ruleId: string | null;
};

export type WhatsappIngestStatus = {
  connected: boolean;
  channelId?: string;
  connectorInstanceId?: string | null;
  /** The paired phone number (display-only); null until connected. */
  connectedNumber: string | null;
  groups: WhatsappGroup[];
};

/** Fetch connection status + the observed-group inventory with enable state. */
export async function getWhatsappIngest(
  workspaceId: string,
): Promise<WhatsappIngestStatus> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp`,
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to load WhatsApp (${res.status})`);
  }
  return (await res.json()) as WhatsappIngestStatus;
}

/** Enable a group (eligibility-gated): writes a `group_match` ingest rule. */
export async function enableWhatsappGroup(
  workspaceId: string,
  chatJid: string,
  routing: WhatsappGroupRouting,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/groups/enable`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatJid, routing }),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Enable failed (${res.status})`);
  }
}

/** Disable a group: removes its `group_match` ingest rule. */
export async function disableWhatsappGroup(
  workspaceId: string,
  chatJid: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/groups/disable`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatJid }),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Disable failed (${res.status})`);
  }
}

/** Events surfaced by the connect SSE stream. */
export type WhatsappConnectHandlers = {
  /** A fresh QR string to render and scan (re-emitted as it rotates). */
  onQr?: (qr: string) => void;
  /** Pairing succeeded; the connected number is now linked. */
  onConnected?: (phoneNumber: string) => void;
  /** The QR expired before it was scanned. */
  onTimeout?: (message: string) => void;
};

/**
 * Open the POST QR-pairing stream and dispatch its SSE events. Resolves when
 * the stream ends (connected, timed out, or aborted). Pass `signal` from an
 * `AbortController` to cancel pairing when the modal closes.
 */
export async function connectWhatsappIngest(
  workspaceId: string,
  handlers: WhatsappConnectHandlers,
  signal?: AbortSignal,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/connect`,
    { method: "POST", signal },
  );
  if (!res.ok || !res.body) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `WhatsApp connect failed (${res.status})`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // SSE frames are separated by a blank line.
    let sep: number;
    while ((sep = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, sep);
      buffer = buffer.slice(sep + 2);
      dispatchFrame(frame, handlers);
    }
  }
}

/** Parse one `event: X\ndata: {...}` SSE frame and call the matching handler. */
function dispatchFrame(frame: string, handlers: WhatsappConnectHandlers): void {
  let event = "message";
  let data = "";
  for (const line of frame.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data += line.slice(5).trim();
  }
  if (!data) return;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return;
  }
  if (event === "qr" && typeof payload.qr === "string") handlers.onQr?.(payload.qr);
  else if (event === "connected" && typeof payload.phoneNumber === "string")
    handlers.onConnected?.(payload.phoneNumber);
  else if (event === "timeout")
    handlers.onTimeout?.(typeof payload.message === "string" ? payload.message : "");
}
