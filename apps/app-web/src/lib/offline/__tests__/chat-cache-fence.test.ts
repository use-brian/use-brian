/** [COMP:app-web/chat-sessions-cache] Two independent windows share durable cache ordering. */
import { describe, expect, it } from "vitest";
import { createChatCachePersistence, type ChatCacheRowFence, type FencedList } from "../chat-cache-fence";

function windows() {
  const kv = new Map<string, unknown>();
  let queue = Promise.resolve();
  const storage = {
    read: async (keys: readonly string[]) => { await queue; return structuredClone(Object.fromEntries(keys.map(key => [key, kv.get(key) ?? null]))); },
    update: (keys: readonly string[], update: (values: Readonly<Record<string, unknown>>) => Record<string, unknown>) => {
      const operation = queue.then(() => {
        const values = structuredClone(Object.fromEntries(keys.map(key => [key, kv.get(key) ?? null])));
        for (const [key, value] of Object.entries(update(values))) {
          if (value === undefined) kv.delete(key); else kv.set(key, structuredClone(value));
          values[key] = value ?? null;
        }
        return structuredClone(values);
      });
      queue = operation.then(() => {}); return operation;
    },
  };
  return { kv, one: createChatCachePersistence(storage), two: createChatCachePersistence(storage), reload: () => createChatCachePersistence(storage) };
}
const snapshot = (title: string, updatedAt = 100) => ({ version: 1, updatedAt,
  value: { personal: [{ id: "denied", title }, { id: "other", title: "Other title" }] as Array<{ id: string; title: string }>, shared: [] } } satisfies FencedList);
const guard = "scope", history = "history:denied", list = "list";

describe("durable chat cache fences", () => {
  it("keeps denial across reload without optional list UI maintenance and preserves other titles and timestamps", async () => {
    const { one, two, reload } = windows();
    const ticket = (await one.capture(guard))!;
    await one.writeList(guard, list, ticket, snapshot("Old title"), row => one.source(ticket, row.id));
    await one.writeHistory(guard, history, "denied", ticket, { syncedAt: 99, rows: ["old reply"] });
    await two.capture(guard);
    await two.deny(guard, history, list, "denied", ticket);
    const after = await reload().readList(guard, list);
    expect(after?.updatedAt).toBe(100);
    expect(after?.value.personal).toEqual([{ id: "other", title: "Other title" }]);
    expect(await reload().readHistory(guard, history, "denied")).toBeNull();
  });
  it("rejects another window's old 200 after denial and preserves a newer healthy snapshot", async () => {
    const { one, two, reload } = windows();
    const older = (await one.capture(guard))!, denial = (await two.capture(guard))!;
    await two.deny(guard, history, list, "denied", denial);
    const fresh = (await two.capture(guard))!;
    await two.writeHistory(guard, history, "denied", fresh, { rows: ["fresh persisted reply"] });
    await two.writeList(guard, list, fresh, snapshot("Fresh title", 200), row => two.source(fresh, row.id));
    expect(await one.writeHistory(guard, history, "denied", older, { rows: ["late old reply"] })).toBe(false);
    await one.writeList(guard, list, older, snapshot("Late old title", 300), row => one.source(older, row.id));
    expect((await reload().readList(guard, list))?.value.personal[0]).toEqual({ id: "denied", title: "Fresh title" });
    expect(await reload().readHistory(guard, history, "denied")).toMatchObject({ rows: ["fresh persisted reply"] });
    // A delayed earlier denial/broadcast is not a verdict on the new read.
    expect(await one.deny(guard, history, list, "denied", older)).toBe(false);
    await one.refresh(guard);
    expect(one.matches(guard, "denied", two.source(fresh, "denied"))).toBe(true);
  });
  it("disk flushes do not re-admit a denied row; a genuinely later authoritative read can", async () => {
    const { one, two } = windows();
    const ticket = (await one.capture(guard))!;
    await two.capture(guard); await two.deny(guard, history, list, "denied", ticket);
    const after = (await one.capture(guard))!;
    await one.writeList(guard, list, after, snapshot("Painted old title"), () => undefined);
    expect((await one.readList(guard, list))?.value.personal.map(row => row.id)).toEqual(["other"]);
    await one.writeList(guard, list, after, snapshot("Authorized title", 101), row => one.source(after, row.id));
    expect((await two.readList(guard, list))?.value.personal.map(row => row.id)).toEqual(["denied", "other"]);
  });
  it("an older storage failure cannot discard a newer successful mirror", async () => {
    const values = { version: 1 as const, generation: "current", denials: { denied: "revoked" } };
    let fail!: (error: Error) => void;
    let first = true;
    const cache = createChatCachePersistence({
      read: async () => first ? (first = false, await new Promise((_, reject) => { fail = reject; })) : { [guard]: values },
      update: async () => ({ [guard]: values }),
    });
    const older = cache.refresh(guard);
    const fresh = (await cache.capture(guard))!;
    fail(new Error("Old transaction failed")); await older;
    expect(cache.matches(guard, "denied", cache.source(fresh, "denied"))).toBe(true);
    expect(cache.allowsUnfenced(guard, "denied")).toBe(false);
  });
  it("logout's committed KV clear fences old writers even when the same account logs in again in another window", async () => {
    const { kv, one, two } = windows();
    const old = (await one.capture(guard))!; kv.clear();
    const next = (await two.capture(guard))!;
    expect(next.generation).not.toBe(old.generation);
    expect(await one.writeHistory(guard, history, "denied", old, { rows: ["late"] })).toBe(false);
    await one.writeList(guard, list, old, snapshot("Late"), row => one.source(old, row.id));
    expect(await two.readList(guard, list)).toBeNull();
    const oldRow: ChatCacheRowFence = one.source(old, "denied");
    expect(two.matches(guard, "denied", oldRow)).toBe(false);
  });
});
