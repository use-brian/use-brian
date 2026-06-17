"use client";

/**
 * New-comment composer — the **draft** popover shown while the user is writing
 * a brand-new comment, before anything is committed.
 *
 * This is the lazy half of the comment flow. Clicking "Comment" on a selection
 * paints a LOCAL draft highlight (`comment-decorations.ts` → `syncCommentDraft`)
 * and opens this composer; it writes nothing to the backend or the Yjs doc.
 * Only when the user sends the first message does `collab-page-editor` commit —
 * minting the thread, stamping the `comment` mark, and opening the real
 * `<CommentThreadBody>`. Clicking elsewhere or pressing Escape dismisses the
 * draft with no trace (the highlight clears, no thread row, no badge).
 *
 * Deliberately leaner than the thread body: no message list, no "No comments
 * yet" empty state, and no composer avatar — just the quoted anchor text and a
 * single auto-focused input. A subtle **AI-reply toggle** (in
 * `<ComposerControls>`) lets the user post a plain comment for teammates with
 * no assistant reply; when off, the research + model controls disable and
 * attachments hide (they only shape an AI turn).
 *
 * Positioning + the outside-click/Escape shell mirror `comment-thread-popover`
 * (it reuses `useAnchoredPosition` + `COMMENT_PANEL_WIDTH`).
 *
 * [COMP:app-web/new-comment-popover]
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { ArrowUp, Paperclip } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { ComposerControls, useComposerControls } from "@/components/doc/composer-controls";
import { CommentComposer } from "@/components/doc/comment-composer";
import { AttachmentChips, FileDropOverlay } from "@/components/doc/attachment-chips";
import { useFileAttachments } from "@/lib/use-file-attachments";
import { useFileDrop } from "@/lib/use-file-drop";
import { isInsideComposerPopup } from "@/lib/comment-dismiss";
import { type ModelTier } from "@/lib/chat-model";
import {
  COMMENT_PANEL_WIDTH,
  useAnchoredPosition,
} from "@/components/doc/comment-thread-popover";

/** What the editor needs to commit a draft into a real thread + first comment. */
export type NewCommentSubmit = {
  body: string;
  fileIds: string[];
  model?: ModelTier;
  researchMode: boolean;
  /** Whether the assistant should reply (false → a plain teammate comment). */
  aiReply: boolean;
  /** Workspace-member ids @-mentioned in the body, for Inbox notifications. */
  mentions: string[];
};

type Props = {
  /** The draft highlight element to anchor against (null → not shown). */
  anchorEl: HTMLElement | null;
  /** Snapshot of the selected text, shown as the amber quote bar. */
  quote: string;
  workspaceId: string;
  /** Whether a doc assistant backs this page — gates the AI-reply path. With
   *  no assistant the toggle is hidden and every comment is teammate-only. */
  hasAssistant: boolean;
  /** Commit the draft: mint the thread + post the first comment. */
  onSubmit: (payload: NewCommentSubmit) => void;
  /** Dismiss without committing — clears the draft highlight, no backend write. */
  onDismiss: () => void;
};

export function NewCommentPopover({
  anchorEl,
  quote,
  workspaceId,
  hasAssistant,
  onSubmit,
  onDismiss,
}: Props) {
  const t = useT().comments;
  const tAttach = useT().attachments;
  const open = !!anchorEl;
  const panelRef = React.useRef<HTMLDivElement>(null);
  const composerRef = React.useRef<HTMLTextAreaElement>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  // Pass the panel element so an inside-the-panel scroll (e.g. the model picker's
  // own scroll) doesn't trigger a reposition — see `scrollMovesAnchor`.
  const pos = useAnchoredPosition(anchorEl, open, panelRef);

  const controls = useComposerControls(workspaceId);
  // Teammate-only when there's no assistant to reply; otherwise default to an
  // AI reply (the assistant acts on the comment, matching the existing flow).
  const [aiReply, setAiReply] = React.useState(hasAssistant);
  const [draft, setDraft] = React.useState("");
  const [mentionIds, setMentionIds] = React.useState<string[]>([]);
  const [busy, setBusy] = React.useState(false);
  // Draft attachments (uploaded to the transient cache, no session yet) — only
  // meaningful on the AI path, so hidden + cleared when AI reply is off.
  const att = useFileAttachments();
  const drop = useFileDrop((files) => void att.upload(files), { disabled: !aiReply });

  // Move focus to the input as soon as the composer is placed (one rAF so the
  // portal has painted) — the user clicked "Comment" to type, so don't make
  // them click again.
  React.useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => composerRef.current?.focus());
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  // Outside-click + Escape dismiss. Attached next tick so the opening click
  // can't immediately close it (mirrors the thread popover). The model picker's
  // dropdown portals to <body>, so ignore clicks inside it too.
  React.useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (panelRef.current?.contains(tgt as Node)) return;
      if (anchorEl?.contains(tgt as Node)) return;
      if (tgt?.closest?.("[data-comment-draft]") || isInsideComposerPopup(tgt))
        return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
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
  }, [open, anchorEl, onDismiss]);

  const hasFiles = aiReply && att.hasReady;
  const canSend = !busy && !att.uploading && (!!draft.trim() || hasFiles);

  function submit() {
    if (!canSend) return;
    setBusy(true);
    onSubmit({
      body: draft.trim(),
      fileIds: hasFiles ? att.fileIds() : [],
      model: controls.model,
      researchMode: aiReply ? controls.researchMode : false,
      aiReply,
      mentions: mentionIds,
    });
    // The editor unmounts this on commit; clear locally in case it lingers.
    setDraft("");
    setMentionIds([]);
    att.clear();
  }

  if (!open || !pos || typeof document === "undefined") return null;

  const panel = (
    <div
      ref={panelRef}
      role="dialog"
      aria-label={t.newCommentAria}
      style={{
        position: "fixed",
        left: pos.left,
        top: pos.top,
        bottom: pos.bottom,
        width: COMMENT_PANEL_WIDTH,
        maxHeight: pos.maxHeight,
      }}
      className="z-40 flex max-w-[92vw] flex-col overflow-hidden rounded-xl border border-border bg-popover text-popover-foreground shadow-lg"
    >
      <div className="flex flex-col gap-2 p-3" {...drop.dropProps}>
        <FileDropOverlay active={drop.isDragging} />
        {quote ? (
          <div className="border-l-2 border-amber-400 pl-2.5 text-[13px] leading-snug text-muted-foreground">
            <span className="line-clamp-2">{quote}</span>
          </div>
        ) : null}
        <div className="flex flex-1 flex-col gap-1 rounded-2xl border border-foreground/[0.18] bg-background px-3 py-2 shadow-[0_1px_2px_rgba(0,0,0,0.04)]">
          {/* The composer is the input row alone — attach + send (ArrowUp) live
              in the footer strip below (attach next to the AI-reply / Research
              toggles, send next to the model picker), so a grown multi-line
              comment isn't flanked by controls drifting in its vertical centre
              (mirrors the landing + floating-dock composers). */}
          <CommentComposer
            textareaRef={composerRef}
            value={draft}
            onValueChange={(v, ids) => {
              setDraft(v);
              setMentionIds(ids);
            }}
            onEnter={submit}
            workspaceId={workspaceId}
            placeholder={t.composerPlaceholder}
            className="max-h-32 min-h-[24px] w-full resize-none border-0 bg-transparent p-0 text-[14px] leading-relaxed outline-none focus-visible:shadow-none placeholder:text-muted-foreground/70"
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
              // Doc research ships — arm the toggle wherever the assistant
              // answers (it disables with AI-reply off, like the model picker).
              // A no-assistant page has nothing to research for.
              showResearch={hasAssistant}
              {...(hasAssistant
                ? { aiReply, onAiReplyChange: setAiReply }
                : {})}
              className="flex-1"
            />
            <button
              type="button"
              onClick={submit}
              disabled={!canSend}
              aria-label={t.send}
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

  return createPortal(panel, document.body);
}
