/** Device-encrypted Office packages and durable offline command journal.
 * [COMP:app-web/office-offline] */
import { getUserInfo } from "@/lib/user";
import type { OfficeCommand } from "@use-brian/office-model";
import type { OfficeArtifact, OfficeCommentThread, OfficeLiveSnapshot } from "../api";

export type OfficeOfflineOwner = Readonly<{userId: string; workspaceId: string}>;

export type OfficeOfflineStatus = "saved_device" | "offline" | "syncing" | "synced" | "needs_attention" | "sync_failed";
export type EncryptedOfficePackage = { artifactId: string; version: number; manifestHash: string; iv: string; ciphertext: string; pinned: boolean; savedAt: string };
type OfficeOfflinePayload = {
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
type OfficeOfflinePackage = { manifest: Record<string, unknown>; signature: string; payload: OfficeOfflinePayload };
export type LoadedOfficeOfflinePackage = OfficeOfflinePackage & { savedAt: string };
export type OfflineJournalEntry =
  | { artifactId: string; seq: number; kind: "command"; expectedSeq: number; command: OfficeCommand; createdAt: string }
  | { artifactId: string; seq: number; kind: "suggestion"; expectedSeq: number; command: OfficeCommand; createdAt: string }
  | { artifactId: string; seq: number; kind: "comment"; anchor: { kind: string; targetIds: string[] }; body: string; mentions?: string[]; invokeBrian?: { assistantId: string; expectedVersion: number; idempotencyKey: string }; createdAt: string };

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
async function validateOfficeOfflinePackage(value: OfficeOfflinePackage): Promise<void> {
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

async function deriveOfficeDeviceKey(deviceSecret: Uint8Array | CryptoKey, artifactId: string): Promise<CryptoKey> {
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
const PACKAGE_STORE = "viewer-packages";
const JOURNAL_STORE = "viewer-journal";
const KEY_STORE = "keys";

type EncryptedJournalEntry = { artifactId: string; seq: number; iv: string; ciphertext: string };

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => {
      const db = request.result;
      // Legacy artifact-only stores/root remain encrypted quarantine, never adopted.
      if (!db.objectStoreNames.contains(PACKAGE_STORE)) db.createObjectStore(PACKAGE_STORE, { keyPath: ["workspaceId", "userId", "artifactId"] });
      if (!db.objectStoreNames.contains(JOURNAL_STORE)) db.createObjectStore(JOURNAL_STORE, { keyPath: ["workspaceId", "userId", "artifactId", "seq"] });
      if (!db.objectStoreNames.contains(KEY_STORE)) db.createObjectStore(KEY_STORE);
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("office_offline_db_open_failed"));
  });
}

function assertOwner(owner: OfficeOfflineOwner): void {
  if (!owner.userId || !owner.workspaceId || getUserInfo()?.id !== owner.userId) throw new Error("office_offline_owner_changed");
}

function captureOwner(owner: OfficeOfflineOwner): OfficeOfflineOwner {
  const captured = {userId: owner.userId, workspaceId: owner.workspaceId};
  assertOwner(captured);
  return captured;
}

function recordKey(owner: OfficeOfflineOwner, artifactId: string): IDBValidKey[] {
  return [owner.workspaceId, owner.userId, artifactId];
}

async function readRecord<T>(store: string, key: IDBValidKey | IDBKeyRange, all = false): Promise<T> {
  const db = await openDb();
  try {
    const source = db.transaction(store, "readonly").objectStore(store);
    const request = all ? source.getAll(key) : source.get(key);
    return await new Promise<T>((resolve, reject) => {
      request.onsuccess = () => resolve(request.result as T);
      request.onerror = () => reject(request.error ?? new Error("office_offline_read_failed"));
    });
  } finally { db.close(); }
}

async function writeRecord(owner: OfficeOfflineOwner, name: string, write: (store: IDBObjectStore) => void): Promise<void> {
  const db = await openDb();
  try {
    assertOwner(owner);
    const transaction = db.transaction(name, "readwrite");
    const done = transactionDone(transaction);
    try { write(transaction.objectStore(name)); }
    catch (error) { transaction.abort(); await done.catch(() => undefined); throw error; }
    await done;
    assertOwner(owner);
  } finally { db.close(); }
}

/** Atomic get-or-create: concurrent first writes must encrypt under the SAME root. */
async function ownerValue<T>(owner: OfficeOfflineOwner, kind: string, candidate: T): Promise<T> {
  const db = await openDb();
  try {
    assertOwner(owner);
    const transaction = db.transaction(KEY_STORE, "readwrite");
    const done = transactionDone(transaction);
    const store = transaction.objectStore(KEY_STORE);
    const key = [kind, owner.workspaceId, owner.userId];
    const request = store.get(key);
    let selected: T | undefined;
    let refusal: unknown;
    request.onsuccess = () => {
      try {
        assertOwner(owner);
        selected = request.result ?? candidate;
        if (request.result === undefined) store.put(selected, key);
      } catch (error) { refusal = error; transaction.abort(); }
    };
    try { await done; } catch (error) { throw refusal ?? error; }
    assertOwner(owner);
    if (selected === undefined) throw new Error("office_offline_key_missing");
    return selected;
  } finally { db.close(); }
}

/** Non-extractable HKDF roots are separate for each viewer/workspace. */
async function getOrCreateOfficeDeviceKey(owner: OfficeOfflineOwner): Promise<CryptoKey> {
  assertOwner(owner);
  const candidate = await crypto.subtle.importKey("raw", crypto.getRandomValues(new Uint8Array(32)), "HKDF", false, ["deriveKey"]);
  const key = await ownerValue(owner, "root", candidate);
  if (key.type !== "secret" || key.extractable || key.algorithm.name !== "HKDF") throw new Error("office_offline_key_invalid");
  return key;
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onerror = () => reject(transaction.error ?? new Error("office_offline_write_failed"));
    transaction.onabort = () => reject(transaction.error ?? new Error("office_offline_write_aborted"));
  });
}

function assertPackageScope(value: OfficeOfflinePackage, owner: OfficeOfflineOwner, artifactId: string): void {
  if (value.payload?.artifact?.artifactId !== artifactId || value.payload?.snapshot?.workspaceId !== owner.workspaceId || value.payload?.snapshot?.artifactId !== artifactId) throw new Error("office_offline_scope_mismatch");
}

export async function loadOfflinePackage(artifactId: string, expectedOwner: OfficeOfflineOwner): Promise<LoadedOfficeOfflinePackage | null> {
  const owner = captureOwner(expectedOwner);
  const record = await readRecord<(EncryptedOfficePackage & OfficeOfflineOwner) | undefined>(PACKAGE_STORE, recordKey(owner, artifactId));
  assertOwner(owner);
  if (!record) return null;
  if (record.userId !== owner.userId || record.workspaceId !== owner.workspaceId || record.artifactId !== artifactId) throw new Error("office_offline_scope_mismatch");
  const decrypted = await decryptOfficePackage<OfficeOfflinePackage>(record, await getOrCreateOfficeDeviceKey(owner));
  assertOwner(owner);
  assertPackageScope(decrypted, owner, artifactId);
  await validateOfficeOfflinePackage(decrypted);
  assertOwner(owner);
  if (decrypted.payload.artifact.version !== record.version) throw new Error("office_offline_manifest_identity_mismatch");
  return { ...decrypted, savedAt: record.savedAt };
}

export async function removeOfflinePackage(artifactId: string, expectedOwner: OfficeOfflineOwner): Promise<void> {
  const owner = captureOwner(expectedOwner);
  await writeRecord(owner, PACKAGE_STORE, store => {store.delete(recordKey(owner, artifactId));});
}

export async function officeOfflineDeviceId(expectedOwner: OfficeOfflineOwner): Promise<string> {
  const owner = captureOwner(expectedOwner);
  return ownerValue(owner, "device-id", crypto.randomUUID());
}

export async function persistOfficeOfflinePackage(params: { artifactId: string; version: number; manifest: unknown; payload: unknown; signature: string; pinned: boolean }, expectedOwner: OfficeOfflineOwner): Promise<void> {
  const owner = captureOwner(expectedOwner);
  assertPackageScope(params as OfficeOfflinePackage, owner, params.artifactId);
  const encrypted = await encryptOfficePackage({ ...params, deviceSecret: await getOrCreateOfficeDeviceKey(owner) });
  assertOwner(owner);
  await writeRecord(owner, PACKAGE_STORE, store => {store.put({...encrypted, ...owner});});
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

function assertCommandOwner(command: OfficeCommand, owner: OfficeOfflineOwner, artifactId: string): void {
  if (command.actor.type !== "user" || command.actor.id !== owner.userId || command.artifactId !== artifactId) throw new Error("office_offline_scope_mismatch");
  if (command.kind === "batch") for (const child of command.commands) assertCommandOwner(child, owner, artifactId);
}

function assertJournalOwner(entry: OfflineJournalEntry, owner: OfficeOfflineOwner): void {
  if (!entry.artifactId || !Number.isSafeInteger(entry.seq) || entry.seq < 0) throw new Error("office_offline_journal_identity_invalid");
  if (entry.kind !== "comment") assertCommandOwner(entry.command, owner, entry.artifactId);
}

export async function appendOfflineCommand(entry: OfflineJournalEntry, expectedOwner: OfficeOfflineOwner): Promise<void> {
  const owner = captureOwner(expectedOwner);
  assertJournalOwner(entry, owner);
  const encrypted = await encryptOfflineJournalEntry(entry, await getOrCreateOfficeDeviceKey(owner));
  assertOwner(owner);
  await writeRecord(owner, JOURNAL_STORE, store => {store.put({...encrypted, ...owner});});
}

export async function listOfflineJournal(artifactId: string, expectedOwner: OfficeOfflineOwner): Promise<OfflineJournalEntry[]> {
  const owner = captureOwner(expectedOwner);
  const range = IDBKeyRange.bound([...recordKey(owner, artifactId), 0], [...recordKey(owner, artifactId), Number.MAX_SAFE_INTEGER]);
  const rows = await readRecord<Array<EncryptedJournalEntry & OfficeOfflineOwner>>(JOURNAL_STORE, range, true);
  assertOwner(owner);
  if (!rows.length) return [];
  const key = await getOrCreateOfficeDeviceKey(owner);
  const entries = await Promise.all(rows.map(async record => {
    if (record.userId !== owner.userId || record.workspaceId !== owner.workspaceId || record.artifactId !== artifactId) throw new Error("office_offline_scope_mismatch");
    const entry = await decryptOfflineJournalEntry(record, key);
    assertOwner(owner);
    assertJournalOwner(entry, owner);
    if (entry.artifactId !== artifactId || entry.seq !== record.seq) throw new Error("office_offline_journal_identity_invalid");
    return entry;
  }));
  assertOwner(owner);
  return entries.sort((a,b) => a.seq-b.seq);
}

export async function removeOfflineJournalEntry(entry: OfflineJournalEntry, expectedOwner: OfficeOfflineOwner): Promise<void> {
  const owner = captureOwner(expectedOwner);
  assertJournalOwner(entry, owner);
  await writeRecord(owner, JOURNAL_STORE, store => {store.delete([...recordKey(owner, entry.artifactId), entry.seq]);});
}

export function classifyOfficeReconnect(result: { status?: string; reason?: string; quarantine?: boolean }): { status: OfficeOfflineStatus; quarantine: boolean; conflict: boolean } {
  if (result.status === "synced") return { status: "synced", quarantine: false, conflict: false };
  if (result.reason === "access_revoked") return { status: "needs_attention", quarantine: true, conflict: false };
  if (result.reason === "structural_conflict") return { status: "needs_attention", quarantine: false, conflict: true };
  return { status: "sync_failed", quarantine: false, conflict: false };
}
