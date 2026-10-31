/** Transient stream ownership, never content or authority. [COMP:app-web/chat-stream-observation] */
import { useSyncExternalStore } from "react";

const observers = new Map<string, Map<string, Set<symbol>>>();
const snapshots = new Map<string, ReadonlySet<string>>();
const empty: ReadonlySet<string> = new Set();
const listeners = new Set<() => void>();

function update(workspaceId: string) {
  const sessions = observers.get(workspaceId);
  if (sessions?.size) snapshots.set(workspaceId, new Set(sessions.keys()));
  else {
    observers.delete(workspaceId);
    snapshots.delete(workspaceId);
  }
  for (const listener of listeners) listener();
}

/** A token belongs to one actual stream; closing it cannot release a successor. */
export function createChatStreamObserver(workspaceId: string) {
  const token = Symbol();
  let sessionId: string | null = null;
  let closed = false;
  const detach = () => {
    if (!sessionId) return;
    const sessions = observers.get(workspaceId);
    const owners = sessions?.get(sessionId);
    owners?.delete(token);
    if (sessions && owners?.size === 0) {
      sessions.delete(sessionId);
      update(workspaceId);
    }
    sessionId = null;
  };
  return {
    observe(id: string) {
      if (closed || !id || sessionId === id) return;
      detach();
      const sessions = observers.get(workspaceId) ?? new Map<string, Set<symbol>>();
      const owners = sessions.get(id) ?? new Set<symbol>();
      const first = owners.size === 0;
      owners.add(token);
      sessions.set(id, owners);
      observers.set(workspaceId, sessions);
      sessionId = id;
      if (first) update(workspaceId);
    },
    release() {
      closed = true;
      detach();
    },
  };
}

export function readObservedChatSessions(workspaceId: string): ReadonlySet<string> {
  return snapshots.get(workspaceId) ?? empty;
}
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};
export function useObservedChatSessions(workspaceId: string): ReadonlySet<string> {
  return useSyncExternalStore(subscribe, () => readObservedChatSessions(workspaceId), () => empty);
}

/** Keep the status backstop for every working chat without a live observer. */
export function needsChatActivityPoll(
  rows: readonly { id: string; status?: string }[],
  activity: Readonly<Record<string, { working: boolean }>>,
  observed: ReadonlySet<string>,
): boolean {
  return rows.some(row => !observed.has(row.id) && (activity[row.id]?.working ?? row.status === "running"))
    || Object.entries(activity).some(([id, state]) => state.working && !observed.has(id));
}
