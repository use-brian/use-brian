"use client";

/**
 * The `@` assistant autocomplete, shared by the room composer and the inline
 * message editor.
 *
 * Owns exactly one thing: which assistant this text addresses. The popup is
 * dismissible (Escape, a click anywhere outside), never re-offers a mention
 * the user already confirmed, and reports the resolved mention ranges so the
 * text field can paint them as chips instead of plain prose.
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
};

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
  /** Resolved mention ranges over the current value, for chip painting. */
  highlightRanges: { start: number; end: number }[];
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

  const highlightRanges = useMemo(
    () =>
      enabled
        ? resolveMentionSpans(value, assistants).map((span) => ({
            start: span.start,
            end: span.end,
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
      {mentions.candidates.map((assistant, index) => (
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
          aria-label={format(t.mentionInsertAria, { name: assistant.name })}
          className={cn(
            "flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-sm text-foreground hover:bg-accent",
            index === mentions.selectedIndex && "bg-accent",
          )}
        >
          <AssistantAvatar
            id={assistant.id}
            name={assistant.name}
            iconSeed={assistant.iconSeed ?? undefined}
            size="xs"
          />
          <span className="min-w-0 flex-1 truncate">@{assistant.name}</span>
        </button>
      ))}
    </div>
  );
}
