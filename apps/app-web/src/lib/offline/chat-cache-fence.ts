/** Cache versions only. Server reads remain the source of authority.
 * [COMP:app-web/chat-sessions-cache] */
import { idbReadEntries, idbUpdateEntries } from "./idb";

export type ChatCacheFence = { version: 1; generation: string; denials: Record<string, string> };
export type ChatCacheTicket = { generation: string; denials: Record<string, string> };
export type ChatCacheRowFence = { generation: string; marker: string | null };
type Rows = { id: string };
export type FencedList = { version: 1; updatedAt: number; value: { personal: Rows[]; shared: Rows[] }; cacheGeneration?: string; rowMarkers?: Record<string, string | null> };
type Storage = {
  read: typeof idbReadEntries;
  update: typeof idbUpdateEntries;
};
const valid = (value: unknown): value is ChatCacheFence => !!value && typeof value === "object"
  && (value as ChatCacheFence).version === 1 && typeof (value as ChatCacheFence).generation === "string"
  && !!(value as ChatCacheFence).denials && typeof (value as ChatCacheFence).denials === "object";
const marker = (fence: ChatCacheFence, id: string) => fence.denials[id] ?? null;
const matches = (fence: ChatCacheFence, id: string, source?: ChatCacheRowFence) => !!source
  && source.generation === fence.generation && source.marker === marker(fence, id);
const list = (value: unknown): value is FencedList => !!value && typeof value === "object"
  && !!(value as FencedList).value && Array.isArray((value as FencedList).value.personal)
  && Array.isArray((value as FencedList).value.shared);

/** Separate instances model separate windows; only KV transactions synchronize them. */
export function createChatCachePersistence(storage: Storage = { read: idbReadEntries, update: idbUpdateEntries }) {
  const known = new Map<string, ChatCacheFence>();
  let epoch = 0, clock = 0;
  const reads = new Map<string, number>();
  const begin = (key: string) => { const request = ++clock; reads.delete(key); reads.set(key, request); while (reads.size > 128) reads.delete(reads.keys().next().value!); return { epoch, request }; };
  const remember = (key: string, value: unknown, owner: { epoch: number; request: number }) => {
    if (owner.epoch !== epoch || reads.get(key) !== owner.request) return valid(value) ? value : null;
    if (valid(value)) known.set(key, value); else known.delete(key);
    // A bounded mirror is not a permission store. Missing mirrors paint no copy.
    while (known.size > 128) known.delete(known.keys().next().value!);
    return valid(value) ? value : null;
  };
  const forget = (key: string, owner: { epoch: number; request: number }) => {
    if (owner.epoch === epoch && reads.get(key) === owner.request) known.delete(key);
  };
  const source = (ticket: ChatCacheTicket, id: string): ChatCacheRowFence => ({ generation: ticket.generation, marker: ticket.denials[id] ?? null });
  return {
    clearMemory: () => { epoch++; known.clear(); reads.clear(); },
    source,
    current: (key: string) => known.get(key) ?? null,
    // A storage failure cannot erase an already observed denial or a newer mirror.
    async refresh(key: string) {
      const owner = begin(key);
      try { return remember(key, (await storage.read([key]))[key], owner); } catch { return null; }
    },
    async capture(key: string): Promise<ChatCacheTicket | null> {
      const owner = begin(key);
      try {
        const values = await storage.update([key], previous => valid(previous[key]) ? {} : {
          [key]: { version: 1, generation: crypto.randomUUID(), denials: {} } satisfies ChatCacheFence,
        });
        const fence = remember(key, values[key], owner);
        return fence ? { generation: fence.generation, denials: { ...fence.denials } } : null;
      } catch { return null; }
    },
    allowsUnfenced: (key: string, id: string) => known.get(key)?.denials[id] === undefined,
    matches(key: string, id: string, fence?: ChatCacheRowFence) {
      const current = known.get(key); return !!current && matches(current, id, fence);
    },
    filter<T extends Rows>(key: string, rows: T[], rowSource: (row: T) => ChatCacheRowFence | undefined): T[] {
      const current = known.get(key); if (!current) return [];
      return rows.filter(row => {
        const origin = rowSource(row);
        return origin ? matches(current, row.id, origin) : marker(current, row.id) === null;
      });
    },
    async deny(key: string, historyKey: string, listKey: string, id: string, ticket?: ChatCacheTicket | null): Promise<boolean> {
      const owner = begin(key);
      let changed = false;
      try {
        const values = await storage.update([key, historyKey, listKey], previous => {
          const stored = previous[key];
          if (ticket && (!valid(stored) || !matches(stored, id, source(ticket, id)))) return {};
          const old: ChatCacheFence = valid(stored) ? stored : { version: 1, generation: crypto.randomUUID(), denials: {} };
          const rotate = Object.keys(old.denials).length >= 4096 && old.denials[id] === undefined;
          const next: ChatCacheFence = { version: 1, generation: rotate ? crypto.randomUUID() : old.generation,
            denials: { ...(rotate ? {} : old.denials), [id]: crypto.randomUUID() } };
          const snapshot = previous[listKey]; changed = true;
          return { [key]: next, [historyKey]: undefined, ...(list(snapshot) ? { [listKey]: {
            ...snapshot, value: { personal: snapshot.value.personal.filter(row => row.id !== id), shared: snapshot.value.shared.filter(row => row.id !== id) },
          } } : {}) };
        });
        remember(key, values[key], owner); return changed;
      } catch {
        // Dropping the generation makes every earlier copy unreadable if a
        // denial marker could not commit (for example, exhausted storage).
        await storage.update([key], previous => valid(previous[key]) && (!ticket || matches(previous[key], id, source(ticket, id))) ? { [key]: undefined } : {}).catch(() => {});
        forget(key, owner); return true;
      }
    },
    async readHistory<T extends { cacheFence?: ChatCacheRowFence }>(key: string, historyKey: string, id: string): Promise<T | null> {
      const owner = begin(key);
      try {
        const values = await storage.read([key, historyKey]); const fence = remember(key, values[key], owner);
        const value = values[historyKey] as T | null;
        return fence && value && matches(fence, id, value.cacheFence) ? value : null;
      } catch { return null; }
    },
    async writeHistory<T extends object>(key: string, historyKey: string, id: string, ticket: ChatCacheTicket, value: T): Promise<boolean> {
      const owner = begin(key);
      let written = false;
      try {
        const values = await storage.update([key, historyKey], previous => {
          if (!valid(previous[key]) || !matches(previous[key], id, source(ticket, id))) return {};
          written = true; return { [historyKey]: { ...value, cacheFence: source(ticket, id) } };
        });
        remember(key, values[key], owner); return written;
      } catch { return false; }
    },
    async readList<T extends FencedList>(key: string, listKey: string): Promise<T | null> {
      const owner = begin(key);
      try {
        const values = await storage.read([key, listKey]), fence = remember(key, values[key], owner), snapshot = values[listKey];
        if (!fence || !list(snapshot) || snapshot.cacheGeneration !== fence.generation) return null;
        const permitted = (row: Rows) => matches(fence, row.id, { generation: snapshot.cacheGeneration!, marker: snapshot.rowMarkers?.[row.id] ?? null });
        return { ...snapshot, value: { personal: snapshot.value.personal.filter(permitted), shared: snapshot.value.shared.filter(permitted) } } as T;
      } catch { return null; }
    },
    async writeList(key: string, listKey: string, ticket: ChatCacheTicket, snapshot: FencedList, rowSource: (row: Rows) => ChatCacheRowFence | undefined): Promise<void> {
      await storage.update([key, listKey], previous => {
        const fence = previous[key], saved = previous[listKey];
        if (!valid(fence) || fence.generation !== ticket.generation || list(saved) && saved.updatedAt > snapshot.updatedAt) return {};
        // A stale window must not replace a newer healthy snapshot with its filtered result.
        if ([...snapshot.value.personal, ...snapshot.value.shared].some(row => { const origin = rowSource(row); return origin && !matches(fence, row.id, origin); })) return {};
        const markers: Record<string, string | null> = {};
        const permitted = (row: Rows) => {
          const origin = rowSource(row) ?? (list(saved) && saved.cacheGeneration === fence.generation && row.id in (saved.rowMarkers ?? {})
            ? { generation: saved.cacheGeneration, marker: saved.rowMarkers![row.id] } : source(ticket, row.id));
          // A disk flush or optimistic patch cannot re-admit a denied row.
          if (!rowSource(row) && marker(fence, row.id) !== null && !(list(saved) && saved.rowMarkers?.[row.id] === marker(fence, row.id))) return false;
          if (!matches(fence, row.id, origin)) return false;
          markers[row.id] = origin.marker; return true;
        };
        return { [listKey]: { ...snapshot, cacheGeneration: fence.generation, rowMarkers: markers,
          value: { personal: snapshot.value.personal.filter(permitted), shared: snapshot.value.shared.filter(permitted) } } };
      }).catch(() => {});
    },
  };
}
export const chatCachePersistence = createChatCachePersistence();
