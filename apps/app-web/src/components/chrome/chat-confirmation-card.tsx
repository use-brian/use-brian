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

import { TriangleAlert } from "lucide-react";
import type { PendingConfirmation } from "@use-brian/chat-ui";
import { cn } from "@/lib/utils";
import { ToolPreview } from "@/components/doc/panels/approval-tool-previews";
import {
  extractAttachmentLines,
  parseToolPreview,
} from "@/lib/approval-previews";

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
  onDeny: (toolCallId: string) => void;
}) {
  const title = confirmation.displayName ?? confirmation.toolName;
  const isInFlight = confirmation.status === "approving";
  const preview = parseToolPreview(confirmation.toolName, confirmation.input);
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
              <ul className="text-xs text-muted-foreground space-y-0.5">
                {confirmation.displayLines.map((line, i) => (
                  <li key={i} className="break-words">
                    {line}
                  </li>
                ))}
              </ul>
            ) : null}
          </>
        )}
        <div className="flex items-center gap-2 pt-1">
          <button
            type="button"
            onClick={() => onApprove(confirmation.toolCallId)}
            disabled={isInFlight}
            className={cn(
              "rounded-md bg-primary px-3 py-1 text-[12px] font-medium text-primary-foreground",
              "transition-colors hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed",
            )}
          >
            {isInFlight ? approvingLabel : approveLabel}
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
            {denyLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
