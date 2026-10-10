"use client";

/**
 * Read-only raw document: the Chat side pane's `document` tab body, plus the
 * transcript card that reopens it (chat-parity D5; the old split view is
 * gone, the pane owns closing and resizing).
 * [COMP:app-web/chat-document-viewer]
 */

import { useEffect, useRef, useState } from "react";
import { ChatMarkdown, type DocumentAttachment } from "@use-brian/chat-ui";
import remarkGfm from "remark-gfm";
import { Check, ChevronRight, Copy, FileText } from "lucide-react";
import { format, useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";

const REMARK_PLUGINS = [remarkGfm];

export function ChatDocumentCard({
  document,
  onOpen,
}: {
  document: DocumentAttachment;
  onOpen: (document: DocumentAttachment) => void;
}) {
  const t = useT().chatApp.documentViewer;
  return (
    <button
      type="button"
      onClick={() => onOpen(document)}
      aria-label={format(t.openAria, { title: document.title })}
      className={cn(
        "flex w-full max-w-md items-center gap-3 rounded-xl border border-border bg-muted/30 px-3 py-2.5 text-left",
        "transition-colors hover:border-primary/30 hover:bg-muted/55 focus-visible:shadow-none",
      )}
    >
      <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-background text-muted-foreground ring-1 ring-border">
        <FileText className="size-4" aria-hidden />
      </span>
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-medium text-foreground">
          {document.title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {document.sourceName ?? t.open}
        </span>
      </span>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground" aria-hidden />
    </button>
  );
}

export function ChatDocumentBody({ document }: { document: DocumentAttachment }) {
  const t = useT().chatApp.documentViewer;
  const [copied, setCopied] = useState(false);
  const resetRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (resetRef.current != null) window.clearTimeout(resetRef.current);
    },
    [],
  );

  const copy = () => {
    void navigator.clipboard?.writeText(document.content).catch(() => {});
    setCopied(true);
    if (resetRef.current != null) window.clearTimeout(resetRef.current);
    resetRef.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div aria-label={t.label} className="flex min-h-0 flex-1 flex-col">
      <header className="flex min-h-14 shrink-0 items-center gap-3 border-b border-border px-3.5 py-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <FileText className="size-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-foreground">
            {document.title}
          </p>
          <p className="truncate text-[11px] text-muted-foreground">
            {document.sourceName ?? t.label}
          </p>
        </div>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? t.copied : t.copy}
          title={copied ? t.copied : t.copy}
          className="inline-flex size-11 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:shadow-none sm:size-8"
        >
          {copied ? (
            <Check className="size-4" aria-hidden />
          ) : (
            <Copy className="size-4" aria-hidden />
          )}
        </button>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 py-6 sm:px-7 md:px-8">
        {document.format === "markdown" ? (
          <div
            data-document-format="markdown"
            className="chat-markdown prose prose-sm dark:prose-invert max-w-none text-[14px] leading-[1.7] text-foreground break-words"
          >
            <ChatMarkdown text={document.content} remarkPlugins={REMARK_PLUGINS} />
          </div>
        ) : (
          <pre
            data-document-format="text"
            className="m-0 whitespace-pre-wrap break-words font-sans text-[14px] leading-[1.75] text-foreground"
          >
            {document.content}
          </pre>
        )}
      </div>
    </div>
  );
}
