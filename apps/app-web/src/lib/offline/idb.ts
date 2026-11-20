/**
 * Minimal promise-based IndexedDB key-value store for the offline caches
 * (sidebar list, block payloads, chat, entity types, the offline write queue —
 * originally Phase 3/5 of docs/plans/doc-desktop-bundled-offline.md, now used
 * by every client). No dependency, one object store, structured-clone values.
 *
 * Cache calls are best-effort: on any failure (private mode, quota, no IndexedDB)
 * reads resolve to `null` and writes no-op, so a cache miss degrades to the
 * normal network path rather than throwing. Authored outbox writes use
 * `idbUpdate`, which rejects failures and resolves only on transaction commit.
 *
 * Also home to `clearLocalDocCaches` — the sign-out sweep that deletes this KV
 * store AND every `y-indexeddb` per-page doc store (`doc-page-*`), since page
 * content cached for offline editing must not outlive the session on a shared
 * browser.
 *
 * [COMP:app-web/offline-idb]
 */

const DB_NAME = "sidanclaw-doc-offline";
const STORE = "kv";
const VERSION = 1;

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise<IDBDatabase>((resolve, reject) => {
    if (typeof indexedDB === "undefined") {
      reject(new Error("IndexedDB unavailable"));
      return;
    }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  // Don't cache a rejected promise — let the next call retry.
  dbPromise.catch(() => {
    dbPromise = null;
  });
  return dbPromise;
}

/** Required durable state: a read failure must never look like an absent checkpoint. */
export async function idbReadRequired<T>(key: string): Promise<T | null> {
  const db = await openDb();
  return new Promise<T | null>((resolve, reject) => {
    const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
    req.onsuccess = () => resolve((req.result ?? null) as T | null);
    req.onerror = () => reject(req.error);
  });
}

/** Read an optional cache value; storage failure is a cache miss. */
export async function idbGet<T>(key: string): Promise<T | null> {
  try { return await idbReadRequired<T>(key); } catch { return null; }
}

/** Write a value by key. Best-effort (no-op on failure). */
export async function idbSet(key: string, value: unknown): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).put(value, key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* best-effort */
  }
}

/** Atomic, durable update for user-authored offline work. Unlike cache writes,
 * failures reject and success waits for the transaction to COMMIT. */
export async function idbUpdate<T>(key: string, update: (value: T | null) => T): Promise<T> {
  const db = await openDb();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const store = tx.objectStore(STORE);
    const request = store.get(key);
    let next: T;
    request.onsuccess = () => {
      try {
        next = update((request.result ?? null) as T | null);
        store.put(next, key);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    tx.oncomplete = () => resolve(next);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Local storage write failed"));
  });
}

/** Read a cache record and its fencing metadata from one consistent transaction. */
export async function idbReadEntries(keys: readonly string[]): Promise<Record<string, unknown>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly"), values: Record<string, unknown> = {};
    for (const key of keys) {
      const request = tx.objectStore(STORE).get(key);
      request.onsuccess = () => { values[key] = request.result ?? null; };
    }
    tx.oncomplete = () => resolve(values);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Local cache read failed"));
  });
}

/** Serialize cache bytes and their fence across every renderer sharing this KV. */
export async function idbUpdateEntries(keys: readonly string[], update: (values: Readonly<Record<string, unknown>>) => Record<string, unknown>): Promise<Record<string, unknown>> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite"), store = tx.objectStore(STORE), values: Record<string, unknown> = {};
    let remaining = keys.length;
    for (const key of keys) {
      const request = store.get(key);
      request.onsuccess = () => {
        values[key] = request.result ?? null;
        if (--remaining) return;
        try {
          for (const [changed, value] of Object.entries(update(values))) {
            if (!keys.includes(changed)) throw new Error("Cache transaction key mismatch");
            if (value === undefined) { store.delete(changed); values[changed] = null; }
            else { store.put(value, changed); values[changed] = value; }
          }
        } catch (error) { tx.abort(); reject(error); }
      };
    }
    tx.oncomplete = () => resolve(values);
    tx.onerror = tx.onabort = () => reject(tx.error ?? new Error("Local cache transaction failed"));
  });
}

/** Delete a key. Best-effort. */
export async function idbDelete(key: string): Promise<void> {
  try {
    const db = await openDb();
    await new Promise<void>((resolve, reject) => {
      const req = db.transaction(STORE, "readwrite").objectStore(STORE).delete(key);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    /* best-effort */
  }
}

/** Prefix of the per-page `y-indexeddb` stores (`use-collab-provider.ts`). */
const DOC_STORE_PREFIX = "doc-page-";

function deleteDb(name: string): Promise<void> {
  return new Promise<void>((resolve) => {
    const req = indexedDB.deleteDatabase(name);
    // `onblocked` fires when a live connection still holds the DB (e.g. a doc
    // page open behind the settings modal). The browser completes the delete
    // once that connection closes — which the imminent sign-out navigation
    // does — so resolving here keeps the sweep from hanging.
    req.onsuccess = req.onerror = req.onblocked = () => resolve();
  });
}

/**
 * Sign-out sweep: delete every locally cached doc page (`doc-page-*`
 * y-indexeddb stores) plus this module's KV store. Cached page content must
 * not outlive the session on a shared browser. Best-effort and bounded by
 * `timeoutMs` so a hung IndexedDB can never block the sign-out redirect;
 * unsynced offline edits are dropped by design (signing out is an explicit
 * "leave this device" act).
 */
export async function clearLocalDocCaches(timeoutMs = 1500): Promise<void> {
  if (typeof window !== "undefined") window.dispatchEvent(new Event("brian:local-data-cleared"));
  try { for (const key of Object.keys(localStorage)) if ((key.startsWith("brian:unsent:v1:") || key.startsWith("brian:offline-routing:v1:"))) localStorage.removeItem(key); } catch { /* unavailable */ }
  if (typeof indexedDB === "undefined") return;
  const sweep = (async () => {
    // Clear the shared KV transactionally first. Another window may keep its
    // connection open and block deleteDatabase; old tickets must still die.
    const kv = await openDb();
    await new Promise<void>((resolve, reject) => {
      const tx = kv.transaction(STORE, "readwrite"); tx.objectStore(STORE).clear();
      tx.oncomplete = () => resolve(); tx.onabort = tx.onerror = () => reject(tx.error);
    });
    if (typeof window !== "undefined") window.dispatchEvent(new CustomEvent("brian:local-data-cleared", { detail: { committed: true } }));
    // `indexedDB.databases()` is missing on some older engines; without it the
    // per-page store names can't be enumerated, so only the KV store goes.
    const dbs = (await indexedDB.databases?.()) ?? [{ name: DB_NAME }];
    const targets = dbs
      .map((d) => d.name)
      .filter(
        (n): n is string =>
          !!n && (n.startsWith(DOC_STORE_PREFIX) || n === DB_NAME || n === "brian-recorder-spool"),
      );
    // Close our own cached KV connection so its delete isn't blocked by us.
    if (dbPromise) {
      try {
        (await dbPromise).close();
      } catch {
        /* already failed to open */
      }
      dbPromise = null;
    }
    await Promise.all(targets.map(deleteDb));
  })().catch(() => {
    /* best-effort */
  });
  await Promise.race([
    sweep,
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
