/**
 * Composer attachment trays, kept beside the conversation registry.
 *
 * Ready upload chips are a composer draft: they must survive the
 * presentation unmounting (leaving `/chat` for `/p` and coming back) and be
 * shared by every mounted presentation of one composer (the desktop dock and
 * `MobileChatDrawer`). The registry cannot hold them: it evicts an idle
 * detached conversation as soon as its presentation detaches. So the trays
 * live here, keyed with the registry's encoding (write-authority prefix
 * `{ apiOrigin, viewerId, workspaceId }` plus a conversation part), bounded,
 * and dropped on the same identity signals the registry follows.
 *
 * `useFileAttachments` reads and writes a tray when its host passes one;
 * without one it keeps a tray local to the mounted component.
 *
 * Contract: docs/architecture/features/chat-app.md → "Conversation attachment
 * trays (M5, WP-F)". [COMP:app-web/conversation-attachments]
 */
import type { Attachment } from "@/lib/use-file-attachments";
import { currentOfflineWriteAuthority } from "@/lib/offline/application-write-authority";
import { publicRuntimeConfig } from "@/lib/runtime-public-config";
import * as userModule from "@/lib/user";
import * as desktopAuthModule from "@/lib/desktop-auth-source";
import type { ConversationScope } from "./conversation-controller";
import type { ConversationPart } from "./conversation-registry";

/** Non-empty trays kept while no presentation reads them. */
const DEFAULT_DETACHED_TRAY_CAP = 12;

/** One composer's chips plus the upload bookkeeping that must outlive a mount. */
export type AttachmentTray = {
  getSnapshot: () => Attachment[];
  subscribe: (listener: () => void) => () => void;
  /** Replace the chips; ignored once the tray is disposed. */
  update: (next: (prev: Attachment[]) => Attachment[]) => void;
  /** Upload generation: `clear`, `detach`, `restore` and disposal bump it. */
  generation: number;
  /** Local ids of chips whose upload has not settled. */
  readonly pending: Set<string>;
  isDisposed: () => boolean;
};

type TrayRecord = {
  key: string;
  scope: ConversationScope | null;
  tray: AttachmentTray;
  listeners: Set<() => void>;
  lastUsed: number;
  dispose: () => void;
};

function revokePreviews(chips: readonly Attachment[]): void {
  if (typeof URL === "undefined" || typeof URL.revokeObjectURL !== "function") return;
  for (const chip of chips) if (chip.previewUrl) URL.revokeObjectURL(chip.previewUrl);
}

function createTrayRecord(
  key: string,
  scope: ConversationScope | null,
  onChange: () => void,
  onSubscribe: (record: TrayRecord) => void = () => {},
): TrayRecord {
  let chips: Attachment[] = [];
  let disposed = false;
  const listeners = new Set<() => void>();
  const notify = () => { for (const listener of [...listeners]) listener(); };
  const tray: AttachmentTray = {
    getSnapshot: () => chips,
    subscribe(listener) {
      listeners.add(listener);
      onSubscribe(record);
      onChange();
      return () => {
        listeners.delete(listener);
        onChange();
      };
    },
    update(next) {
      if (disposed) return;
      const value = next(chips);
      if (value === chips) return;
      chips = value;
      notify();
      onChange();
    },
    generation: 0,
    pending: new Set<string>(),
    isDisposed: () => disposed,
  };
  const record: TrayRecord = {
    key,
    scope,
    tray,
    listeners,
    lastUsed: 0,
    dispose() {
      if (disposed) return;
      disposed = true;
      tray.generation += 1;
      tray.pending.clear();
      revokePreviews(chips);
      chips = [];
      notify();
    },
  };
  return record;
}

/** A tray owned by one mounted component (no key, no store). */
export function createAttachmentTray(): AttachmentTray {
  return createTrayRecord("", null, () => {}).tray;
}

/** The registry's key encoding, so a tray and its conversation line up. */
export function conversationAttachmentKey(scope: ConversationScope, part: ConversationPart): string {
  const prefix = JSON.stringify([scope.apiOrigin, scope.viewerId, scope.workspaceId]);
  return `${prefix}|${"sessionId" in part ? `s:${part.sessionId}` : `p:${part.provisional}`}`;
}

export type ConversationAttachmentStoreOptions = {
  /** Non-empty trays kept with no reader; least recently used dropped first. */
  cap?: number;
  setTimeout?: (callback: () => void, ms: number) => unknown;
  /** The renderer's current identity; null when signed out. */
  currentIdentity?: () => { viewerId: string; apiOrigin: string } | null;
};

export function createConversationAttachmentStore(options: ConversationAttachmentStoreOptions = {}) {
  const records = new Map<string, TrayRecord>();
  const cap = options.cap ?? DEFAULT_DETACHED_TRAY_CAP;
  const later = options.setTimeout ?? ((callback: () => void, ms: number) => setTimeout(callback, ms));
  let clock = 0;
  let sweepPending = false;

  const drop = (record: TrayRecord) => {
    if (records.get(record.key) === record) records.delete(record.key);
    record.dispose();
  };

  /** Unread empty trays go; unread non-empty ones are bounded, LRU first. */
  const sweep = () => {
    sweepPending = false;
    const kept: TrayRecord[] = [];
    for (const record of [...records.values()]) {
      if (record.listeners.size > 0) continue;
      if (record.tray.getSnapshot().length === 0 && record.tray.pending.size === 0) {
        records.delete(record.key);
        continue;
      }
      kept.push(record);
    }
    kept.sort((a, b) => a.lastUsed - b.lastUsed);
    while (kept.length > cap) drop(kept.shift()!);
  };
  // A tray swept while empty between render and subscribe is registered again.
  const resubscribed = (record: TrayRecord) => {
    if (record.tray.isDisposed() || records.has(record.key)) return;
    record.lastUsed = ++clock;
    records.set(record.key, record);
  };
  // Deferred so a StrictMode subscribe/unsubscribe/subscribe replay settles first.
  const scheduleSweep = () => {
    if (sweepPending) return;
    sweepPending = true;
    later(sweep, 0);
  };

  /** The tray for this conversation; the same object while it lives. */
  function tray(scope: ConversationScope, part: ConversationPart): AttachmentTray {
    const key = conversationAttachmentKey(scope, part);
    const found = records.get(key);
    if (found && !found.tray.isDisposed()) {
      found.lastUsed = ++clock;
      return found.tray;
    }
    const record = createTrayRecord(key, { ...scope }, scheduleSweep, resubscribed);
    record.lastUsed = ++clock;
    records.set(key, record);
    // A render that never subscribes must not leak an empty tray.
    scheduleSweep();
    return record.tray;
  }

  /**
   * Re-key a tray when its conversation gets a session (an upload on a fresh
   * pane created it). The tray object moves, so uploads still in flight land
   * in it. A target already holding chips is never merged into; an empty
   * target is replaced (its readers re-render and pick up the moved tray).
   */
  function move(scope: ConversationScope, from: ConversationPart, to: ConversationPart): boolean {
    const fromKey = conversationAttachmentKey(scope, from);
    const toKey = conversationAttachmentKey(scope, to);
    if (fromKey === toKey) return false;
    const source = records.get(fromKey);
    if (!source || source.tray.isDisposed()) return false;
    const target = records.get(toKey);
    if (target && !target.tray.isDisposed()) {
      if (target.tray.getSnapshot().length > 0 || target.tray.pending.size > 0) return false;
      drop(target);
    }
    records.delete(fromKey);
    source.key = toKey;
    source.lastUsed = ++clock;
    records.set(toKey, source);
    return true;
  }

  function disposeWhere(predicate: (scope: ConversationScope) => boolean): number {
    let count = 0;
    for (const record of [...records.values()]) {
      if (!record.scope || !predicate(record.scope)) continue;
      drop(record);
      count++;
    }
    return count;
  }

  /** Drop every tray that does not belong to the current identity. */
  function reconcileIdentity(): number {
    const identity = options.currentIdentity?.() ?? null;
    return disposeWhere((scope) => !identity || scope.viewerId !== identity.viewerId || scope.apiOrigin !== identity.apiOrigin);
  }

  return {
    tray,
    lookup: (scope: ConversationScope, part: ConversationPart): AttachmentTray | null =>
      records.get(conversationAttachmentKey(scope, part))?.tray ?? null,
    move,
    disposeWhere,
    disposeAll: () => disposeWhere(() => true),
    reconcileIdentity,
    size: () => records.size,
    sweepNow: sweep,
  };
}

export type ConversationAttachmentStore = ReturnType<typeof createConversationAttachmentStore>;

/** Subscribe a store to the identity signals the conversation registry follows. */
export function installAttachmentIdentityHooks(store: ConversationAttachmentStore, sources: {
  target?: Pick<Window, "addEventListener" | "removeEventListener">;
  onSessionRestored?: (callback: () => void) => () => void;
  subscribeUser?: (listener: () => void) => () => void;
} = {}): () => void {
  const target = sources.target ?? (typeof window !== "undefined" ? window : undefined);
  const cleared = () => { store.disposeAll(); };
  const reconcile = () => { store.reconcileIdentity(); };
  target?.addEventListener("brian:local-data-cleared", cleared);
  const stopRestored = sources.onSessionRestored?.(reconcile);
  const stopUser = sources.subscribeUser?.(reconcile);
  return () => {
    target?.removeEventListener("brian:local-data-cleared", cleared);
    stopRestored?.();
    stopUser?.();
  };
}

/** A missing identity source (or a host test's partial mock) means "no signal". */
function optional<T>(read: () => T): T | undefined {
  try { return read(); } catch { return undefined; }
}

const apiOrigin = () => (publicRuntimeConfig().apiUrl ?? "http://localhost:4000").replace(/\/$/, "");

let shared: ConversationAttachmentStore | null = null;

/** This renderer's store. A desktop chat window is a separate realm with its own. */
function conversationAttachments(): ConversationAttachmentStore {
  if (shared) return shared;
  shared = createConversationAttachmentStore({
    currentIdentity: () => {
      const viewerId = optional(() => userModule.getUserInfo())?.id;
      return viewerId ? { viewerId, apiOrigin: apiOrigin() } : null;
    },
  });
  if (typeof window !== "undefined") {
    const bridge = optional(() => desktopAuthModule.desktopBridge());
    const subscribe = optional(() => userModule.subscribeUserInfo);
    installAttachmentIdentityHooks(shared, {
      onSessionRestored: bridge?.onSessionRestored?.bind(bridge),
      subscribeUser: typeof subscribe === "function" ? (listener) => subscribe(() => listener()) : undefined,
    });
  }
  return shared;
}

function scopeFor(workspaceId: string): ConversationScope | null {
  const authority = currentOfflineWriteAuthority(workspaceId);
  return authority
    ? { apiOrigin: authority.apiOrigin, viewerId: authority.viewerId, workspaceId: authority.workspaceId }
    : null;
}

/**
 * The tray a presentation binds during render; null until the write authority
 * is known (the hook then keeps a component-local tray). Idempotent by key.
 */
export function conversationAttachmentTray(
  workspaceId: string,
  part: ConversationPart,
  store: ConversationAttachmentStore = conversationAttachments(),
): AttachmentTray | null {
  const scope = scopeFor(workspaceId);
  return scope ? store.tray(scope, part) : null;
}

/** Move a tray to its conversation's session key (see `move`). */
export function moveConversationAttachments(
  workspaceId: string,
  from: ConversationPart,
  to: ConversationPart,
  store: ConversationAttachmentStore = conversationAttachments(),
): boolean {
  const scope = scopeFor(workspaceId);
  return scope ? store.move(scope, from, to) : false;
}
