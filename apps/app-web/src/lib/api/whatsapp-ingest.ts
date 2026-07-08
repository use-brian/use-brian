/**
 * WhatsApp read-only ingest SDK (app-web).
 *
 * Backs the Studio -> Ingestion "Connect WhatsApp (your number)" panel
 * ([COMP:app-web/studio-whatsapp-ingest]). The assistant silently reads
 * owner-enabled team groups into the brain and never sends - see
 * docs/architecture/channels/whatsapp.md.
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

/**
 * Who the bot may answer (Telegram-parity allowlist, WhatsApp flavour):
 *   - `allow_all` — everyone.
 *   - `allowlist` — only the numbers in `allowedNumbers`.
 *   - `blocklist` — everyone except the numbers in `blockedNumbers`.
 *   - `group_members` — only people who share a group with the connected number.
 */
export type WhatsappBotAccessMode =
  | "allow_all"
  | "allowlist"
  | "blocklist"
  | "group_members";

export type WhatsappBotConfig = {
  connected: boolean;
  chatEnabled: boolean;
  sendScope: WhatsappBotSendScope;
  triggers: WhatsappBotTrigger[];
  accessMode: WhatsappBotAccessMode;
  /** Allowed sender numbers (phone digits) when `accessMode='allowlist'`. */
  allowedNumbers: string[];
  /** Blocked sender numbers (phone digits) when `accessMode='blocklist'`. */
  blockedNumbers: string[];
  /** Acknowledgment reaction emoji (reacted when the bot starts); "" = none. */
  ackReaction: string;
  /** Group chat JIDs the bot may reply in (consulted when scope is groups). */
  groupOptIn: string[];
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

/**
 * Set who the bot may answer. `numbers` is the list for whichever number-mode
 * is active: the allowlist when `accessMode='allowlist'`, the blocklist when
 * `'blocklist'` (phone digits, normalized server-side); `allow_all` /
 * `group_members` ignore it. Returns the persisted (normalized) lists.
 */
export async function setWhatsappBotAccess(
  workspaceId: string,
  accessMode: WhatsappBotAccessMode,
  numbers: string[],
): Promise<{
  accessMode: WhatsappBotAccessMode;
  allowedNumbers: string[];
  blockedNumbers: string[];
}> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/bot/access`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accessMode, numbers }),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Save access failed (${res.status})`);
  }
  return (await res.json()) as {
    accessMode: WhatsappBotAccessMode;
    allowedNumbers: string[];
    blockedNumbers: string[];
  };
}

/**
 * Set bot behavior — the acknowledgment reaction emoji and/or the per-group
 * reply opt-in (group chat JIDs the bot may answer in). Only the provided
 * fields are written. Returns the persisted values.
 */
export async function setWhatsappBotBehavior(
  workspaceId: string,
  patch: { ackReaction?: string; groupOptIn?: string[] },
): Promise<{ ackReaction: string; groupOptIn: string[] }> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/bot/behavior`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(patch),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Save behavior failed (${res.status})`);
  }
  return (await res.json()) as { ackReaction: string; groupOptIn: string[] };
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

// ── Official bot (shared business number) ──────────────────────────────
// Distinct from BYON above: the official number is paired centrally; a
// workspace doesn't pair it, it just adds the number to a group (which binds
// that group to the adder's workspace) and sees its bound groups here.
// Backend: packages/api-platform/src/routes/whatsapp-official-admin.ts (closed).
// The card that uses these is gated behind isHostedEdition().

export type WhatsappOfficialBinding = {
  groupJid: string;
  /** True when the current user is the one who added the bot to this group. */
  boundByYou: boolean;
  status: "active" | "removed";
};

export type WhatsappOfficialState = {
  /** The official shared bot's number to add to a group; null if unconfigured. */
  officialNumber: string | null;
  bindings: WhatsappOfficialBinding[];
};

export async function getWhatsappOfficial(
  workspaceId: string,
): Promise<WhatsappOfficialState> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/official`,
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to load official bot (${res.status})`);
  }
  return (await res.json()) as WhatsappOfficialState;
}

/** Stop ingesting a bound group (owner/admin). The bot stays a silent member. */
export async function unbindWhatsappOfficialGroup(
  workspaceId: string,
  groupJid: string,
): Promise<void> {
  const res = await authFetch(
    `${API_URL}/api/workspaces/${encodeURIComponent(workspaceId)}/whatsapp/official/unbind`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ groupJid }),
    },
  );
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(data.error ?? `Failed to stop ingesting (${res.status})`);
  }
}
