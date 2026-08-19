"use client";

/**
 * The `/` slash-command autocomplete, shared by the chat-app composer and the
 * floating dock.
 *
 * Discovery UI over the skill system's slash commands: while the draft is a
 * single half-typed command word (`/go…`), a popup offers the invocable
 * skills. Selecting one rewrites the draft to `/<slug> ` and the user types
 * the arguments; the send itself is an ordinary message send — the server
 * seam (`parseSlashCommand` → `enforceSlugs`) does the real resolution, with
 * governance applied there, so this menu is a hint and never an authority.
 * The roster is fetched lazily on the first `/` keystroke and cached for the
 * component's lifetime.
 *
 * Spec: docs/architecture/engine/skill-system.md → "Slash commands".
 * [COMP:app-web/slash-command-autocomplete]
 */

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { listInvocableSkills, type InvocableSkill } from "@/lib/api/skills";
import {
  acceptsMentionSelection,
  mentionNavigationDelta,
  nextMentionSelectionIndex,
} from "./multi-assistant-response";

const QUERY_RE = /^\/([A-Za-z0-9-]*)$/;
const MAX_CANDIDATES = 8;

/** The half-typed command word, or null once the draft is anything else.
 *  Matches only while the WHOLE draft is `/partial` — after the first space
 *  the command is settled and the menu must be gone. */
export function slashCommandQueryOf(value: string): string | null {
  const m = QUERY_RE.exec(value);
  return m ? m[1].toLowerCase() : null;
}

/** Prefix matches on the slug first (the thing being typed), then substring
 *  matches on slug or name — both alphabetical within their tier. */
export function filterSlashCommands(
  entries: InvocableSkill[],
  query: string,
): InvocableSkill[] {
  const q = query.toLowerCase();
  const prefix: InvocableSkill[] = [];
  const loose: InvocableSkill[] = [];
  for (const entry of entries) {
    if (entry.slug.startsWith(q)) prefix.push(entry);
    else if (q.length > 0 && (entry.slug.includes(q) || entry.name.toLowerCase().includes(q)))
      loose.push(entry);
  }
  return [...prefix, ...loose].slice(0, MAX_CANDIDATES);
}

export type SlashCommands = {
  open: boolean;
  candidates: InvocableSkill[];
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  listRef: RefObject<HTMLDivElement | null>;
  insert: (slug: string) => void;
  /** Runs before the composer's Enter-to-send; consumes navigation, Enter,
   *  Tab and Escape while the popup is open. */
  handleKeyDown: (event: KeyboardEvent<HTMLTextAreaElement>) => void;
};

export function useSlashCommands(params: {
  enabled: boolean;
  workspaceId: string | null;
  value: string;
  onChange: (next: string) => void;
  /** The element wrapping BOTH the popup and the text field — a pointer
   *  landing outside it dismisses. Hosts pass the composer box's ref (the
   *  same one the mention autocomplete anchors to). */
  containerRef: RefObject<HTMLElement | null>;
}): SlashCommands {
  const { enabled, workspaceId, value, onChange, containerRef } = params;
  const [roster, setRoster] = useState<InvocableSkill[] | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  /** The query the user Escape-dismissed; reopen only once it changes. */
  const [dismissedQuery, setDismissedQuery] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const fetchStartedRef = useRef(false);

  const query = enabled ? slashCommandQueryOf(value) : null;

  // Lazy roster fetch — only ever fired by the first `/` keystroke, so chats
  // that never use commands never pay for the lookup. Cached for the
  // component's lifetime; a failed fetch resolves to [] and the menu stays
  // closed (typed commands still work — the server resolves them).
  useEffect(() => {
    if (query === null || fetchStartedRef.current) return;
    fetchStartedRef.current = true;
    let cancelled = false;
    void listInvocableSkills(workspaceId)
      .then((skills) => {
        if (!cancelled) setRoster(skills);
      })
      .catch(() => {
        if (!cancelled) setRoster([]);
      });
    return () => {
      cancelled = true;
    };
  }, [query, workspaceId]);

  // A changed query invalidates the dismissal and resets the selection.
  useEffect(() => {
    setSelectedIndex(0);
    if (query === null) setDismissedQuery(null);
  }, [query]);

  const candidates =
    query !== null && roster ? filterSlashCommands(roster, query) : [];
  const open =
    query !== null && query !== dismissedQuery && candidates.length > 0;

  const dismiss = useCallback(() => {
    setDismissedQuery(query);
  }, [query]);

  const insert = useCallback(
    (slug: string) => {
      onChange(`/${slug} `);
    },
    [onChange],
  );

  // A pointer anywhere outside the field + popup collapses it. Capture phase
  // so it beats whatever the click is actually for.
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
  }, [open, dismiss, containerRef]);

  // Keep the active option visible while keyboard navigation cycles a roster
  // longer than the popup's scrollable viewport.
  useEffect(() => {
    if (!open) return;
    const active = listRef.current?.querySelector('[aria-selected="true"]');
    active?.scrollIntoView?.({ block: "nearest" });
  }, [open, selectedIndex]);

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (!open || event.nativeEvent.isComposing) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        dismiss();
        return;
      }
      if (acceptsMentionSelection(event.key, event.shiftKey)) {
        const selected = candidates[selectedIndex];
        if (!selected) return;
        // preventDefault keeps Enter from sending the half-typed command and
        // Tab from leaving the field.
        event.preventDefault();
        insert(selected.slug);
        return;
      }
      const navigationDelta = mentionNavigationDelta(event.key);
      if (navigationDelta !== null) {
        event.preventDefault();
        setSelectedIndex((current) =>
          nextMentionSelectionIndex(current, candidates.length, navigationDelta),
        );
      }
    },
    [candidates, dismiss, insert, open, selectedIndex],
  );

  return {
    open,
    candidates,
    selectedIndex,
    setSelectedIndex,
    listRef,
    insert,
    handleKeyDown,
  };
}

/** The popup itself. Positioned by the host (`className`); rendered above the
 *  field so it never shifts it. */
export function SlashCommandMenuList(props: {
  commands: SlashCommands;
  className?: string;
}) {
  const t = useT().chatApp;
  const { commands } = props;
  if (!commands.open) return null;
  return (
    <div
      ref={commands.listRef}
      role="listbox"
      className={cn(
        "absolute z-20 max-h-64 w-80 overflow-y-auto rounded-md border border-border bg-popover shadow-md",
        props.className,
      )}
    >
      <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {t.slashMenuLabel}
      </div>
      {commands.candidates.map((skill, index) => (
        <button
          key={skill.slug}
          type="button"
          role="option"
          aria-selected={index === commands.selectedIndex}
          onMouseDown={(event) => {
            // mousedown, not click — keep the text field focused.
            event.preventDefault();
            commands.insert(skill.slug);
          }}
          onMouseEnter={() => commands.setSelectedIndex(index)}
          aria-label={format(t.slashInsertAria, { slug: skill.slug })}
          className={cn(
            "flex w-full flex-col gap-0.5 px-2.5 py-1.5 text-left hover:bg-accent",
            index === commands.selectedIndex && "bg-accent",
          )}
        >
          <span className="text-sm font-medium text-foreground">/{skill.slug}</span>
          {skill.description ? (
            <span className="line-clamp-1 text-xs text-muted-foreground">
              {skill.description}
            </span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
