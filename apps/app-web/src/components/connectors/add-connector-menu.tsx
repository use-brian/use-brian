"use client";

/**
 * AddConnectorMenu — the single "Add connector" entry point for the unified
 * Studio -> Connectors list (app-web).
 *
 * Ported verbatim from `apps/web/src/components/connectors/add-connector-menu.tsx`
 * (app consolidation §9 #5). No app-local imports, so it copies cleanly.
 *
 * A primary button that opens a small menu with the two ways to add a
 * connector: pick one from the directory, or point at a custom MCP server.
 *
 * See docs/architecture/integrations/mcp.md → "Personal vs workspace
 * connectors — the Studio toggle".
 *
 * [COMP:app-web/add-connector-menu]
 */

import { useEffect, useRef, useState } from "react";

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
        className="text-sm font-medium bg-primary text-primary-foreground px-4 py-2 rounded-lg hover:bg-primary/90 transition-colors"
      >
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
