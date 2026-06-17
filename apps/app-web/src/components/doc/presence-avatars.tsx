"use client";

/**
 * Top-bar collaborator face-pile — the live avatars of who is on the page
 * right now, mirroring Notion's header presence cluster. Data comes from
 * `usePresence` (Yjs awareness); each avatar's ring is the person's live
 * cursor colour so the pile and the in-document carets read as the same
 * people. Avatars overlap left-to-right with the leftmost painted on top
 * (descending `z-index`), so the online cluster `usePresence` sorts to the
 * left sits over the dimmed away peers; anything past `max` collapses into a
 * "+N" chip, kept at the bottom of the stack.
 *
 * Presentational — the host resolves and passes the `PresenceUser[]`.
 *
 * [COMP:app-web/presence-avatars]
 */

import { getInitials } from "@/lib/user";
import { readableTextColor } from "@/lib/collab/cursor-color";
import { useT, format } from "@/lib/i18n/client";
import type { PresenceUser } from "@/lib/collab/use-presence";

export function PresenceAvatars({
  users,
  max = 3,
}: {
  users: PresenceUser[];
  max?: number;
}) {
  const t = useT().docPage;
  if (users.length === 0) return null;

  const shown = users.slice(0, max);
  const overflow = users.length - shown.length;

  return (
    <div
      className="flex items-center -space-x-1.5"
      aria-label={t.presenceGroupAria}
    >
      {shown.map((u, i) => {
        // Dim collaborators whose tab is backgrounded. Never dim yourself —
        // you always know where you are, and self-dimming on a window blur
        // reads as a glitch.
        const dimmed = !u.active && !u.isSelf;
        const label = u.isSelf
          ? format(t.presenceSelf, { name: u.name })
          : dimmed
            ? format(t.presenceAway, { name: u.name })
            : u.name;
        return (
          <span
            key={u.id}
            role="img"
            aria-label={label}
            title={label}
            className={`inline-flex size-6 select-none items-center justify-center rounded-full text-[10px] font-semibold ring-2 ring-background transition-opacity ${
              dimmed ? "opacity-40" : ""
            }`}
            // Descending z-index → the leftmost (online, per usePresence's
            // sort) paints over the avatar to its right. z-index applies to
            // flex children even without `position`.
            style={{
              backgroundColor: u.color,
              color: readableTextColor(u.color),
              zIndex: shown.length - i,
            }}
          >
            {getInitials(u.name)}
          </span>
        );
      })}
      {overflow > 0 && (
        <span
          role="img"
          aria-label={format(t.presenceOverflow, { count: String(overflow) })}
          title={format(t.presenceOverflow, { count: String(overflow) })}
          className="inline-flex size-6 select-none items-center justify-center rounded-full bg-muted text-[10px] font-semibold text-muted-foreground ring-2 ring-background"
          // Trails the pile, so it stays beneath every avatar.
          style={{ zIndex: 0 }}
        >
          +{overflow}
        </span>
      )}
    </div>
  );
}
