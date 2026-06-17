/**
 * Minimal promise-based IndexedDB key-value store for the bundled-desktop offline
 * caches (sidebar list, block payloads, chat, entity types — Phase 3/5 of
 * docs/plans/doc-desktop-bundled-offline.md). No dependency, one object store,
 * structured-clone values.
 *
 * Every call is best-effort: on any failure (private mode, quota, no IndexedDB)
 * reads resolve to `null` and writes no-op, so a cache miss degrades to the
 * normal network path rather than throwing. Callers gate usage on
 * `isDesktopAuth()` so the web app never touches this.
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
