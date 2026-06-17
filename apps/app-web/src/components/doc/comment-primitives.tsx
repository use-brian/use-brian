"use client";

/**
 * Comment thread **presentational atoms** — the dependency-light pieces shared
 * by every comment surface: the live editor's thread body + rail
 * (`comment-thread-body.tsx` / `comment-rail.tsx`) AND the read-only public
 * share view (`share/[token]/public-page-view.tsx`).
 *
 * These were split out of `comment-thread-body.tsx` so the public share route
 * can render an IDENTICAL comment card without pulling that module's heavy,
 * auth-bound deps (`@sidanclaw/chat-ui`, `authFetch`, the composer + its model
 * controls) into the anonymous bundle. Keeping them here is also the anti-drift
 * guarantee: the editor and the share view render the same avatar, the same
 * `ThreadGutter` connecting line, and the same relative-time, so the two
 * surfaces cannot visually diverge again.
 *
 * Deps are intentionally minimal: react + `cursor-color` + `lib/user` +
 * `assistant-avatar`. Nothing here touches the network or the session SDK.
 *
 * [COMP:app-web/comment-primitives]
 */

import * as React from "react";
import { getInitials } from "@/lib/user";
import { colorForUserId, readableTextColor } from "@/lib/collab/cursor-color";
import { AssistantAvatar } from "@/components/assistant-avatar";

export function Avatar({
  id,
  name,
  size = 28,
  avatarUrl,
}: {
  id: string;
  name: string;
  size?: number;
  /** Profile photo URL. When set, the photo renders instead of the
   *  colored-initials bubble — but an `onError` (hot-linked Google URLs can
   *  rotate/expire) falls back to those initials, so the bubble is always the
   *  safety net. See `docs/architecture/platform/user-profile.md`. */
  avatarUrl?: string | null;
}) {
  const color = colorForUserId(id);
  // Track a load failure so a broken/expired photo URL reverts to initials.
  const [failed, setFailed] = React.useState(false);
  // Reset the failure flag if the URL changes (e.g. a member updates their
  // photo) so a fresh URL gets a fresh attempt.
  React.useEffect(() => setFailed(false), [avatarUrl]);

  const initials = (
    <span
      role="img"
      aria-label={name || undefined}
      className="inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: size <= 24 ? 10 : 11,
        backgroundColor: color,
        color: readableTextColor(color),
      }}
    >
      {getInitials(name || "?")}
    </span>
  );

  if (!avatarUrl || failed) return initials;

  return (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={avatarUrl}
      alt={name || ""}
      width={size}
      height={size}
      className="inline-block shrink-0 select-none rounded-full object-cover"
      style={{ width: size, height: size }}
      onError={() => setFailed(true)}
    />
  );
}

/** A comment author — a human (colored-initials `Avatar`) or the doc
 *  assistant (its real `AssistantAvatar` creature icon from `iconSeed`). */
export type CommentAuthor = {
  id: string;
  name: string;
  isAssistant?: boolean;
  iconSeed?: number | null;
  /** Human author's profile photo (humans only; the assistant uses `iconSeed`).
   *  Absent / null → the `Avatar` colored-initials fallback. */
  avatarUrl?: string | null;
};

/** Render the right avatar for an author: the assistant gets its actual doc
 *  icon, humans get the colored-initials avatar. */
export function AuthorAvatar({ author, size = 28 }: { author: CommentAuthor; size?: number }) {
  if (author.isAssistant) {
    return (
      <AssistantAvatar
        id={author.id}
        name={author.name}
        iconSeed={author.iconSeed ?? undefined}
        size="sm"
      />
    );
  }
  return <Avatar id={author.id} name={author.name} size={size} avatarUrl={author.avatarUrl} />;
}

/** The left column of a thread row: the author's avatar with an optional
 *  vertical line dropping to the next row's avatar, so a multi-message thread
 *  reads as one continuous discussion (Notion-style). Omit `author` to draw the
 *  connector alone — the rail uses that for its "Show N replies" gap. The line
 *  is `flex-1`, so the host row must stay `items-stretch` (the flex default) and
 *  carry the inter-row spacing as the content column's bottom padding (not a
 *  margin) for the line to span the gap down to the next avatar. */
export function ThreadGutter({
  author,
  connect,
}: {
  author?: CommentAuthor;
  connect: boolean;
}) {
  return (
    <div className="flex w-7 shrink-0 flex-col items-center">
      {author ? <AuthorAvatar author={author} /> : null}
      {connect ? (
        <div className={author ? "mt-1.5 w-px flex-1 bg-foreground/15" : "w-px flex-1 bg-foreground/15"} />
      ) : null}
    </div>
  );
}

export function relativeTime(iso: string, justNow: string): string {
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return "";
  const min = Math.floor((Date.now() - then) / 60000);
  if (min < 1) return justNow;
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h`;
  const d = Math.floor(hr / 24);
  if (d < 7) return `${d}d`;
  return new Date(iso).toLocaleDateString();
}
