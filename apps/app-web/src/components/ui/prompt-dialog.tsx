"use client";

/**
 * On-brand text prompt — `promptDialog({ ... })` returns a
 * `Promise<string | null>` (the entered value, or `null` if cancelled).
 * The themed sibling of `confirmDialog`: used for Rename and any other
 * "ask the user for one short string" flow. `multiline` swaps the input
 * for a textarea in a wider popup (sentence-length answers), and
 * `allowEmpty` makes a blank field resolve `""` instead of cancelling, so
 * a flow can offer "do it without the extra step" from the same dialog.
 *
 * **Never use `window.prompt`** in this app (root CLAUDE.md
 * anti-pattern) — it ignores the theme + i18n cookie and breaks the
 * cross-app look. Mounted once at the app root via
 * `<PromptDialogProvider />`; a queue serialises overlapping calls.
 *
 * [COMP:app-web/prompt-dialog]
 */

import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";

import { cn } from "@/lib/utils";
import { Button } from "./button";

export type PromptOptions = {
  title?: string;
  description?: string;
  /** Pre-filled value (e.g. the current page name for a rename). */
  defaultValue?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /**
   * Multi-line answer: a textarea in a wider popup instead of a one-line
   * input. Enter inserts a newline; Cmd/Ctrl+Enter submits. Use it when
   * the answer is a sentence (a delete reason), not a name.
   */
  multiline?: boolean;
  /**
   * Treat an empty field as a real answer (resolves `""`) instead of a
   * cancel. Only for flows where "no text" is a valid choice - Tasks
   * delete uses it for "delete without teaching a rule".
   */
  allowEmpty?: boolean;
  /**
   * Confirm label shown while the field is empty, so the button states
   * the *actual* consequence of pressing it. Needs `allowEmpty`.
   */
  emptyConfirmLabel?: string;
};

type Pending = PromptOptions & { resolve: (value: string | null) => void };

const queue: Pending[] = [];
let notify: (() => void) | null = null;

export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise<string | null>((resolve) => {
    queue.push({ ...opts, resolve });
    notify?.();
  });
}

export function PromptDialogProvider() {
  const [active, setActive] = React.useState<Pending | null>(null);
  const [value, setValue] = React.useState("");
  // One ref for whichever field renders (input or textarea) - base-ui's
  // `initialFocus` only needs an HTMLElement.
  const inputRef = React.useRef<HTMLElement | null>(null);

  const drain = React.useCallback(() => {
    setActive((current) => {
      if (current) return current;
      const next = queue.shift() ?? null;
      if (next) setValue(next.defaultValue ?? "");
      return next;
    });
  }, []);

  React.useEffect(() => {
    notify = drain;
    drain();
    return () => {
      notify = null;
    };
  }, [drain]);

  function resolveWith(answer: string | null) {
    if (!active) return;
    active.resolve(answer);
    setActive(null);
    setValue("");
    queueMicrotask(drain);
  }

  function submit() {
    const trimmed = value.trim();
    if (trimmed) {
      resolveWith(trimmed);
      return;
    }
    // Empty input is treated as a cancel — never rename to "" — unless the
    // caller opted in, in which case "" is the answer and null still means
    // cancel.
    resolveWith(active?.allowEmpty ? "" : null);
  }

  return (
    <Dialog.Root
      open={active !== null}
      onOpenChange={(open) => {
        if (!open) resolveWith(null);
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <Dialog.Popup
          initialFocus={inputRef}
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2",
            active?.multiline ? "max-w-lg" : "max-w-md",
            "rounded-2xl border border-border bg-background p-6 shadow-xl ring-1 ring-foreground/5",
            "transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          {active?.title ? (
            <Dialog.Title className="text-base font-semibold text-foreground">
              {active.title}
            </Dialog.Title>
          ) : null}
          {active?.description ? (
            <Dialog.Description
              className={cn(
                "text-sm leading-relaxed text-muted-foreground",
                active?.title ? "mt-2" : "mt-0",
              )}
            >
              {active.description}
            </Dialog.Description>
          ) : null}
          {active?.multiline ? (
            <textarea
              ref={(el) => {
                inputRef.current = el;
              }}
              value={value}
              placeholder={active?.placeholder}
              rows={3}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                // Enter is a newline here; the modifier submits.
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  submit();
                }
              }}
              className="mt-4 min-h-[88px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 text-sm leading-relaxed text-foreground outline-none placeholder:text-muted-foreground"
            />
          ) : (
            <input
              ref={(el) => {
                inputRef.current = el;
              }}
              type="text"
              value={value}
              placeholder={active?.placeholder}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  submit();
                }
              }}
              className="mt-4 h-9 w-full rounded-md border border-border bg-background px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground"
            />
          )}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => resolveWith(null)}
            >
              {active?.cancelLabel ?? "Cancel"}
            </Button>
            <Button variant="default" size="sm" onClick={submit}>
              {/* While the field is empty the button must name what it will
                  actually do (plain delete, not delete + rule). */}
              {(value.trim()
                ? active?.confirmLabel
                : (active?.emptyConfirmLabel ?? active?.confirmLabel)) ??
                "Save"}
            </Button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
