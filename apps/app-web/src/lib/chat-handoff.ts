/**
 * One-shot handoff from the Home briefing composer into a fresh Personal
 * conversation in the Chat operator app.
 *
 * The prompt must not ride in the URL: it can be long, private, and should not
 * remain in browser history. sessionStorage keeps the payload inside this tab
 * and survives a full-page transition; the in-memory map keeps ordinary SPA
 * navigation working when storage is unavailable. The Chat app consumes the
 * payload once, validates the assistant against its freshly-loaded roster,
 * then either sends or preserves the text as an editable draft.
 *
 * [COMP:app-web/chat-handoff]
 */

export type PendingChatHandoff = {
  workspaceId: string;
  assistantId: string;
  text: string;
  ts: number;
};

export const CHAT_HANDOFF_TTL_MS = 3 * 60 * 1000;

const inMemory = new Map<string, PendingChatHandoff>();

function storageKey(workspaceId: string): string {
  return `sidan:chat-handoff:${workspaceId}`;
}

function store(): Storage | null {
  try {
    return typeof window !== "undefined" ? window.sessionStorage : null;
  } catch {
    return null;
  }
}

export function parsePendingChatHandoff(
  raw: string | null,
): PendingChatHandoff | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const value = parsed as Record<string, unknown>;
  if (
    typeof value.workspaceId !== "string" ||
    !value.workspaceId ||
    typeof value.assistantId !== "string" ||
    !value.assistantId ||
    typeof value.text !== "string" ||
    !value.text.trim() ||
    typeof value.ts !== "number"
  ) {
    return null;
  }
  return {
    workspaceId: value.workspaceId,
    assistantId: value.assistantId,
    text: value.text.trim(),
    ts: value.ts,
  };
}

export function isPendingChatHandoffFresh(
  handoff: PendingChatHandoff | null,
  workspaceId: string,
  nowMs: number,
): boolean {
  if (!handoff || handoff.workspaceId !== workspaceId) return false;
  const age = nowMs - handoff.ts;
  return age >= 0 && age < CHAT_HANDOFF_TTL_MS;
}

export function stashChatHandoff(handoff: PendingChatHandoff): void {
  const normalized = parsePendingChatHandoff(JSON.stringify(handoff));
  if (!normalized) return;
  inMemory.set(normalized.workspaceId, normalized);
  try {
    store()?.setItem(
      storageKey(normalized.workspaceId),
      JSON.stringify(normalized),
    );
  } catch {
    // The in-memory copy still covers same-SPA navigation.
  }
}

/** Read and remove this workspace's payload. Every outcome is single-consume. */
export function takeChatHandoff(
  workspaceId: string,
  nowMs: number,
): PendingChatHandoff | null {
  const memory = inMemory.get(workspaceId) ?? null;
  inMemory.delete(workspaceId);

  let raw: string | null = null;
  const s = store();
  try {
    raw = s?.getItem(storageKey(workspaceId)) ?? null;
  } catch {
    raw = null;
  }
  try {
    s?.removeItem(storageKey(workspaceId));
  } catch {
    // Already consumed from memory; there is nothing else to do.
  }

  const candidate = memory ?? parsePendingChatHandoff(raw);
  return isPendingChatHandoffFresh(candidate, workspaceId, nowMs)
    ? candidate
    : null;
}

/** Explicit Personal + assistant params bypass remembered Chat-app location. */
export function personalChatHandoffPath(
  workspaceId: string,
  assistantId: string,
): string {
  const params = new URLSearchParams({ v: "personal", assistant: assistantId });
  return `/w/${encodeURIComponent(workspaceId)}/chat?${params.toString()}`;
}

export type ChatHandoffAction = "wait" | "send" | "prefill" | "drop";

/**
 * Resolve the safe client action without trusting the Home surface's roster.
 * A removed/cross-workspace assistant preserves the text but never falls back
 * to a different interlocutor.
 */
export function resolveChatHandoffAction(args: {
  handoff: PendingChatHandoff | null;
  assistantsLoaded: boolean;
  assistantIds: readonly string[];
  activeAssistantId: string | null;
  activeSessionId: string | null;
  view: "personal" | "workspace";
}): ChatHandoffAction {
  const {
    handoff,
    assistantsLoaded,
    assistantIds,
    activeAssistantId,
    activeSessionId,
    view,
  } = args;
  if (!handoff) return "drop";
  if (activeSessionId || view !== "personal") return "drop";
  if (!assistantsLoaded) return "wait";
  if (!assistantIds.includes(handoff.assistantId)) return "prefill";
  return activeAssistantId === handoff.assistantId ? "send" : "wait";
}
