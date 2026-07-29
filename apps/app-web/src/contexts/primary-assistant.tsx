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
 * as optional (`SuggestedView`, `EmptyPageLanding`, the page header), because
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
  const [assistantId, setAssistantId] = useState<string | null>(null);
  const [resolved, setResolved] = useState(false);

  const refresh = useCallback(() => {
    if (!workspaceId) return;
    listWorkspaceAssistants(workspaceId)
      .then((list) => {
        // Repair-only: seed when we have no interlocutor yet, or when the one
        // we picked has left the workspace. Re-picking unconditionally would
        // yank a live conversation to a different assistant whenever the
        // roster reorders.
        setAssistantId((current) =>
          current && list.some((a) => a.id === current)
            ? current
            : (pickPrimaryAssistant(list)?.id ??
              // Data drift (no assistant flagged primary): fall back to the
              // first accessible one so the surface still has an interlocutor
              // rather than stranding the user with no chat at all.
              list[0]?.id ??
              null),
        );
        setResolved(true);
      })
      .catch(() => {
        /* no list → no dock this load; a later workspace change retries */
      });
  }, [workspaceId]);

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
    return () => window.removeEventListener(ASSISTANT_REFRESH_EVENT, onRefresh);
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
