/** Bounded complete device copies, never signed-URL caching. [COMP:recordings/offline-media] */
import { idbGet, idbUpdate } from "@/lib/offline/idb";
import { currentOfflineWriteAuthority, sameOfflineWriteAuthority, type OfflineWriteAuthority } from "@/lib/offline/application-write-authority";
const KEY = "recording-media:v1";
const MEDIA_MAX_BYTES = 128 * 1024 * 1024;
const MEDIA_CACHE_BYTES = 512 * 1024 * 1024;
export const MEDIA_RETENTION_MS = 7 * 86400_000;
type Entry = { owner: OfflineWriteAuthority; id: string; blob: Blob; savedAt: number; usedAt: number };
export function mediaOwner() { return currentOfflineWriteAuthority(); }
export function ownsMedia(owner: OfflineWriteAuthority | null) { return sameOfflineWriteAuthority(owner, mediaOwner()); }
function matches(entry: Entry, owner: OfflineWriteAuthority, id: string) { return entry.id === id && sameOfflineWriteAuthority(entry.owner, owner); }
export async function readOfflineMedia(owner: OfflineWriteAuthority, id: string): Promise<Blob | null> {
  if (!ownsMedia(owner)) return null;
  const rows = await idbGet<Entry[]>(KEY) ?? [];
  const entry = rows.find(row => matches(row, owner, id) && row.savedAt > Date.now() - MEDIA_RETENTION_MS);
  if (!ownsMedia(owner) || !(entry?.blob instanceof Blob)) return null;
  void idbUpdate<Entry[]>(KEY, current => (current ?? []).map(row => matches(row, owner, id) ? { ...row, usedAt: Date.now() } : row)).catch(() => {});
  return entry.blob;
}
export async function removeOfflineMedia(owner: OfflineWriteAuthority, id: string) {
  await idbUpdate<Entry[]>(KEY, rows => (rows ?? []).filter(row => !matches(row, owner, id)));
}
export async function saveOfflineMedia(owner: OfflineWriteAuthority, id: string, blob: Blob) {
  if (!ownsMedia(owner) || !blob.size || blob.size > MEDIA_MAX_BYTES) return;
  await idbUpdate<Entry[]>(KEY, rows => {
    if (!ownsMedia(owner)) return rows ?? [];
    const now = Date.now();
    const retained = (rows ?? []).filter(row => !matches(row, owner, id) && row.savedAt > now - MEDIA_RETENTION_MS)
      .sort((a, b) => b.usedAt - a.usedAt);
    let bytes = blob.size;
    return [{ owner, id, blob, savedAt: now, usedAt: now }, ...retained.filter(row => {
      if (bytes + row.blob.size > MEDIA_CACHE_BYTES) return false;
      bytes += row.blob.size; return true;
    })];
  });
}
/** Read streaming with a hard cap even when Content-Length is absent or wrong. */
export async function downloadOfflineMedia(owner: OfflineWriteAuthority, id: string, url: string, signal: AbortSignal) {
  if (!ownsMedia(owner)) return;
  const response = await fetch(url, { signal, credentials: "omit" });
  if (!response.ok || Number(response.headers.get("content-length")) > MEDIA_MAX_BYTES || !response.body) {
    await response.body?.cancel(); return;
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array<ArrayBuffer>[] = []; let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > MEDIA_MAX_BYTES || !ownsMedia(owner)) { await reader.cancel(); return; }
      chunks.push(new Uint8Array(value));
    }
    if (signal.aborted) return;
    await saveOfflineMedia(owner, id, new Blob(chunks, { type: response.headers.get("content-type") ?? "audio/webm" }));
  } finally { reader.releaseLock(); }
}
