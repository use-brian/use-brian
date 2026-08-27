"use client";

/**
 * The `/` slash-command autocomplete, shared by the full-page chat composer,
 * universal workspace dock, and Feed assistant dock.
 *
 * Discovery UI over the skill system's slash commands: while the draft is a
 * single half-typed command word (`/go…`), a popup offers the invocable
 * skills. Selecting one rewrites the draft to `/<slug> ` and the user types
 * the arguments. A roster-backed prefix is then painted as a command token
 * and named in a dismissible strip, so a special invocation never collapses
 * back into indistinguishable prose. The send itself is an ordinary message
 * send — the server seam (`parseSlashCommand` → `enforceSlugs`) does the real
 * resolution, with governance applied there, so this menu is a hint and never
 * an authority. The roster is fetched lazily on the first `/` keystroke and
 * cached for the component's lifetime.
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
import { Sparkles, X } from "lucide-react";
import { useT, format } from "@/lib/i18n/client";
import { cn } from "@/lib/utils";
import { listInvocableSkills, type InvocableSkill } from "@/lib/api/skills";
import {
  acceptsMentionSelection,
  mentionNavigationDelta,
  nextMentionSelectionIndex,
} from "./multi-assistant-response";

const QUERY_RE = /^\/(?:([A-Za-z][A-Za-z0-9-]{0,63}))?$/;
const ACTIVE_COMMAND_RE = /^\/([A-Za-z][A-Za-z0-9-]{0,63})(?=\s|$)/;

/** The half-typed command word, or null once the draft is anything else.
 *  Matches only while the WHOLE draft is `/partial` — after the first space
 *  the command is settled and the menu must be gone. */
export function slashCommandQueryOf(value: string): string | null {
  const m = QUERY_RE.exec(value);
  return m ? (m[1] ?? "").toLowerCase() : null;
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
    else if (
      q.length > 0 &&
      (entry.slug.includes(q) || entry.name.toLowerCase().includes(q))
    )
      loose.push(entry);
  }
  return [...prefix, ...loose];
}

export type ActiveSlashCommand = {
  skill: InvocableSkill;
  /** End of the `/<slug>` prefix in the controlled draft. */
  end: number;
};

/** Resolve only a complete, roster-backed command prefix. A half-typed slug
 *  and an unknown `/word` remain ordinary text; server governance still makes
 *  the final invocation decision when the message is sent. */
export function activeSlashCommandOf(
  value: string,
  entries: InvocableSkill[],
): ActiveSlashCommand | null {
  const match = ACTIVE_COMMAND_RE.exec(value);
  if (!match) return null;
  const slug = match[1].toLowerCase();
  const skill = entries.find((entry) => entry.slug.toLowerCase() === slug);
  return skill ? { skill, end: match[0].length } : null;
}

export type SlashCommands = {
  open: boolean;
  loading: boolean;
  candidates: InvocableSkill[];
  activeCommand: ActiveSlashCommand | null;
  highlightRanges: Array<{ start: number; end: number; className: string }>;
  selectedIndex: number;
  setSelectedIndex: (index: number) => void;
  listRef: RefObject<HTMLDivElement | null>;
  insert: (slug: string) => void;
  clearActiveCommand: () => void;
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
  const requestedWorkspaceRef = useRef<string | null>(null);
  const mountedRef = useRef(true);

  const query = enabled ? slashCommandQueryOf(value) : null;
  const workspaceKey = workspaceId ?? "__no_workspace__";

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // A host may survive a workspace switch. Never let the previous workspace's
  // cached roster style or offer commands in the next one.
  useEffect(() => {
    setRoster(null);
    requestedWorkspaceRef.current = null;
  }, [workspaceKey]);

  // Lazy roster fetch — only ever fired by the first `/` keystroke, so chats
  // that never use commands never pay for the lookup. Do NOT cancel it when
  // `/g` becomes `/go` or the user accepts a command: the old query-dependent
  // cleanup stranded the component in a permanent loading state because the
  // "started" flag survived while the only in-flight result was discarded.
  // Cached per workspace for the component's lifetime; a failure becomes the
  // explicit no-results state (typed commands still reach the server).
  useEffect(() => {
    if (query === null || requestedWorkspaceRef.current === workspaceKey) return;
    requestedWorkspaceRef.current = workspaceKey;
    void listInvocableSkills(workspaceId)
      .then((skills) => {
        if (
          mountedRef.current &&
          requestedWorkspaceRef.current === workspaceKey
        ) {
          setRoster(skills);
        }
      })
      .catch(() => {
        if (
          mountedRef.current &&
          requestedWorkspaceRef.current === workspaceKey
        ) {
          setRoster([]);
        }
      });
  }, [query, workspaceId, workspaceKey]);

  // A changed query invalidates the dismissal and resets the selection.
  useEffect(() => {
    setSelectedIndex(0);
    if (query === null) setDismissedQuery(null);
  }, [query]);

  const candidates =
    query !== null && roster ? filterSlashCommands(roster, query) : [];
  // Open immediately, before the lazy fetch resolves, so `/` always has
  // visible feedback. A miss stays open as an explicit no-results row rather
  // than looking like the feature did nothing.
  const open = query !== null && query !== dismissedQuery;
  const loading = open && roster === null;
  const activeCommand = roster ? activeSlashCommandOf(value, roster) : null;
  const highlightRanges = activeCommand
    ? [
        {
          start: 0,
          end: activeCommand.end,
          className: "composer-command-chip",
        },
      ]
    : [];

  const dismiss = useCallback(() => {
    setDismissedQuery(query);
  }, [query]);

  const insert = useCallback(
    (slug: string) => {
      onChange(`/${slug} `);
    },
    [onChange],
  );

  const clearActiveCommand = useCallback(() => {
    if (!activeCommand) return;
    // Remove the mode selector, not the work the user already typed after it.
    onChange(value.slice(activeCommand.end).replace(/^\s+/, ""));
  }, [activeCommand, onChange, value]);

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
      if (navigationDelta !== null && candidates.length > 0) {
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
    loading,
    candidates,
    activeCommand,
    highlightRanges,
    selectedIndex,
    setSelectedIndex,
    listRef,
    insert,
    clearActiveCommand,
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
      {commands.loading ? (
        <div className="px-2.5 py-2 text-xs text-muted-foreground" role="status">
          {t.slashLoading}
        </div>
      ) : commands.candidates.length === 0 ? (
        <div className="px-2.5 py-2 text-xs text-muted-foreground" role="status">
          {t.slashEmpty}
        </div>
      ) : null}
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
            "flex w-full flex-col gap-0.5 px-2.5 py-2 text-left hover:bg-accent",
            index === commands.selectedIndex && "bg-accent",
          )}
        >
          <span className="flex min-w-0 items-baseline gap-2">
            <code className="shrink-0 rounded bg-primary/10 px-1.5 py-0.5 text-xs font-semibold text-primary">
              /{skill.slug}
            </code>
            <span className="truncate text-sm font-medium text-foreground">
              {skill.name}
            </span>
          </span>
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

/** Persistent selected-command feedback rendered inside the composer. The
 *  raw `/<slug>` remains in the controlled textarea for native editing and the
 *  server parser; this strip only makes that state explicit. */
export function SlashCommandIndicator(props: {
  commands: SlashCommands;
  className?: string;
}) {
  const t = useT().chatApp;
  const active = props.commands.activeCommand;
  if (!active) return null;
  return (
    <div
      data-testid="slash-command-indicator"
      className={cn(
        "flex items-start gap-2 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2",
        props.className,
      )}
    >
      <Sparkles className="mt-0.5 size-3.5 shrink-0 text-primary" aria-hidden />
      <div className="min-w-0 flex-1">
        <div className="flex min-w-0 items-center gap-1.5 text-xs">
          <span className="font-medium text-primary">{t.slashActiveLabel}</span>
          <code className="shrink-0 rounded bg-primary/10 px-1 py-0.5 font-semibold text-primary">
            /{active.skill.slug}
          </code>
          <span className="truncate font-medium text-foreground">
            {active.skill.name}
          </span>
        </div>
        {active.skill.description ? (
          <p className="mt-0.5 line-clamp-1 text-[11px] leading-relaxed text-muted-foreground">
            {active.skill.description}
          </p>
        ) : null}
      </div>
      <button
        type="button"
        onMouseDown={(event) => event.preventDefault()}
        onClick={props.commands.clearActiveCommand}
        aria-label={format(t.slashClearAria, { slug: active.skill.slug })}
        title={format(t.slashClearAria, { slug: active.skill.slug })}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-primary/10 hover:text-foreground"
      >
        <X className="size-3.5" aria-hidden />
      </button>
    </div>
  );
}
