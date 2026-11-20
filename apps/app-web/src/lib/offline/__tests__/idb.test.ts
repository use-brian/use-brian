import { beforeEach, describe, expect, it, vi } from "vitest";
beforeEach(() => vi.resetModules());
function storage() {
  const read: { result?: unknown; onsuccess?: () => void } = {};
  const tx = { objectStore: () => ({ get: () => read, put: vi.fn() }), error: null as Error | null,
    oncomplete: () => {}, onerror: () => {}, onabort: () => {}, abort: vi.fn() };
  vi.stubGlobal("indexedDB", { open: () => {
    const req = { result: { transaction: () => tx }, onsuccess: () => {} };
    queueMicrotask(() => req.onsuccess());
    return req;
  } });
  return { read, tx };
}
describe("[COMP:app-web/offline-idb] durable authored writes", () => {
  it("resolves only after the IndexedDB transaction commits", async () => {
    const { read, tx } = storage();
    const { idbUpdate } = await import("../idb");
    let complete = false;
    const pending = idbUpdate<number>("page", () => 1).then(() => { complete = true; });
    await vi.waitFor(() => expect(read.onsuccess).toBeTypeOf("function"));
    read.onsuccess!();
    await Promise.resolve();
    expect(complete).toBe(false);
    tx.oncomplete();
    await pending;
    expect(complete).toBe(true);
  });
  it("rejects an aborted transaction instead of claiming a page was saved", async () => {
    const { read, tx } = storage();
    const { idbUpdate } = await import("../idb");
    const pending = idbUpdate("page", () => ({}));
    const rejected = expect(pending).rejects.toThrow("quota");
    await vi.waitFor(() => expect(read.onsuccess).toBeTypeOf("function"));
    read.onsuccess!(); tx.error = new Error("quota"); tx.onabort();
    await rejected;
  });
  it("commits the cache fence and bytes together, and rejects aborts", async () => {
    const { read, tx } = storage();
    const { idbUpdateEntries } = await import("../idb");
    let complete = false;
    const pending = idbUpdateEntries(["fence"], () => ({ fence: { generation: "new" } })).then(() => { complete = true; });
    await vi.waitFor(() => expect(read.onsuccess).toBeTypeOf("function"));
    read.onsuccess!(); await Promise.resolve(); expect(complete).toBe(false);
    tx.oncomplete(); await pending; expect(complete).toBe(true);
    const failed = idbUpdateEntries(["fence"], () => ({ fence: { generation: "later" } }));
    const rejected = expect(failed).rejects.toThrow("quota");
    await Promise.resolve(); read.onsuccess!(); tx.error = new Error("quota"); tx.onabort(); await rejected;
  });

});
