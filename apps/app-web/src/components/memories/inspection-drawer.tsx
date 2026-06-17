"use client";

/**
 * Inspection drawer — "Ask about this" surface in the brain inbox.
 *
 * Slide-in right-edge panel containing an ephemeral chat with the
 * workspace's primary assistant (resolved server-side). The chat is
 * read-only — no save/delete tools are wired in this session — so the
 * model can only inspect and explain. Card buttons remain the only
 * mutation path.
 *
 * The first user message is prefixed with a preamble that gives the
 * model the memory context. Subsequent messages flow normally through
 * the existing /api/chat endpoint with the inspection-session id.
 *
 * Non-streaming v1 — the drawer reads the full SSE response and
 * extracts the final assistant text. Streaming UX is a follow-up; for
 * the short-deliberation use case the 1-3s wait is acceptable.
 *
 * Spec: docs/architecture/brain/corrections.md.
 */

import { useEffect, useState } from "react";
import { useT } from "@/lib/i18n/client";
import { authFetch } from "@/lib/auth-fetch";
import {
  createInspectionSession,
  type BrainPrimitive,
  type InspectionSession,
} from "@/lib/api/brain-inbox";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

type Props = {
  workspaceId: string;
  primitive: BrainPrimitive;
  rowId: string;
  memorySummary: string;
  memoryDetail: string | null;
  savingAssistantName: string;
  onClose: () => void;
};

type ChatTurn = { role: "user" | "assistant"; text: string };

export function InspectionDrawer({
  workspaceId,
  primitive,
  rowId,
  memorySummary,
  memoryDetail,
  savingAssistantName,
  onClose,
}: Props) {
  const t = useT();
  const [session, setSession] = useState<InspectionSession | null>(null);
  const [sessionError, setSessionError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [turns, setTurns] = useState<ChatTurn[]>([]);

  // Create the inspection session on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await createInspectionSession(workspaceId, primitive, rowId);
      if (cancelled) return;
      if ("error" in result) {
        setSessionError(result.error);
      } else {
        setSession(result);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, primitive, rowId]);

  // Close on Escape.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function buildPreamble(): string {
    // Threaded to the model as the leading block of the user's first
    // message. Gives the model the memory body, source assistant,
    // and the user's intent ("help me decide").
    const detailLine = memoryDetail ? `\nDetail: ${memoryDetail}` : "";
    return (
      `[Memory review context]\n` +
      `The user is reviewing a memory saved by their assistant "${savingAssistantName}":\n` +
      `Summary: ${memorySummary}${detailLine}\n\n` +
      `Help the user decide whether to confirm, adjust, or delete this memory. ` +
      `You are read-only here — you cannot save, delete, or modify memories yourself; ` +
      `the user will act on the card. Be brief and concrete.\n\n` +
      `[User asks]\n`
    );
  }

  async function send() {
    if (!session || busy || draft.trim().length === 0) return;
    const userText = draft.trim();
    setDraft("");
    setBusy(true);

    // First turn gets the preamble; subsequent turns send the raw text.
    const isFirst = turns.length === 0;
    const messageBody = isFirst ? buildPreamble() + userText : userText;

    // Optimistic append — both the user turn AND an empty assistant
    // turn that we'll grow as chunks arrive. The streaming render
    // path keys off the last turn, so the empty assistant turn must
    // exist before the first delta lands.
    setTurns((prev) => [
      ...prev,
      { role: "user", text: userText },
      { role: "assistant", text: "" },
    ]);

    try {
      const res = await authFetch(`${API_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: messageBody,
          sessionId: session.sessionId,
          assistantId: session.assistantId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }),
      });
      if (!res.ok || !res.body) {
        throw new Error(`Chat failed (${res.status})`);
      }
      // Stream the SSE response. Each parsed delta updates the last
      // assistant turn in-place so the drawer reads as a live typing
      // surface rather than a blocked spinner.
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantText = "";
      let flushScheduled = false;
      const flush = () => {
        flushScheduled = false;
        setTurns((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role !== "assistant") return prev;
          if (last.text === assistantText) return prev;
          return [...prev.slice(0, -1), { ...last, text: assistantText }];
        });
      };
      const scheduleFlush = () => {
        // Coalesce updates to roughly one render per animation frame.
        // Without this a chatty stream re-renders 50+ times per second.
        if (flushScheduled) return;
        flushScheduled = true;
        if (typeof requestAnimationFrame === "function") {
          requestAnimationFrame(flush);
        } else {
          setTimeout(flush, 16);
        }
      };
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const json = trimmed.slice(5).trim();
          if (!json) continue;
          try {
            const evt = JSON.parse(json) as { type?: string; text?: string; delta?: string };
            // Two shapes observed across the codebase — accommodate both.
            if (typeof evt.text === "string") assistantText += evt.text;
            else if (typeof evt.delta === "string") assistantText += evt.delta;
            scheduleFlush();
          } catch {
            // Non-JSON SSE line (heartbeat, comment) — skip.
          }
        }
      }
      // Final flush to commit any pending coalesced delta.
      flush();
      // Empty-response guard — if the stream closed without any text,
      // surface a marker so the user isn't staring at a blank bubble.
      if (assistantText.length === 0) {
        setTurns((prev) => {
          if (prev.length === 0) return prev;
          const last = prev[prev.length - 1];
          if (last.role !== "assistant" || last.text.length > 0) return prev;
          return [
            ...prev.slice(0, -1),
            { ...last, text: t.memoriesReview.askEmptyResponse },
          ];
        });
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setTurns((prev) => {
        if (prev.length === 0) return prev;
        const last = prev[prev.length - 1];
        if (last.role !== "assistant") return prev;
        return [
          ...prev.slice(0, -1),
          { ...last, text: `${t.memoriesReview.askError} ${msg}` },
        ];
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="fixed inset-0 z-50 flex justify-end bg-black/30"
      role="dialog"
      aria-modal="true"
      aria-label={t.memoriesReview.askAboutThis}
      onClick={onClose}
    >
      <div
        className="w-full max-w-md h-full bg-card border-l border-border flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex flex-col gap-0.5 min-w-0">
            <div className="text-sm font-semibold truncate">
              {session?.assistantName ?? t.memoriesReview.connecting}
            </div>
            <div className="text-[10px] text-muted-foreground">
              {t.memoriesReview.inspectionMode}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="text-muted-foreground hover:text-foreground p-1"
            aria-label={t.memoriesReview.close}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden>
              <path d="M18 6L6 18M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Memory context summary */}
        <div className="px-4 py-3 border-b border-border bg-background/50">
          <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1">
            {t.memoriesReview.reviewingMemory}
          </div>
          <div className="text-xs text-foreground break-words">{memorySummary}</div>
          {memoryDetail && (
            <div className="text-xs text-muted-foreground mt-1 break-words line-clamp-3">
              {memoryDetail}
            </div>
          )}
        </div>

        {/* Conversation */}
        <div className="flex-1 overflow-y-auto px-4 py-3 flex flex-col gap-3">
          {sessionError && (
            <div className="text-xs text-red-500">{sessionError}</div>
          )}
          {turns.length === 0 && !sessionError && (
            <div className="text-xs text-muted-foreground italic">
              {t.memoriesReview.askPlaceholderBody}
            </div>
          )}
          {turns.map((turn, i) => {
            const isLastAssistantEmpty =
              i === turns.length - 1 && turn.role === "assistant" && turn.text.length === 0;
            // Hide empty assistant bubble before the first chunk
            // lands — the standalone "Thinking…" line below covers it.
            if (isLastAssistantEmpty && busy) return null;
            return (
              <div
                key={i}
                className={
                  turn.role === "user"
                    ? "self-end max-w-[85%] text-xs bg-primary text-primary-foreground rounded-md px-3 py-2 whitespace-pre-wrap"
                    : "self-start max-w-[95%] text-xs bg-muted text-foreground rounded-md px-3 py-2 whitespace-pre-wrap"
                }
              >
                {turn.text}
              </div>
            );
          })}
          {busy && (() => {
            // Only show the indicator while we're awaiting the first
            // chunk — once text streams in, the bubble itself is the
            // signal that the model is responding.
            const last = turns[turns.length - 1];
            if (last && last.role === "assistant" && last.text.length > 0) return null;
            return (
              <div className="self-start text-xs text-muted-foreground italic">
                {t.memoriesReview.thinking}
              </div>
            );
          })()}
        </div>

        {/* Composer */}
        <div className="border-t border-border px-4 py-3 flex flex-col gap-2">
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                void send();
              }
            }}
            // Typeable while the reply streams — `send()` no-ops on busy, so
            // Enter can't double-send; only the session-less state locks it.
            disabled={!session}
            placeholder={t.memoriesReview.askInputPlaceholder}
            rows={3}
            className="text-sm px-3 py-2 rounded-md border border-border bg-background resize-y"
          />
          <div className="flex items-center justify-between">
            <div className="text-[10px] text-muted-foreground">
              {t.memoriesReview.inspectionDisclosure}
            </div>
            <button
              type="button"
              onClick={() => void send()}
              disabled={!session || busy || draft.trim().length === 0}
              className="text-xs px-3 py-1.5 rounded-md bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
            >
              {busy ? t.memoriesReview.sending : t.memoriesReview.send}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
