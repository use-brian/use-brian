"use client";

/**
 * Emoji picker for choosing a page icon — a Notion-style "pick an icon"
 * popover. The trigger, portal, and dismiss behavior come from
 * `@base-ui/react`'s Popover (matching `dropdown-menu.tsx`); the grid
 * itself is the full, searchable `emoji-mart` set.
 *
 * emoji-mart is loaded lazily (dynamic import on first open) so its ~1MB
 * data stays out of the initial sidebar bundle, and is mounted in
 * VANILLA mode (the framework-agnostic `Picker` custom element, NOT
 * `@emoji-mart/react`) — the React wrapper pins a React 18 peer and this
 * repo runs React 19, so the custom-element path is the compatible one.
 *
 * Usage:
 *   <EmojiPicker onPick={(emoji) => onSetIcon(row.id, emoji)} trigger={…} />
 *
 * `onPick(null)` is raised by the "Remove" action — it clears the icon
 * back to the type-derived glyph. Esc / outside-click close (base-ui).
 *
 * [COMP:app-web/emoji-picker]
 */

import * as React from "react";
import { Popover as PopoverPrimitive } from "@base-ui/react/popover";
import type { LucideIcon } from "lucide-react";

import { cn } from "@/lib/utils";
import { isImageIcon } from "@use-brian/shared/page-icon";
import { useT } from "@/lib/i18n/client";

export type EmojiPickerProps = {
  /** Raised with the chosen emoji, or `null` for the Remove action. */
  onPick: (emoji: string | null) => void;
  /**
   * The element that opens the picker — passed to the Popover trigger's
   * `render` prop so the caller owns styling. Must be a single focusable
   * element (a `<button>`).
   */
  trigger: React.ReactElement;
  side?: "top" | "bottom" | "left" | "right";
  align?: "start" | "center" | "end";
  /**
   * Controlled open state. Omit for uncontrolled (the trigger toggles
   * it). Used by the row `…` menu's "Change icon" item.
   */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
};

export function EmojiPicker({
  onPick,
  trigger,
  side = "bottom",
  align = "start",
  open: openProp,
  onOpenChange,
}: EmojiPickerProps) {
  const t = useT().docPage.emojiPicker;
  const [openState, setOpenState] = React.useState(false);
  const open = openProp ?? openState;
  const setOpen = React.useCallback(
    (next: boolean) => {
      setOpenState(next);
      onOpenChange?.(next);
    },
    [onOpenChange],
  );

  const pick = React.useCallback(
    (emoji: string | null) => {
      onPick(emoji);
      setOpen(false);
    },
    [onPick, setOpen],
  );

  return (
    <PopoverPrimitive.Root open={open} onOpenChange={setOpen}>
      <PopoverPrimitive.Trigger render={trigger} />
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Positioner
          side={side}
          align={align}
          sideOffset={6}
          className="isolate z-50"
        >
          <PopoverPrimitive.Popup
            data-slot="emoji-picker"
            aria-label={t.title}
            className={cn(
              "relative isolate z-50 w-auto origin-(--transform-origin) overflow-hidden rounded-lg bg-popover text-popover-foreground shadow-md ring-1 ring-foreground/10 duration-100",
              "data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2",
              "data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            )}
          >
            <div className="flex items-center justify-between border-b border-border px-2.5 py-1.5">
              <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                {t.title}
              </span>
              <button
                type="button"
                onClick={() => pick(null)}
                className="rounded px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
              >
                {t.remove}
              </button>
            </div>
            {open && <EmojiMart onSelect={(native) => pick(native)} />}
          </PopoverPrimitive.Popup>
        </PopoverPrimitive.Positioner>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}

/**
 * Lazily loads + mounts the vanilla emoji-mart Picker (a custom element)
 * into a container div. Only rendered while the popover is open, so the
 * heavy data import is deferred to first use. Mounts once; the latest
 * `onSelect` is read through a ref so picking always hits the live row.
 */
function EmojiMart({ onSelect }: { onSelect: (native: string) => void }) {
  const ref = React.useRef<HTMLDivElement>(null);
  const onSelectRef = React.useRef(onSelect);
  onSelectRef.current = onSelect;

  React.useEffect(() => {
    let cancelled = false;
    const host = ref.current;
    void (async () => {
      const [dataMod, martMod] = await Promise.all([
        import("@emoji-mart/data"),
        import("emoji-mart"),
      ]);
      if (cancelled || !host) return;
      const picker = new martMod.Picker({
        data: dataMod.default,
        theme: "light",
        previewPosition: "none",
        skinTonePosition: "none",
        navPosition: "top",
        perLine: 8,
        maxFrequentRows: 1,
        onEmojiSelect: (e: { native: string }) => onSelectRef.current(e.native),
      });
      host.appendChild(picker as unknown as Node);
    })();
    return () => {
      cancelled = true;
      host?.replaceChildren();
    };
  }, []);

  return <div ref={ref} />;
}

/**
 * The leading page-icon as a self-contained picker trigger. Renders the
 * chosen emoji when `icon` is set, otherwise the type-derived lucide
 * glyph (`fallback`). Clicking opens the `<EmojiPicker>`; picking calls
 * `onSetIcon(emoji | null)`.
 *
 * A *separate button from the row's navigation target* — rendered as a
 * sibling of the title button so the icon opens the picker while the
 * title navigates (never a button nested inside a button).
 * `stopPropagation` keeps a row-level drag/select from firing on tap.
 */
export function PageIconButton({
  icon,
  fallback: Fallback,
  onSetIcon,
  side,
  align,
  className,
  open,
  onOpenChange,
}: {
  icon: string | null;
  fallback: LucideIcon;
  onSetIcon: (icon: string | null) => void;
  side?: EmojiPickerProps["side"];
  align?: EmojiPickerProps["align"];
  /** Extra classes for the trigger button (sizing per row context). */
  className?: string;
  /** Controlled open — lets a sibling menu item open this picker. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const t = useT().docPage.emojiPicker;
  return (
    <EmojiPicker
      onPick={onSetIcon}
      side={side}
      align={align}
      open={open}
      onOpenChange={onOpenChange}
      trigger={
        <button
          type="button"
          aria-label={t.iconButtonAria}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            "flex shrink-0 items-center justify-center rounded hover:bg-sidebar-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40",
            className,
          )}
        >
          {icon && !isImageIcon(icon) ? (
            <span className="text-[15px] leading-none">{icon}</span>
          ) : (
            <Fallback className="size-4 text-sidebar-foreground/55" />
          )}
        </button>
      }
    />
  );
}
