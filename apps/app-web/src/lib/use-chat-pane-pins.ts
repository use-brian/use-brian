"use client";

/**
 * Pins as durable tabs (chat-parity D7).
 *
 * Open tabs are local to this browser (`chat-pane-session.ts`); a pinned tab
 * is a `session_pins` row, so it syncs across devices and teammates in a
 * room see it. This hook keeps the two in step:
 *
 * - **Restore.** Opening a chat loads its pins and restores each page, file
 *   and URL pin as a pinned tab, first in the strip, without focusing it or
 *   expanding the pane (`syncPinnedTabs`). An unavailable pin (gone, or above
 *   the session's clearance) gets no tab; the Work tab lists it.
 * - **Sync.** `refreshKey` is the room stream's `pins_changed` signal: every
 *   open client reloads and reconciles, so a pin or unpin anywhere shows here.
 * - **Pin / unpin.** "Pin tab" writes the matching row (`panePinFor`: a page
 *   or stored file by id, a link, a browser tab as its current URL);
 *   unpinning deletes it and leaves the tab open. A reload that started
 *   before the request finished is dropped, and one runs after it.
 *
 * Spec: docs/architecture/features/chat-app.md -> "Side pane" -> "Pinned tabs".
 *
 * [COMP:app-web/chat-pane-pins]
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { addSessionPin, listSessionPins, removeSessionPin } from "@/lib/api/session-pins";
import { updateChatPane } from "@/lib/chat-pane-session";
import {
  panePinFor,
  setPaneTabPin,
  syncPinnedTabs,
  tabRef,
  type PaneTab,
} from "@/lib/chat-pane-tabs";
import { paneRefForPin } from "@/components/chat-app/chat-link-routing";

export type ChatPanePins = {
  /** Can this tab be pinned, or (pinned) unpinned, here? */
  pinnable: (tab: PaneTab) => boolean;
  /** Pin the tab, or unpin it when it is pinned. */
  toggle: (tab: PaneTab) => void;
  /** The tab whose last pin or unpin failed, if any. */
  failedKey: string | null;
};

/**
 * The open chat's pinned tabs. Null when this chat cannot pin (a fresh chat
 * before its first send, or a policy without pins): no Pin control shows.
 */
export function useChatPanePins({
  workspaceId,
  sessionId,
  enabled,
  refreshKey,
  onChanged,
}: {
  workspaceId: string;
  sessionId: string | null;
  enabled: boolean;
  /** Bumped by `pins_changed`. */
  refreshKey: number;
  /** A pin or unpin from the pane landed: the Work tab's list reloads too. */
  onChanged?: () => void;
}): ChatPanePins | null {
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);
  /** Each load and each pin request takes a number; only the latest load applies. */
  const generation = useRef(0);
  const inflight = useRef(0);
  const onChangedRef = useRef(onChanged);
  useEffect(() => {
    onChangedRef.current = onChanged;
  });

  useEffect(() => {
    setFailedKey(null);
  }, [sessionId]);

  useEffect(() => {
    if (!enabled || !sessionId) return;
    const mine = ++generation.current;
    void listSessionPins(sessionId)
      .then((rows) => {
        if (mine !== generation.current || inflight.current > 0) return;
        const pins = rows.flatMap((row) => {
          if (row.label === null && row.kind !== "url") return [];
          const ref = paneRefForPin(row);
          return ref ? [{ id: row.id, ref }] : [];
        });
        updateChatPane(workspaceId, sessionId, (state) => syncPinnedTabs(state, pins));
      })
      .catch(() => {
        // The Work tab shows the load failure; the strip keeps what it has.
      });
  }, [enabled, sessionId, workspaceId, refreshKey, reloadTick]);

  const toggle = useCallback(
    (tab: PaneTab) => {
      if (!enabled || !sessionId) return;
      const pinId = tab.pinId ?? null;
      const pin = pinId ? null : panePinFor(tabRef(tab));
      if (!pinId && !pin) return;
      const key = tab.key;
      const apply = (next: string | null) =>
        updateChatPane(workspaceId, sessionId, (state) => setPaneTabPin(state, key, next));
      inflight.current += 1;
      generation.current += 1;
      setFailedKey(null);
      // Unpinning shows at once; pinning waits for the row's id.
      if (pinId) apply(null);
      const request = pinId
        ? removeSessionPin(sessionId, pinId).then(() => null)
        : addSessionPin(sessionId, pin!).then((row) => row.id);
      void request
        .then(
          (id) => {
            if (id) apply(id);
            onChangedRef.current?.();
          },
          () => {
            if (pinId) apply(pinId);
            setFailedKey(key);
          },
        )
        .finally(() => {
          inflight.current -= 1;
          setReloadTick((n) => n + 1);
        });
    },
    [enabled, sessionId, workspaceId],
  );

  return useMemo(
    () =>
      enabled && sessionId
        ? {
            pinnable: (tab: PaneTab) => !!tab.pinId || panePinFor(tabRef(tab)) !== null,
            toggle,
            failedKey,
          }
        : null,
    [enabled, sessionId, toggle, failedKey],
  );
}
