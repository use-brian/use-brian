"use client";

/**
 * Profile photo for a person, with an initials fallback.
 *
 * Ported verbatim from `apps/web/src/components/ui/user-avatar.tsx`
 * ([COMP:app-web/user-avatar]) as part of the settings consolidation
 * (docs/architecture/features/doc.md §5a — Settings). Depends only
 * on `getInitials` from `@/lib/user` and `cn` from `@/lib/utils`, both of
 * which already exist in app-web — no new npm dependency.
 *
 * Renders the user's `avatarUrl` as a rounded `<img>` when present, and an
 * initials bubble (`getInitials(name || email)`) otherwise. The image swaps
 * to the initials bubble `onError` — hot-linked provider photos (Google
 * `picture`) can rotate or expire, so we must degrade gracefully rather than
 * show a broken image. See `docs/architecture/platform/user-profile.md`.
 *
 * Distinct from `<TeamAvatar>` (the pixel-art workspace icon keyed on
 * `icon_seed`): that identifies a workspace, this identifies a person.
 */

import { useState } from "react";
import { getInitials } from "@/lib/user";
import { cn } from "@/lib/utils";

export function UserAvatar({
  name,
  email,
  avatarUrl,
  size = 32,
  className,
}: {
  name?: string;
  email?: string;
  avatarUrl?: string | null;
  /** Diameter in px. Drives both box size and the initial's font size. */
  size?: number;
  className?: string;
}) {
  const [failed, setFailed] = useState(false);
  const initials = getInitials(name || email || "?");
  const label = name || email || undefined;

  const dimension = { width: size, height: size };

  if (avatarUrl && !failed) {
    return (
      <img
        src={avatarUrl}
        alt={label}
        width={size}
        height={size}
        style={dimension}
        onError={() => setFailed(true)}
        className={cn("rounded-full object-cover shrink-0", className)}
      />
    );
  }

  return (
    <div
      style={{ ...dimension, fontSize: Math.max(10, Math.round(size * 0.42)) }}
      aria-hidden
      className={cn(
        "rounded-full bg-primary text-primary-foreground flex items-center justify-center font-bold shrink-0",
        className,
      )}
    >
      {initials}
    </div>
  );
}
