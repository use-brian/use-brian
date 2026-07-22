/**
 * Crash-durable chunk spool for latched live captures
 * (docs/architecture/media/live-capture.md → "Durability").
 *
 * A latched capture is meeting-length intent, and a sales call is
 * unrepeatable — so once a capture latches, every ~5s MediaRecorder chunk is
 * ALSO written to IndexedDB as it arrives. If the tab or app dies
 * mid-meeting, the next mount finds the orphaned session and offers
 * Save / Discard (the recovery banner). Hold-to-talk clips never spool:
 * they are seconds long and in-memory is fine.
 *
 * The session meta carries `elapsedMs`, refreshed on every append — the
 * crash also kills the recorder's clock, so recovery bills/forks off the
 * last written elapsed (at most one timeslice stale). Spool writes are
 * best-effort by contract: an IndexedDB failure must degrade to
 * in-memory-only capture, never break the recording (callers swallow).
 *
 * `SpoolStore` is an interface with two implementations: IndexedDB for the
 * browser, and an in-memory twin the node tests exercise the contract
 * against (app-web's vitest has no DOM).
 *
 * [COMP:app-web/recorder-engine]
 */

export type SpoolSessionMeta = {
  /** Session id — `crypto.randomUUID()` at latch time. */
  id: string;
  workspaceId: string;
  assistantId: string;
  /** Epoch ms of capture start — the recovery banner's "from 2:14 PM". */
  startedAt: number;
  /** Capture mime (the assembled Blob's type). */
  mime: string;
  /** Recorder clock at the last append — the recovered capture's duration. */
  elapsedMs: number;
  /** Number of chunks written (the next append index). */
  chunkCount: number;
  /**
   * Wall-clock of the last write. A LIVE capture refreshes this every
   * timeslice, which is how the recovery banner tells a crashed session
   * from one currently recording in another tab (`LIVE_SESSION_GRACE_MS`).
   */
  updatedAt: number;
};

/**
 * A session written to within this window is presumed LIVE in some tab and
 * is not offered for recovery — a second tab's "Discard" on a session that
 * is mid-meeting elsewhere would delete the chunks under the live capture.
 * Comfortably larger than the 5s timeslice; small enough that a genuinely
 * crashed session surfaces on the hook's delayed re-list.
 */
export const LIVE_SESSION_GRACE_MS = 20_000;

export interface SpoolStore {
  createSession(meta: SpoolSessionMeta): Promise<void>;
  /** Append one chunk and refresh the session's `elapsedMs`/`chunkCount`. */
  appendChunk(sessionId: string, index: number, chunk: Blob, elapsedMs: number): Promise<void>;
  listSessions(): Promise<SpoolSessionMeta[]>;
  /** Chunks in append order, for recovery assembly. */
  readChunks(sessionId: string): Promise<Blob[]>;
  /** Drop the session and its chunks (hand-off complete, or discarded). */
  deleteSession(sessionId: string): Promise<void>;
}

/** Assemble a recovered session's chunks into the capture blob. */
export function assembleSpooledBlob(meta: SpoolSessionMeta, chunks: Blob[]): Blob {
  return new Blob(chunks, { type: meta.mime });
}

/**
 * Meta for a RESCUE write: a capture that was never live-spooled (only
 * hold-to-talk voice clips skip the spool) whose hand-off failed —
 * typically an offline send. Writing the finished blob after the fact
 * makes the offline story uniform: everything that reached a stop
 * recovers through the banner. `startedAt` is back-dated so the banner's
 * "from 2:14 PM" names when the capture began, not when it failed.
 */
export function rescueSessionMeta(
  id: string,
  workspaceId: string,
  assistantId: string,
  capture: { mime: string; durationMs: number },
  now: number,
): SpoolSessionMeta {
  return {
    id,
    workspaceId,
    assistantId,
    startedAt: now - capture.durationMs,
    mime: capture.mime,
    elapsedMs: capture.durationMs,
    chunkCount: 0,
    updatedAt: now,
  };
}

/**
 * The sessions the recovery banner should offer: everything except the
 * live capture's own session AND anything written to inside the grace
 * window (live in another tab), oldest first.
 */
export function recoverableSessions(
  sessions: SpoolSessionMeta[],
  activeSessionId: string | null,
  now: number = Date.now(),
): SpoolSessionMeta[] {
  return sessions
    .filter((s) => s.id !== activeSessionId && now - s.updatedAt >= LIVE_SESSION_GRACE_MS)
    .sort((a, b) => a.startedAt - b.startedAt);
}

/** In-memory `SpoolStore` — the node-testable contract twin. */
export function memorySpoolStore(): SpoolStore {
  const sessions = new Map<string, SpoolSessionMeta>();
  const chunks = new Map<string, Blob[]>();
  return {
    async createSession(meta) {
      sessions.set(meta.id, { ...meta });
      chunks.set(meta.id, []);
    },
    async appendChunk(sessionId, index, chunk, elapsedMs) {
      const meta = sessions.get(sessionId);
      if (!meta) throw new Error("no such spool session");
      const list = chunks.get(sessionId)!;
      list[index] = chunk;
      sessions.set(sessionId, {
        ...meta,
        elapsedMs,
        chunkCount: Math.max(meta.chunkCount, index + 1),
        updatedAt: Date.now(),
      });
    },
    async listSessions() {
      return [...sessions.values()].map((s) => ({ ...s }));
    },
    async readChunks(sessionId) {
      return [...(chunks.get(sessionId) ?? [])].filter(Boolean);
    },
    async deleteSession(sessionId) {
      sessions.delete(sessionId);
      chunks.delete(sessionId);
    },
  };
}

// ── IndexedDB implementation ─────────────────────────────────────────────

const DB_NAME = "brian-recorder-spool";
const DB_VERSION = 1;
const SESSIONS = "sessions";
const CHUNKS = "chunks";

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SESSIONS)) db.createObjectStore(SESSIONS, { keyPath: "id" });
      if (!db.objectStoreNames.contains(CHUNKS)) db.createObjectStore(CHUNKS, { keyPath: ["sessionId", "index"] });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("indexedDB open failed"));
  });
}

function tx<T>(db: IDBDatabase, stores: string[], mode: IDBTransactionMode, run: (t: IDBTransaction) => IDBRequest<T> | void): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = db.transaction(stores, mode);
    let result: T | undefined;
    const req = run(t);
    if (req) {
      req.onsuccess = () => {
        result = req.result;
      };
    }
    t.oncomplete = () => resolve(result as T);
    t.onerror = () => reject(t.error ?? new Error("indexedDB tx failed"));
    t.onabort = () => reject(t.error ?? new Error("indexedDB tx aborted"));
  });
}

/**
 * The browser spool. Opens lazily on first use; every method rejects on
 * IndexedDB failure and CALLERS treat that as degrade-to-memory, never as
 * a capture error.
 */
export function openRecorderSpool(): SpoolStore {
  let dbPromise: Promise<IDBDatabase> | null = null;
  const db = () => (dbPromise ??= openDb());
  return {
    async createSession(meta) {
      await tx(await db(), [SESSIONS], "readwrite", (t) => void t.objectStore(SESSIONS).put(meta));
    },
    async appendChunk(sessionId, index, chunk, elapsedMs) {
      const d = await db();
      await tx(d, [SESSIONS, CHUNKS], "readwrite", (t) => {
        t.objectStore(CHUNKS).put({ sessionId, index, chunk });
        const store = t.objectStore(SESSIONS);
        const get = store.get(sessionId);
        get.onsuccess = () => {
          const meta = get.result as SpoolSessionMeta | undefined;
          if (meta) {
            store.put({
              ...meta,
              elapsedMs,
              chunkCount: Math.max(meta.chunkCount, index + 1),
              updatedAt: Date.now(),
            });
          }
        };
      });
    },
    async listSessions() {
      return tx(await db(), [SESSIONS], "readonly", (t) => t.objectStore(SESSIONS).getAll()) as Promise<SpoolSessionMeta[]>;
    },
    async readChunks(sessionId) {
      const rows = (await tx(
        await db(),
        [CHUNKS],
        "readonly",
        (t) => t.objectStore(CHUNKS).getAll(IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity])),
      )) as Array<{ sessionId: string; index: number; chunk: Blob }>;
      return rows.sort((a, b) => a.index - b.index).map((r) => r.chunk);
    },
    async deleteSession(sessionId) {
      await tx(await db(), [SESSIONS, CHUNKS], "readwrite", (t) => {
        t.objectStore(SESSIONS).delete(sessionId);
        t.objectStore(CHUNKS).delete(IDBKeyRange.bound([sessionId, 0], [sessionId, Infinity]));
      });
    },
  };
}
