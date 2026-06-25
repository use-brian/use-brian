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

// ── Bot ('chat' capability) config ──────────────────────────────
// The bot replies when triggered; distinct from the read-only listener above.
// Backend: packages/api-platform/src/routes/whatsapp-ingest-admin.ts (Phase 6).

export type WhatsappBotSendScope = "dm" | "dm_and_groups";

/** A reply trigger — a `routing_mode='reply'` rule. */
export type WhatsappBotTrigger = {
  id: string;
  filterType: string;
  filterParams: Record<string, unknown>;
};

export type WhatsappBotConfig = {
  connected: boolean;
  chatEnabled: boolean;
  sendScope: WhatsappBotSendScope;
  triggers: WhatsappBotTrigger[];
};

/** Fetch the bot config (chat enabled + send scope + reply triggers). */
export async function getWhatsappBot(workspaceId: string): Promise<WhatsappBotConfig> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/bot`,
  );
  if (!res.ok) throw new Error(`Failed to load WhatsApp bot (${res.status})`);
  return (await res.json()) as WhatsappBotConfig;
}

/** Enable replies: add the `chat` capability + set the send scope. */
export async function enableWhatsappBot(
  workspaceId: string,
  sendScope: WhatsappBotSendScope,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/bot/enable`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sendScope }),
    },
  );
  if (!res.ok) throw new Error(`Enable replies failed (${res.status})`);
}

/** Disable replies: remove the `chat` capability. */
export async function disableWhatsappBot(workspaceId: string): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/bot/disable`,
    { method: "POST" },
  );
  if (!res.ok) throw new Error(`Disable replies failed (${res.status})`);
}

/** Add a reply trigger (`is_mention` / `keyword_match` / `is_dm` / `always`). */
export async function addWhatsappBotTrigger(
  workspaceId: string,
  filterType: string,
  filterParams: Record<string, unknown> = {},
): Promise<WhatsappBotTrigger> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/bot/triggers`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ filterType, filterParams }),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Add trigger failed (${res.status})`);
  }
  return (await res.json()) as WhatsappBotTrigger;
}

/** Remove a reply trigger. */
export async function deleteWhatsappBotTrigger(
  workspaceId: string,
  ruleId: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/bot/triggers/${encodeURIComponent(ruleId)}`,
    { method: "DELETE" },
  );
  if (!res.ok) throw new Error(`Remove trigger failed (${res.status})`);
}

/** Events surfaced by the connect SSE stream. */
export type WhatsappConnectHandlers = {
  /** A fresh QR string to render and scan (re-emitted as it rotates). */
  onQr?: (qr: string) => void;
  /** Pairing succeeded; the connected number is now linked. */
  onConnected?: (phoneNumber: string) => void;
  /** The QR expired before it was scanned. */
  onTimeout?: (message: string) => void;
  /**
   * The connector failed to start pairing (e.g. logged out, session conflict,
   * persistence unavailable). Without this the stream just ends silently and
   * the modal hangs on the loading state forever.
   */
  onError?: (error: string) => void;
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
  else if (event === "error")
    handlers.onError?.(typeof payload.error === "string" ? payload.error : "");
}
