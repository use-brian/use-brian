"use client";

/** Shared person avatar with the app's profile-photo and initials fallback. */

import { useState } from "react";
function getInitials(nameOrEmail: string): string {
  if (!nameOrEmail) return "?";
  const source = nameOrEmail.includes("@") ? nameOrEmail.split("@")[0].replace(/[._-]+/g, " ") : nameOrEmail;
  const first = source.trim()[0]; return first ? first.toUpperCase() : "?";
}
const cn = (...parts: Array<string | undefined>) => parts.filter(Boolean).join(" ");

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
