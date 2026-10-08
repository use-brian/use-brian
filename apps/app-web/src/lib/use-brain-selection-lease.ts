"use client";

import { useEffect, useRef } from "react";
import { confirmBrainRowAccess } from "./api/brain-inbox";
import type { BrainRow } from "./api/brain";
import { brainKindToInboxPrimitive } from "./brain-row-target";
import { SURFACE_CONTENT_LEASE_MS, SURFACE_CONTENT_RENEW_MS } from "./offline/surface-content-cache";



/**
 * Content lease for the open Brain drawer (perceived-performance.md, "Content
 * lease for protected lists"). The open row is re-confirmed every 15 seconds and
 * on return to the foreground; a denial closes it at once, and a row that has
 * not been confirmed for 30 seconds closes as well. [COMP:app-web/brain-deep-link]
 */
export function useBrainSelectionLease(
  workspaceId: string | null,
  selected: BrainRow | null,
  select: (row: BrainRow | null) => void,
): void {
  const selectRef = useRef(select);
  selectRef.current = select;
  const rowId = selected?.id ?? null;
  const primitive = selected ? brainKindToInboxPrimitive(selected.kind) : null;
  useEffect(() => {
    if (!workspaceId || !rowId || !primitive) return;
    let cancelled = false;
    let deadline = performance.now() + SURFACE_CONTENT_LEASE_MS;
    const close = () => { if (!cancelled) { cancelled = true; selectRef.current(null); } };
    const renew = async () => {
      const started = performance.now();
      try {
        const allowed = await confirmBrainRowAccess(workspaceId, primitive, rowId);
        if (cancelled) return;
        if (!allowed) { close(); return; }
        deadline = Math.max(deadline, started + SURFACE_CONTENT_LEASE_MS);
      } catch {
        // Transient failure: the deadline stands.
      }
    };
    const renewTimer = setInterval(() => void renew(), SURFACE_CONTENT_RENEW_MS);
    const expiryTimer = setInterval(() => { if (performance.now() >= deadline) close(); }, 1_000);
    const onFocus = () => void renew();
    const onVisible = () => { if (document.visibilityState === "visible") void renew(); };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      clearInterval(renewTimer);
      clearInterval(expiryTimer);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [workspaceId, rowId, primitive]);
}
