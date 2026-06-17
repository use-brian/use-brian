"use client";

/**
 * Live presence over a page's Yjs awareness — the data behind the top-bar
 * collaborator face-pile. Subscribes to the shared `HocuspocusProvider`'s
 * `awareness` and returns the deduped set of people currently on the page.
 *
 * Identity + colour come from the `user` field that `CollaborationCursor`
 * writes into awareness (`{ id, name, color }`), so an avatar's ring colour
 * always matches that person's live cursor caret. We dedupe by `id` (the
 * same person open in two tabs collapses to one avatar) and order
 * online-first — actively-viewing people (and yourself, who never dims)
 * cluster on the left, away peers sink right — with yourself last within
 * your group, so the pile reads like Notion's.
 *
 * [COMP:app-web/collab-presence]
 */

import { useEffect, useState } from "react";
import type { HocuspocusProvider } from "@hocuspocus/provider";

export type PresenceUser = {
  /** Stable per-person id (falls back to the awareness clientID). */
  id: string;
  name: string;
  /** Cursor colour assigned by `colorForUserId` — drives the avatar ring. */
  color: string;
  /** True when this entry includes the local client (this browser tab). */
  isSelf: boolean;
  /**
   * True when this person is *actively viewing* the page — their tab is
   * foregrounded (visible + focused). False dims their avatar in the
   * face-pile. A person open in several tabs is active if **any** tab is, so
   * a backgrounded second tab never dims someone who's looking at the page.
   */
  active: boolean;
};

type AwarenessUser = { id?: string; name?: string; color?: string };
/** The fields this app publishes per Yjs awareness client. */
type AwarenessState = { user?: AwarenessUser; active?: boolean };

/**
 * Pure: collapse raw awareness states into a deduped, ordered presence
 * list. Exported so the dedup/order contract is unit-testable without a
 * live socket.
 */
export function derivePresence(
  states: Map<number, AwarenessState | undefined>,
  localClientId: number,
): PresenceUser[] {
  const byId = new Map<string, PresenceUser>();
  for (const [clientId, state] of states) {
    const user = state?.user;
    // A peer mid-handshake has a state row but no `user` yet — skip it
    // rather than render a nameless ghost avatar.
    if (!user || !user.name) continue;
    const id = user.id ?? `client:${clientId}`;
    const isSelf = clientId === localClientId;
    // Absent flag = active: older clients don't publish it, so default-on
    // never falsely dims them. The publisher sets it within a tick of joining.
    const active = state?.active ?? true;
    const existing = byId.get(id);
    if (existing) {
      // Same person across tabs → one avatar; mark self if any tab is self,
      // and treat them as active if any of their tabs is foregrounded.
      if (isSelf) existing.isSelf = true;
      existing.active = existing.active || active;
      continue;
    }
    byId.set(id, {
      id,
      name: user.name,
      color: user.color ?? "var(--primary)",
      isSelf,
      active,
    });
  }
  // Online first, away peers sink right — so the live faces cluster on the
  // left and, with the face-pile's left-on-top z-order, paint over the dimmed
  // ones. "Online" folds in yourself: you never dim, so you always belong with
  // the live group. Within a group you sort last — Notion's "you on the right".
  return [...byId.values()].sort((a, b) => {
    const aOnline = a.active || a.isSelf;
    const bOnline = b.active || b.isSelf;
    if (aOnline !== bOnline) return Number(bOnline) - Number(aOnline);
    return Number(a.isSelf) - Number(b.isSelf);
  });
}

export function usePresence(
  provider: HocuspocusProvider | null,
): PresenceUser[] {
  const [users, setUsers] = useState<PresenceUser[]>([]);

  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness) {
      setUsers([]);
      return;
    }
    const recompute = () => {
      setUsers(
        derivePresence(
          awareness.getStates() as Map<number, AwarenessState>,
          awareness.clientID,
        ),
      );
    };
    recompute();
    awareness.on("change", recompute);
    return () => {
      awareness.off("change", recompute);
    };
  }, [provider]);

  return users;
}

/**
 * Publish this tab's "actively viewing" flag into the page's Yjs awareness so
 * peers can dim the face-pile avatar of anyone whose tab is backgrounded.
 *
 * Active = the tab is **visible AND focused**. Switching to another tab or app
 * (or minimising) flips it false; clicking inside the same window — e.g. the
 * chat side-panel — keeps `window.hasFocus()` true, so it stays active. We
 * write a sibling `active` field via `setLocalStateField`, which merges into
 * the local state and never disturbs the `user` field `CollaborationCursor`
 * owns. Mount once per provider (the shell does this beside `useCollabProvider`).
 */
export function usePublishPresenceActivity(
  provider: HocuspocusProvider | null,
): void {
  useEffect(() => {
    const awareness = provider?.awareness;
    if (!awareness || typeof document === "undefined") return;
    const publish = () => {
      awareness.setLocalStateField(
        "active",
        document.visibilityState === "visible" && document.hasFocus(),
      );
    };
    publish();
    document.addEventListener("visibilitychange", publish);
    window.addEventListener("focus", publish);
    window.addEventListener("blur", publish);
    return () => {
      document.removeEventListener("visibilitychange", publish);
      window.removeEventListener("focus", publish);
      window.removeEventListener("blur", publish);
    };
  }, [provider]);
}
