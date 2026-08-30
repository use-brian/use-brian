"use client";

/**
 * Inline Approve/Deny card while a tool awaits user confirmation in chat.
 *
 * Extracted from `floating-chat.tsx` so the per-tool preview wiring is
 * testable. Recognised tool calls (the `parseToolPreview` registry shared
 * with the approvals queue and the workflow live-run banner) render a rich
 * preview parsed from the confirmation's `input` — an email send shows as
 * a proofreadable email, not the tool's model-facing description. When a
 * preview renders, the `description` and `displayLines` are suppressed
 * (they narrate the same call); unrecognised tools keep the original
 * description + displayLines card.
 *
 * Spec: docs/architecture/features/workflow.md → Unified approvals.
 * [COMP:app-web/chat-confirmation-card]
 */

import { useState, type ReactNode } from "react";
import { TriangleAlert } from "lucide-react";
import type { PendingConfirmation } from "@use-brian/chat-ui";
import { buildConfirmationPreview } from "@use-brian/shared";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  GenericToolPreview,
  ToolInputToggle,
  ToolPreview,
} from "@/components/doc/panels/approval-tool-previews";
import {
  extractAttachmentLines,
  extractEmailSender,
  parseToolPreview,
} from "@/lib/approval-previews";

/** A unified-diff-notation line (server-computed KB update preview). */
function isDiffLine(line: string): boolean {
  return (
    line.startsWith("@@ ") ||
    line.startsWith("+ ") ||
    line.startsWith("- ") ||
    line.startsWith("  ")
  );
}

/**
 * Display lines with diff awareness. `updateKnowledgeEntry` confirmations
 * carry a server-computed unified diff after a `Changes:` marker (only the
 * server holds the old body — see knowledge-base.md → "Update previews are
 * diffs"); those lines render as a styled monospace diff block instead of
 * prose bullets. Every other tool keeps the plain list.
 */
function ConfirmationLines({
  toolName,
  lines,
}: {
  toolName: string;
  lines: string[];
}) {
  if (toolName !== "updateKnowledgeEntry" && toolName !== "updateBrainEntry") {
    return (
      <ul className="text-xs text-muted-foreground space-y-0.5">
        {lines.map((line, i) => (
          <li key={i} className="whitespace-pre-wrap break-words">
            {line}
          </li>
        ))}
      </ul>
    );
  }

  // Split into prose lines and consecutive diff runs, preserving order.
  const blocks: Array<{ kind: "prose"; line: string } | { kind: "diff"; lines: string[] }> = [];
  for (const line of lines) {
    if (isDiffLine(line)) {
      const last = blocks[blocks.length - 1];
      if (last && last.kind === "diff") last.lines.push(line);
      else blocks.push({ kind: "diff", lines: [line] });
    } else {
      blocks.push({ kind: "prose", line });
    }
  }

  return (
    <div className="space-y-1">
      {blocks.map((block, i): ReactNode =>
        block.kind === "prose" ? (
          <p key={i} className="text-xs text-muted-foreground whitespace-pre-wrap break-words">
            {block.line}
          </p>
        ) : (
          <pre
            key={i}
            className="max-h-64 overflow-auto rounded-md border border-border/60 bg-background/60 px-2 py-1.5 font-mono text-[11px] leading-relaxed"
          >
            {block.lines.map((line, j) => (
              <div
                key={j}
                className={cn(
                  "whitespace-pre-wrap break-words",
                  line.startsWith("@@")
                    ? "text-muted-foreground/70"
                    : line.startsWith("+")
                      ? "text-emerald-600 dark:text-emerald-400"
                      : line.startsWith("-")
                        ? "text-red-600 dark:text-red-400"
                        : "text-muted-foreground",
                )}
              >
                {line}
              </div>
            ))}
          </pre>
        ),
      )}
    </div>
  );
}

export function ChatConfirmationCard({
  confirmation,
  approveLabel,
  denyLabel,
  approvingLabel,
  onApprove,
  onDeny,
}: {
  confirmation: PendingConfirmation;
  approveLabel: string;
  denyLabel: string;
  approvingLabel: string;
  onApprove: (toolCallId: string) => void;
  /** A denial with an optional note. The note reaches the model via
   *  `declinedToolResult` so the assistant revises rather than re-asks. */
  onDeny: (toolCallId: string, comment?: string) => void;
}) {
  const dictionary = useT();
  const t = dictionary.chat;
  const brainEdit = dictionary.brainPage.detailDrawer;
  // "Deny with comment": the composer is revealed on demand so the default
  // card stays a two-button Approve/Deny. Submitting sends the trimmed note
  // (or a plain deny when left blank).
  const [commenting, setCommenting] = useState(false);
  const [comment, setComment] = useState("");
  const title = confirmation.displayName ?? confirmation.toolName;
  const isInFlight = confirmation.status === "approving";
  const effectiveApproveLabel =
    confirmation.toolName === "updateBrainEntry"
      ? brainEdit.editThreadApply
      : approveLabel;
  const effectiveDenyLabel =
    confirmation.toolName === "updateBrainEntry"
      ? brainEdit.editThreadKeepEditing
      : denyLabel;
  const effectiveApprovingLabel =
    confirmation.toolName === "updateBrainEntry"
      ? brainEdit.editThreadApplying
      : approvingLabel;
  const preview = parseToolPreview(confirmation.toolName, confirmation.input);
  const submitDenial = () => {
    if (isInFlight) return;
    onDeny(confirmation.toolCallId, comment.trim() || undefined);
  };
  return (
    <div className="flex gap-2.5">
      <div className="mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-lg bg-amber-500/15 text-amber-600 dark:text-amber-400 ring-1 ring-amber-500/25">
        <TriangleAlert className="size-3.5" aria-hidden />
      </div>
      <div className="flex-1 min-w-0 rounded-xl border border-amber-500/30 bg-amber-500/5 p-3 space-y-2">
        <div className="text-[13px] font-medium text-foreground">{title}</div>
        {preview ? (
          <ToolPreview
            preview={preview}
            attachmentLines={extractAttachmentLines(confirmation.displayLines)}
            senderEmail={extractEmailSender(confirmation.displayLines)}
          />
        ) : (
          <>
            {confirmation.description ? (
              <p className="text-xs text-muted-foreground leading-relaxed">
                {confirmation.description}
              </p>
            ) : null}
            {confirmation.displayLines &&
            confirmation.displayLines.length > 0 ? (
              <ConfirmationLines
                toolName={confirmation.toolName}
                lines={confirmation.displayLines}
              />
            ) : (
              <GenericToolPreview
                preview={buildConfirmationPreview(confirmation.input)}
              />
            )}
          </>
        )}
        <ToolInputToggle args={confirmation.input} disabled={isInFlight} />
        {commenting ? (
          <div className="space-y-2 pt-1">
            <textarea
              autoFocus
              rows={2}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
              onKeyDown={(event) => {
                if (
                  event.key !== "Enter" ||
                  event.shiftKey ||
                  event.nativeEvent.isComposing
                ) {
                  return;
                }
                event.preventDefault();
                submitDenial();
              }}
              disabled={isInFlight}
              placeholder={t.confirmationCommentPlaceholder}
              maxLength={1000}
              className={cn(
                "w-full resize-none rounded-md border border-amber-500/40 bg-background px-2.5 py-1.5 text-[12px] text-foreground",
                "placeholder:text-muted-foreground focus:outline-none focus:ring-1 focus:ring-amber-500/50 disabled:opacity-50",
              )}
            />
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={submitDenial}
                disabled={isInFlight}
                className={cn(
                  "rounded-md border border-border bg-background px-3 py-1 text-[12px] font-medium text-muted-foreground",
                  "transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed",
                )}
              >
                {t.confirmationCommentSubmit}
              </button>
              <button
                type="button"
                onClick={() => {
                  setCommenting(false);
                  setComment("");
                }}
                disabled={isInFlight}
                className="rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {t.confirmationCommentCancel}
              </button>
            </div>
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <button
              type="button"
              onClick={() => onApprove(confirmation.toolCallId)}
              disabled={isInFlight}
              className={cn(
                "rounded-md bg-action px-3 py-1 text-[12px] font-medium text-action-foreground",
                "transition-colors hover:bg-action/90 disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {isInFlight ? effectiveApprovingLabel : effectiveApproveLabel}
            </button>
            <button
              type="button"
              onClick={() => onDeny(confirmation.toolCallId)}
              disabled={isInFlight}
              className={cn(
                "rounded-md border border-border bg-background px-3 py-1 text-[12px] font-medium text-muted-foreground",
                "transition-colors hover:bg-muted hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed",
              )}
            >
              {effectiveDenyLabel}
            </button>
            <button
              type="button"
              onClick={() => setCommenting(true)}
              disabled={isInFlight}
              className="rounded-md px-2 py-1 text-[12px] font-medium text-muted-foreground transition-colors hover:text-foreground disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {t.confirmationDenyWithComment}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
