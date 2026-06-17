"use client";

/**
 * SkillIterationChat — the chat rail that iterates on a skill document,
 * shared by the skill CREATOR's doc stage (refining the unsaved draft) and
 * the skill EDITOR page's rail Chat tab (refining the loaded skill; Save
 * still goes through the existing PATCH + D2 trust stamp — the human
 * reviews, then saves).
 *
 * Each send posts ONE stateless turn to `POST /api/skills/draft`
 * (`draftSkillTurn`): the local transcript + the LIVE document
 * (`getDraft()`, hand edits included) travel with every request. A
 * `kind:'draft'` response applies to the document via `onDraft` and the
 * narration message lands as the assistant bubble; a `kind:'reply'`
 * (questions / advice) is a bubble only — no draft change. The old
 * structured clarify-round form and "Regenerate with feedback" box are
 * retired by this conversation (plan D3 as amended).
 *
 * Full chat-composer UX, reusing the doc surfaces' pieces:
 *   - model tier picker + deep-research toggle (`ComposerControls` via
 *     `useComposerControls`; the tier choice shares `doc-chat-model`
 *     persistence with the chat docks — deliberate). Research turns get
 *     webSearch/urlReader grounding server-side (NOT the deep-research
 *     coordinator; no lifetime quota events on this path, so the quota chip
 *     simply never renders).
 *   - file attachments (`useFileAttachments` + `AttachmentChips` +
 *     drag-drop `FileDropOverlay`), sent as `fileIds`.
 *
 * Transcript state lives HERE (the host owns the document state); it is
 * conversation-scoped and intentionally not persisted — the endpoint is
 * stateless and the document is the artifact, not the chat. Failed sends
 * stay visible (error styling) but never ride the wire again
 * (`toWireMessages` drops them).
 *
 * [COMP:app-web/skill-iteration-chat]
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Paperclip, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";
import { ChatMarkdown } from "@sidanclaw/chat-ui";
import {
  draftSkillTurn,
  type SkillDraft,
} from "@/lib/api/skills";
import {
  clampDraftForWire,
  draftHasContent,
  toWireMessages,
  type SkillChatTurn,
} from "@/lib/skill-draft-chat";
import {
  ComposerControls,
  useComposerControls,
} from "@/components/doc/composer-controls";
import { useFileAttachments } from "@/lib/use-file-attachments";
import { useFileDrop } from "@/lib/use-file-drop";
import { useAutoGrowTextarea } from "@/lib/use-auto-grow-textarea";
import {
  AttachmentChips,
  FileDropOverlay,
} from "@/components/doc/attachment-chips";

/** Statuses meaning "the draft engine isn't reachable" — hosts degrade
 *  (the creator shows its manual-authoring notice). */
const DRAFT_UNAVAILABLE_STATUSES = new Set([404, 500, 501, 503]);

type Props = {
  workspaceId: string;
  /** Read the LIVE document at send time — hand edits included. */
  getDraft: () => SkillDraft;
  /** Apply a revised draft (the narration lands as the assistant bubble). */
  onDraft: (draft: SkillDraft, message: string) => void;
  /** Template grounding resent with every stateless turn (creator only). */
  templateSlug?: string;
  /** Sent as the first user turn on mount (the creator's intent path). */
  autoSendFirst?: string;
  /** File ids staged in the creator's intent composer — they ride the
   *  auto-sent first turn (ignored without `autoSendFirst`: a turn is a
   *  message, files can't travel alone). */
  initialFileIds?: string[];
  /** A turn failed with a draft-engine-unreachable status (404/500/501/503). */
  onUnavailable?: (status: number) => void;
  /** Mirrors the in-flight turn so hosts can quiet their own chrome. */
  onBusyChange?: (busy: boolean) => void;
  className?: string;
};

export function SkillIterationChat({
  workspaceId,
  getDraft,
  onDraft,
  templateSlug,
  autoSendFirst,
  initialFileIds,
  onUnavailable,
  onBusyChange,
  className,
}: Props) {
  const t = useT();
  const copy = t.brainPage.skillChat;

  const [transcript, setTranscript] = useState<SkillChatTurn[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const controls = useComposerControls(workspaceId);
  const attachments = useFileAttachments();
  const { isDragging, dropProps } = useFileDrop(attachments.upload);

  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoGrowTextarea(textareaRef, input);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  // Keep the latest callbacks/state in refs so `sendText` stays stable for
  // the auto-send effect.
  const busyRef = useRef(busy);
  busyRef.current = busy;
  // The transcript snapshot `sendText` builds the wire view from. A ref so
  // the auto-send effect can fire before the first render commits state.
  const transcriptRef = useRef(transcript);
  transcriptRef.current = transcript;

  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);

  // Pin the transcript to the bottom as turns land.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcript, busy]);

  const sendText = useCallback(
    async (raw: string, extraFileIds?: string[]) => {
      const text = raw.trim();
      if (!text || busyRef.current) return;
      const userTurn: SkillChatTurn = {
        id: crypto.randomUUID(),
        role: "user",
        content: text,
      };
      // Wire view BEFORE the optimistic append (it includes the new turn).
      const prior = transcriptRef.current;
      const wire = toWireMessages([...prior, userTurn]);
      setTranscript((prev) => [...prev, userTurn]);
      setError(null);
      // Files staged in this composer + any handed in by the caller (the
      // creator's intent-composer attachments on the auto-sent first turn).
      const fileIds = [...(extraFileIds ?? []), ...attachments.fileIds()];
      attachments.clear();
      setBusy(true);
      const draft = getDraft();
      const result = await draftSkillTurn({
        workspaceId,
        messages: wire,
        templateSlug: templateSlug || undefined,
        currentDraft: draftHasContent(draft) ? clampDraftForWire(draft) : undefined,
        model: controls.model,
        research: controls.researchMode || undefined,
        fileIds: fileIds.length > 0 ? fileIds : undefined,
      });
      setBusy(false);
      if (!result.ok) {
        setTranscript((prev) =>
          prev.map((turn) =>
            turn.id === userTurn.id ? { ...turn, failed: true } : turn,
          ),
        );
        setError(result.error);
        if (DRAFT_UNAVAILABLE_STATUSES.has(result.status)) {
          onUnavailable?.(result.status);
        }
        return;
      }
      const note =
        result.kind === "draft"
          ? result.message || copy.draftApplied
          : result.message;
      if (result.kind === "draft") onDraft(result.draft, note);
      setTranscript((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: note },
      ]);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [
      workspaceId,
      templateSlug,
      getDraft,
      onDraft,
      onUnavailable,
      controls.model,
      controls.researchMode,
      attachments,
      copy.draftApplied,
    ],
  );

  // The creator's intent path: the first user message (plus any files staged
  // in the intent composer) arrives as props and sends itself once on mount.
  const autoSentRef = useRef(false);
  useEffect(() => {
    if (autoSentRef.current) return;
    autoSentRef.current = true;
    if (autoSendFirst?.trim()) void sendText(autoSendFirst, initialFileIds);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function submit() {
    if (busy || attachments.uploading) return;
    const text = input;
    setInput("");
    void sendText(text);
  }

  return (
    <div className={cn("flex min-h-0 flex-col", className)}>
      {/* ── Transcript ─────────────────────────────────────────────── */}
      <div
        ref={scrollRef}
        className="min-h-0 flex-1 overflow-y-auto"
        aria-live="polite"
      >
        {transcript.length === 0 && !busy ? (
          <div className="flex h-full min-h-24 items-center justify-center px-4 text-center">
            <p className="text-xs leading-relaxed text-muted-foreground/70">
              {copy.emptyHint}
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-3 py-2">
            {transcript.map((turn) =>
              turn.role === "user" ? (
                <div key={turn.id} className="flex justify-end pl-8">
                  <div
                    className={cn(
                      "max-w-full rounded-xl rounded-br-sm bg-muted px-3 py-2 text-[13px] leading-relaxed whitespace-pre-wrap break-words",
                      turn.failed && "border border-destructive/40 text-muted-foreground",
                    )}
                  >
                    {turn.content}
                  </div>
                </div>
              ) : (
                <div
                  key={turn.id}
                  className="doc-chat-markdown pr-4 text-[13px] leading-relaxed text-foreground/90 [&_p]:my-1.5 [&_ul]:my-1.5 [&_ol]:my-1.5"
                >
                  <ChatMarkdown text={turn.content} />
                </div>
              ),
            )}
            {busy && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Sparkles className="size-3.5 animate-pulse" aria-hidden />
                {copy.drafting}
              </div>
            )}
          </div>
        )}
      </div>

      {error && (
        <p className="px-1 pb-1.5 text-xs text-red-500" role="alert">
          {error}
        </p>
      )}

      {/* ── Composer — the app's composer-card recipe ──────────────── */}
      <div
        {...dropProps}
        className={cn(
          "relative rounded-xl border border-border bg-card shadow-xs transition-[border-color,box-shadow]",
          "focus-within:border-ring focus-within:ring-2 focus-within:ring-ring/35",
        )}
      >
        <FileDropOverlay active={isDragging} />
        {attachments.attachments.length > 0 && (
          <div className="px-3 pt-2.5">
            <AttachmentChips
              attachments={attachments.attachments}
              onRemove={attachments.remove}
            />
          </div>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          rows={1}
          maxLength={4000}
          placeholder={copy.placeholder}
          aria-label={copy.placeholder}
          // Stays typeable while a turn is in flight — `submit()` no-ops on
          // busy, so Enter can't double-send; only the send button locks.
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
          className="max-h-32 w-full resize-none overflow-y-auto bg-transparent px-3 pt-2.5 pb-1 text-[13px] outline-none focus-visible:shadow-none placeholder:text-muted-foreground/70 disabled:opacity-60"
        />
        <div className="flex items-center gap-1.5 px-2 pb-2 pt-0.5">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => {
              if (e.target.files) void attachments.upload(e.target.files);
              e.target.value = "";
            }}
          />
          <button
            type="button"
            aria-label={copy.attach}
            title={copy.attach}
            onClick={() => fileInputRef.current?.click()}
            className="inline-flex size-7 shrink-0 items-center justify-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <Paperclip className="size-4" aria-hidden />
          </button>
          <ComposerControls
            model={controls.model}
            onModelChange={controls.setModel}
            plan={controls.plan}
            researchMode={controls.researchMode}
            onResearchModeChange={controls.setResearchMode}
            researchQuota={controls.researchQuota}
            researchExhausted={controls.researchExhausted}
            showResearch
            selectSide="top"
            className="min-w-0 flex-1"
          />
          <button
            type="button"
            aria-label={copy.send}
            title={copy.send}
            disabled={busy || attachments.uploading || !input.trim()}
            onClick={submit}
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-lg transition-colors",
              input.trim() && !busy && !attachments.uploading
                ? "bg-primary text-primary-foreground hover:bg-primary/90"
                : "bg-muted text-muted-foreground",
            )}
          >
            <ArrowUp className="size-4" aria-hidden />
          </button>
        </div>
      </div>
    </div>
  );
}
