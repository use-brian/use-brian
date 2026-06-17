"use client";

/**
 * The page's **overall comments** surface — the Notion-style band that sits
 * directly under the page title (`PageTitle`) and above the document body. It
 * is the prominent home for whole-page discussion, distinct from the inline /
 * block-anchored ("specific") comments that live in the gutter / rail.
 *
 * Notion model — **one running page thread**, inline (never a floating modal):
 *   - **No open thread yet** → a starter composer ("Add a comment…") opens an
 *     *unanchored* thread (`anchorBlockId: null`) and hands the first message to
 *     that thread's body as a `seed`, which runs it through `/api/chat` so the
 *     doc assistant acts on it (the same auto-invoke a block-anchored comment
 *     gets). With the AI-reply toggle off it posts a plain teammate comment and
 *     fires no turn.
 *   - **An open thread exists** → it renders inline as the running discussion
 *     (`<CommentThreadBody inline>`): collapsed at rest to
 *     `first → "Show N replies" → last`, expanding on focus to the full thread
 *     which **grows with the page** (no inner scroll), composer pinned at the
 *     bottom. Further comments are replies in that one thread; the assistant's
 *     replies stream in place, and if it calls `postComment` the anchored
 *     highlight + rail card appear through the usual path. Resolving clears the
 *     thread (the next comment starts a fresh one).
 *   - **Specific-comment nudge** — an amber chip surfacing the count of open
 *     threads anchored to specific text/blocks; clicking it reveals the first
 *     one (the editor scrolls + opens its rail card / popover).
 *
 * Thread state is owned by `CollabPageEditor` (one fetch for the whole page);
 * this component receives the open threads as a prop, reports a brand-new post
 * through `onSubmitted` (so the editor adds it to the list), and refetches via
 * `onThreadChanged` once the body's turn settles. Expand/collapse is local UI.
 *
 * [COMP:app-web/page-comments]
 */

import * as React from "react";
import { ArrowRight, ArrowUp, MessageSquare, Paperclip } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { format } from "@/lib/i18n/format";
import { isInsideComposerPopup } from "@/lib/comment-dismiss";
import { createCommentThread, type CommentThread } from "@/lib/api/comments";
import {
  CommentThreadBody,
  type CommentSeed,
} from "@/components/doc/comment-thread-body";
import { type AssistantIdentity } from "@/lib/api/views";
import { ComposerControls, useComposerControls } from "@/components/doc/composer-controls";
import { AttachmentChips, FileDropOverlay } from "@/components/doc/attachment-chips";
import { useFileAttachments } from "@/lib/use-file-attachments";
import { useFileDrop } from "@/lib/use-file-drop";
import { useAutoGrowTextarea } from "@/lib/use-auto-grow-textarea";

type Props = {
  pageId: string;
  workspaceId: string;
  /** The doc assistant backing the thread's session. Absent → read-only
   *  (the composer is hidden; an existing thread still renders to read). */
  assistantId?: string;
  currentUser?: { id: string; name: string; avatarUrl?: string | null };
  /** The doc assistant's name + icon, for AI rows in the running thread. */
  assistant?: AssistantIdentity | null;
  /** Open threads for this page (resolved excluded by the editor's fetch). */
  threads: CommentThread[];
  /** Open an EXISTING anchored thread (the specific-comment nudge — the editor
   *  resolves the anchor element + scrolls). */
  onPick: (thread: CommentThread) => void;
  /** A page comment was just posted: the editor adds the brand-new unanchored
   *  thread to its list so it renders here as the running thread. */
  onSubmitted: (thread: CommentThread, seed: CommentSeed) => void;
  /** Refetch the page threads after the running thread's turn / resolve. */
  onThreadChanged?: () => void;
};

export function PageComments({
  pageId,
  workspaceId,
  assistantId,
  currentUser,
  assistant,
  threads,
  onPick,
  onSubmitted,
  onThreadChanged,
}: Props) {
  const t = useT().comments;
  const tAttach = useT().attachments;
  const [draft, setDraft] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const cardRef = React.useRef<HTMLDivElement>(null);
  const att = useFileAttachments();
  // Model tier + research toggle for the FIRST comment (the starter) — shared
  // with the floating chat + the in-thread reply composer via <ComposerControls>.
  const controls = useComposerControls(workspaceId);
  // Per-turn AI-reply toggle for the starter: on → the doc assistant answers
  // (the seed runs through /api/chat); off → a plain teammate comment, no AI
  // turn. Research + model disable while off (they only shape an AI turn).
  const [aiReply, setAiReply] = React.useState(true);

  // Grow the starter composer line-by-line as the draft wraps / takes Shift+Enter
  // newlines (capped by `max-h-32`, then it scrolls) — without this the `rows={1}`
  // box stays one line tall and earlier lines scroll out of view.
  useAutoGrowTextarea(composerRef, draft);

  const open = threads.filter((th) => !th.resolvedAt);
  const specific = open.filter((th) => !!th.anchorBlockId);
  // The running page discussion: the newest open unanchored thread. Posting
  // appends to it; resolving it clears the band back to the starter composer.
  const overall = open.filter((th) => !th.anchorBlockId);
  const runningThread =
    overall.length > 0
      ? overall.reduce((a, b) => (a.createdAt >= b.createdAt ? a : b))
      : null;

  // Inline expand/collapse for the running thread — collapsed (Notion preview)
  // at rest / on reload, expanded once focused. Reset whenever the running
  // thread changes (a fresh post / a resolve), so a new thread opens collapsed.
  const [expanded, setExpanded] = React.useState(false);
  // The just-posted thread's first message, kept locally so the running thread's
  // body auto-sends + streams it (no editor round-trip for the seed). Cleared on
  // resolve / a new post.
  const [seed, setSeed] = React.useState<{ threadId: string; seed: CommentSeed } | null>(null);

  const canComment = !!assistantId;
  const drop = useFileDrop((files) => void att.upload(files), {
    disabled: !canComment || !aiReply,
  });

  // Collapse the running thread on Escape / an outside click (mirrors the rail +
  // popover). A click on the thread card itself, or the mention popup the
  // composer portals to <body>, must not collapse it.
  React.useEffect(() => {
    if (!expanded || !runningThread) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (cardRef.current?.contains(tgt)) return;
      // The model-tier picker (base-ui Select) and the mention popup portal to
      // <body>, so a click on a dropdown item is technically outside the thread
      // card — but it must not collapse the running thread (the re-render would
      // tear the dropdown down before the pick commits). Treat another thread's
      // card + both portaled composer popups as part of the composer.
      if (tgt?.closest?.("[data-thread-id]") || isInsideComposerPopup(tgt)) return;
      setExpanded(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setExpanded(false);
    };
    const id = window.setTimeout(() => {
      document.addEventListener("mousedown", onDown);
      document.addEventListener("keydown", onKey);
    }, 0);
    return () => {
      window.clearTimeout(id);
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [expanded, runningThread]);

  async function post() {
    const body = draft.trim();
    const aid = assistantId;
    // Attachments only feed an AI turn — ignored with AI reply off, where the
    // comment must carry text.
    const hasFiles = aiReply && att.hasReady;
    if ((!body && !hasFiles) || busy || !aid || att.uploading) return;
    const fileIds = hasFiles ? att.fileIds() : [];
    setBusy(true);
    try {
      // Open an empty unanchored thread, then hand the first message to its body
      // as a seed: the body shows the comment immediately (optimistic) and
      // STREAMS the assistant's reply in place. createCommentThread seeds NO
      // body — the body's turn appends the user message itself, carrying the
      // chosen model / research / files / AI-reply choice. With AI reply OFF the
      // body posts a plain teammate comment and fires no turn.
      const thread = await createCommentThread({ pageId, assistantId: aid, workspaceId });
      const built: CommentSeed = {
        message: body,
        fileIds,
        model: controls.model,
        researchMode: aiReply ? controls.researchMode : false,
        aiReply,
      };
      setDraft("");
      att.clear();
      setSeed({ threadId: thread.id, seed: built });
      setExpanded(true);
      // Tell the editor to add the thread to its list so it renders here as the
      // running thread (the seed lives locally; no need to round-trip it).
      onSubmitted(thread, built);
    } catch {
      /* RLS / network — leave the draft so the user can retry */
    } finally {
      setBusy(false);
    }
  }

  // Nothing to show: no composer (read-only) and no threads of either kind.
  if (!canComment && overall.length === 0 && specific.length === 0) return null;

  const nudgeLabel =
    specific.length === 1
      ? t.specificNudgeOne
      : format(t.specificNudgeMany, { count: specific.length });

  return (
    <section
      aria-label={t.overallListAria}
      className="mb-3 mt-2 flex flex-col gap-2.5 border-b border-foreground/[0.06] pb-3"
    >
      {specific.length > 0 ? (
        <button
          type="button"
          onClick={() => onPick(specific[0])}
          className="inline-flex w-fit items-center gap-1.5 rounded-full bg-amber-100/70 px-2.5 py-1 text-[12.5px] font-medium text-amber-800 ring-1 ring-inset ring-amber-300/50 transition-colors hover:bg-amber-100 dark:bg-amber-400/10 dark:text-amber-200/90 dark:ring-amber-400/25 dark:hover:bg-amber-400/15"
        >
          <MessageSquare className="size-3.5" />
          <span>{nudgeLabel}</span>
          <ArrowRight className="size-3.5 opacity-70" />
        </button>
      ) : null}

      {runningThread ? (
        // The running page discussion, inline. `data-thread-id` lets the editor's
        // anchor lookups + the outside-click guard recognise it.
        <div
          ref={cardRef}
          data-thread-id={runningThread.id}
          role="region"
          aria-label={t.overallListAria}
        >
          <CommentThreadBody
            key={runningThread.id}
            thread={runningThread}
            pageId={pageId}
            workspaceId={workspaceId}
            assistantId={assistantId ?? ""}
            currentUser={currentUser}
            assistant={assistant}
            seed={seed?.threadId === runningThread.id ? seed.seed : undefined}
            inline
            collapsed={!expanded}
            onExpand={() => setExpanded(true)}
            onChanged={() => onThreadChanged?.()}
            onResolved={() => {
              setExpanded(false);
              setSeed(null);
              onThreadChanged?.();
            }}
          />
        </div>
      ) : canComment ? (
        // Starter composer — only while no page thread is open. Once the first
        // comment lands, the running thread's own composer (above) takes over.
        <div className="flex items-center gap-2.5">
          <div
            {...drop.dropProps}
            className="relative flex flex-1 flex-col gap-1 rounded-2xl border border-foreground/[0.18] bg-background px-3 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)] transition-[border-color,box-shadow] focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/30"
          >
            <FileDropOverlay active={drop.isDragging} />
            {/* The textarea is the input row alone — the attach + send (ArrowUp)
                buttons live in the footer strip below (attach next to the
                AI-reply / Research toggles, send next to the model picker), so a
                grown multi-line comment isn't flanked by controls drifting in its
                vertical centre (mirrors the landing + floating-dock composers). */}
            <textarea
              ref={composerRef}
              rows={1}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void post();
                }
              }}
              aria-label={t.pageComposerAria}
              placeholder={t.composerPlaceholder}
              className="max-h-32 min-h-[24px] w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-relaxed outline-none focus-visible:shadow-none placeholder:text-muted-foreground/60"
            />
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
            {aiReply ? (
              <AttachmentChips attachments={att.attachments} onRemove={att.remove} />
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
                // Doc research ships; the band always has a backing assistant.
                showResearch
                aiReply={aiReply}
                onAiReplyChange={setAiReply}
                selectSide="bottom"
                className="flex-1"
              />
              <button
                type="button"
                onClick={() => void post()}
                disabled={busy || att.uploading || (!draft.trim() && !(aiReply && att.hasReady))}
                aria-label={busy ? t.sending : t.send}
                className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary text-primary-foreground transition-colors hover:bg-primary/90 disabled:bg-foreground/10 disabled:text-muted-foreground"
              >
                <ArrowUp className="size-4" />
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}
