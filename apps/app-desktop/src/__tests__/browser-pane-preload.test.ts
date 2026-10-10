import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const source = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');

/** Run the real app preload with a fake Electron and capture its bridge. */
function load() {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  const bridges = new Map<string, Record<string, any>>();
  const document = Object.assign(new EventTarget(), {
    documentElement: null, createElement: () => ({ style: { setProperty() {}, removeProperty() {} }, setAttribute() {} }),
    getElementById: () => null,
  });
  runInNewContext(source, {
    require: (name: string) => {
      if (name !== 'electron') throw new Error(`Sandbox cannot require ${name}`);
      return {
        contextBridge: { exposeInMainWorld: (key: string, value: Record<string, any>) => bridges.set(key, value) },
        ipcRenderer: {
          on: (channel: string, callback: (event: unknown, payload: unknown) => void) => listeners.set(channel, callback),
          sendSync: () => false, invoke: vi.fn(), send: vi.fn(),
        },
        webFrame: { getZoomFactor: () => 1 },
      };
    },
    process: { platform: 'linux', argv: [] },
    document, window: new EventTarget(), CustomEvent: class extends Event {}, queueMicrotask,
  });
  return { bridge: bridges.get('usebrianDesktop')!, emit: (payload: unknown) => listeners.get('embedded-browser:pane')!(null, payload) };
}

describe('[COMP:app-desktop/embedded-browser] the app bridge for the Chat side pane (chat-parity T7)', () => {
  it('advertises the pane protocol the app gates on', () => {
    expect(load().bridge.browserPaneProtocol).toBe(1);
  });

  it('relays only a validated copy of a tab Brian opened', () => {
    const { bridge, emit } = load();
    const seen: unknown[] = [];
    const off = bridge.onBrowserPane((event: unknown) => seen.push(event));
    emit({ type: 'tab-opened', chatKey: 'chat-a', browserId: 'h-1', url: 'https://a.example/', extra: 'dropped' });
    emit({ type: 'tab-opened', chatKey: 7, browserId: 'h-2', url: 'https://b.example/' });
    emit({ type: 'other' });
    expect(seen).toEqual([{ type: 'tab-opened', chatKey: 'chat-a', browserId: 'h-1', url: 'https://a.example/' }]);
    off();
    emit({ type: 'tab-opened', chatKey: null, browserId: 'h-3', url: 'https://c.example/' });
    expect(seen).toHaveLength(1);
  });
});
