"use client";


/**
 * EntryThread — the entry page's inline Q&A thread (the Notion "Comments"
 * analog for a brain entry). Renders as the last section of the
 * BrainDetailDrawer: suggested-question chips while empty, comment-style
 * turns once started (assistant = avatar + name + tool-activity chips +
 * markdown; user = quiet right-aligned bubble), and an always-visible
 * composer whose send button morphs into Stop while a turn streams.
 *
 * Transport is the shared conversation controller (M5 WP-E): the thread is a
 * presentation of its inspection session's registry entry
 * (`review-thread-conversation.ts`, dock transcript profile). The controller
 * owns send, the mid-turn queue (queue + steer), the compare-and-set Stop,
 * the re-attach after a dropped stream and the per-turn transcript; `text_delta`
 * grows the answer, `reasoning` feeds the live thinking line (never the answer
 * body), tool frames drive the activity chips (labels from
 * `t.chat.toolNarration`). The thread auto-follows the stream only while its
 * bottom sentinel is visible (scrolling up detaches).
 *
 * Tool activity stays compact: past `TOOL_CHIP_COLLAPSE_THRESHOLD` chips,
 * finished tools fold into one expandable "{count} steps" summary chip
 * (`partitionToolChips`) — while streaming only the currently-running
 * tools render individually, so a deep-research turn never buries the
 * answer under four rows of done-chips.
 *
 * The first message's preamble is primed with what the page already
 * knows — the Source section's origin clue (fetched via the cheap
 * `explain` endpoint, in parallel with session creation) and the row's
 * created/updated timestamps — so the model answers "why was this
 * saved?" from context instead of spelunking the workspace with a dozen
 * read-only tool calls, and says plainly when no source was recorded.
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

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowUp, Check, ChevronDown, Loader2, Square } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { ChatMarkdown, type Message, type ToolUsed } from "@use-brian/chat-ui";
import type { ConversationSendResult, ConversationState } from "@/lib/chat/conversation-controller";
import { QueuedInputs } from "@/components/ui/queued-inputs";
import { chatMarkdownCodeComponents } from "@/components/chrome/chat-code-block";
import { originClue } from "./source-origin";
import {
  latestNotice,
  reviewThreadView,
  stripReviewPreamble,
  useReviewConversation,
} from "./review-thread-conversation";
import {
  createInspectionSession,
  explainBrainRow,
  type BrainPrimitive,
  type ExplainContext,
  type InspectionSession,
} from "@/lib/api/brain-inbox";

const CLIENT_TIMEZONE = (() => {
  try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch { return undefined; }
})();

/**
 * Model-facing context block prefixed to the thread's first message.
 * Generalised from the old memory-only preamble: the thread covers every
 * entry kind (task / memory / file / CRM / entity).
 *
 * `context` primes the model with what the page already shows so it
 * answers provenance questions from here instead of tool-hunting:
 * `originLine` is the Source section's clue — a string when an origin
 * resolved, `null` when the explain endpoint answered but no source was
 * ever recorded (the model must say so rather than search), `undefined`
 * when we couldn't fetch it (say nothing, let the model look).
 */
export function buildEntryPreamble(
  summary: string,
  detail: string | null,
  context?: {
    createdAt?: string;
    updatedAt?: string;
    originLine?: string | null;
  },
): string {
  const detailLine = detail ? `\nDetail: ${detail}` : "";
  let known = "";
  if (context?.createdAt) {
    const updated =
      context.updatedAt && context.updatedAt !== context.createdAt
        ? ` · Last updated: ${context.updatedAt}`
        : "";
    known += `Created: ${context.createdAt}${updated}\n`;
  }
  if (context?.originLine) {
    known += `Source (already shown on the page): ${context.originLine}\n`;
  } else if (context && context.originLine === null) {
    known +=
      `Source: none recorded. The platform did not capture where this ` +
      `entry came from (entries saved before source tracking shipped ` +
      `carry no source). If the user asks where it came from, say that ` +
      `plainly instead of searching for it.\n`;
  }
  return (
    `[Entry review context]\n` +
    `The user is reviewing a brain entry on its detail page:\n` +
    `Summary: ${summary}${detailLine}\n` +
    known +
    `\n` +
    `Help the user understand this entry: why it exists, whether it is ` +
    `right, and what it connects to. You are read-only here; you cannot ` +
    `save, delete, or modify entries. The user edits directly on the page. ` +
    `Be brief and concrete. Lean on the context above before reaching ` +
    `for tools; a couple of targeted lookups beats a broad sweep.\n\n` +
    `[User asks]\n`
  );
}

/** Fold ceiling for the tool-activity strip — past this many chips the
 *  finished tools collapse into one "{count} steps" summary chip. */
export const TOOL_CHIP_COLLAPSE_THRESHOLD = 3;

/**
 * Pure fold decision for the tool-activity strip. At or under the
 * threshold every chip renders. Over it, finished tools fold into the
 * summary chip: while streaming the currently-running tools stay visible
 * next to it; once the turn settles everything folds. `expanded` reveals
 * the full list (the summary chip is the toggle). `foldedCount` is the
 * number of chips the summary chip stands for — stable across the
 * expand/collapse toggle so the label doesn't jump.
 */
export function partitionToolChips(
  tools: ToolUsed[],
  opts: { streaming: boolean; expanded: boolean },
): { visible: ToolUsed[]; foldedCount: number } {
  if (tools.length <= TOOL_CHIP_COLLAPSE_THRESHOLD) {
    return { visible: tools, foldedCount: 0 };
  }
  const running = opts.streaming
    ? tools.filter((tool) => tool.status === "running")
    : [];
  return {
    visible: opts.expanded ? tools : running,
    foldedCount: tools.length - running.length,
  };
}

/** How a settled turn reads when it produced no reply of its own. */
type EntryTurnOutcome = {
  /** The user turn the outcome answers. */
  afterMessageId: string;
  kind: "stopped" | "failed" | "empty";
  /** Server or transport text for a failed turn. */
  detail?: string;
};

/**
 * Pure outcome of one settled send: a stopped, failed or empty turn renders
 * a stand-in reply under its question (the thread never shows a silent gap).
 * A turn that committed a reply needs none, except that a failure is still
 * stated under the partial reply.
 */
export function entryTurnOutcome(
  result: ConversationSendResult,
  state: ConversationState | null,
): EntryTurnOutcome | null {
  if (!state || (result !== "stopped" && result !== "failed" && result !== "completed")) return null;
  const messages = state.transcript.messages;
  let userIndex = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (messages[index]!.role === "user") { userIndex = index; break; }
  }
  if (userIndex < 0) return null;
  const answered = messages.slice(userIndex + 1).some((message) => message.role === "assistant" && message.text.trim().length > 0);
  const afterMessageId = messages[userIndex]!.id;
  if (result === "failed") {
    const notice = latestNotice(state, ["error"]);
    const detail = notice?.code === "error" ? notice.message ?? notice.errorCode : undefined;
    return { afterMessageId, kind: "failed", ...(detail ? { detail } : {}) };
  }
  if (answered) return null;
  return { afterMessageId, kind: result === "stopped" ? "stopped" : "empty" };
}

type Props = {
  workspaceId: string;
  primitive: BrainPrimitive;
  rowId: string;
  entrySummary: string;
  entryDetail: string | null;
  /** Row audit timestamps (ISO) — primed into the first message's
   *  preamble so the model never tool-hunts for them. */
  entryCreatedAt?: string;
  entryUpdatedAt?: string;
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
  entryCreatedAt,
  entryUpdatedAt,
  focusTick,
}: Props) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const review = t.memoriesReview;
  const tQueue = t.chat.queue;

  const [draft, setDraft] = useState("");
  const [sessionError, setSessionError] = useState<string | null>(null);
  // The question shown while the inspection session is being minted, before
  // the controller turn (and its optimistic user bubble) exists.
  const [minting, setMinting] = useState<string | null>(null);
  const [outcomes, setOutcomes] = useState<readonly EntryTurnOutcome[]>([]);

  // The session is identity for the whole thread — once created it sticks,
  // even if an inline edit re-anchors `rowId` to a superseded row's new id.
  const sessionRef = useRef<InspectionSession | null>(null);
  const [boundSessionId, setBoundSessionId] = useState<string | null>(null);
  const [assistant, setAssistant] = useState<{ id: string; name: string } | null>(
    null,
  );

  const { controller, state, sendBound, currentController } = useReviewConversation({
    workspaceId,
    sessionId: boundSessionId,
    kind: "entry-thread",
    // Uncertain queued text comes back to the composer; never resent.
    onUnsent: (texts) => {
      const restored = texts.join("\n\n");
      setDraft((current) => (current.trim() ? `${current}\n\n${restored}` : restored));
    },
  });
  const view = reviewThreadView(state);
  const busy = view.busy || minting !== null;
  const stopFailed = latestNotice(state, ["stopTurnFailed"]) !== null;
  const reconnectNotice = latestNotice(state, ["reconnecting", "reconnectFailed"]);

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

  // The controller's turn has begun: its own user bubble replaces the
  // minting placeholder.
  useEffect(() => {
    if (minting !== null && view.busy) setMinting(null);
  }, [minting, view.busy]);

  // Follow the stream while pinned (each publication is one paint).
  useEffect(() => {
    if (followRef.current) bottomRef.current?.scrollIntoView({ block: "nearest" });
  }, [view.messages.length, view.streamingText, view.liveTools.length, minting]);

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

  // Explain context for the preamble — fetched once, in parallel with the
  // session mint (both cheap; no LLM). `undefined` = never fetched,
  // `null` = fetch failed (the preamble stays silent about provenance).
  const explainRef = useRef<ExplainContext | null | undefined>(undefined);
  async function fetchExplainOnce(): Promise<ExplainContext | null> {
    if (explainRef.current !== undefined) return explainRef.current;
    const ctx = await explainBrainRow(workspaceId, primitive, rowId).catch(
      () => null,
    );
    explainRef.current = ctx;
    return ctx;
  }

  async function send(raw: string, steer = false) {
    const text = raw.trim();
    if (text.length === 0) return;
    // A turn is already running: hand this to it rather than dropping it.
    // See docs/architecture/engine/mid-turn-input.md.
    if (busy) {
      if (controller?.queue(text, steer, { bodyExtras: CLIENT_TIMEZONE ? { timezone: CLIENT_TIMEZONE } : {} })) setDraft("");
      return;
    }
    setDraft("");
    setSessionError(null);
    setMinting(text);
    followRef.current = true;

    const isFirst = view.messages.length === 0;
    const [session, explain] = await Promise.all([
      ensureSession(),
      isFirst ? fetchExplainOnce() : Promise.resolve(null),
    ]);
    if (!session) {
      // Session creation failed — withdraw the placeholder so the chips
      // return, restore the draft, and let the error line explain.
      setMinting(null);
      setDraft(text);
      return;
    }
    setBoundSessionId(session.sessionId);
    const messageBody = isFirst
      ? buildEntryPreamble(entrySummary, entryDetail, {
          createdAt: entryCreatedAt,
          updatedAt: entryUpdatedAt,
          // Fetch failed → undefined (silence); fetched → the Source
          // section's clue, or null when no origin was ever recorded.
          originLine: explain
            ? originClue(
                explain.origin,
                review,
                explain.savedAt,
                explain.savedByAssistantName,
              )
            : undefined,
        }) + text
      : text;
    const result = await sendBound(session.sessionId, {
      text: messageBody,
      assistantId: session.assistantId,
      bodyExtras: CLIENT_TIMEZONE ? { timezone: CLIENT_TIMEZONE } : {},
      // Failed before the server accepted it: the question returns to the
      // composer; nothing is resent automatically.
      onRejected: () => setDraft((current) => (current.trim() ? current : text)),
    });
    setMinting(null);
    if (result === "busy" || result === "invalid") {
      setDraft((current) => (current.trim() ? current : text));
      return;
    }
    const bound = currentController();
    const snapshot = bound?.getSessionId() === session.sessionId ? bound.getSnapshot() : null;
    const outcome = entryTurnOutcome(result, snapshot);
    if (outcome) {
      setOutcomes((current) => [...current.filter((item) => item.afterMessageId !== outcome.afterMessageId), outcome]);
    } else if (result === "failed") {
      const notice = latestNotice(snapshot, ["error"]);
      setSessionError(notice?.code === "error" ? notice.message ?? notice.errorCode : review.askEmptyResponse);
    }
  }

  // One Stop entry point: the controller's compare-and-set Stop. The server
  // turn ends, not just this renderer's stream (M5 WP-E fixed the former
  // local-abort-only Stop).
  function stop() {
    void controller?.stop();
  }

  const suggestions = [
    labels.threadSuggestion1,
    labels.threadSuggestion2,
    labels.threadSuggestion3,
  ];
  const canSend = draft.trim().length > 0;
  const hasTurns = view.messages.length > 0 || busy;
  const outcomeText = (outcome: EntryTurnOutcome) =>
    outcome.kind === "stopped"
      ? labels.threadStopped
      : outcome.kind === "empty"
        ? review.askEmptyResponse
        : `${review.askError} ${outcome.detail ?? ""}`.trim();

  const renderAssistant = (
    key: string,
    body: ReactNode,
    tools: ToolUsed[],
    streaming: boolean,
  ) => (
    <div key={key} className="flex gap-2.5">
      <div className="shrink-0 pt-0.5">
        {assistant ? (
          <AssistantAvatar id={assistant.id} name={assistant.name} size="sm" />
        ) : (
          <div className="size-7 rounded-full bg-muted" aria-hidden />
        )}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="text-xs font-medium text-foreground/80">
          {assistant?.name ?? review.connecting}
        </div>
        {tools.length > 0 && <ToolActivity tools={tools} streaming={streaming} />}
        {body}
      </div>
    </div>
  );

  const renderMessage = (message: Message) => {
    if (message.role === "user") {
      return (
        <div
          key={message.id}
          className="self-end max-w-[85%] rounded-lg bg-muted px-3 py-1.5 text-sm whitespace-pre-wrap break-words"
        >
          {stripReviewPreamble(message.text)}
        </div>
      );
    }
    return renderAssistant(
      message.id,
      <div className="chat-markdown text-sm leading-relaxed break-words">
        <ChatMarkdown text={message.text} components={chatMarkdownCodeComponents} />
      </div>,
      message.toolsUsed ?? [],
      false,
    );
  };

  return (
    <section
      ref={sectionRef}
      className="flex flex-col gap-3 border-t border-border pt-4 mt-1"
    >
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="text-sm font-medium text-foreground/80">
          {labels.threadHeading}
        </h3>
        {hasTurns && (
          <span className="text-[11px] text-muted-foreground/60">
            {labels.threadEphemeral}
          </span>
        )}
      </div>

      {/* Suggested starters — they teach what the thread is for better
          than instruction prose ever did. */}
      {!hasTurns && (
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

      {hasTurns && (
        <div className="flex flex-col gap-3" aria-live="polite">
          {view.messages.flatMap((message, index) => {
            const nodes = [renderMessage(message)];
            // A stand-in reply closes its turn: after the turn's last row
            // (a failure reads under the partial reply it ended).
            const turnEnds = view.messages[index + 1]?.role !== "assistant";
            if (!turnEnds) return nodes;
            let question: Message | undefined;
            for (let at = index; at >= 0; at--) {
              if (view.messages[at]!.role === "user") { question = view.messages[at]; break; }
            }
            const outcome = question ? outcomes.find((item) => item.afterMessageId === question!.id) : undefined;
            if (outcome) {
              nodes.push(renderAssistant(`outcome-${outcome.afterMessageId}`, (
                <p className={cn("text-sm whitespace-pre-wrap break-words", outcome.kind === "failed" ? "text-red-500" : "text-muted-foreground")}>
                  {outcomeText(outcome)}
                </p>
              ), [], false));
            }
            return nodes;
          })}
          {minting !== null && (
            <div className="self-end max-w-[85%] rounded-lg bg-muted px-3 py-1.5 text-sm whitespace-pre-wrap break-words">
              {minting}
            </div>
          )}
          {busy && renderAssistant(
            "live",
            view.streamingText ? (
              <div className="chat-markdown text-sm leading-relaxed break-words">
                <ChatMarkdown text={view.streamingText} components={chatMarkdownCodeComponents} />
              </div>
            ) : (
              <div className="text-sm text-muted-foreground italic truncate">
                {view.reasoningTail || review.thinking}
              </div>
            ),
            view.liveTools,
            true,
          )}
        </div>
      )}

      {sessionError && (
        <p className="text-xs text-red-500" role="alert">
          {review.askError} {sessionError}
        </p>
      )}
      {reconnectNotice ? (
        <p className="text-xs text-muted-foreground" role="status">
          {reconnectNotice.code === "reconnecting" ? t.chat.turnReconnecting : t.chat.turnReconnectFailed}
        </p>
      ) : null}
      {stopFailed ? (
        <p className="text-xs text-red-500" role="alert">
          {t.chatApp.stopTurnFailed}
        </p>
      ) : null}

      {/* Follow-ups handed to the running turn, not yet taken by it.
          See docs/architecture/engine/mid-turn-input.md. */}
      <QueuedInputs
        inputs={state?.queued ? [...state.queued] : []}
        dict={tQueue}
        onSteer={(inputId) => void controller?.steer(inputId)}
      />

      <div className="flex flex-col gap-1.5">
        {/* Composite field: the box draws the focus ring, the inner
            textarea opts out of the global :focus-visible ring
            (globals.css convention; see page-comments.tsx). */}
        <div className="flex items-end gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 transition-[border-color,box-shadow,background-color] focus-within:border-ring focus-within:bg-background [&_:focus-visible]:shadow-none">
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
                // Cmd/Ctrl+Enter steers a running turn (mid-turn-input.md).
                void send(draft, busy && (e.metaKey || e.ctrlKey));
              }
              if (e.key === "Escape") {
                // Blur the composer without letting the drawer's global
                // Escape-close fire.
                e.stopPropagation();
                (e.target as HTMLTextAreaElement).blur();
              }
            }}
            placeholder={review.askInputPlaceholder}
            className="max-h-40 flex-1 resize-none field-sizing-content bg-transparent text-[16px] md:text-sm outline-none focus-visible:shadow-none placeholder:text-muted-foreground/60"
          />
          {/* The soft keyboard's return inserts a newline, so the tap target
              is the touch path: `size-11 sm:size-6` (C 16 / M3). */}
          {view.busy && (
            <button
              type="button"
              onClick={stop}
              disabled={state?.run.stopRequested === true}
              aria-label={labels.threadStop}
              title={labels.threadStop}
              className="mb-0.5 inline-flex size-11 sm:size-6 shrink-0 items-center justify-center rounded-full bg-foreground/80 text-background transition-opacity hover:opacity-90 disabled:opacity-60"
            >
              <Square className="size-2.5" fill="currentColor" aria-hidden />
            </button>
          )}
          {/* Send stays live during a turn — it QUEUES into the running one
              (muted to mark the difference). See mid-turn-input.md. */}
          <button
            type="button"
            onClick={() => void send(draft)}
            disabled={!canSend}
            aria-label={busy ? tQueue.send : review.send}
            title={busy ? tQueue.send : review.send}
            className={cn(
              "mb-0.5 inline-flex size-11 sm:size-6 shrink-0 items-center justify-center rounded-full transition-colors",
              !canSend
                ? "bg-muted text-muted-foreground"
                : busy
                  ? "bg-muted text-foreground/80 hover:bg-muted/80"
                  : "bg-action text-action-foreground hover:bg-action/90",
            )}
          >
            <ArrowUp className="size-3.5" aria-hidden />
          </button>
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

/**
 * The turn's tool-activity strip. Under the fold threshold it renders the
 * classic per-tool chips; over it, finished tools collapse into a single
 * "{count} steps" summary chip that toggles the full list — while a turn
 * streams, the currently-running tools stay visible beside the summary so
 * live progress never disappears.
 */
function ToolActivity({
  tools,
  streaming,
}: {
  tools: ToolUsed[];
  streaming: boolean;
}) {
  const t = useT();
  const labels = t.brainPage.detailDrawer;
  const narration = t.chat.toolNarration as Record<string, string>;
  const [expanded, setExpanded] = useState(false);
  const { visible, foldedCount } = partitionToolChips(tools, {
    streaming,
    expanded,
  });

  return (
    <div className="flex flex-wrap gap-1">
      {foldedCount > 0 && (
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          aria-expanded={expanded}
          className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <Check className="size-3 text-emerald-500" aria-hidden />
          {format(labels.threadToolsSummary, { count: foldedCount })}
          <ChevronDown
            className={cn("size-3 transition-transform", expanded && "rotate-180")}
            aria-hidden
          />
        </button>
      )}
      {visible.map((tool) => (
        <span
          key={tool.id}
          className="inline-flex items-center gap-1 rounded-full bg-muted/60 px-2 py-0.5 text-[11px] text-muted-foreground"
        >
          {tool.status === "running" ? (
            <Loader2 className="size-3 animate-spin" aria-hidden />
          ) : (
            <Check className="size-3 text-emerald-500" aria-hidden />
          )}
          {narration[tool.name] ??
            format(narration.generic, { name: tool.name })}
        </span>
      ))}
    </div>
  );
}
