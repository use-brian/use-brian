"use client";

/**
 * The workspace's primary assistant, resolved ONCE per workspace and shared.
 *
 * This used to be fetched twice, in two places, for two purposes:
 *
 *  - `WorkspaceChrome` fetched `listWorkspaceAssistants` to pick the chat
 *    dock's interlocutor. Non-blocking: no dock until it lands.
 *  - `p/layout.tsx` fetched the SAME list to pick the doc surface's default
 *    assistant - and **blocked the entire doc surface on it**, rendering a
 *    centred "Loading..." line until it resolved. Opening a page from any other
 *    surface therefore cost a full round trip before a single pixel of the
 *    page appeared, on the app's most-used surface, for a value the chrome one
 *    level up was already fetching in parallel.
 *
 * Hoisting the resolution here kills both problems: one request instead of two,
 * and the doc shell renders immediately with `assistantId` undefined, filling
 * it in when the list lands. Every consumer of `assistantId` already treats it
 * as optional (`EmptyPageLanding`, the Brief work pickup, the page header), because
 * the chrome's copy was always allowed to be null.
 *
 * Mounted in `/w/[workspaceId]/layout.tsx`, above `WorkspaceChrome`, so both
 * the chrome and everything under `{children}` read the same value.
 *
 * Spec: docs/architecture/features/perceived-performance.md
 * [COMP:app-web/primary-assistant-context]
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { currentOfflineWriteAuthority } from "@/lib/offline/application-write-authority";
import { listWorkspaceAssistants } from "@/lib/api/views";
import { pickPrimaryAssistant } from "@/lib/primary-assistant";
import {
  ASSISTANT_REFRESH_EVENT,
  type AssistantRefreshDetail,
} from "@/lib/assistant-events";

type PrimaryAssistantState = {
  /** The workspace primary (or the first accessible assistant), once known. */
  assistantId: string | null;
  /** True once a list has come back - distinguishes "none" from "not yet". */
  resolved: boolean;
  /** Re-resolve (the assistant-refresh event already does this for you). */
  refresh: () => void;
};

const PrimaryAssistantContext = createContext<PrimaryAssistantState | null>(
  null,
);

export function PrimaryAssistantProvider({
  workspaceId,
  children,
}: {
  workspaceId: string;
  children: React.ReactNode;
}) {
  const owner = currentOfflineWriteAuthority(workspaceId);
  const ownerKey = owner ? `brian:offline-routing:v1:${[owner.apiOrigin, owner.viewerId, workspaceId].map(encodeURIComponent).join(":")}` : null;
  const [selection, setSelection] = useState<{ key: string | null; id: string | null; resolved: boolean }>({ key: ownerKey, id: null, resolved: false });
  const assistantId = selection.key === ownerKey ? selection.id : null;
  const resolved = selection.key === ownerKey && selection.resolved;
  const refresh = useCallback(() => {
    if (!workspaceId) return;
    const stillCurrent = () => JSON.stringify(currentOfflineWriteAuthority(workspaceId)) === JSON.stringify(owner);
    try {
      const cached = ownerKey ? localStorage.getItem(ownerKey) : null;
      if (cached) setSelection(current => current.key === ownerKey && current.id ? current : { key: ownerKey, id: cached, resolved: true });
    } catch { /* optional routing cache */ }
    listWorkspaceAssistants(workspaceId).then(list => {
      if (!stillCurrent()) return;
      setSelection(current => {
        const id = current.key === ownerKey && list.some(a => a.id === current.id) ? current.id : pickPrimaryAssistant(list)?.id ?? list[0]?.id ?? null;
        try { if (ownerKey) { if (id) localStorage.setItem(ownerKey, id); else localStorage.removeItem(ownerKey); } } catch { /* cache only */ }
        return { key: ownerKey, id, resolved: true };
      });
    }).catch(error => {
      if (!stillCurrent()) return;
      if (error?.status === 401 || error?.status === 403 || error?.status === 404) {
        try { if (ownerKey) localStorage.removeItem(ownerKey); } catch {}
        setSelection({ key: ownerKey, id: null, resolved: true });
      }
    });
  }, [workspaceId, ownerKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Live refresh. The provider never unmounts inside a workspace, so a
  // first-ever assistant created after load would otherwise leave
  // `assistantId` null (no dock at all) until an app restart.
  useEffect(() => {
    const onRefresh = (event: Event) => {
      const detail = (event as CustomEvent<AssistantRefreshDetail>).detail;
      if (detail?.workspaceId && detail.workspaceId !== workspaceId) return;
      refresh();
    };
    window.addEventListener(ASSISTANT_REFRESH_EVENT, onRefresh);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    return () => {
      window.removeEventListener(ASSISTANT_REFRESH_EVENT, onRefresh);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
    };
  }, [workspaceId, refresh]);

  const value = useMemo(
    () => ({ assistantId, resolved, refresh }),
    [assistantId, resolved, refresh],
  );

  return (
    <PrimaryAssistantContext.Provider value={value}>
      {children}
    </PrimaryAssistantContext.Provider>
  );
}

/**
 * Read the workspace primary assistant. Returns the unresolved state outside a
 * provider rather than throwing - the desktop SPA composes its own tree, and a
 * missing dock is a better failure than a blank screen.
 */
export function usePrimaryAssistant(): PrimaryAssistantState {
  return (
    useContext(PrimaryAssistantContext) ?? {
      assistantId: null,
      resolved: false,
      refresh: () => {},
    }
  );
}
