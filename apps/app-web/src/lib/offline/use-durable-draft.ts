"use client";
/** Restart-safe unsent text. [COMP:app-web/durable-draft] */
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { currentOfflineWriteAuthority } from "./application-write-authority";
const DRAFT_PREFIX = "brian:unsent:v1:";
function draftKey(workspaceId: string, composer: string, viewerId?: string): string | null {
  const owner = currentOfflineWriteAuthority(workspaceId);
  if (!owner || viewerId && owner.viewerId !== viewerId) return null;
  return DRAFT_PREFIX + [owner.apiOrigin, owner.viewerId, workspaceId, composer].map(encodeURIComponent).join(":");
}
function read(key: string | null): string {
  try { return key ? localStorage.getItem(key) ?? "" : ""; } catch { return ""; }
}
/**
 * Same-tab mounts of one key (the desktop dock and the mobile drawer, for
 * example) see each other's writes, so a stale sibling cannot overwrite the
 * draft the user is typing in the other one.
 */
type Sibling = (key: string, text: string) => void;
const siblings = new Map<string, Set<Sibling>>();
function subscribeSiblings(key: string, sibling: Sibling): () => void {
  const set = siblings.get(key) ?? new Set<Sibling>();
  set.add(sibling);
  siblings.set(key, set);
  return () => {
    set.delete(sibling);
    if (set.size === 0 && siblings.get(key) === set) siblings.delete(key);
  };
}
function notifySiblings(key: string, text: string, source: Sibling): void {
  for (const sibling of [...(siblings.get(key) ?? [])]) if (sibling !== source) sibling(key, text);
}
export function useDurableDraft(workspaceId: string, composer: string, viewerId?: string) {
  const key = draftKey(workspaceId, composer, viewerId);
  const [state, setState] = useState(() => ({ key, text: read(key), failed: false }));
  const current = useRef(state);
  if (current.current.key !== key) current.current = { key, text: read(key), failed: false };
  const displayed = state.key === key ? state : current.current;
  useEffect(() => { setState({ key, text: read(key), failed: false }); }, [key]);
  const siblingRef = useRef<Sibling | null>(null);
  if (!siblingRef.current) {
    siblingRef.current = (owner, text) => {
      if (current.current.key !== owner) return;
      current.current = { key: owner, text, failed: false };
      setState(current.current);
    };
  }
  useEffect(() => (key ? subscribeSiblings(key, siblingRef.current!) : undefined), [key]);
  const set = useCallback((value: SetStateAction<string>) => {
    // A callback retained by an old request cannot clear the new identity's draft.
    if (key !== draftKey(workspaceId, composer, viewerId)) return;
    const text = typeof value === "function" ? value(current.current.text) : value;
    let failed = false;
    try {
      if (!key) throw new Error("No draft owner");
      if (text) localStorage.setItem(key, text); else localStorage.removeItem(key);
    } catch { failed = true; }
    current.current = { key, text, failed }; setState(current.current);
    if (key) notifySiblings(key, text, siblingRef.current!);
  }, [key, workspaceId, composer, viewerId]);
  return [displayed.text, set, displayed.failed] as const;
}
