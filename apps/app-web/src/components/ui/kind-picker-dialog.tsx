"use client";

/**
 * On-brand property-type picker — `kindPickerDialog({ ... })` returns a
 * `Promise<PropertyKind | null>` (the chosen kind, or `null` if cancelled).
 * The themed sibling of `promptDialog` / `confirmDialog`: used by the doc
 * table column menu's "Edit property type" (retype) action.
 *
 * One-tap: clicking a type resolves immediately (Notion-style). v1 offers the
 * config-free kinds (text / number / date / checkbox / url / email / phone /
 * person); option-bearing kinds (select / status / multi_select) stay
 * chat-authored. Mounted once at the app root via `<KindPickerDialogProvider />`.
 *
 * [COMP:app-web/kind-picker-dialog]
 */

import * as React from "react";
import { Dialog } from "@base-ui/react/dialog";
import {
  CheckSquare,
  Hash,
  Calendar,
  Type,
  Link as LinkIcon,
  Mail,
  Phone,
  User,
  type LucideIcon,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

export type PickableKind =
  | "text" | "number" | "date" | "checkbox" | "url" | "email" | "phone" | "person";

/** The config-free kinds offered in the picker, in display order. Option-bearing
 *  kinds (select / status / multi_select) stay chat-authored for v1. */
export const PICKABLE_KINDS: readonly { kind: PickableKind; Icon: LucideIcon }[] = [
  { kind: "text", Icon: Type },
  { kind: "number", Icon: Hash },
  { kind: "date", Icon: Calendar },
  { kind: "checkbox", Icon: CheckSquare },
  { kind: "person", Icon: User },
  { kind: "url", Icon: LinkIcon },
  { kind: "email", Icon: Mail },
  { kind: "phone", Icon: Phone },
];

export type KindPickerOptions = {
  title?: string;
  /** The current kind, highlighted in the list. */
  current?: PickableKind;
};

type Pending = KindPickerOptions & { resolve: (value: PickableKind | null) => void };

const queue: Pending[] = [];
let notify: (() => void) | null = null;

export function kindPickerDialog(opts: KindPickerOptions): Promise<PickableKind | null> {
  return new Promise<PickableKind | null>((resolve) => {
    queue.push({ ...opts, resolve });
    notify?.();
  });
}

export function KindPickerDialogProvider() {
  const t = useT().docPage.propertyTypes;
  const [active, setActive] = React.useState<Pending | null>(null);

  const drain = React.useCallback(() => {
    setActive((current) => current ?? (queue.shift() ?? null));
  }, []);

  React.useEffect(() => {
    notify = drain;
    drain();
    return () => {
      notify = null;
    };
  }, [drain]);

  function resolveWith(answer: PickableKind | null) {
    if (!active) return;
    active.resolve(answer);
    setActive(null);
    queueMicrotask(drain);
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
          className={cn(
            "fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-xs -translate-x-1/2 -translate-y-1/2",
            "rounded-2xl border border-border bg-background p-4 shadow-xl ring-1 ring-foreground/5",
            "transition-all duration-150",
            "data-[starting-style]:opacity-0 data-[starting-style]:scale-95",
            "data-[ending-style]:opacity-0 data-[ending-style]:scale-95",
          )}
        >
          <Dialog.Title className="px-1 pb-2 text-sm font-semibold text-foreground">
            {active?.title ?? t.dialogTitle}
          </Dialog.Title>
          <div className="flex flex-col">
            {PICKABLE_KINDS.map(({ kind, Icon }) => (
              <button
                key={kind}
                type="button"
                onClick={() => resolveWith(kind)}
                className={cn(
                  "flex items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-sm hover:bg-muted",
                  active?.current === kind ? "bg-muted font-medium" : "text-foreground",
                )}
              >
                <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                <span>{t[kind]}</span>
              </button>
            ))}
          </div>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
