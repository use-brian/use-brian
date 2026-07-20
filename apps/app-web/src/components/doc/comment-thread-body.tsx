"use client";

/**
 * Comment thread body — the expanded thread content shared by the two shells
 * that can host it: the on-content overlay (`comment-thread-popover.tsx`, used
 * on narrow viewports) and the always-on margin rail (`comment-rail.tsx`, used
 * when there's room beside the page column).
 *
 * It owns everything stateful about a thread — loading the comments via
 * `fetchSessionMessages`, streaming an AI reply through `/api/chat`, resolving —
 * and renders the resolve affordance, the scrollable message list, and the
 * Notion-style composer. Positioning, the outer card chrome, and the
 * compress-to-fit `maxHeight` are the wrapper's job; the body only assumes it
 * lives inside a `flex flex-col` box (its message list is `flex-1 min-h-0` so
 * it shrinks and scrolls, the composer is `shrink-0` so it stays pinned).
 *
 * [COMP:app-web/comment-thread-body]
 */

import * as React from "react";
import { ArrowUp, Paperclip, Check, X } from "lucide-react";
import { parseSSEStream, createSSEBuffer, ChatMarkdown } from "@use-brian/chat-ui";
import { authFetch } from "@/lib/auth-fetch";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { ThreadGutter, relativeTime, type CommentAuthor } from "./comment-primitives";
import {
  fetchSessionMessages,
  extractMessageText,
  parseMessageAttachments,
  stripCommentThreadReplyTag,
  type DocSessionMessage,
} from "@/lib/api/sessions";
import { MessageAttachments } from "@/components/doc/message-attachment-card";
import { ComposerControls, useComposerControls } from "@/components/doc/composer-controls";
import { CommentComposer } from "@/components/doc/comment-composer";
import { PreviewMarkdown } from "@/components/doc/preview-markdown";
import { type ModelTier } from "@/lib/chat-model";
import { setThreadResolved, addCommentMessage, type CommentThread } from "@/lib/api/comments";
import { recordDocMention } from "@/lib/api/inbox";
import { type AssistantIdentity } from "@/lib/api/views";
import { AttachmentChips, FileDropOverlay } from "@/components/doc/attachment-chips";
import { pinnedToBottom } from "@/components/doc/comment-scroll";
import { shouldReconnectToTurn } from "@/components/doc/comment-reconnect";
import { CommentQuoteReply } from "@/components/doc/comment-quote-reply";
import { composeQuotedBody, quoteForRow } from "@/components/doc/comment-quote";
import { useFileAttachments } from "@/lib/use-file-attachments";
import { useRecordingUpload } from "@/lib/recordings/use-recording-upload";
import { useFileDrop } from "@/lib/use-file-drop";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:4000";

// The presentational atoms (`Avatar`, `AuthorAvatar`, `ThreadGutter`,
// `relativeTime`, and the `CommentAuthor` type) now live in
// `./comment-primitives` so the read-only public share view can render an
// IDENTICAL comment card without pulling this module's chat/auth deps. They're
// re-exported here so the editor surfaces (comment-rail) + inbox-panel keep
// their existing `from "./comment-thread-body"` import paths unchanged.
export { Avatar, AuthorAvatar, ThreadGutter, relativeTime } from "./comment-primitives";
export type { CommentAuthor } from "./comment-primitives";

/** Resolve the author identity for a thread message row. Pure + exported so all
 *  three comment surfaces (the thread body, the rail preview, and the
 *  page-comments band) attribute rows identically: assistant rows get the
 *  doc assistant's identity; the current viewer gets their own (freshest)
 *  name; every other member gets the server-resolved `senderName` (`users.name`
 *  ?? email). A missing name falls through to the `Avatar`'s "?" fallback — the
 *  rare deleted/unknown sender. Before `senderName` existed, the non-viewer
 *  branch had no name at all, so every teammate's comment rendered as "?". */
export function resolveCommentAuthor(
  m: Pick<DocSessionMessage, "role" | "senderUserId" | "senderName" | "senderAvatarUrl">,
  ctx: {
    currentUser?: { id: string; name: string; avatarUrl?: string | null };
    assistant: CommentAuthor;
  },
): CommentAuthor {
  if (m.role === "assistant") return ctx.assistant;
  // The viewer's own rows take their photo from the freshest source — the
  // `user` cookie — so an avatar the viewer just changed reflects immediately,
  // even before the server-side `senderAvatarUrl` catches up.
  if (m.senderUserId && ctx.currentUser && m.senderUserId === ctx.currentUser.id) {
    return { id: ctx.currentUser.id, name: ctx.currentUser.name, avatarUrl: ctx.currentUser.avatarUrl };
  }
  return {
    id: m.senderUserId ?? "member",
    name: m.senderName ?? "",
    avatarUrl: m.senderAvatarUrl ?? null,
  };
}

/** Drop tool-only / empty turns so a thread never shows blank "?" rows. */
export function visibleComments(messages: DocSessionMessage[]): DocSessionMessage[] {
  return messages.filter(
    (m) =>
      (m.role === "user" || m.role === "assistant") &&
      extractMessageText(m.content).trim().length > 0,
  );
}

/** Three staggered dots — the "thinking" indicator before reply text lands. */
function ThinkingDots() {
  return (
    <span className="inline-flex items-center gap-[3px]" aria-hidden>
      {[0, 160, 320].map((delay) => (
        <span
          key={delay}
          className="inline-block size-[5px] animate-bounce rounded-full bg-current"
          style={{ animationDelay: `${delay}ms`, animationDuration: "1.1s" }}
        />
      ))}
    </span>
  );
}

/**
 * The page composer's hand-off to a freshly-created thread: the first message
 * to auto-send plus the picker choices the user made in the page band. The body
 * runs it through its normal streaming reply path, so a page-level comment shows
 * the typed message immediately and streams the assistant's reply in place —
 * instead of the old fire-and-wait that left the band blank until the whole turn
 * finished (and needed a refresh to surface anything).
 */
export type CommentSeed = {
  message: string;
  fileIds: string[];
  model?: ModelTier;
  researchMode?: boolean;
  /** Whether the assistant should answer this seeded comment. Omitted /
   *  `true` → the historical AI hand-off (the body auto-sends through
   *  `/api/chat`). `false` → a plain teammate comment: the body posts it to
   *  the thread and fires no AI turn (the page band's AI-reply toggle off). */
  aiReply?: boolean;
};

/**
 * Thread ids whose `seed` first message has already been auto-sent. A freshly
 * minted thread can briefly render in TWO surfaces at once (the on-content
 * popover and the margin rail disagree for a frame while the anchor element
 * resolves, so both mount an expanded body) or remount as the routing settles.
 * The per-instance `seedSentRef` guards one body; this module-level set guards
 * across instances so the seeded message is sent exactly once — never the
 * duplicate "hello + hello" two-reply turn. Thread ids are UUIDs (never reused),
 * so the set only grows by the handful of comments opened per page session.
 */
const sentSeedThreadIds = new Set<string>();

type Props = {
  thread: CommentThread;
  pageId: string;
  workspaceId: string;
  assistantId: string;
  currentUser?: { id: string; name: string; avatarUrl?: string | null };
  /** The doc assistant's real name + icon, for AI comment rows. */
  assistant?: AssistantIdentity | null;
  /** A page-composer hand-off (see {@link CommentSeed}): a brand-new unanchored
   *  thread whose first message auto-sends on mount, streaming the reply in
   *  place. Omitted for an existing thread (opened to read / reply manually). */
  seed?: CommentSeed;
  /** Refetch the page's threads after a reply / resolve. */
  onChanged: () => void;
  /** Dismiss the host shell after the thread is resolved. */
  onResolved: () => void;
  /** Start the message list scrolled to the latest comment (rail expansion). */
  scrollToEnd?: boolean;
  /** Messages the host already fetched (the rail preloads them to build the
   *  collapsed preview). When passed, the thread opens with content in place and
   *  revalidates silently — no load→content flicker, so an expand is one motion.
   *  Omit (the popover) to fetch on mount and show the loader as before. */
  initialMessages?: DocSessionMessage[];
  /** Inline band mode (the page-comments running thread): the message list grows
   *  with its content and the PAGE scrolls, instead of the `max-h-[44vh]` inner
   *  scroll the popover / rail use. Notion's page comments expand the document
   *  rather than scrolling a fixed box. */
  inline?: boolean;
  /** Collapsed preview (inline mode only): show `first → "Show N replies" → last`
   *  instead of the whole list — the at-rest / post-reload state. The composer
   *  stays mounted below it. Ignored while a reply is streaming (an active turn is
   *  always shown in full). Clicking the preview calls {@link onExpand}. */
  collapsed?: boolean;
  /** Expand the collapsed preview — fired by clicking it or focusing the
   *  composer, so the host can flip `collapsed` off. */
  onExpand?: () => void;
};

export function CommentThreadBody({
  thread,
  pageId,
  workspaceId,
  assistantId,
  currentUser,
  assistant,
  onChanged,
  onResolved,
  scrollToEnd,
  initialMessages,
  seed,
  inline,
  collapsed,
  onExpand,
}: Props) {
  const t = useT().comments;
  const tAttach = useT().attachments;
  const tChat = useT().chat;
  const tRec = useT().recordings;
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const scrollRef = React.useRef<HTMLDivElement>(null);
  // Whether the thread is parked at its newest message. While pinned, fresh
  // replies and streamed tokens keep the bottom in view; once the reader
  // scrolls up to read history we stop following so we don't yank them down.
  // Seeded from `scrollToEnd` so an expand-to-bottom thread follows from the
  // start, while a top-anchored open stays put until the reader scrolls down
  // or sends a reply.
  const pinnedRef = React.useRef(scrollToEnd ?? false);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Recordings attached to THIS reply, queued but not yet sent. A
  // recording-sized audio/video dropped in chat routes to the recording
  // pipeline (its own cost confirm + async transcribe) rather than the inline
  // file_cache path; the turn references it here so the assistant acknowledges
  // + links instead of pretending to read it. See recordings.md → "Chat entry".
  const rec = useRecordingUpload(workspaceId, assistantId);
  const [pendingRecordings, setPendingRecordings] = React.useState<
    { recordingId: string; title: string }[]
  >([]);
  const att = useFileAttachments(() => thread.sessionId, {
    onRouteMedia: (files) => {
      void (async () => {
        for (const file of files) {
          const res = await rec.run(file);
          if (res) {
            setPendingRecordings((prev) => [
              ...prev,
              { recordingId: res.recordingId, title: file.name },
            ]);
          }
        }
      })();
    },
  });
  const drop = useFileDrop((files) => void att.upload(files));
  // Model tier + research toggle for the reply turn — shared with the floating
  // chat and the page-comments band via <ComposerControls>.
  const controls = useComposerControls(workspaceId);

  const [messages, setMessages] = React.useState<DocSessionMessage[]>(initialMessages ?? []);
  // Did we open with preloaded messages? If so the mount fetch revalidates
  // SILENTLY (no loading state) so content never flashes a loader. Captured once
  // at mount — a ref, so a later prop identity change can't flip it.
  const hadInitial = React.useRef((initialMessages?.length ?? 0) > 0);
  const [loading, setLoading] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [draft, setDraft] = React.useState("");
  // Quote-reply: text the reader selected in an existing comment (via the
  // floating <CommentQuoteReply> button) to reply to. Shown as a quote chip
  // above the composer and prefixed onto the sent reply as a Markdown blockquote
  // (`composeQuotedBody`); cleared after send or via the chip's ✕.
  const [quotedReply, setQuotedReply] = React.useState<string | null>(null);
  // Workspace-member ids @-mentioned in the current draft reply, tracked by the
  // mention-aware composer and posted to the Inbox once the reply commits.
  const [mentionIds, setMentionIds] = React.useState<string[]>([]);
  const [streaming, setStreaming] = React.useState<string | null>(null);
  // While streaming, the assistant's current tool activity (e.g. "Saving to
  // memory") — shown before any reply text lands so a tool-heavy turn doesn't
  // sit on a static placeholder. Cleared once text starts.
  const [streamActivity, setStreamActivity] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  // Per-turn AI-reply toggle for a manual reply: on → the assistant answers
  // (the /api/chat stream); off → the reply is a plain teammate comment posted
  // straight to the thread with no AI turn. Defaults on (the historical
  // behavior); the `seed` hand-off always uses the AI path regardless.
  const [aiReply, setAiReply] = React.useState(true);
  // A page-composer hand-off (the `seed` prop), captured once at mount so the
  // fetch-skip + single auto-send decisions hold for THIS thread instance — the
  // popover keys the body by thread id, so a different thread is a fresh mount.
  //
  // The seed is a ONE-SHOT: it only applies to a brand-new thread whose first
  // message hasn't been auto-sent yet. On a REMOUNT of an already-seeded thread
  // the seed is stale and must be ignored — `CollabPageEditor` + `PageComments`
  // persist across page navigation (no React key), so `PageComments` still holds
  // the `seed` for this thread id after you navigate away and back, and re-passes
  // it to the freshly remounted body. `sentSeedThreadIds` already records that
  // this thread's seed was sent; when it has, treat the prop as no seed so the
  // mount fetch below runs and loads the persisted comments. Without this the
  // remount skipped BOTH the fetch (seed present) AND the re-send (already sent),
  // stranding the thread on "No comments yet" while its comment-count badge read
  // 1. See docs/architecture/features/doc-comments.md → "Exactly-once seed".
  const seedRef = React.useRef(
    seed && !sentSeedThreadIds.has(thread.id) ? seed : null,
  );
  const seedSentRef = React.useRef(false);

  // A friendly label for a tool the assistant runs mid-reply, or null for an
  // unmapped tool (we keep the generic "replying…" placeholder rather than
  // surfacing a raw tool name).
  const narrationFor = (name: string): string | null => {
    const map = tChat.toolNarration as unknown as Record<string, string>;
    return map[name] ?? null;
  };

  const sessionId = thread.sessionId;

  React.useEffect(() => {
    if (!sessionId) return;
    // A brand-new thread opened from the page composer (seed present) has
    // nothing to fetch yet — the seed auto-send below populates it (optimistic
    // message + streamed reply, then a final refetch). Skipping the mount fetch
    // keeps its empty result from clobbering the optimistic message.
    if (seedRef.current) return;
    const controller = new AbortController();
    // Preloaded? Revalidate without the loader (and swallow a failed refetch —
    // we already have content to show). Otherwise load + show the loader.
    if (!hadInitial.current) setLoading(true);
    setError(null);
    // A thread whose turn is still running (a refresh mid-reply) reconnects to
    // the live turn below and owns the streaming bubble — don't clear it here.
    if (thread.sessionStatus !== "running") setStreaming(null);
    setDraft("");
    void fetchSessionMessages(sessionId, { signal: controller.signal })
      .then((rows) => {
        // `fetchSessionMessages` swallows aborts/errors and resolves to `[]`. If
        // this fetch was aborted (effect re-run / StrictMode's mount→unmount→
        // mount) its `[]` must NOT overwrite the preloaded messages — that
        // wiped content out from under the open and flashed empty → grow
        // (the "shrink then expand" double-move). Likewise keep preloaded
        // content if a live refetch comes back empty (a transient failure).
        if (controller.signal.aborted) return;
        if (rows.length === 0 && hadInitial.current) return;
        setMessages(rows);
      })
      .catch(() => {
        if (!hadInitial.current) setError(t.loadError);
      })
      .finally(() => {
        // Don't let an aborted fetch's settle clear the loader the live fetch
        // (re-run) just set.
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [sessionId, t.loadError]);

  // Page-composer hand-off: a brand-new thread arrives with a first message to
  // send. Fire it once on mount through the SAME streaming path as a manual
  // reply, so the comment shows immediately (optimistic) and the assistant's
  // reply streams live (thinking → tools → tokens) — no fire-and-wait, no
  // refresh. The ref guard makes React StrictMode's double-mount send once.
  React.useEffect(() => {
    const s = seedRef.current;
    if (!s || seedSentRef.current || sentSeedThreadIds.has(thread.id)) return;
    seedSentRef.current = true;
    sentSeedThreadIds.add(thread.id);
    void sendReply({
      body: s.message,
      fileIds: s.fileIds,
      model: s.model,
      researchMode: s.researchMode,
      aiReply: s.aiReply,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live-turn reconnect: a thread whose backing turn is still running (a page
  // refresh mid-reply — the `doc_thread` background carve-out in the chat route)
  // arrives with `sessionStatus==='running'`. Re-attach to that turn via
  // `GET /api/sessions/:id/stream`, show the "working…" indicator immediately,
  // stream the reply in from each snapshot, and refetch the persisted rows on
  // completion. The seed hand-off (a fresh thread sending its own turn) and an
  // in-progress local send own the bubble themselves, so they're excluded.
  // See docs/architecture/features/doc-comments.md → "Live turn reconnect".
  React.useEffect(() => {
    if (!sessionId) return;
    if (
      !shouldReconnectToTurn({
        sessionStatus: thread.sessionStatus,
        seeded: !!seedRef.current,
        busy,
      })
    )
      return;
    const controller = new AbortController();
    setStreaming((cur) => cur ?? "");
    setStreamActivity(null);
    let cancelled = false;
    const finish = () => {
      if (cancelled) return;
      void fetchSessionMessages(sessionId).then((rows) => {
        if (cancelled) return;
        if (rows.length > 0) setMessages(rows);
        setStreaming(null);
        setStreamActivity(null);
      });
      onChanged();
    };
    void (async () => {
      try {
        const res = await authFetch(`${API_URL}/api/sessions/${sessionId}/stream`, {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) throw new Error("reconnect failed");
        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const buf = createSSEBuffer();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const ev of parseSSEStream(decoder.decode(value, { stream: true }), buf)) {
            if (ev.event === "status") {
              if ((ev.data as { status?: string }).status !== "running") {
                finish();
                return;
              }
            } else if (ev.event === "snapshot") {
              const d = ev.data as { text?: string; activity?: string | null };
              setStreaming(d.text ?? "");
              setStreamActivity(d.text ? null : d.activity ? narrationFor(d.activity) : null);
            } else if (ev.event === "done") {
              finish();
              return;
            }
          }
        }
        // Stream ended without an explicit `done` (server closed) — settle from
        // the persisted state so the bubble never strands on "working…".
        finish();
      } catch {
        if (!cancelled) {
          setStreaming(null);
          setStreamActivity(null);
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, thread.sessionStatus]);

  // Land on the newest comment when a long thread first expands.
  React.useEffect(() => {
    if (scrollToEnd && !loading && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [scrollToEnd, loading]);

  // Recompute the pin state whenever the reader scrolls: parked at the bottom
  // → follow new content; scrolled up to read → leave them be.
  const handleScroll = React.useCallback(() => {
    if (scrollRef.current) pinnedRef.current = pinnedToBottom(scrollRef.current);
  }, []);

  // Follow the newest content while pinned — the sent reply, each streamed
  // token (`streaming`/`streamActivity`), and the final persisted rows
  // (`messages`) all keep the latest message in view. This is the fix for the
  // thread not scrolling to the assistant's reply after a send.
  React.useEffect(() => {
    if (pinnedRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, streaming, streamActivity]);

  const assistantAuthor: CommentAuthor = {
    id: assistant?.id ?? "assistant",
    name: assistant?.name ?? t.assistantName,
    isAssistant: true,
    iconSeed: assistant?.iconSeed ?? null,
  };

  const authorOf = (m: DocSessionMessage): CommentAuthor =>
    resolveCommentAuthor(m, { currentUser, assistant: assistantAuthor });

  const visible = visibleComments(messages);

  // Send a reply turn. With no argument it reads the composer (draft +
  // attachments + the shared <ComposerControls> model/research state). With an
  // `override` it sends a caller-supplied turn instead — the page-composer
  // hand-off (`seed`): a brand-new thread's first message + the picker choices
  // the user made in the page band. Either way the user's message shows
  // immediately (optimistic) and the assistant's reply streams in place.
  async function sendReply(override?: {
    body: string;
    fileIds: string[];
    model?: ModelTier;
    researchMode?: boolean;
    /** Seed hand-off only: whether the assistant should answer. Defaults to
     *  `true` (the historical AI hand-off). `false` → post the seeded comment
     *  as a plain teammate comment (the page band's AI-reply toggle was off). */
    aiReply?: boolean;
  }) {
    const body = (override?.body ?? draft).trim();
    // A manual reply carries the reader's optional quote-reply (the seed/override
    // path is a brand-new thread, so there's nothing to quote). The quote rides
    // as a leading Markdown blockquote so it persists in the plain message body,
    // renders back as the amber quote bar, and reads as a quote to the assistant
    // when the reply runs through /api/chat.
    const effectiveBody =
      !override && quotedReply ? composeQuotedBody(quotedReply, body) : body;
    const fileIds = override ? override.fileIds : att.fileIds();
    const hasFiles = fileIds.length > 0;
    // Recordings queued for this reply (not on the seed/override path — those
    // carry no composer state). A recording-only reply is valid: the assistant
    // acknowledges and links even with no typed body.
    const attachedRecordingIds = override ? [] : pendingRecordings.map((r) => r.recordingId);
    const hasRecordings = attachedRecordingIds.length > 0;
    const model = override ? override.model : controls.model;
    const researchMode = override ? override.researchMode : controls.researchMode;
    if ((!body && !hasFiles && !hasRecordings) || busy || att.uploading) return;
    // A reconnected turn is streaming into the bubble (a refresh mid-reply) —
    // block a manual send so the composer can't double-drive it. The seed
    // override path runs before any reconnect, so it's exempt.
    if (!override && streaming !== null) return;
    // AI reply OFF → post a plain teammate comment, no assistant turn. A manual
    // reply reads the composer's toggle; a `seed` hand-off carries the page
    // band's toggle (defaulting to the historical AI path when unset). A
    // teammate comment is text-only (attachments only feed an AI turn), so it
    // needs a body.
    const replyWithoutAi = override ? override.aiReply === false : !aiReply;
    if (replyWithoutAi && !body) return;
    setBusy(true);
    // Mentions belong to a user-typed reply; the seed `override` (a new
    // thread's first comment) records its mentions in `collab-page-editor`
    // where the thread is minted.
    const mentions = override ? [] : mentionIds;
    // A user-typed reply clears the composer; an override carries no composer
    // state to reset.
    if (!override) {
      setDraft("");
      setMentionIds([]);
      setQuotedReply(null);
      att.clear();
      setPendingRecordings([]);
    }
    // Show the sent comment immediately (replaced by the persisted row on
    // refetch). Without this the user's own message doesn't appear until the
    // assistant's whole reply has streamed.
    const optimistic: DocSessionMessage = {
      id: `local-${Date.now()}`,
      role: "user",
      content: effectiveBody,
      timestamp: new Date().toISOString(),
      senderUserId: currentUser?.id ?? null,
      senderName: currentUser?.name ?? null,
    };
    // The reader just sent — follow their reply (and any streamed answer) to the
    // bottom even if they'd scrolled up to read earlier in the thread.
    pinnedRef.current = true;
    setMessages((prev) => [...prev, optimistic]);

    // AI reply off → store the comment for teammates and stop (no /api/chat).
    if (replyWithoutAi) {
      try {
        await addCommentMessage(thread.id, effectiveBody);
        if (mentions.length > 0) {
          void recordDocMention({
            workspaceId,
            pageId,
            threadId: thread.id,
            mentionedUserIds: mentions,
            preview: body,
          });
        }
        setMessages(await fetchSessionMessages(thread.sessionId));
        onChanged();
      } catch {
        setError(t.loadError);
      } finally {
        setBusy(false);
      }
      return;
    }

    setStreaming("");
    setStreamActivity(null);
    try {
      const res = await authFetch(`${API_URL}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: effectiveBody,
          sessionId: thread.sessionId,
          assistantId,
          workspaceId,
          appOrigin: "doc",
          docViewId: pageId,
          replyTarget: { threadId: thread.id },
          ...(model ? { model } : {}),
          ...(researchMode ? { mode: "research" as const } : {}),
          ...(hasFiles ? { fileIds } : {}),
          ...(hasRecordings ? { attachedRecordingIds } : {}),
        }),
      });
      if (!res.ok || !res.body) throw new Error("stream failed");
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      const buf = createSSEBuffer();
      let acc = "";
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        for (const ev of parseSSEStream(decoder.decode(value, { stream: true }), buf)) {
          if (ev.event === "text_delta") {
            acc += (ev.data as { text?: string }).text ?? "";
            setStreaming(acc);
            setStreamActivity(null);
          } else if (ev.event === "tool_start" && !acc) {
            // Reflect the assistant's work before any reply text lands.
            const name = (ev.data as { name?: string }).name;
            const label = name ? narrationFor(name) : null;
            if (label) setStreamActivity(label);
          } else if (
            ev.event === "research_quota" ||
            ev.event === "research_quota_exhausted"
          ) {
            // Keep the composer's research toggle in sync with the server's
            // free-research counter (same handling as the floating chat).
            const d = ev.data as { used?: number; quota?: number; isPaid?: boolean };
            controls.applyResearchQuotaEvent({
              type: ev.event,
              used: d.used,
              quota: d.quota,
              isPaid: d.isPaid,
            });
          } else if (ev.event === "page_created") {
            // The AI authored a brand-new page (renderPage) during a thread
            // reply. The prompt steers it to edit THIS page instead, but if it
            // does mint a separate page anyway, reload the sidebar so the draft
            // is reachable rather than orphaned. Reload only — never navigate
            // away from the thread the user is reading.
            const newPageId = (ev.data as { pageId?: string }).pageId;
            if (newPageId && typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("doc:draft-created", {
                  detail: { viewId: newPageId, action: "created" },
                }),
              );
            }
          } else if (ev.event === "doc_title_update") {
            // The assistant committed a title/icon change (`setTitle`/`setIcon`
            // via patchPage, or the post-turn auto-title). Bridge it to the
            // shell exactly like floating-chat does — `doc:title-updated` →
            // `applyAutoTitle` updates `activeView` (page header + active tab)
            // and reloads the sidebar. Without this, an icon/title set from a
            // comment thread lands in `saved_views` but every surface stays
            // stale until a full remount.
            const d = ev.data as {
              pageId?: string;
              title?: string;
              icon?: string | null;
              nameOrigin?: string;
              overwrite?: boolean;
            };
            const pageIdOf = typeof d.pageId === "string" ? d.pageId : "";
            const title = typeof d.title === "string" ? d.title : "";
            const icon = typeof d.icon === "string" ? d.icon : null;
            const nameOrigin =
              d.nameOrigin === "user" ||
              d.nameOrigin === "auto" ||
              d.nameOrigin === "placeholder"
                ? d.nameOrigin
                : undefined;
            if (pageIdOf && title && typeof window !== "undefined") {
              window.dispatchEvent(
                new CustomEvent("doc:title-updated", {
                  detail: {
                    pageId: pageIdOf,
                    title,
                    icon,
                    nameOrigin,
                    overwrite: d.overwrite === true,
                  },
                }),
              );
            }
          }
        }
      }
      const rows = await fetchSessionMessages(thread.sessionId);
      setMessages(rows);
      if (mentions.length > 0) {
        void recordDocMention({
          workspaceId,
          pageId,
          threadId: thread.id,
          mentionedUserIds: mentions,
          preview: body,
        });
      }
      onChanged();
    } catch {
      setError(t.loadError);
    } finally {
      setStreaming(null);
      setStreamActivity(null);
      setBusy(false);
    }
  }

  async function resolve() {
    try {
      await setThreadResolved(thread.id, true);
      onChanged();
      onResolved();
    } catch {
      setError(t.loadError);
    }
  }

  // Inline (page-band) running thread: at rest it shows a Notion-style preview
  // (`first → "Show N replies" → last`); an active turn or an explicit expand
  // shows the whole list. Only meaningful in `inline` mode with content.
  const showCollapsed =
    !!inline && !!collapsed && !loading && streaming === null && visible.length > 0;

  return (
    <div
      className={
        inline
          ? "group relative flex flex-col"
          : "group relative flex min-h-0 flex-1 flex-col"
      }
      // A press on comment text is a text selection, never a page area-select.
      // The rail card / popover shells already bail via `role="dialog"`, but the
      // page-comments band hosts this body in a `role="region"` wrapper, so tag
      // the body itself — the one element every comment shell shares — so a drag
      // to highlight a comment never rubber-bands the page beneath it.
      data-area-select-ignore
      {...drop.dropProps}
    >
      <FileDropOverlay active={drop.isDragging} />
      <button
        type="button"
        onClick={() => void resolve()}
        aria-label={t.resolve}
        className={`absolute right-2 top-2 z-10 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground/70 hover:bg-accent hover:text-foreground${
          // Notion reveals the resolve control on hover; the popover/rail keep it
          // always visible (a fixed box with no surrounding page to hover off).
          inline ? " opacity-0 transition-opacity focus-visible:opacity-100 group-hover:opacity-100" : ""
        }`}
      >
        <Check className="size-4" />
      </button>

      <div
        ref={scrollRef}
        onScroll={handleScroll}
        className={
          inline
            ? "px-4 pb-1 pt-4"
            : "min-h-0 max-h-[44vh] flex-1 overflow-y-auto px-4 pb-1 pt-4"
        }
      >
        {loading ? (
          <p className="py-4 text-center text-[13px] text-muted-foreground">…</p>
        ) : visible.length === 0 && !streaming ? (
          <p className="py-4 text-center text-[13px] text-muted-foreground">{t.emptyThread}</p>
        ) : showCollapsed ? (
          <CollapsedThreadPreview
            visible={visible}
            quote={thread.quote}
            authorOf={authorOf}
            justNow={t.justNow}
            placeholder={t.popoverTitle}
            showRepliesLabel={(n) =>
              n === 1 ? t.showRepliesOne : format(t.showRepliesMany, { count: n })
            }
            onExpand={() => onExpand?.()}
          />
        ) : (
          visible.map((m, i) => {
            const a = authorOf(m);
            const parsed = parseMessageAttachments(m.content);
            // Human rows may carry a leading quote-reply blockquote — split it
            // off so it renders as the amber quote bar (assistant rows keep their
            // own Markdown intact: `quote` is always null there).
            const rowQuote = quoteForRow(parsed.text, a.isAssistant);
            return (
              <div key={m.id} className="flex gap-2.5">
                <ThreadGutter author={a} connect={i < visible.length - 1 || streaming !== null} />
                <div className="min-w-0 flex-1 pb-4">
                  <div className="flex items-baseline gap-2">
                    <span className="truncate text-[14px] font-semibold text-foreground">
                      {a.name}
                    </span>
                    <span className="shrink-0 text-[12px] text-muted-foreground">
                      {relativeTime(m.timestamp, t.justNow)}
                    </span>
                  </div>
                  {i === 0 && thread.quote ? (
                    <div className="mt-1 border-l-2 border-amber-400 pl-2.5 text-[13px] leading-snug text-muted-foreground">
                      <span className="line-clamp-1">{thread.quote}</span>
                    </div>
                  ) : null}
                  <MessageAttachments attachments={parsed.attachments} />
                  {rowQuote.quote ? (
                    // The reader quoted an earlier comment in this reply — show
                    // the quoted text as the amber bar above the reply body
                    // (matches the page-anchor `thread.quote` styling).
                    <div className="mt-1 border-l-2 border-amber-400 pl-2.5 text-[13px] leading-snug text-muted-foreground">
                      <span className="line-clamp-3 whitespace-pre-wrap">{rowQuote.quote}</span>
                    </div>
                  ) : null}
                  {parsed.text ? (
                    a.isAssistant ? (
                      // Assistant replies carry markdown (bold, lists, inline
                      // code) — render it, matching the floating chat.
                      <div className="chat-markdown mt-1 break-words text-[14px] leading-relaxed text-foreground">
                        <ChatMarkdown text={parsed.text} />
                      </div>
                    ) : (
                      // Human comments are plain text; keep their literal line
                      // breaks rather than collapsing them through markdown.
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

        {streaming !== null ? (
          <div className="flex gap-2.5">
            <ThreadGutter author={assistantAuthor} connect={false} />
            <div className="min-w-0 flex-1 pb-4">
              <div className="text-[14px] font-semibold text-foreground">
                {assistantAuthor.name}
              </div>
              <div className="chat-markdown mt-1 break-words text-[14px] leading-relaxed text-foreground">
                {streaming ? (
                  <>
                    <ChatMarkdown text={stripCommentThreadReplyTag(streaming)} />
                    {/* Blinking caret while tokens are still arriving. */}
                    <span className="ml-px inline-block h-[1.05em] w-[2px] translate-y-[0.15em] animate-pulse rounded-full bg-foreground/60" />
                  </>
                ) : (
                  <span className="inline-flex items-center gap-2 text-muted-foreground">
                    <ThinkingDots />
                    <span>{streamActivity ?? t.streamingReply}</span>
                  </span>
                )}
              </div>
            </div>
          </div>
        ) : null}

        {error ? <p className="pb-2 text-[12px] text-destructive">{error}</p> : null}
      </div>

      {/* Quote-reply: selecting text in any comment above pops a floating
          "Reply" button that drops the selection into the composer as a quote.
          Disabled while the inline band is collapsed (the list shows a preview,
          not the full thread). */}
      <CommentQuoteReply
        containerRef={scrollRef}
        disabled={!!showCollapsed}
        onQuote={(text) => {
          setQuotedReply(text);
          if (inline && collapsed) onExpand?.();
          composerRef.current?.focus();
        }}
      />

      {/* Composer — Notion single-line input box with the actions inline (one
          line tall, growing as you type); attachment chips drop below only when
          present. `shrink-0` keeps it pinned when the thread above compresses to
          fit. No composer avatar — each message row already carries the author's
          avatar, so a second one beside the input was redundant. */}
      <div
        className={`flex shrink-0 items-center gap-2.5 px-3 py-2.5${
          // The popover / rail need the divider to separate the composer from the
          // scrolling list above; the inline band reads as one flush Notion thread.
          inline ? "" : " border-t border-foreground/[0.06]"
        }`}
        // Focusing the reply textarea expands a collapsed inline thread (Notion:
        // clicking into the reply box opens the discussion). Scoped to the
        // textarea itself: focusing a footer control (the model-tier picker, the
        // research / AI-reply toggles) must NOT expand, because the expand
        // re-renders the thread above mid-click and tears the just-opened model
        // dropdown down before the tier commits. No-op for the popover / rail.
        onFocusCapture={
          inline && collapsed
            ? (e) => {
                if ((e.target as Node) === composerRef.current) onExpand?.();
              }
            : undefined
        }
      >
        <div className="flex flex-1 flex-col gap-1 rounded-2xl border border-foreground/[0.18] bg-background px-3 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          {quotedReply ? (
            <div className="flex items-start gap-1.5">
              <div className="min-w-0 flex-1 border-l-2 border-amber-400 pl-2 text-[12.5px] leading-snug text-muted-foreground">
                <span className="line-clamp-2 whitespace-pre-wrap">{quotedReply}</span>
              </div>
              <button
                type="button"
                onClick={() => setQuotedReply(null)}
                aria-label={t.clearQuote}
                className="-mr-1 inline-flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 hover:bg-accent hover:text-foreground"
              >
                <X className="size-3.5" />
              </button>
            </div>
          ) : null}
          {/* The composer is the input row alone — attach + send (ArrowUp) live
              in the footer strip below (attach next to the AI-reply / Research
              toggles, send next to the model picker), so a grown multi-line reply
              isn't flanked by controls drifting in its vertical centre (mirrors
              the landing + floating-dock composers). */}
          <CommentComposer
            textareaRef={composerRef}
            value={draft}
            onValueChange={(v, ids) => {
              setDraft(v);
              setMentionIds(ids);
            }}
            onEnter={() => void sendReply()}
            workspaceId={workspaceId}
            placeholder={t.composerPlaceholder}
            className="max-h-32 min-h-[24px] w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-relaxed outline-none focus-visible:shadow-none placeholder:text-muted-foreground/70"
          />
          {aiReply ? (
            <AttachmentChips attachments={att.attachments} onRemove={att.remove} />
          ) : null}
          {pendingRecordings.length > 0 ? (
            <div className="mt-1 flex flex-wrap gap-1.5">
              {pendingRecordings.map((r) => (
                <span
                  key={r.recordingId}
                  className="inline-flex items-center gap-1 rounded border border-border bg-muted/40 px-2 py-0.5 text-xs text-muted-foreground"
                >
                  <span aria-hidden>◉</span>
                  {tRec.chatQueuedChip.replace("{name}", r.title)}
                </span>
              ))}
            </div>
          ) : null}
          <div className="mt-1 flex items-center gap-1.5">
            {aiReply ? (
              <button
                type="button"
                aria-label={tAttach.attach}
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground"
              >
                <Paperclip className="size-[18px]" />
              </button>
            ) : null}
            <ComposerControls
              model={controls.model}
              onModelChange={controls.setModel}
              plan={controls.plan}
              researchMode={controls.researchMode}
              onResearchModeChange={controls.setResearchMode}
              researchQuota={controls.researchQuota}
              researchExhausted={controls.researchExhausted}
              // A thread always has a backing assistant — keep the research
              // toggle on replies so it doesn't vanish after the first message
              // (it disables with AI-reply off, like the model picker).
              showResearch
              aiReply={aiReply}
              onAiReplyChange={setAiReply}
              className="flex-1"
            />
            <button
              type="button"
              onClick={() => void sendReply()}
              disabled={busy || streaming !== null || att.uploading || (!draft.trim() && !(aiReply && att.hasReady))}
              aria-label={busy ? t.sending : t.send}
              className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-foreground/10 disabled:text-muted-foreground"
            >
              <ArrowUp className="size-4" />
            </button>
          </div>
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void att.upload(e.target.files);
              e.target.value = "";
            }}
          />
        </div>
      </div>
    </div>
  );
}

/**
 * The at-rest preview for an inline (page-band) thread — Notion's collapsed
 * page comment: the opening comment, a "Show N replies" affordance for the
 * hidden middle, and the latest comment, joined by the same `ThreadGutter`
 * line as the expanded thread. The whole block is one button: clicking
 * anywhere (including "Show N replies") expands to the full conversation.
 * Bodies are clamped here (the full markdown renders once expanded).
 */
function CollapsedThreadPreview({
  visible,
  quote,
  authorOf,
  justNow,
  placeholder,
  showRepliesLabel,
  onExpand,
}: {
  visible: DocSessionMessage[];
  quote: string | null;
  authorOf: (m: DocSessionMessage) => CommentAuthor;
  justNow: string;
  placeholder: string;
  showRepliesLabel: (n: number) => string;
  onExpand: () => void;
}) {
  const first = visible[0];
  const last = visible.length > 1 ? visible[visible.length - 1] : null;
  const hidden = Math.max(0, visible.length - 2);

  const row = (m: DocSessionMessage, isFirst: boolean, connect: boolean) => {
    const a = authorOf(m);
    const parsed = parseMessageAttachments(m.content);
    // Show the reply body in the preview, not a quoted-reply's leading `>` block.
    const previewText = quoteForRow(parsed.text, a.isAssistant).body;
    return (
      <div className="flex gap-2.5">
        <ThreadGutter author={a} connect={connect} />
        <div className={connect ? "min-w-0 flex-1 pb-2.5" : "min-w-0 flex-1"}>
          <div className="flex items-baseline gap-2">
            <span className="truncate text-[14px] font-semibold text-foreground">{a.name}</span>
            <span className="shrink-0 text-[12px] text-muted-foreground">
              {relativeTime(m.timestamp, justNow)}
            </span>
          </div>
          {isFirst && quote ? (
            <div className="mt-1 border-l-2 border-amber-400 pl-2.5 text-[13px] leading-snug text-muted-foreground">
              <span className="line-clamp-1">{quote}</span>
            </div>
          ) : null}
          <p className="mt-1 line-clamp-2 text-[14px] leading-relaxed text-foreground/90">
            {previewText ? (
              // Inline-only markdown so an assistant reply's `**bold**` renders
              // formatted (not raw `**`) while the `line-clamp-2` clamp holds —
              // same renderer the rail's collapsed preview uses.
              <PreviewMarkdown text={previewText} />
            ) : (
              parsed.attachments[0]?.name || placeholder
            )}
          </p>
        </div>
      </div>
    );
  };

  return (
    <button type="button" onClick={onExpand} className="block w-full cursor-pointer text-left">
      {row(first, true, hidden > 0 || !!last)}
      {hidden > 0 ? (
        <div className="flex gap-2.5">
          <ThreadGutter connect />
          <span className="pb-2.5 text-[13px] font-medium text-muted-foreground transition-colors hover:text-foreground">
            {showRepliesLabel(hidden)}
          </span>
        </div>
      ) : null}
      {last ? row(last, false, false) : null}
    </button>
  );
}
