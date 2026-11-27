import type { ComputerTask } from "@/lib/api/computer";
import { isBrowserToolName } from "@/lib/desktop-browser-pane";

/** Presentation only; opening a tab always requires an authorized task lookup. */
export function createChatBrowserPreview({
  lookup, open, hasNativePane,
}: {
  lookup: (sessionId: string) => Promise<ComputerTask | null>;
  open: (sessionId: string, task: ComputerTask) => void;
  hasNativePane: () => boolean;
}) {
  const opened = new Set<string>();
  const calls = new Map<string, Map<string, Promise<void>>>();
  const pending = new Map<string, Promise<void>>();
  function probe(sessionId: string): Promise<void> {
    if (opened.has(sessionId)) return Promise.resolve();
    const existing = pending.get(sessionId);
    if (existing) return existing;
    const read = lookup(sessionId).then((task) => {
      if (!task || (task.status !== "running" && task.status !== "paused")) return;
      if (task.backend === "local" && hasNativePane()) return;
      open(sessionId, task);
      opened.add(sessionId);
    }).catch(() => {}).finally(() => { pending.delete(sessionId); });
    pending.set(sessionId, read);
    return read;
  }
  function forget(sessionId: string, id: string) {
    const sessionCalls = calls.get(sessionId);
    const started = sessionCalls?.get(id);
    sessionCalls?.delete(id);
    if (!sessionCalls?.size) calls.delete(sessionId);
    return started;
  }
  return {
    started(sessionId: string, id: string, name: string) {
      if (opened.has(sessionId) || !isBrowserToolName(name)) return;
      const sessionCalls = calls.get(sessionId) ?? new Map();
      if (!sessionCalls.has(id)) sessionCalls.set(id, probe(sessionId));
      calls.set(sessionId, sessionCalls);
    },
    async settled(sessionId: string, id: string) {
      const started = forget(sessionId, id);
      if (!started) return;
      // The start probe can hit before the task exists, especially when the
      // extension is still waiting for consent. Recheck after the result,
      // even when it arrived while the first probe was in flight.
      await started;
      await probe(sessionId);
    },
    dropped: forget,
  };
}
