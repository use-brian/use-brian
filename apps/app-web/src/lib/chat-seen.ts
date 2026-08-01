/**
 * Per-user seen watermarks for room unread dots (multiplayer chat T7).
 *
 * A rail row is "unread" when the room's `last_active_at` is newer than the
 * viewer's watermark for it. Watermarks live CLIENT-SIDE in `localStorage`,
 * keyed by workspace + session — device-scoped is the explicit v1 ceiling
 * (a server-side watermark table is deferred with notifications). No read
 * receipts: nobody else ever sees these.
 */

const key = (workspaceId: string) => `sidan:chat-seen:${workspaceId}`;

type SeenMap = Record<string, string>;

function readMap(workspaceId: string): SeenMap {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(key(workspaceId));
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as SeenMap) : {};
  } catch {
    return {};
  }
}

/** Stamp "I have seen this room as of now" (or an explicit instant). */
export function markRoomSeen(
  workspaceId: string,
  sessionId: string,
  at: Date = new Date(),
): void {
  if (typeof window === "undefined") return;
  try {
    const map = readMap(workspaceId);
    map[sessionId] = at.toISOString();
    window.localStorage.setItem(key(workspaceId), JSON.stringify(map));
  } catch {
    // Quota / privacy mode — the dot degrades to always-on, never crashes.
  }
}

/** True when the room has activity newer than this device's watermark. */
export function isRoomUnread(
  workspaceId: string,
  sessionId: string,
  lastActive: string | Date,
): boolean {
  const seen = readMap(workspaceId)[sessionId];
  if (!seen) return true;
  const last =
    typeof lastActive === "string" ? Date.parse(lastActive) : lastActive.getTime();
  return Number.isFinite(last) && last > Date.parse(seen);
}
