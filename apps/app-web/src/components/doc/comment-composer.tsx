"use client";

// [COMP:app-web/comment-composer]
/**
 * Comment composer — the mention-aware text input shared by the two comment
 * composers (`new-comment-popover.tsx` first comment, `comment-thread-body.tsx`
 * reply). It replaces the bare `<textarea>` both used, adding `@person`
 * mentions of workspace members so a teammate comment can tag someone into
 * their doc Inbox (see `docs/architecture/features/doc-inbox.md`).
 *
 * It is a **controlled** component over a plain string `value` — the parent
 * keeps owning the draft (its optimistic-message + clear-on-send logic is
 * unchanged). The only additions are:
 *
 *   - an `@`-trigger that opens the shared `<MentionPopup>` (people only) and
 *     inserts the picked member as `@Display Name ` text, and
 *   - `mentionIds`: the workspace-member ids of the mentions still present in
 *     the text, handed back on every change so the parent can post them.
 *
 * Mentions render as plain `@name` text (not a pill) — comments are a small
 * surface and the body is stored as plain text; the authoritative recipient
 * ids ride alongside via `mentionIds`, so display fidelity doesn't matter for
 * delivery. Keyboard + popup open-state are owned here (not delegated to a
 * rich-editor keymap), so Enter-to-send stays identical to the old textarea.
 */

import * as React from "react";
import { createPortal } from "react-dom";
import { fetchMembers } from "@/lib/api/mentions";
import type { SuggestionKeyDownProps } from "@tiptap/suggestion";
import {
  MentionPopup,
  type MentionItem,
  type MentionPopupRef,
  type PersonMentionItem,
} from "@/components/doc/mentions/mention-popup";
import { useT } from "@/lib/i18n/client";
import { useAutoGrowTextarea } from "@/lib/use-auto-grow-textarea";
import {
  activeMentionQuery,
  presentMentionIds,
  type InsertedMention,
} from "@/components/doc/comment-mention-text";

export type CommentComposerProps = {
  value: string;
  /** Fires on every edit with the new text + the ids of mentions still in it. */
  onValueChange: (value: string, mentionIds: string[]) => void;
  /** Enter pressed while the mention popup is closed — send the comment. */
  onEnter: () => void;
  workspaceId: string;
  placeholder: string;
  className?: string;
  /** Forwarded to the underlying textarea (focus management by the parent). */
  textareaRef?: React.RefObject<HTMLTextAreaElement | null>;
};

export function CommentComposer({
  value,
  onValueChange,
  onEnter,
  workspaceId,
  placeholder,
  className,
  textareaRef,
}: CommentComposerProps) {
  const labels = useT().docPage.mentionPopup;
  const innerRef = React.useRef<HTMLTextAreaElement>(null);
  const ref = textareaRef ?? innerRef;
  const popupRef = React.useRef<MentionPopupRef>(null);

  // Grow the box line-by-line as the comment wraps / takes Shift+Enter newlines,
  // capped by the className's `max-h-*` (then it scrolls). Without this the
  // `rows={1}` box stays one line tall and earlier lines scroll out of view.
  useAutoGrowTextarea(ref, value);

  // Every mention ever inserted in this draft; pruned-by-presence at read time.
  const trackedRef = React.useRef<InsertedMention[]>([]);
  // Caret to restore after a controlled re-render (mention insert / clear).
  const pendingCaretRef = React.useRef<number | null>(null);

  const [people, setPeople] = React.useState<PersonMentionItem[]>([]);
  // The open mention query: `at` is the `@` offset, `anchor` the textarea rect.
  const [mention, setMention] = React.useState<{ at: number; query: string } | null>(null);

  // Reset the tracked mentions when the draft is cleared from the outside
  // (send / dismiss). Keeps stale ids from leaking into the next comment.
  React.useEffect(() => {
    if (value === "") trackedRef.current = [];
  }, [value]);

  // Restore the caret after a programmatic value change (mention insert).
  React.useLayoutEffect(() => {
    if (pendingCaretRef.current != null && ref.current) {
      const pos = pendingCaretRef.current;
      pendingCaretRef.current = null;
      ref.current.focus();
      ref.current.setSelectionRange(pos, pos);
    }
  }, [value, ref]);

  // Fetch member matches as the `@query` changes (fetchMembers is cached per
  // workspace + query, so this is cheap on repeat).
  React.useEffect(() => {
    if (!mention) return;
    let cancelled = false;
    void fetchMembers(workspaceId, mention.query).then((rows) => {
      if (!cancelled) setPeople(rows);
    });
    return () => {
      cancelled = true;
    };
  }, [mention, workspaceId]);

  function recompute(next: string) {
    onValueChange(next, presentMentionIds(next, trackedRef.current));
  }

  function handleChange(e: React.ChangeEvent<HTMLTextAreaElement>) {
    const next = e.target.value;
    const caret = e.target.selectionStart ?? next.length;
    const q = activeMentionQuery(next.slice(0, caret));
    setMention(q ? { at: q.at, query: q.query } : null);
    recompute(next);
  }

  function insertMention(item: MentionItem) {
    if (item.kind !== "person" || !mention || !ref.current) return;
    const token = `@${item.name} `;
    const before = value.slice(0, mention.at);
    // Replace from the `@` up to the current caret with the mention token.
    const caret = ref.current.selectionStart ?? value.length;
    const after = value.slice(caret);
    const next = before + token + after;
    trackedRef.current = [
      ...trackedRef.current.filter((m) => m.id !== item.id || m.name !== item.name),
      { id: item.id, name: item.name },
    ];
    pendingCaretRef.current = before.length + token.length;
    setMention(null);
    recompute(next);
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (mention) {
      if (e.key === "Escape") {
        e.preventDefault();
        setMention(null);
        return;
      }
      // Let the popup consume navigation / select keys while it's open. The
      // popup only reads `.event`; the rest of SuggestionKeyDownProps is unused
      // here (we drive the popup from a textarea, not a ProseMirror view).
      const consumed =
        popupRef.current?.onKeyDown({
          event: e.nativeEvent,
        } as SuggestionKeyDownProps) ?? false;
      if (consumed) {
        e.preventDefault();
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onEnter();
    }
  }

  const rect = mention && ref.current ? ref.current.getBoundingClientRect() : null;

  return (
    <>
      <textarea
        ref={ref}
        value={value}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        rows={1}
        placeholder={placeholder}
        className={
          className ??
          "max-h-32 min-h-[24px] flex-1 resize-none border-0 bg-transparent p-0 text-[14px] leading-relaxed outline-none focus-visible:shadow-none placeholder:text-muted-foreground/70"
        }
      />
      {rect && typeof document !== "undefined"
        ? createPortal(
            <div
              // Marks the portaled popup so a host's outside-click handler (the
              // inline page thread, the rail, the popover) doesn't treat picking
              // a mention as a click-away and collapse the thread under it.
              data-mention-popup
              style={{
                position: "fixed",
                top: rect.bottom + 4,
                left: rect.left,
                zIndex: 60,
              }}
            >
              <MentionPopup
                ref={popupRef}
                people={people}
                pages={[]}
                initialTab="people"
                onSelect={insertMention}
                labels={{
                  people: labels.tabPeople,
                  pages: labels.tabPages,
                  empty: labels.empty,
                  aria: labels.ariaLabel,
                }}
              />
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
