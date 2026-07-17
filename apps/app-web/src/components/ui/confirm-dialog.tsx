"use client";

/**
 * On-brand confirmation modal — `confirmDialog({ ... })` returns a
 * `Promise<boolean>` so callers stay declarative. Mounted once at the
 * app root via `<ConfirmDialogProvider />`; the queue lets multiple
 * call sites chain without trampling each other.
 *
 * **Never use `window.confirm`** in this app — it doesn't honor dark
 * mode, doesn't honor i18n, and breaks the cross-app visual continuity
 * with apps/web. See the root CLAUDE.md anti-pattern.
 *
 * [COMP:app-web/confirm-dialog]
 */

import * as React from "react";
import { AlertDialog } from "@base-ui/react/alert-dialog";

import { cn } from "@/lib/utils";
import { Button } from "./button";

export type ConfirmOptions = {
  title?: string;
  description: string;
  confirmLabel?: string;
  cancelLabel?: string;
  variant?: "default" | "destructive";
  /**
   * Optional extra content rendered between the description and the action
   * row — an input the user sets before confirming (e.g. the recording
   * flow's blueprint picker, per the pre-flight-confirm invariant). The
   * caller owns the node's state; the dialog only hosts it.
   */
  content?: React.ReactNode;
};

type Pending = ConfirmOptions & { resolve: (value: boolean) => void };

const queue: Pending[] = [];
let notify: (() => void) | null = null;

export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    queue.push({ ...opts, resolve });
    notify?.();
  });
}

export function ConfirmDialogProvider() {
  const [active, setActive] = React.useState<Pending | null>(null);

  const drain = React.useCallback(() => {
    setActive((current) => current ?? queue.shift() ?? null);
  }, []);

  React.useEffect(() => {
    notify = drain;
    drain();
    return () => {
      notify = null;
    };
  }, [drain]);

  function resolveWith(answer: boolean) {
    if (!active) return;
    active.resolve(answer);
    setActive(null);
    queueMicrotask(drain);
  }

  return (
    <AlertDialog.Root
      open={active !== null}
      onOpenChange={(open) => {
        if (!open) resolveWith(false);
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-background/80 backdrop-blur-sm transition-opacity duration-150",
            "data-[starting-style]:opacity-0 data-[ending-style]:opacity-0",
          )}
        />
        <AlertDialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2",
            "rounded-2xl border border-border bg-background p-6 shadow-xl ring-1 ring-foreground/5",
            "transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          {active?.title ? (
            <AlertDialog.Title className="text-base font-semibold text-foreground">
              {active.title}
            </AlertDialog.Title>
          ) : null}
          <AlertDialog.Description
            className={cn(
              "text-sm leading-relaxed text-muted-foreground",
              active?.title ? "mt-2" : "mt-0",
            )}
          >
            {active?.description}
          </AlertDialog.Description>
          {active?.content ? <div className="mt-4">{active.content}</div> : null}
          <div className="mt-6 flex justify-end gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => resolveWith(false)}
            >
              {active?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={active?.variant === "destructive" ? "destructive" : "default"}
              size="sm"
              onClick={() => resolveWith(true)}
            >
              {active?.confirmLabel ?? "Confirm"}
            </Button>
          </div>
        </AlertDialog.Popup>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
