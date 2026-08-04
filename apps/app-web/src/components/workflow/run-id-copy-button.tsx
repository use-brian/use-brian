"use client";

/**
 * Small copy control for a workflow run's FULL identifier.
 *
 * Both places that render a run id — the run-history row and the run-detail
 * header — keep their compact 8-character chip (a full UUID wrecks the row
 * layout) and pair it with this button: click to copy the complete id,
 * transient confirmation, and a `title` tooltip on the chip itself carries
 * the full id for hover-reading. A user who needs the exact reference (a
 * bug report, a support thread, pasting it back into chat) no longer has to
 * select it out of the URL bar.
 *
 * Mirrors the copy interaction already established in this surface
 * (webhook-trigger-fields.tsx `WebhookCredentials.copy`): writes to the
 * clipboard, flips a transient "copied" state that clears itself, and
 * swallows clipboard failures silently (the clipboard may be restricted).
 *
 * use-brian#278 — the original incident was the assistant fabricating a
 * fake UUID because the interface never exposed the real one anywhere.
 * Spec: docs/architecture/features/workflow.md → "Run lookup by prefix".
 * [COMP:app-web/workflow]
 */

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { cn } from "@/lib/utils";

/** Matches the chat code-block copy-flash duration convention in this app. */
const COPIED_FLASH_MS = 1500;

export function RunIdCopyButton({
  id,
  copyLabel,
  copiedLabel,
  className,
}: {
  /** The FULL run id to copy — never the truncated chip text. */
  id: string;
  copyLabel: string;
  copiedLabel: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const onCopy = async (e: React.MouseEvent<HTMLButtonElement>) => {
    // Callers render this as a sibling of (never nested inside) a
    // navigating <Link> — see run-history.tsx's structural note — but stop
    // propagation regardless so copying can never be mistaken for a row
    // click by anything wrapping this button in the future.
    e.preventDefault();
    e.stopPropagation();
    if (!navigator.clipboard?.writeText) return;
    try {
      await navigator.clipboard.writeText(id);
      setCopied(true);
      window.clearTimeout(timerRef.current);
      timerRef.current = window.setTimeout(
        () => setCopied(false),
        COPIED_FLASH_MS,
      );
    } catch {
      // ignore — clipboard may be restricted
    }
  };

  return (
    <button
      type="button"
      onClick={onCopy}
      title={copied ? copiedLabel : copyLabel}
      aria-label={copied ? copiedLabel : copyLabel}
      className={cn(
        "inline-flex h-5 w-5 shrink-0 items-center justify-center rounded text-muted-foreground/70 transition-colors hover:bg-muted hover:text-foreground",
        className,
      )}
    >
      {copied ? (
        <Check className="size-3 text-primary" aria-hidden />
      ) : (
        <Copy className="size-3" aria-hidden />
      )}
    </button>
  );
}
