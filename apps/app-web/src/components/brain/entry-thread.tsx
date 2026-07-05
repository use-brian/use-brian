"use client";

/**
 * EntryThread — the entry page's inline Q&A thread (the Notion "Comments"
 * analog for a brain entry). Renders as the last section of the
 * BrainDetailDrawer: suggested-question chips while empty, comment-style
 * turns once started (assistant = avatar + name + tool-activity chips +
 * markdown; user = quiet right-aligned bubble), and an always-visible
 * composer whose send button morphs into Stop while a turn streams.
 *
 * Transport is the product chat plumbing (`useMessageStream` from
 * @sidanclaw/chat-ui): named SSE events, aborts, and the full taxonomy —
 * `text_delta` grows the answer, `reasoning` feeds the live thinking line
 * (never the answer body), `tool_start`/`tool_input`/`tool_result`/
 * `tool_dropped` drive the activity chips (labels from
 * `t.chat.toolNarration`), `error` fails the turn in place. State commits
 * per event (React batches; the dock does the same — an rAF coalescer
 * freezes in backgrounded tabs), and the thread auto-follows the stream
 * only while its bottom sentinel is visible (scrolling up detaches).
 *
 * The conversation is an ephemeral inspection session with the workspace's
 * primary assistant (read-only tool registry: the model can explain the
 * entry but cannot change it; every mutation stays on the page above).
 * The session is created lazily on the first send, so opening an entry
 * page costs nothing.
 *
 * Replaces the stacked InspectionDrawer overlay on the entry page (the
 * overlay remains for the list-row UnverifiedNudge ask affordance).
 *
 * Spec: docs/architecture/brain/corrections.md → "Entry page view".
 * [COMP:app-web/brain-entry-thread]
 */

import { useEffect, useRef, useState } from "react";
import { ArrowUp, Check, Loader2, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { authFetch } from "@/lib/auth-fetch";
import { AssistantAvatar } from "@/components/assistant-avatar";
import {
  ChatMarkdown,
  useMessageStream,
  type ToolUsed,
} from "@sidanclaw/chat-ui";
import {
  createInspectionSession,
  type BrainPrimitive,
  type InspectionSession,
} from "@/lib/api/brain-inbox";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

/**
 * Model-facing context block prefixed to the thread's first message.
 * Generalised from the old memory-only preamble: the thread covers every
 * entry kind (task / memory / file / CRM / entity).
 */
export function buildEntryPreamble(
  summary: string,
  detail: string | null,
): string {
  const detailLine = detail ? `\nDetail: ${detail}` : "";
  return (
    `[Entry review context]\n` +
    `The user is reviewing a brain entry on its detail page:\n` +
    `Summary: ${summary}${detailLine}\n\n` +
    `Help the user understand this entry: why it exists, whether it is ` +
    `right, and what it connects to. You are read-only here; you cannot ` +
    `save, delete, or modify entries. The user edits directly on the page. ` +
    `Be brief and concrete.\n\n` +
    `[User asks]\n`
  );
}

/**
 * Pure tool-timeline transition for the SSE tool events. Returns the next
 * array, or null when the event doesn't change the timeline (unknown event,
 * duplicate start, missing id).
 */
export function reduceToolEvent(
  tools: ToolUsed[],
  eventName: string,
  payload: Record<string, unknown>,
): ToolUsed[] | null {
  const id = typeof payload.id === "string" ? payload.id : "";
  if (!id) return null;
  if (eventName === "tool_start") {
    const name = typeof payload.name === "string" ? payload.name : "";
    if (!name) return null;
    // Dedup — re-emits keep the existing row.
    if (tools.some((tool) => tool.id === id)) return null;
    return [...tools, { id, name, status: "running" }];
  }
  if (eventName === "tool_dropped") {
    if (!tools.some((tool) => tool.id === id)) return null;
    return tools.filter((tool) => tool.id !== id);
  }
  if (eventName === "tool_result") {
    if (!tools.some((tool) => tool.id === id)) return null;
    const isError = payload.isError === true;
    return tools.map((tool) =>
      tool.id === id
        ? { ...tool, status: isError ? "retried" : "done" }
        : tool,
    );
  }
  return null;
}

/** Safe SSE payload coercion — the parser hands us parsed JSON when the
 *  data line was JSON, else the raw string. */
function coercePayload(data: unknown): Record<string, unknown> {
  if (data && typeof data === "object") return data as Record<string, unknown>;
  return {};
}

type ThreadTurn =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; tools: ToolUsed[]; failed?: boolean };

type Props = {
  workspaceId: string;
  primitive: BrainPrimitive;
  rowId: string;
  entrySummary: string;
  entryDetail: string | null;
  /** Bumped by the drawer toolbar's "Ask about this" item — scrolls the
   *  thread into view and focuses the composer. */
  focusTick: number;
};

export function EntryThread({
  workspaceId,
  primitive,
  rowId,
  entrySummary,
  entryDetail,
  focusTick,
}: Props) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const review = t.memoriesReview;
  const narration = t.chat.toolNarration as Record<string, string>;

  const [turns, setTurns] = useState<ThreadTurn[]>([]);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [sessionError, setSessionError] = useState<string | null>(null);
  // The latest reasoning line — the live thinking indicator before the
  // first answer token lands. Never merged into the answer text.
  const [reasoningTail, setReasoningTail] = useState("");

  // The session is identity for the whole thread — once created it sticks,
  // even if an inline edit re-anchors `rowId` to a superseded row's new id.
  const sessionRef = useRef<InspectionSession | null>(null);
  const [assistant, setAssistant] = useState<{ id: string; name: string } | null>(
    null,
  );

  // Destructured because the hook returns a fresh object each render while
  // the methods themselves are stable — effects must depend on the methods,
  // or their cleanup aborts the in-flight stream on every re-render.
  const { start: startStream, abort: abortStream } = useMessageStream();
  const stoppedRef = useRef(false);

  // Per-turn accumulators. Refs so the streaming callbacks never close over
  // stale state; `flush` commits them per event — React batches the setState
  // calls (the dock dispatches per event the same way; an rAF coalescer
  // would freeze updates in a backgrounded tab, where rAF stops firing).
  const textRef = useRef("");
  const toolsRef = useRef<ToolUsed[]>([]);
  const reasoningRef = useRef("");
  const failedRef = useRef<string | null>(null);

  const sectionRef = useRef<HTMLElement | null>(null);
  const composerRef = useRef<HTMLTextAreaElement | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  // Auto-follow: keep the streaming answer pinned only while the bottom
  // sentinel is on screen — scrolling up detaches, scrolling back re-arms.
  const followRef = useRef(true);

  useEffect(() => {
    const el = bottomRef.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      ([entry]) => {
        followRef.current = entry?.isIntersecting ?? false;
      },
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  // Toolbar "Ask about this" → bring the composer into view and focus it.
  useEffect(() => {
    if (focusTick <= 0) return;
    sectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    composerRef.current?.focus();
  }, [focusTick]);

  // Abort any in-flight stream when the thread unmounts (row swap / close).
  useEffect(() => {
    return () => abortStream();
  }, [abortStream]);

  function flush() {
    setReasoningTail(() => {
      const lines = reasoningRef.current.split("\n").filter(Boolean);
      return (lines[lines.length - 1] ?? "").slice(-160);
    });
    setTurns((prev) => {
      if (prev.length === 0) return prev;
      const last = prev[prev.length - 1];
      if (last.role !== "assistant") return prev;
      const next: ThreadTurn = {
        role: "assistant",
        text: textRef.current,
        tools: toolsRef.current,
        ...(failedRef.current ? { failed: true } : {}),
      };
      return [...prev.slice(0, -1), next];
    });
    if (followRef.current) {
      bottomRef.current?.scrollIntoView({ block: "nearest" });
    }
  }

  /** Create the inspection session on first use. */
  async function ensureSession(): Promise<InspectionSession | null> {
    if (sessionRef.current) return sessionRef.current;
    const result = await createInspectionSession(workspaceId, primitive, rowId);
    if ("error" in result) {
      setSessionError(result.error);
      return null;
    }
    sessionRef.current = result;
    setAssistant({ id: result.assistantId, name: result.assistantName });
    return result;
  }

  async function send(raw: string) {
    const text = raw.trim();
    if (busy || text.length === 0) return;
    setDraft("");
    setBusy(true);
    setSessionError(null);
    stoppedRef.current = false;

    const isFirst = turns.length === 0;
    // Optimistic append — the user turn AND an empty assistant turn the
    // stream grows into (the render path keys off the last turn).
    setTurns((prev) => [
      ...prev,
      { role: "user", text },
      { role: "assistant", text: "", tools: [] },
    ]);
    followRef.current = true;
    requestAnimationFrame(() =>
      bottomRef.current?.scrollIntoView({ block: "nearest" }),
    );

    textRef.current = "";
    toolsRef.current = [];
    reasoningRef.current = "";
    failedRef.current = null;

    try {
      const session = await ensureSession();
      if (!session) {
        // Session creation failed — withdraw the optimistic pair so the
        // chips return, restore the draft, and let the error line explain.
        setTurns((prev) => prev.slice(0, -2));
        setDraft(text);
        return;
      }

      const messageBody = isFirst
        ? buildEntryPreamble(entrySummary, entryDetail) + text
        : text;

      await startStream({
        url: `${API_URL}/api/chat`,
        body: {
          message: messageBody,
          sessionId: session.sessionId,
          assistantId: session.assistantId,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
        authFetch: (url, init) => authFetch(String(url), init),
        onEvent: (event) => {
          const payload = coercePayload(event.data);
          switch (event.event) {
            case "text_delta": {
              const delta =
                typeof payload.text === "string" ? payload.text : "";
              if (delta) {
                textRef.current += delta;
                flush();
              }
              break;
            }
            case "reasoning": {
              // Live thinking — indicator only, never the answer body.
              const delta =
                typeof payload.text === "string" ? payload.text : "";
              if (delta) {
                reasoningRef.current += delta;
                flush();
              }
              break;
            }
            case "tool_start":
            case "tool_dropped":
            case "tool_result": {
              const next = reduceToolEvent(
                toolsRef.current,
                event.event,
                payload,
              );
              if (next) {
                toolsRef.current = next;
                flush();
              }
              break;
            }
            case "error": {
              const message =
                typeof payload.message === "string"
                  ? payload.message
                  : typeof payload.error === "string"
                    ? payload.error
                    : review.askEmptyResponse;
              failedRef.current = message;
              flush();
              break;
            }
            default:
              // session / notice / citations / saved-markers: nothing to
              // render in the inline thread.
              break;
          }
        },
        onError: (err) => {
          failedRef.current = err instanceof Error ? err.message : String(err);
        },
      });
    } finally {
      // One terminal flush after the stream settles (done, error, or stop).
      if (failedRef.current && textRef.current.length === 0) {
        textRef.current = `${review.askError} ${failedRef.current}`;
      }
      if (!failedRef.current && textRef.current.length === 0) {
        textRef.current = stoppedRef.current
          ? labels.threadStopped
          : review.askEmptyResponse;
      }
      flush();
      setReasoningTail("");
      setBusy(false);
    }
  }

  function stop() {
    stoppedRef.current = true;
    abortStream();
  }

  const suggestions = [
    labels.threadSuggestion1,
    labels.threadSuggestion2,
    labels.threadSuggestion3,
  ];
  const canSend = draft.trim().length > 0;

  return (
    <section
      ref={sectionRef}
      className="flex flex-col gap-3 border-t border-border pt-4 mt-1"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground/80">
          {labels.threadHeading}
        </h3>
        {turns.length > 0 && (
          <span className="text-[11px] text-muted-foreground/60">
            {labels.threadEphemeral}
          </span>
        )}
      </div>

      {/* Suggested starters — they teach what the thread is for better
          than instruction prose ever did. */}
      {turns.length === 0 && (
        <div className="flex flex-wrap gap-1.5">
          {suggestions.map((s) => (
            <button
              key={s}
              type="button"
              disabled={busy}
              onClick={() => void send(s)}
              className="rounded-full border border-border bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50"
            >
              {s}
            </button>
          ))}
        </div>
      )}

      {turns.length > 0 && (
        <div className="flex flex-col gap-3" aria-live="polite">
          {turns.map((turn, i) => {
            if (turn.role === "user") {
              return (
                <div
                  key={i}
                  className="self-end max-w-[85%] rounded-lg bg-muted px-3 py-1.5 text-sm whitespace-pre-wrap break-words"
                >
                  {turn.text}
                </div>
              );
            }
            const isLast = i === turns.length - 1;
            const streamingThis = isLast && busy;
            const awaitingText = streamingThis && turn.text.length === 0;
            return (
              <div key={i} className="flex gap-2.5">
                <div className="shrink-0 pt-0.5">
                  {assistant ? (
                    <AssistantAvatar
                      id={assistant.id}
                      name={assistant.name}
                      size="sm"
                    />
                  ) : (
                    <div className="size-7 rounded-full bg-muted" aria-hidden />
                  )}
                </div>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <div className="text-xs font-medium text-foreground/80">
                    {assistant?.name ?? review.connecting}
                  </div>

                  {turn.tools.length > 0 && (
                    <div className="flex flex-wrap gap-1">
                      {turn.tools.map((tool) => (
                        <span
                          key={tool.id}
                          className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground"
                        >
                          {tool.status === "running" ? (
                            <Loader2
                              className="size-3 animate-spin"
                              aria-hidden
                            />
                          ) : (
                            <Check
                              className="size-3 text-emerald-500"
                              aria-hidden
                            />
                          )}
                          {narration[tool.name] ??
                            format(narration.generic, { name: tool.name })}
                        </span>
                      ))}
                    </div>
                  )}

                  {awaitingText ? (
                    <div className="text-sm text-muted-foreground italic truncate">
                      {reasoningTail || review.thinking}
                    </div>
                  ) : turn.failed ? (
                    <p className="text-sm text-red-500 whitespace-pre-wrap break-words">
                      {turn.text}
                    </p>
                  ) : (
                    <div className="chat-markdown text-sm leading-relaxed break-words">
                      <ChatMarkdown text={turn.text} />
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {sessionError && (
        <p className="text-xs text-red-500" role="alert">
          {review.askError} {sessionError}
        </p>
      )}

      <div className="flex flex-col gap-1.5">
        {/* Composite field: the box draws the focus ring, the inner
            textarea opts out of the global :focus-visible ring
            (globals.css convention; see page-comments.tsx). */}
        <div className="flex items-end gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 transition-[border-color,box-shadow,background-color] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30 focus-within:bg-background">
          <textarea
            ref={composerRef}
            value={draft}
            rows={1}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                void send(draft);
              }
              if (e.key === "Escape") {
                // Blur the composer without letting the drawer's global
                // Escape-close fire.
                e.stopPropagation();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            placeholder={review.askInputPlaceholder}
            className="max-h-40 flex-1 resize-none field-sizing-content bg-transparent text-sm outline-none focus-visible:shadow-none placeholder:text-muted-foreground/60"
          />
          {busy ? (
            <button
              type="button"
              onClick={stop}
              aria-label={labels.threadStop}
              title={labels.threadStop}
              className="mb-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full bg-foreground/80 text-background transition-opacity hover:opacity-90"
            >
              <Square className="size-2.5" fill="currentColor" aria-hidden />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => void send(draft)}
              disabled={!canSend}
              aria-label={review.send}
              className={cn(
                "mb-0.5 inline-flex size-6 shrink-0 items-center justify-center rounded-full transition-colors",
                canSend
                  ? "bg-primary text-primary-foreground hover:bg-primary/90"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <ArrowUp className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
        <p className="text-[11px] text-muted-foreground/60">
          {labels.threadDisclosure}
        </p>
      </div>

      {/* Auto-follow sentinel — while visible, streaming keeps the thread
          pinned; scrolling up detaches until the user returns. */}
      <div ref={bottomRef} aria-hidden />
    </section>
  );
}
