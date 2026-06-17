"use client";

/**
 * Read-only page **History** — a top-bar button (clock glyph) that opens the
 * page's past comment threads (each thread = a chat session) as **read-only
 * transcripts**: a list of conversations → click one → its full message log,
 * with no composer, resolve, or reply.
 *
 * Distinct from `comment-thread-list.tsx` (the interactive comment *index*,
 * which lives in the editor band and opens a thread to reply / jump to its
 * live anchor). History is a viewer for iterations that already happened —
 * mostly resolved comments — surfaced from the page chrome. **Read-only for
 * now** (reopen / jump-to-anchor are deliberate follow-ups).
 *
 * Self-contained, exactly like `comment-thread-list`: it owns its own
 * `listPageThreads({ includeResolved })`, assistant-identity, and per-session
 * `fetchSessionMessages` fetches — all **lazy** (nothing loads until the panel
 * is opened), so the page-header stays pure chrome and only forwards `pageId`,
 * `assistantId`, and the current user.
 *
 * [COMP:app-web/comment-history]
 */

import * as React from "react";
import { History as HistoryIcon, ChevronLeft } from "lucide-react";
import { ChatMarkdown } from "@sidanclaw/chat-ui";
import { useT } from "@/lib/i18n/client";
import { listPageThreads, type CommentThread } from "@/lib/api/comments";
import {
  fetchSessionMessages,
  parseMessageAttachments,
  type DocSessionMessage,
} from "@/lib/api/sessions";
import { getAssistantIdentity, type AssistantIdentity } from "@/lib/api/views";
import {
  ThreadGutter,
  resolveCommentAuthor,
  relativeTime,
  visibleComments,
  type CommentAuthor,
} from "@/components/doc/comment-thread-body";
import { quoteForRow } from "@/components/doc/comment-quote";
import { commentThreadLabel } from "@/components/doc/comment-thread-list";
import { MessageAttachments } from "@/components/doc/message-attachment-card";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  orderHistoryThreads,
  historyThreadStatus,
} from "./comment-history-threads";

type CommentsDict = ReturnType<typeof useT>["comments"];

type Props = {
  /** The active page id (`view.id`). */
  pageId: string;
  /** The workspace's doc assistant — resolves the assistant identity for
   *  attribution. Absent (no doc assistant yet) → assistant rows fall back
   *  to the generic name. */
  assistantId?: string;
  /** The viewer, so their own rows read as their name (not the raw sender). */
  currentUser: { id: string; name: string; avatarUrl?: string | null };
  /**
   * The page's genesis prompt (migration 231) — the message that created it.
   * Rendered read-only at the top of the list as the "first prompt". Absent /
   * null → no origin entry. Distinct from the comment threads below, which are
   * the page's specific follow-up conversations.
   */
  originPrompt?: string | null;
};

export function CommentHistory({
  pageId,
  assistantId,
  currentUser,
  originPrompt,
}: Props) {
  const t = useT().comments;
  const [open, setOpen] = React.useState(false);
  const [threads, setThreads] = React.useState<CommentThread[] | null>(null);
  const [assistant, setAssistant] = React.useState<AssistantIdentity | null>(
    null,
  );
  const [active, setActive] = React.useState<CommentThread | null>(null);

  // Lazy load — nothing is fetched until the panel is first opened (mirrors
  // comment-thread-list). Refetches on each open so a thread resolved since
  // the last look shows without a page reload.
  React.useEffect(() => {
    if (!open || !pageId) return;
    let cancelled = false;
    void listPageThreads(pageId, { includeResolved: true }).then((rows) => {
      if (!cancelled) setThreads(orderHistoryThreads(rows));
    });
    return () => {
      cancelled = true;
    };
  }, [open, pageId]);

  React.useEffect(() => {
    if (!open || !assistantId) return;
    let cancelled = false;
    void getAssistantIdentity(assistantId).then((a) => {
      if (!cancelled) setAssistant(a);
    });
    return () => {
      cancelled = true;
    };
  }, [open, assistantId]);

  // Closing the panel returns it to the list, so re-opening never lands deep
  // in a stale transcript.
  React.useEffect(() => {
    if (!open) setActive(null);
  }, [open]);

  const assistantAuthor: CommentAuthor = {
    id: assistant?.id ?? assistantId ?? "assistant",
    name: assistant?.name ?? t.assistantName,
    isAssistant: true,
    iconSeed: assistant?.iconSeed ?? null,
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        className="inline-flex size-8 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground aria-expanded:bg-muted"
        aria-label={t.history.buttonAria}
        title={t.history.buttonAria}
      >
        <HistoryIcon className="size-4" aria-hidden />
      </PopoverTrigger>
      <PopoverContent
        side="bottom"
        align="end"
        className="flex max-h-[70vh] w-[380px] flex-col overflow-hidden p-0"
      >
        {active ? (
          <HistoryTranscript
            thread={active}
            assistant={assistantAuthor}
            currentUser={currentUser}
            onBack={() => setActive(null)}
            t={t}
          />
        ) : (
          <HistoryList
            threads={threads}
            originPrompt={originPrompt}
            onPick={setActive}
            t={t}
          />
        )}
      </PopoverContent>
    </Popover>
  );
}

/** The master view: the page's genesis prompt (when present) pinned read-only
 *  at the top, then every thread on the page, most-recent first, each a row
 *  with its label + status chip + relative time. Exported for the SSR unit
 *  test (the popover panel itself is web-QA territory). */
export function HistoryList({
  threads,
  originPrompt,
  onPick,
  t,
}: {
  threads: CommentThread[] | null;
  originPrompt?: string | null;
  onPick: (thread: CommentThread) => void;
  t: CommentsDict;
}) {
  return (
    <>
      <header className="shrink-0 border-b border-border px-3 py-2.5">
        <div className="text-sm font-semibold text-foreground">
          {t.history.title}
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {t.history.subtitle}
        </p>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {/* The page's genesis prompt — pinned above the comment threads,
            read-only. The threads below are the page's specific follow-up
            conversations; this is "how the page started". Scrolls with the
            list so a long prompt stays fully readable. */}
        {originPrompt ? (
          <div className="mb-1 rounded-md border border-border/70 bg-muted/40 px-2.5 py-2">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t.history.originLabel}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-[13px] leading-snug text-foreground">
              {originPrompt}
            </p>
          </div>
        ) : null}
        {threads === null ? (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            {t.history.loading}
          </p>
        ) : threads.length === 0 ? (
          // With an origin entry present the panel isn't empty — suppress the
          // "no conversations" caption so it doesn't read as a contradiction.
          originPrompt ? null : (
            <p className="px-2 py-6 text-center text-xs text-muted-foreground">
              {t.history.empty}
            </p>
          )
        ) : (
          <ul>
            {threads.map((th) => (
              <li key={th.id}>
                <button
                  type="button"
                  onClick={() => onPick(th)}
                  className="flex w-full flex-col gap-1 rounded-md px-2 py-2 text-left hover:bg-accent"
                >
                  <span className="flex items-center justify-between gap-2">
                    <span className="truncate text-sm text-foreground">
                      {commentThreadLabel(th, t.popoverTitle)}
                    </span>
                    <StatusChip thread={th} t={t} />
                  </span>
                  <span className="text-[11px] text-muted-foreground">
                    {relativeTime(th.resolvedAt ?? th.createdAt, t.justNow)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </>
  );
}

/** The detail view: one thread's full conversation, rendered read-only with
 *  the same attribution + markdown the live thread uses (no composer/resolve).
 *  Mirrors `comment-thread-body`'s row layout so a transcript reads identically
 *  to the live thread. */
function HistoryTranscript({
  thread,
  assistant,
  currentUser,
  onBack,
  t,
}: {
  thread: CommentThread;
  assistant: CommentAuthor;
  currentUser: { id: string; name: string; avatarUrl?: string | null };
  onBack: () => void;
  t: CommentsDict;
}) {
  const [messages, setMessages] = React.useState<DocSessionMessage[] | null>(
    null,
  );

  React.useEffect(() => {
    let cancelled = false;
    setMessages(null);
    const controller = new AbortController();
    void fetchSessionMessages(thread.sessionId, {
      signal: controller.signal,
    }).then((rows) => {
      // fetchSessionMessages resolves [] on abort/error; an aborted call must
      // not paint over the load (StrictMode double-mount), so ignore it.
      if (cancelled || controller.signal.aborted) return;
      setMessages(rows);
    });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [thread.sessionId]);

  const visible = messages ? visibleComments(messages) : [];

  return (
    <>
      <header className="flex shrink-0 items-center gap-1.5 border-b border-border px-2 py-2">
        <button
          type="button"
          onClick={onBack}
          aria-label={t.history.back}
          title={t.history.back}
          className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
          {commentThreadLabel(thread, t.popoverTitle)}
        </span>
        <StatusChip thread={thread} t={t} />
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-3">
        {thread.quote ? (
          <div className="mb-3 border-l-2 border-amber-400 pl-2.5 text-[13px] leading-snug text-muted-foreground">
            <span className="line-clamp-2">{thread.quote}</span>
          </div>
        ) : null}
        {messages === null ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t.history.loading}
          </p>
        ) : visible.length === 0 ? (
          <p className="py-6 text-center text-xs text-muted-foreground">
            {t.emptyThread}
          </p>
        ) : (
          visible.map((m, i) => {
            const a = resolveCommentAuthor(m, { currentUser, assistant });
            const parsed = parseMessageAttachments(m.content);
            const rowQuote = quoteForRow(parsed.text, a.isAssistant);
            return (
              <div key={m.id} className="flex gap-2.5">
                <ThreadGutter author={a} connect={i < visible.length - 1} />
                <div className="min-w-0 flex-1 pb-4">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[14px] font-semibold text-foreground">
                      {a.name}
                    </span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      {relativeTime(m.timestamp, t.justNow)}
                    </span>
                  </div>
                  <MessageAttachments attachments={parsed.attachments} />
                  {rowQuote.quote ? (
                    <div className="mt-1 border-l-2 border-amber-400 pl-2.5 text-[13px] leading-snug text-muted-foreground">
                      <span className="line-clamp-3 whitespace-pre-wrap">
                        {rowQuote.quote}
                      </span>
                    </div>
                  ) : null}
                  {parsed.text ? (
                    a.isAssistant ? (
                      <div className="chat-markdown mt-1 break-words text-[14px] leading-relaxed text-foreground">
                        <ChatMarkdown text={parsed.text} />
                      </div>
                    ) : (
                      <div className="mt-1 whitespace-pre-wrap text-[14px] leading-relaxed text-foreground">
                        {rowQuote.body}
                      </div>
                    )
                  ) : null}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

function StatusChip({ thread, t }: { thread: CommentThread; t: CommentsDict }) {
  const resolved = historyThreadStatus(thread) === "resolved";
  return (
    <span
      className={`shrink-0 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
        resolved
          ? "bg-muted text-muted-foreground"
          : "bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
      }`}
    >
      {resolved ? t.resolved : t.history.open}
    </span>
  );
}
