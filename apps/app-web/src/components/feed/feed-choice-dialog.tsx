"use client";

/**
 * Three-way choice dialog for the feed draft flows — the `chooseAsync` slice
 * of feed-web's `useConfirm` (`apps/feed-web/src/components/confirm-dialog.tsx`),
 * ported as a feed-scoped hook because the app-root `confirmDialog()` is
 * deliberately boolean-only (docs/plans/feed-web-consolidation.md §7.4).
 *
 * Renders `Cancel | secondaryLabel | confirmLabel`; the chosen async action
 * runs inside the dialog's busy state (spinner on the pressed button,
 * pointer-dismissal disabled) and the promise resolves
 * `'primary' | 'secondary' | 'cancel'` once it settles — `'cancel'` when the
 * action throws, matching feed-web's semantics. Two-way confirms in the feed
 * surface keep using the app-root `confirmDialog()` (the feed-inbox
 * precedent); this hook exists only for the "do A, do B, or neither"
 * decisions (discard-with-posted-content, delete-published).
 *
 * Usage (feed-web's shape):
 *   const { chooseAsync, dialog } = useChoiceDialog();
 *   // render {dialog} once
 *   await chooseAsync({ title, description, confirmLabel, secondaryLabel,
 *     variant }, primaryAction, secondaryAction);
 *
 * Covered under [COMP:app-web/feed-draft-sessions].
 */

import { Dialog } from "@base-ui/react/dialog";
import { useCallback, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

export type ChoiceVariant = "default" | "destructive";

export type ChoiceOptions = {
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  variant?: ChoiceVariant;
  /** The middle button — the lighter of the two actions. */
  secondaryLabel: string;
  secondaryVariant?: ChoiceVariant;
};

type ActiveAction = "primary" | "secondary" | null;

type PendingChoice = ChoiceOptions & {
  resolveChoice: (value: "primary" | "secondary" | "cancel") => void;
};

function variantClass(variant: ChoiceVariant): string {
  return variant === "destructive"
    ? "bg-destructive text-white hover:bg-destructive/90"
    : "bg-action text-action-foreground hover:bg-action/90";
}

function BusyLabel({ label }: { label: string }) {
  return (
    <span className="inline-flex items-center gap-2">
      <span
        aria-hidden
        className="h-3.5 w-3.5 rounded-full border-2 border-current border-t-transparent animate-spin"
      />
      {label}
    </span>
  );
}

export function useChoiceDialog() {
  const t = useT().feedPage.draftSessions;
  const [pending, setPending] = useState<PendingChoice | null>(null);
  const [activeAction, setActiveAction] = useState<ActiveAction>(null);

  /**
   * Three-way choice. `primary` runs the destructive-ish "big" action,
   * `secondary` the lighter one; either resolves the returned promise to
   * its name once its async action settles. Cancel resolves `'cancel'`
   * without running anything.
   */
  const chooseAsync = useCallback(
    (
      opts: ChoiceOptions,
      primary: () => Promise<void>,
      secondary: () => Promise<void>,
    ): Promise<"primary" | "secondary" | "cancel"> => {
      return new Promise<"primary" | "secondary" | "cancel">((resolve) => {
        setPending({
          ...opts,
          resolveChoice: async (choice) => {
            if (choice === "cancel") {
              setPending(null);
              resolve("cancel");
              return;
            }
            setActiveAction(choice);
            try {
              await (choice === "primary" ? primary() : secondary());
              resolve(choice);
            } catch {
              resolve("cancel");
            } finally {
              setActiveAction(null);
              setPending(null);
            }
          },
        });
      });
    },
    [],
  );

  const busy = activeAction !== null;
  const onCancel = () => {
    if (busy) return;
    pending?.resolveChoice("cancel");
  };

  const dialog = (
    <Dialog.Root
      open={pending !== null}
      onOpenChange={(next) => {
        if (!next && !busy) onCancel();
      }}
      disablePointerDismissal={busy}
    >
      <Dialog.Portal>
        <Dialog.Backdrop
          className={cn(
            "fixed inset-0 z-50 bg-black/55 backdrop-blur-sm",
            "data-[open]:animate-fade-in",
            "data-[closed]:opacity-0 data-[closed]:transition-opacity data-[closed]:duration-150",
          )}
        />
        <Dialog.Popup
          className={cn(
            "fixed left-1/2 top-1/2 z-50 -translate-x-1/2 -translate-y-1/2",
            "w-[calc(100vw-2rem)] max-w-md outline-none",
            "rounded-2xl border border-border bg-card shadow-2xl",
            "data-[open]:animate-pop-in",
            "data-[closed]:opacity-0 data-[closed]:scale-[0.97] data-[closed]:transition-all data-[closed]:duration-150",
          )}
        >
          <div className="px-5 pt-5 pb-2">
            <Dialog.Title className="text-base font-semibold">
              {pending?.title}
            </Dialog.Title>
            {pending?.description ? (
              <Dialog.Description className="mt-2 text-sm text-muted-foreground leading-relaxed">
                {pending.description}
              </Dialog.Description>
            ) : null}
          </div>
          <div className="flex justify-end gap-2 px-5 py-4 border-t border-border mt-3">
            <button
              type="button"
              onClick={onCancel}
              disabled={busy}
              className="press inline-flex items-center justify-center h-9 px-4 rounded-xl text-sm font-medium text-foreground bg-transparent border border-border hover:bg-accent disabled:opacity-50"
            >
              {pending?.cancelLabel ?? t.cancel}
            </button>
            <button
              type="button"
              onClick={() => pending?.resolveChoice("secondary")}
              disabled={busy}
              className={cn(
                "press inline-flex items-center justify-center h-9 px-4 rounded-xl text-sm font-medium shadow-sm disabled:opacity-60",
                variantClass(pending?.secondaryVariant ?? "default"),
                activeAction === "secondary" && "cursor-wait",
              )}
            >
              {activeAction === "secondary" ? (
                <BusyLabel label={t.working} />
              ) : (
                pending?.secondaryLabel
              )}
            </button>
            <button
              type="button"
              onClick={() => pending?.resolveChoice("primary")}
              disabled={busy}
              autoFocus
              className={cn(
                "press inline-flex items-center justify-center h-9 px-4 rounded-xl text-sm font-medium shadow-sm disabled:opacity-60",
                variantClass(pending?.variant ?? "default"),
                activeAction === "primary" && "cursor-wait",
              )}
            >
              {activeAction === "primary" ? (
                <BusyLabel label={t.working} />
              ) : (
                pending?.confirmLabel
              )}
            </button>
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );

  return { chooseAsync, dialog };
}
