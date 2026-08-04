/** Device-encrypted Office packages and durable offline command journal.
 * [COMP:app-web/office-offline] */
import type { OfficeCommand } from "@use-brian/office-model";
import type { OfficeArtifact, OfficeCommentThread, OfficeLiveSnapshot } from "../api";

export type OfficeOfflineStatus = "saved_device" | "offline" | "syncing" | "synced" | "needs_attention" | "sync_failed";
export type EncryptedOfficePackage = { artifactId: string; version: number; manifestHash: string; iv: string; ciphertext: string; pinned: boolean; savedAt: string };
export type OfficeOfflinePayload = {
  artifact: OfficeArtifact;
  snapshot: OfficeLiveSnapshot["snapshot"];
  seq: number;
  baseVersion: number;
  yjsUpdate: string;
  comments: OfficeCommentThread[];
  history: Array<{ id: string; version: number; summary: string; origin: string; createdAt: string }>;
  renderedFallback: string;
  resources: Array<{ id: string; mime: string; hash: string; bytes: string }>;
};
export type OfficeOfflinePackage = { manifest: Record<string, unknown>; signature: string; payload: OfficeOfflinePayload };
export type LoadedOfficeOfflinePackage = OfficeOfflinePackage & { savedAt: string };
export type OfflineJournalEntry =
  | { artifactId: string; seq: number; kind: "command"; expectedSeq: number; command: OfficeCommand; createdAt: string }
  | { artifactId: string; seq: number; kind: "comment"; anchor: { kind: string; targetIds: string[] }; body: string; invokeBrian?: { assistantId: string; expectedVersion: number; idempotencyKey: string }; createdAt: string };

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const b64 = (bytes: Uint8Array) => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};
const unb64 = (value: string) => Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
const hex = (bytes: Uint8Array) => [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(",")}}`;
  return JSON.stringify(value);
}

async function sha256(value: Uint8Array | string): Promise<string> {
  const bytes = typeof value === "string" ? encoder.encode(value) : value;
  return hex(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes.slice().buffer as ArrayBuffer)));
}

export async function officeManifestHash(manifest: unknown): Promise<string> {
  return sha256(canonical(manifest));
}

/** Rechecks every advertised completeness hash before a package is allowed to
 * become a readable local copy. The server signature authenticates the
 * manifest in transit; AES-GCM authenticates the verified package at rest. */
export async function validateOfficeOfflinePackage(value: OfficeOfflinePackage): Promise<void> {
  const manifest = value.manifest as { artifactId?: unknown; version?: unknown; snapshotHash?: unknown; updateHash?: unknown; fallbackHash?: unknown; resourceHashes?: unknown };
  if (manifest.artifactId !== value.payload.artifact.artifactId || manifest.version !== value.payload.artifact.version) throw new Error("office_offline_manifest_identity_mismatch");
  if (manifest.snapshotHash !== await sha256(canonical(value.payload.snapshot))) throw new Error("office_offline_snapshot_hash_mismatch");
  if (manifest.updateHash !== await sha256(unb64(value.payload.yjsUpdate))) throw new Error("office_offline_update_hash_mismatch");
  if (manifest.fallbackHash !== await sha256(value.payload.renderedFallback)) throw new Error("office_offline_fallback_hash_mismatch");
  const expectedResources = new Map((Array.isArray(manifest.resourceHashes) ? manifest.resourceHashes : []).map((item) => {
    const row = item as { id?: unknown; hash?: unknown };
    return [String(row.id), String(row.hash)];
  }));
  if (expectedResources.size !== value.payload.resources.length) throw new Error("office_offline_resource_manifest_mismatch");
  for (const resource of value.payload.resources) {
    if (expectedResources.get(resource.id) !== resource.hash || resource.hash !== await sha256(unb64(resource.bytes))) throw new Error(`office_offline_resource_hash_mismatch:${resource.id}`);
  }
}

export async function deriveOfficeDeviceKey(deviceSecret: Uint8Array | CryptoKey, artifactId: string): Promise<CryptoKey> {
  const source = deviceSecret instanceof Uint8Array ? await crypto.subtle.importKey("raw", deviceSecret.slice().buffer as ArrayBuffer, "HKDF", false, ["deriveKey"]) : deviceSecret;
  return crypto.subtle.deriveKey({ name: "HKDF", hash: "SHA-256", salt: encoder.encode(artifactId), info: encoder.encode("use-brian-office-offline-v1") }, source, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}

export async function encryptOfficePackage(params: { artifactId: string; version: number; manifest: unknown; payload: unknown; signature: string; pinned: boolean; deviceSecret: Uint8Array | CryptoKey }): Promise<EncryptedOfficePackage> {
  await validateOfficeOfflinePackage({ manifest: params.manifest as Record<string, unknown>, signature: params.signature, payload: params.payload as OfficeOfflinePayload });
  const manifestHash = await officeManifestHash(params.manifest);
  const key = await deriveOfficeDeviceKey(params.deviceSecret, params.artifactId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plaintext = encoder.encode(JSON.stringify({ manifest: params.manifest, signature: params.signature, payload: params.payload }));
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: encoder.encode(manifestHash) }, key, plaintext);
  return { artifactId: params.artifactId, version: params.version, manifestHash, iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)), pinned: params.pinned, savedAt: new Date().toISOString() };
}

export async function decryptOfficePackage<T>(record: EncryptedOfficePackage, deviceSecret: Uint8Array | CryptoKey): Promise<T> {
  const key = await deriveOfficeDeviceKey(deviceSecret, record.artifactId);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(record.iv), additionalData: encoder.encode(record.manifestHash) }, key, unb64(record.ciphertext));
  return JSON.parse(decoder.decode(plaintext)) as T;
}

const DB_NAME = "use-brian-office-offline-v1";
const PACKAGE_STORE = "packages";
const JOURNAL_STORE = "journal";
const KEY_STORE = "keys";

type EncryptedJournalEntry = { artifactId: string; seq: number; iv: string; ciphertext: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 2);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PACKAGE_STORE)) db.createObjectStore(PACKAGE_STORE, { keyPath: "artifactId" });
      if (!db.objectStoreNames.contains(JOURNAL_STORE)) db.createObjectStore(JOURNAL_STORE, { keyPath: ["artifactId", "seq"] });
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("office_offline_db_open_failed"));
  });
}

/** Non-extractable HKDF root, structured-cloned by IndexedDB and never placed
 * in localStorage/cookies. A device/OS credential vault can replace this seam
 * in the bundled client without changing package ciphertext. */
export async function getOrCreateOfficeDeviceKey(): Promise<CryptoKey> {
  const db = await openDb();
  const read = db.transaction(KEY_STORE, "readonly").objectStore(KEY_STORE).get("root");
  const existing = await new Promise<CryptoKey | undefined>((resolve, reject) => {
    read.onsuccess = () => resolve(read.result as CryptoKey | undefined);
    read.onerror = () => reject(read.error ?? new Error("office_offline_key_read_failed"));
  });
  if (existing) { db.close(); return existing; }
  const root = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "HKDF", false, ["deriveKey"]);
  const transaction = db.transaction(KEY_STORE, "readwrite");
  transaction.objectStore(KEY_STORE).put(root, "root");
  await transactionDone(transaction);
  db.close();
  return root;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("office_offline_write_failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("office_offline_write_aborted"));
  });
}

/** Resolves only after IndexedDB commits, so the UI may safely say Saved. */
export async function saveOfflinePackage(record: EncryptedOfficePackage): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(PACKAGE_STORE, "readwrite");
  transaction.objectStore(PACKAGE_STORE).put(record);
  await transactionDone(transaction);
  db.close();
  if (record.pinned) await navigator.storage?.persist?.();
}

export async function loadOfflinePackage(artifactId: string): Promise<LoadedOfficeOfflinePackage | null> {
  const db = await openDb();
  const request = db.transaction(PACKAGE_STORE, "readonly").objectStore(PACKAGE_STORE).get(artifactId);
  const record = await new Promise<EncryptedOfficePackage | undefined>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as EncryptedOfficePackage | undefined);
    request.onerror = () => reject(request.error ?? new Error("office_offline_package_read_failed"));
  });
  db.close();
  if (!record) return null;
  const decrypted = await decryptOfficePackage<OfficeOfflinePackage>(record, await getOrCreateOfficeDeviceKey());
  return { ...decrypted, savedAt: record.savedAt };
}

export async function removeOfflinePackage(artifactId: string): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(PACKAGE_STORE, "readwrite");
  transaction.objectStore(PACKAGE_STORE).delete(artifactId);
  await transactionDone(transaction);
  db.close();
}

export async function encryptOfflineJournalEntry(entry: OfflineJournalEntry, deviceKey: CryptoKey | Uint8Array): Promise<EncryptedJournalEntry> {
  const key = await deriveOfficeDeviceKey(deviceKey, entry.artifactId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const additionalData = encoder.encode(`journal:${entry.artifactId}:${entry.seq}`);
  const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData }, key, encoder.encode(JSON.stringify(entry)));
  return { artifactId: entry.artifactId, seq: entry.seq, iv: b64(iv), ciphertext: b64(new Uint8Array(ciphertext)) };
}

export async function decryptOfflineJournalEntry(record: EncryptedJournalEntry, deviceKey: CryptoKey | Uint8Array): Promise<OfflineJournalEntry> {
  const key = await deriveOfficeDeviceKey(deviceKey, record.artifactId);
  const additionalData = encoder.encode(`journal:${record.artifactId}:${record.seq}`);
  const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(record.iv), additionalData }, key, unb64(record.ciphertext));
  return JSON.parse(decoder.decode(plaintext)) as OfflineJournalEntry;
}

export async function appendOfflineCommand(entry: OfflineJournalEntry): Promise<void> {
  const encrypted = await encryptOfflineJournalEntry(entry, await getOrCreateOfficeDeviceKey());
  const db = await openDb();
  const transaction = db.transaction(JOURNAL_STORE, "readwrite");
  transaction.objectStore(JOURNAL_STORE).put(encrypted);
  await transactionDone(transaction);
  db.close();
}

export async function listOfflineJournal(artifactId: string): Promise<OfflineJournalEntry[]> {
  const db = await openDb();
  const request = db.transaction(JOURNAL_STORE, "readonly").objectStore(JOURNAL_STORE).getAll();
  const all = await new Promise<EncryptedJournalEntry[]>((resolve, reject) => {
    request.onsuccess = () => resolve(request.result as EncryptedJournalEntry[]);
    request.onerror = () => reject(request.error ?? new Error("office_offline_journal_read_failed"));
  });
  db.close();
  const deviceKey = await getOrCreateOfficeDeviceKey();
  return Promise.all(all.filter((entry) => entry.artifactId === artifactId).sort((a, b) => a.seq - b.seq).map((entry) => decryptOfflineJournalEntry(entry, deviceKey)));
}

export async function removeOfflineJournalEntry(entry: OfflineJournalEntry): Promise<void> {
  const db = await openDb();
  const transaction = db.transaction(JOURNAL_STORE, "readwrite");
  transaction.objectStore(JOURNAL_STORE).delete([entry.artifactId, entry.seq]);
  await transactionDone(transaction);
  db.close();
}

export function classifyOfficeReconnect(result: { status?: string; reason?: string; quarantine?: boolean }): { status: OfficeOfflineStatus; quarantine: boolean; conflict: boolean } {
  if (result.status === "synced") return { status: "synced", quarantine: false, conflict: false };
  if (result.reason === "access_revoked") return { status: "needs_attention", quarantine: true, conflict: false };
  if (result.reason === "structural_conflict") return { status: "needs_attention", quarantine: false, conflict: true };
  return { status: "sync_failed", quarantine: false, conflict: false };
}
