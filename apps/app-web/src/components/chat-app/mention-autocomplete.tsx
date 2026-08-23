"use client";

/**
 * The `@` mention autocomplete, shared by the room composer and the inline
 * message editor.
 *
 * Owns which assistant a room turn addresses AND — since
 * docs/plans/room-human-mentions.md (T-H4/T-H5/T-H9) — which teammate a room
 * message notifies. The caller merges both into one roster (assistants
 * first, so an exact name tie resolves to the assistant per D-H3) and tags
 * each entry's `mentionKind`; this module is agnostic to what a resolved
 * mention DOES, only to which name in the text it resolved to. The popup is
 * dismissible (Escape, a click anywhere outside), never re-offers a mention
 * the user already confirmed, and reports every resolved mention as a
 * `highlightRanges` entry for `@use-brian/chat-ui`'s `ChatComposer` — an
 * assistant mention rides its base chip look, a member mention adds the
 * `composer-mention-chip-member` class (defined in app-web's globals.css) so
 * "this will run a paid model turn" reads visibly different from "this will
 * just notify a teammate" (D-H2/T-H9) WITHOUT a second painting mechanism.
 *
 * Spec: docs/architecture/features/chat-app.md → "Choosing an assistant".
 * [COMP:app-web/mention-autocomplete]
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { User } from "lucide-react";
import { AssistantAvatar } from "@/components/assistant-avatar";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import {
  acceptsMentionSelection,
  completeTrailingAssistantMention,
  mentionCandidatesFor,
  mentionNavigationDelta,
  nextMentionSelectionIndex,
  resolveMentionQuery,
  resolveMentionSpans,
  type MentionQuery,
} from "./multi-assistant-response";

export type MentionAssistant = {
  id: string;
  name: string;
  iconSeed?: number | null;
  /**
   * Which kind of roster entry this is (docs/plans/room-human-mentions.md
   * T-H5/T-H9). Omitted (or `"assistant"`) for the pre-existing
   * assistants-only rosters — the room's merged roster tags a teammate
   * explicitly so the popup and the composer can show "will answer and cost
   * a turn" as visually distinct from "will just be notified".
   */
  mentionKind?: "assistant" | "member";
};

/** Must match the class defined in `apps/app-web/src/app/globals.css` —
 *  `@use-brian/chat-ui`'s `ChatComposer` appends it alongside the base
 *  `composer-mention-chip` class, never in place of it (T-H9). */
const MEMBER_CHIP_CLASS_NAME = "composer-mention-chip-member";

export type AssistantMentions = {
  /** Attach to the element wrapping BOTH the popup and the text field — a
   *  pointer landing outside it dismisses. */
  containerRef: React.RefObject<HTMLDivElement | null>;
  open: boolean;
  candidates: MentionAssistant[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  listRef: React.RefObject<HTMLDivElement | null>;
  insert: (name: string) => void;
  /** Runs before the composer's Enter-to-send; consumes navigation, Enter and
   *  Escape while the popup is open. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
  /**
   * Resolved mention ranges over the current value, for chip painting
   * (T-H9). Every resolved mention gets a range; a member mention's range
   * carries `className: "composer-mention-chip-member"` so `ChatComposer`
   * paints it distinguishably from an assistant mention (which rides the
   * base chip look alone) — same `resolveMentionSpans` output, different
   * treatment, one painting mechanism.
   */
  highlightRanges: { start: number; end: number; className?: string }[];
  /**
   * Drop the completion + dismissal anchors — after a send, or when the field
   * is torn down.
   *
   * `treatAsCompleted` seeds the completion anchor with a value the user did
   * not just type: opening the editor on text that already ENDS in a mention
   * must not greet them with a popup, because that mention is settled, not a
   * half-typed query.
   */
  reset: (treatAsCompleted?: string | null) => void;
};

export function useAssistantMentions(params: {
  /** Rooms only — a personal chat has one interlocutor. */
  enabled: boolean;
  assistants: MentionAssistant[];
  value: string;
  onChange: (next: string) => void;
}): AssistantMentions {
  const { enabled, assistants, value, onChange } = params;
  const [query, setQuery] = useState<MentionQuery | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  /** The value produced by the last accepted completion. */
  const completedRef = useRef<string | null>(null);
  /** Text before the `@` the user dismissed. */
  const dismissedRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || assistants.length === 0) {
      setQuery(null);
      return;
    }
    const next = resolveMentionQuery({
      text: value,
      completedInput: completedRef.current,
      dismissedPrefix: dismissedRef.current,
    });
    dismissedRef.current = next.dismissedPrefix;
    setQuery(next.query);
    if (next.query) setSelectedIndex(0);
  }, [value, enabled, assistants.length]);

  const candidates = useMemo(
    () => mentionCandidatesFor(query, assistants),
    [query, assistants],
  );
  const open = query !== null && candidates.length > 0;

  const dismiss = useCallback(() => {
    setQuery((current) => {
      if (current) dismissedRef.current = value.slice(0, current.at);
      return null;
    });
  }, [value]);

  const insert = useCallback(
    (name: string) => {
      const next = completeTrailingAssistantMention(value, name);
      completedRef.current = next;
      setQuery(null);
      onChange(next);
    },
    [onChange, value],
  );

  const reset = useCallback((treatAsCompleted?: string | null) => {
    completedRef.current = treatAsCompleted ?? null;
    dismissedRef.current = null;
    setQuery(null);
  }, []);

  // A pointer anywhere outside the field + popup collapses it. Capture phase
  // so it beats whatever the click is actually for; the popup's own options
  // sit inside the container and are untouched.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const root = containerRef.current;
      if (root && event.target instanceof Node && root.contains(event.target)) {
        return;
      }
      dismiss();
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [open, dismiss]);

  // Keep the active option visible while keyboard navigation cycles a roster
  // longer than the popup's scrollable viewport.
  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector('[aria-selected="true"]');
    // Optional call: keeping the active option visible is a nicety, and it
    // must never be the reason a render throws.
    active?.scrollIntoView?.({ block: "nearest" });
  }, [open, selectedIndex]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open || event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        // Consume it: the popup is the innermost thing Escape can close, and
        // the surfaces above (editor, panel, modal) must not close with it.
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (acceptsMentionSelection(event.key, event.shiftKey)) {
        const selected = candidates[selectedIndex];
        if (!selected) return;
        // preventDefault keeps Enter from sending the half-typed message and
        // Tab from leaving the field.
        event.preventDefault();
        insert(selected.name);
        return;
      }
      const navigationDelta = mentionNavigationDelta(event.key);
      if (navigationDelta !== null) {
        // preventDefault keeps ArrowUp/ArrowDown from moving the caret while
        // the popup is open.
        event.preventDefault();
        setSelectedIndex((current) =>
          nextMentionSelectionIndex(current, candidates.length, navigationDelta),
        );
      }
    },
    [candidates, dismiss, insert, open, selectedIndex],
  );

  // Every resolved mention becomes a highlight range; a member's range
  // carries the extra class ChatComposer appends alongside the base chip
  // (T-H9) — see `highlightRanges`'s doc comment on the type.
  const highlightRanges = useMemo(
    () =>
      enabled
        ? resolveMentionSpans(value, assistants).map((span) => ({
            start: span.start,
            end: span.end,
            ...(span.assistant.mentionKind === "member"
              ? { className: MEMBER_CHIP_CLASS_NAME }
              : {}),
          }))
        : [],
    [enabled, value, assistants],
  );

  return {
    containerRef,
    open,
    candidates,
    selectedIndex,
    setSelectedIndex,
    listRef,
    insert,
    handleKeyDown,
    highlightRanges,
    reset,
  };
}

/** The popup itself. Positioned by the host (`className`); rendered above the
 *  field so it never shifts it. */
export function MentionAutocompleteList(props: {
  mentions: AssistantMentions;
  className?: string;
}) {
  const t = useT().chatApp;
  const { mentions } = props;
  if (!mentions.open) return null;
  return (
    <div
      ref={mentions.listRef}
      role="listbox"
      className={cn(
        "absolute z-20 max-h-56 w-64 overflow-y-auto rounded-md border border-border bg-popover shadow-md",
        props.className,
      )}
    >
      {mentions.candidates.map((assistant, index) => {
        const isMember = assistant.mentionKind === "member";
        return (
          <button
            key={assistant.id}
            type="button"
            role="option"
            aria-selected={index === mentions.selectedIndex}
            onMouseDown={(event) => {
              // mousedown, not click — keep the text field focused.
              event.preventDefault();
              mentions.insert(assistant.name);
            }}
            onMouseEnter={() => mentions.setSelectedIndex(index)}
            aria-label={
              isMember
                ? format(t.mentionInsertMemberAria, { name: assistant.name })
                : format(t.mentionInsertAria, { name: assistant.name })
            }
            className={cn(
              "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-accent",
              index === mentions.selectedIndex && "bg-accent",
            )}
          >
            {isMember ? (
              <span
                aria-hidden
                className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
              >
                <User className="size-3" />
              </span>
            ) : (
              <AssistantAvatar
                id={assistant.id}
                name={assistant.name}
                iconSeed={assistant.iconSeed ?? undefined}
                size="xs"
              />
            )}
            <span className="min-w-0 flex-1 truncate">@{assistant.name}</span>
            {isMember && (
              <span
                aria-hidden
                className="shrink-0 text-[10px] uppercase tracking-wide text-muted-foreground"
              >
                {t.mentionMemberBadge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
