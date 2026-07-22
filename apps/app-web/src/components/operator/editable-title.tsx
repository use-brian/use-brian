"use client";

/**
 * Click-to-edit record title for the operator peek panels (Tasks + CRM) —
 * the entry-page `PageTitle` idea in peek-panel size. Renders as a bold
 * heading; click swaps to an input; Enter/blur commits, Escape cancels.
 * The commit contract mirrors the inline cells (async, busy dim).
 *
 * [COMP:app-web/operator-filter-bar] (shared operator chrome)
 */

import { useState } from "react";
import { cn } from "@/lib/utils";

export function EditableTitle({
  value,
  ariaLabel,
  onCommit,
}: {
  value: string;
  ariaLabel: string;
  onCommit: (next: string) => Promise<{ ok: boolean; error?: string }>;
}) {
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);

  function commit(raw: string) {
    setEditing(false);
    const next = raw.trim();
    if (next.length === 0 || next === value) return;
    setBusy(true);
    void onCommit(next).finally(() => setBusy(false));
  }

  if (editing) {
    return (
      <input
        type="text"
        autoFocus
        defaultValue={value}
        aria-label={ariaLabel}
        onBlur={(e) => commit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            commit((e.target as HTMLInputElement).value);
          }
          if (e.key === "Escape") {
            e.stopPropagation();
            setEditing(false);
          }
        }}
        className="w-full rounded-md bg-muted/50 px-1 py-0.5 text-[15px] font-semibold outline-none ring-1 ring-ring/40"
      />
    );
  }

  return (
    <button
      type="button"
      aria-label={ariaLabel}
      onClick={() => setEditing(true)}
      className={cn(
        "block w-full truncate rounded-md px-1 py-0.5 text-left text-[15px] font-semibold transition-colors hover:bg-muted/50",
        busy && "opacity-60",
      )}
      title={value}
    >
      {value}
    </button>
  );
}
