/**
 * Minimal promise-based IndexedDB key-value store for the offline caches
 * (sidebar list, block payloads, chat, entity types, the offline write queue —
 * originally Phase 3/5 of docs/plans/doc-desktop-bundled-offline.md, now used
 * by every client). No dependency, one object store, structured-clone values.
 *
 * Every call is best-effort: on any failure (private mode, quota, no IndexedDB)
 * reads resolve to `null` and writes no-op, so a cache miss degrades to the
 * normal network path rather than throwing.
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

/** Read a value by key, or `null` (missing / any failure). */
export async function idbGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return await new Promise<T | null>((resolve, reject) => {
      const req = db.transaction(STORE, "readonly").objectStore(STORE).get(key);
      req.onsuccess = () => resolve((req.result ?? null) as T | null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
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
  if (typeof indexedDB === "undefined") return;
  const sweep = (async () => {
    // `indexedDB.databases()` is missing on some older engines; without it the
    // per-page store names can't be enumerated, so only the KV store goes.
    const dbs = (await indexedDB.databases?.()) ?? [{ name: DB_NAME }];
    const targets = dbs
      .map((d) => d.name)
      .filter(
        (n): n is string =>
          !!n && (n.startsWith(DOC_STORE_PREFIX) || n === DB_NAME),
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
