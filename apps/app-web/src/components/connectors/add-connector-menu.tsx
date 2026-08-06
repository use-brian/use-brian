"use client";

/**
 * AddConnectorMenu — the single "Add connector" entry point for the unified
 * Studio -> Connectors list (app-web).
 *
 * Originally ported from `apps/web/src/components/connectors/add-connector-menu.tsx`
 * during app consolidation §9 #5.
 *
 * A compact top-bar action that opens a small menu with the two ways to add a
 * connector: pick one from the directory, or point at a custom MCP server.
 *
 * See docs/architecture/integrations/mcp.md → "Personal vs workspace
 * connectors — the Studio toggle".
 *
 * [COMP:app-web/add-connector-menu]
 */

import { useEffect, useRef, useState } from "react";
import { Plus } from "lucide-react";

export function AddConnectorMenu({
  label,
  browseLabel,
  customLabel,
  onBrowseDirectory,
  onAddCustom,
}: {
  label: string;
  browseLabel: string;
  customLabel: string;
  onBrowseDirectory: () => void;
  onAddCustom: () => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("mousedown", onPointer);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onPointer);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  function pick(fn: () => void) {
    setOpen(false);
    fn();
  }

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="inline-flex h-7 items-center gap-1 rounded-md border border-border px-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      >
        <Plus className="size-3.5" aria-hidden />
        {label}
      </button>
      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1 z-20 w-60 rounded-lg border border-border bg-popover shadow-xl p-1"
        >
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(onBrowseDirectory)}
            className="w-full text-left text-sm px-3 py-2 rounded-md hover:bg-muted transition-colors"
          >
            {browseLabel}
          </button>
          <button
            type="button"
            role="menuitem"
            onClick={() => pick(onAddCustom)}
            className="w-full text-left text-sm px-3 py-2 rounded-md hover:bg-muted transition-colors"
          >
            {customLabel}
          </button>
        </div>
      )}
    </div>
  );
}
