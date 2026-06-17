"use client";

/**
 * The page's headline — a large page icon + inline-editable title at the
 * top of the document body, the way Notion puts the title *in* the page
 * rather than the chrome. Clicking the icon opens the emoji picker; the
 * title is a borderless auto-growing textarea that commits the new name on
 * blur or Enter (Shift held still inserts a newline before it auto-blurs —
 * titles are a single logical line, so Enter commits).
 *
 * The title is page *metadata* (`view.name`), not Yjs document content, so
 * it commits over REST (`onRename`) with last-write-wins — concurrent
 * title edits are rare and don't need CRDT merge. The body below it is the
 * collaborative editor. An external rename (sidebar, ⋯ menu, the AI) flows
 * back in through `name` whenever the field isn't being typed in.
 *
 * [COMP:app-web/page-title]
 */

import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { LucideIcon } from "lucide-react";
import { EmojiPicker } from "@/components/ui/emoji-picker";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/client";

export function PageTitle({
  name,
  icon,
  fallback: Fallback,
  isPlaceholder = false,
  canEdit,
  onRename,
  onSetIcon,
}: {
  name: string;
  icon: string | null;
  fallback: LucideIcon;
  /**
   * The page is still on its untouched auto-title placeholder (`name_origin
   * === 'placeholder'`). Drives a subtle "breathing" animation on the icon +
   * title that hints the page is about to name itself from its content — it
   * pauses the moment the user focuses the field (they're authoring the
   * title now) and stops for good once auto-title or a manual rename settles
   * the name.
   */
  isPlaceholder?: boolean;
  canEdit: boolean;
  onRename: (name: string) => void;
  onSetIcon: (icon: string | null) => void;
}) {
  const t = useT().docPage;
  const [draft, setDraft] = useState(name);
  const [focused, setFocused] = useState(false);
  const ref = useRef<HTMLTextAreaElement>(null);

  // Only hint while the field is idle — animating text under the user's
  // caret would be distracting, and focusing it means they're taking over
  // the title themselves.
  const hint = isPlaceholder && !focused;

  // Reflect external renames (sidebar / ⋯ menu / AI) into the field — but
  // only when the field isn't focused. Adopting `name` while the user is
  // mid-keystroke (e.g. a sidebar rename or an AI edit lands, or the
  // server echoes our own commit back) would clobber their in-flight edit.
  useEffect(() => {
    if (typeof document !== "undefined" && document.activeElement === ref.current) {
      return;
    }
    setDraft(name);
  }, [name]);

  // Auto-grow to fit wrapped lines — runs on every content change.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "0px";
    el.style.height = `${el.scrollHeight}px`;
  }, [draft]);

  // Re-fit on WIDTH changes too. The editor column re-wraps the title whenever
  // its width changes — the comments panel opens, the sidebar toggles, the
  // viewport resizes or rotates, or the responsive layout settles after
  // hydration. Without this the textarea height stays at the old line count and
  // the last wrapped line is clipped (the "title eaten up" bug). A
  // ResizeObserver that reacts only to width deltas avoids the feedback loop our
  // own height writes would otherwise create.
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    let lastWidth = el.clientWidth;
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth;
      if (Math.abs(w - lastWidth) < 0.5) return;
      lastWidth = w;
      el.style.height = "0px";
      el.style.height = `${el.scrollHeight}px`;
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  function commit() {
    const next = draft.trim();
    if (next && next !== name) onRename(next);
    else setDraft(name); // empty / unchanged → revert to current
  }

  const iconButton = (
    <button
      type="button"
      aria-label={t.emojiPicker.iconButtonAria}
      disabled={!canEdit}
      className="flex size-12 items-center justify-center rounded-lg hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40 disabled:hover:bg-transparent"
    >
      {icon ? (
        <span
          className={cn("text-[40px] leading-none", hint && "animate-draft-hint")}
        >
          {icon}
        </span>
      ) : (
        <Fallback
          className={cn(
            "size-9 text-muted-foreground/55",
            hint && "animate-draft-hint",
          )}
          aria-hidden
        />
      )}
    </button>
  );

  return (
    <div className="mb-4 flex flex-col gap-1">
      {canEdit ? (
        <EmojiPicker
          onPick={onSetIcon}
          side="bottom"
          align="start"
          trigger={iconButton}
        />
      ) : (
        iconButton
      )}
      <textarea
        ref={ref}
        rows={1}
        value={draft}
        readOnly={!canEdit}
        onChange={(e) => setDraft(e.target.value)}
        onFocus={() => setFocused(true)}
        onBlur={() => {
          setFocused(false);
          commit();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            (e.target as HTMLTextAreaElement).blur();
          }
        }}
        aria-label={t.pageTitleAria}
        placeholder={t.pageTitlePlaceholder}
        spellCheck={false}
        className={cn(
          // The title is page *content* (a heading), not a form field, so it
          // opts out of the global `:focus-visible` ring the same way the
          // collab editor body and the composite composers do — otherwise the
          // ring paints a hard rectangle around the title on every click
          // (text fields match `:focus-visible` even on mouse focus). The
          // caret is the only "you are here" cue, matching the body beneath.
          // `doc-page-title` swaps in the OS UI display face (globals.css) so
          // the headline hits a real Bold weight — the PingFang body stack caps
          // Latin at faux-bold. `font-bold` (700) is Notion's page-title weight,
          // a notch above the semibold in-body headings. See the `--font-display` note.
          "doc-page-title w-full resize-none overflow-hidden border-0 bg-transparent p-0 text-3xl font-bold leading-tight text-foreground outline-none focus-visible:shadow-none placeholder:text-muted-foreground/40 md:text-4xl",
          hint && "animate-draft-hint",
        )}
      />
    </div>
  );
}
