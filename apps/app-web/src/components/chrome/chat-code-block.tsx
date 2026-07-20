"use client";

/**
 * `<pre>` renderer for chat markdown — every fenced code block gets a
 * hover-reveal copy button so its text can be grabbed in one click.
 *
 * Hand-selecting a block's text inside a chat message is fiddly and, via the
 * per-MESSAGE copy action, drags the whole message's raw markdown along
 * (heading `#`s, the ``` fences, the prose around the block). This copies
 * exactly what the block shows — `textContent` of the rendered `<pre>` — with
 * one trailing newline trimmed (fenced code always parses with one; on the
 * clipboard it only adds a blank line on paste).
 *
 * Wired through `ChatMarkdown`'s `components` pass-through: surfaces with
 * their own renderer map spread `pre: ChatCodeBlock` in (the floating chat's
 * `ChatMarkdownWithLinks`); plain surfaces pass the shared
 * `chatMarkdownCodeComponents` object (module-level, so the reference is
 * stable across renders). The reveal group is NAMED (`group/codeblock`) —
 * message rows already use bare `group` for their own hover actions, and an
 * unnamed nested group would reveal every block's button from anywhere in
 * the message.
 *
 * Clipboard API only (`navigator.clipboard` is present on the app's
 * secure-context surfaces incl. the desktop shell); when it's absent the
 * button no-ops rather than half-selecting.
 *
 * [COMP:app-web/chat-code-block]
 */

import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { useT } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import type { ChatMarkdownProps } from "@use-brian/chat-ui";

/** How long the ✓ "copied" state shows before reverting (matches the
 *  per-message copy flash + the block menu's copy-link flash). */
const COPIED_FLASH_MS = 1600;

type PreProps = React.HTMLAttributes<HTMLPreElement> & {
  /** react-markdown's hast node — stripped so it never hits the DOM. */
  node?: unknown;
};

export function ChatCodeBlock({ node: _node, children, ...rest }: PreProps) {
  const t = useT().chat;
  const preRef = useRef<HTMLPreElement | null>(null);
  const timerRef = useRef<number | undefined>(undefined);
  const [copied, setCopied] = useState(false);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const onCopy = () => {
    const text = preRef.current?.textContent ?? "";
    if (!text || !navigator.clipboard?.writeText) return;
    void navigator.clipboard
      .writeText(text.replace(/\n$/, ""))
      .then(() => {
        setCopied(true);
        window.clearTimeout(timerRef.current);
        timerRef.current = window.setTimeout(
          () => setCopied(false),
          COPIED_FLASH_MS,
        );
      })
      .catch(() => {
        /* clipboard permission denied — leave the button in its idle state */
      });
  };

  return (
    <div className="group/codeblock relative">
      <pre ref={preRef} {...rest}>
        {children}
      </pre>
      <button
        type="button"
        aria-label={copied ? t.copied : t.copyCode}
        title={copied ? t.copied : t.copyCode}
        onClick={onCopy}
        className={cn(
          "absolute right-1.5 top-1.5 inline-flex h-6 w-6 items-center justify-center rounded-md border border-border/60 bg-background/90 text-muted-foreground shadow-sm backdrop-blur-sm transition-opacity hover:text-foreground",
          copied
            ? "opacity-100"
            : "opacity-0 focus-visible:opacity-100 group-hover/codeblock:opacity-100",
        )}
      >
        {copied ? (
          <Check className="size-3.5 text-primary" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
    </div>
  );
}

/** Ready-made `components` map for surfaces that render `ChatMarkdown` with
 *  no renderer overrides of their own (skill iteration chat, entry thread). */
export const chatMarkdownCodeComponents: NonNullable<
  ChatMarkdownProps["components"]
> = { pre: ChatCodeBlock };
