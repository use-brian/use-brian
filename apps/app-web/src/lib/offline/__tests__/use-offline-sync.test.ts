// @vitest-environment jsdom
/**
 * Unit tests for the collab-socket signal store in `use-offline-sync` — the
 * seam doc-shell publishes through so the WorkspaceChrome-mounted driver can
 * fold the sync socket's health into the global connectivity classification.
 *
 * [COMP:app-web/use-offline-sync]
 */

import { describe, expect, expectTypeOf, it, vi } from "vitest";

vi.mock("@/lib/api/views", () => ({
  renameView: vi.fn(),
  setViewIcon: vi.fn(),
  setViewFullWidth: vi.fn(),
  setViewClearance: vi.fn(),
}));

import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
const state = vi.hoisted(() => ({ posts: [] as Array<{ dirty: boolean; error?: 'conflict' | 'blocked' }> }));
vi.mock('../feed-offline', () => ({ FEED_LOCAL_CHANGED: 'feed:local-changed', flushFeedWorkingCopies: vi.fn(async () => {}), readLocalFeedPosts: async () => state.posts }));
vi.mock('../offline-pages', () => ({ LOCAL_PAGES_CHANGED: 'pages:local-changed', flushLocalPages: vi.fn(async () => {}), readLocalPages: async () => [] }));
vi.mock('../offline-writes', () => ({ setOnline: vi.fn(), getOnline: () => true, subscribeOnline: () => () => {}, flushWriteQueue: vi.fn(async () => {}), subscribePendingCount: () => () => {} }));
import {
  useOfflineSync,
  publishCollabConnected,
  getCollabConnected,
  publishCollabLive,
  RECONNECTING_GRACE_MS,
  initialNavigatorOnline,
} from "../use-offline-sync";

describe("[COMP:app-web/use-offline-sync] collab-socket signal store", () => {
  it("uses an SSR-safe optimistic value for the first client render", () => {
    expect(initialNavigatorOnline()).toBe(true);
  });

  it("keeps navigator state writable after the optimistic first render", () => {
    expectTypeOf(initialNavigatorOnline()).toEqualTypeOf<boolean>();
  });

  it("defaults to connected (no open doc must not read as degraded)", () => {
    expect(getCollabConnected()).toBe(true);
  });

  it("publishes down and back up", () => {
    publishCollabConnected(false);
    expect(getCollabConnected()).toBe(false);
    publishCollabConnected(true);
    expect(getCollabConnected()).toBe(true);
  });

  it("is idempotent on repeated publishes of the same value", () => {
    publishCollabConnected(true);
    publishCollabConnected(true);
    expect(getCollabConnected()).toBe(true);
  });
});


describe('[COMP:app-web/use-offline-sync] Feed save status', () => {
  it('distinguishes paused Feed work from retryable edits and clears it after recovery', async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.posts = [{ dirty: true, error: 'conflict' }, { dirty: true }, { dirty: false }];
    const container = document.createElement('div'); const root = createRoot(container);
    function Probe() { const state = useOfflineSync(); return createElement('span', null, `${state.pending}:${state.paused}`); }
    try {
      await act(async () => { root.render(createElement(Probe)); });
      expect(container.textContent).toBe('2:1');
      state.posts = [{ dirty: false }, { dirty: true }];
      await act(async () => { window.dispatchEvent(new Event('feed:local-changed')); });
      expect(container.textContent).toBe('1:0');
    } finally { await act(async () => root.unmount()); }
  });
});

describe('[COMP:app-web/use-offline-sync] Reconnecting status', () => {
  it('reports reconnecting only after the grace while the socket is connecting, not as Online', async () => {
    (globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    state.posts = [];
    vi.useFakeTimers();
    const container = document.createElement('div'); const root = createRoot(container);
    function Probe() { const s = useOfflineSync(); return createElement('span', null, `${s.connectivity}:${s.reconnecting}`); }
    try {
      await act(async () => { root.render(createElement(Probe)); });
      expect(container.textContent).toBe('online:false');
      // A re-dialing socket is still "connected" for write queueing...
      await act(async () => { publishCollabLive(false); });
      expect(container.textContent).toBe('online:false');
      await act(async () => { vi.advanceTimersByTime(RECONNECTING_GRACE_MS); });
      // ...but the status bar must say Reconnecting, not Online.
      expect(container.textContent).toBe('online:true');
      await act(async () => { publishCollabLive(true); });
      expect(container.textContent).toBe('online:false');
    } finally {
      await act(async () => root.unmount());
      publishCollabLive(true);
      vi.useRealTimers();
    }
  });
});
