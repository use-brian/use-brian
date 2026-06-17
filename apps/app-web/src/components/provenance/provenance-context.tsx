"use client";

/**
 * React context for the provenance side-sheet.
 *
 * Any page in the new chrome can call `useProvenance().open(row)` to
 * surface the right-sliding sheet for a derived row. The chrome host
 * owns the sheet instance and renders it once at the top level;
 * descendants only trigger open/close.
 *
 * Use this for chat citations, Brain rows, Workflow approval banners,
 * pending-change badges — any surface that needs "where did this come
 * from?" without re-creating the sheet locally.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { getEpisode, type ProvenanceRow, type Episode } from "@/lib/api/provenance";
import { useWorkspaces } from "@/contexts/workspace-context";

type ProvenanceContextValue = {
  open: (row: ProvenanceRow) => void;
  close: () => void;
};

type ProvenanceStateValue = {
  row: ProvenanceRow | null;
  episode: Episode | null;
  close: () => void;
};

const ProvenanceContext = createContext<ProvenanceContextValue | null>(null);
const ProvenanceState = createContext<ProvenanceStateValue | null>(null);

export function ProvenanceProvider({ children }: { children: React.ReactNode }) {
  const [row, setRow] = useState<ProvenanceRow | null>(null);
  const [episode, setEpisode] = useState<Episode | null>(null);
  const { activeId } = useWorkspaces();

  const open = useCallback((next: ProvenanceRow) => {
    setRow(next);
    setEpisode(null);
  }, []);

  const close = useCallback(() => {
    setRow(null);
    setEpisode(null);
  }, []);

  // Lazy-load the source episode when a row opens.
  useEffect(() => {
    if (!row || !row.authorship.sourceEpisodeId || !activeId) return;
    let cancelled = false;
    void (async () => {
      const ep = await getEpisode(row.authorship.sourceEpisodeId!, activeId);
      if (!cancelled) setEpisode(ep);
    })();
    return () => {
      cancelled = true;
    };
  }, [row, activeId]);

  const ctx = useMemo<ProvenanceContextValue>(() => ({ open, close }), [open, close]);
  const state = useMemo<ProvenanceStateValue>(
    () => ({ row, episode, close }),
    [row, episode, close],
  );

  return (
    <ProvenanceContext.Provider value={ctx}>
      <ProvenanceState.Provider value={state}>{children}</ProvenanceState.Provider>
    </ProvenanceContext.Provider>
  );
}

/**
 * Hook for descendant components that want to open the sheet.
 * Throws if used outside ProvenanceProvider — caller bug, not a
 * runtime case to handle.
 */
export function useProvenance(): ProvenanceContextValue {
  const ctx = useContext(ProvenanceContext);
  if (!ctx) throw new Error("useProvenance must be used within ProvenanceProvider");
  return ctx;
}

/**
 * Internal hook for the chrome host — exposes the current row + episode
 * to render the sheet itself.
 */
export function useProvenanceState(): ProvenanceStateValue {
  const state = useContext(ProvenanceState);
  if (!state) throw new Error("useProvenanceState must be used within ProvenanceProvider");
  return state;
}
