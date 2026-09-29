import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
const tokens = ['background', 'foreground', 'sidebar', 'sidebar-foreground',
  'muted-foreground', 'border', 'primary', 'accent', 'accent-foreground',
  'destructive', 'ring', 'sidebar-accent', 'sidebar-accent-foreground'];
type Theme = { colors: Record<string, string>; colorScheme: string; radius: string; fontFamily: string };

// Execute the real preload in a sandbox. The CSS engine boundary is faked:
// raw variables deliberately differ from computed probe values.
function harness(options: { missingAPIs?: boolean; loaded?: boolean; legacyMedia?: boolean } = {}) {
  class Element extends EventTarget {
    properties = new Map<string, string>();
    children: Element[] = [];
    dark = false;
    classList = { contains: (name: string) => name === 'dark' && this.dark };
    style = {
      cssText: '',
      setProperty: (key: string, value: string) => this.properties.set(key, value),
    };
    setAttribute() {}
    appendChild(child: Element) { this.children.push(child); }
    remove() { body.children = body.children.filter(child => child !== this); }
  }
  const root = new Element();
  const head = new Element();
  const body = new Element();
  const document = Object.assign(new EventTarget(), {
    documentElement: root, head, body,
    readyState: options.loaded ? 'complete' : 'loading',
    createElement: () => new Element(),
  });
  const ipc = new Map<string, () => void>();
  const sent: Theme[] = [];
  const frames: (() => void)[] = [];
  const observations: { target: Element; config: Record<string, unknown> }[] = [];
  let mutate = () => {};
  let systemChange = () => {};
  let themed = true;
  let osDark = true;
  let radius = '8px';
  let font = 'Inter, sans-serif';
  const resolved = Object.fromEntries(tokens.map((token, i) => [token, `rgb(${i}, 20, 30)`]));
  const reads: string[] = [];
  const window = Object.assign(new EventTarget(), options.missingAPIs ? {} : {
    requestAnimationFrame: (callback: () => void) => frames.push(callback),
    matchMedia: () => ({
      get matches() { return osDark; }, // App initially forced light against OS dark.
      ...(options.legacyMedia
        ? { addListener: (callback: () => void) => { systemChange = callback; } }
        : { addEventListener: (_: string, callback: () => void) => { systemChange = callback; } }),
    }),
    getComputedStyle: (element: Element) => {
      if (element === root) return {
        getPropertyValue: () => themed ? 'oklch(0.9 0.1 50)' : '',
        colorScheme: root.dark ? 'dark' : 'light',
      };
      if (element === body) return { fontFamily: font };
      const color = element.properties.get('color') ?? '';
      reads.push(color);
      const token = /^var\(--(.+)\)$/.exec(color)?.[1] ?? '';
      return { color: resolved[token], borderRadius: element.properties.get('border-radius') === 'var(--radius)' ? radius : '' };
    },
  });
  runInNewContext(source, {
    require: () => ({
      contextBridge: { exposeInMainWorld() {} },
      ipcRenderer: {
        on: (channel: string, callback: () => void) => ipc.set(channel, callback),
        sendSync: () => false,
        send: (channel: string, theme: Theme) => {
          expect(channel).toBe('embedded-browser:theme');
          sent.push(JSON.parse(JSON.stringify(theme)));
        },
      },
      webFrame: { getZoomFactor: () => 1 },
    }),
    process: { platform: 'linux', argv: [] }, document, window, queueMicrotask,
    ...(options.missingAPIs ? {} : { MutationObserver: class {
      constructor(callback: () => void) { mutate = callback; }
      observe(target: Element, config: Record<string, unknown>) { observations.push({ target, config }); }
    } }),
  });
  return {
    root, head, body, sent, resolved, observations, reads, frames,
    load: () => document.dispatchEvent(new Event('DOMContentLoaded')),
    flush: () => { frames.splice(0).forEach(callback => callback()); },
    request: () => ipc.get('embedded-browser:request-theme')!(),
    mutate: () => mutate(), systemChange: () => { osDark = !osDark; systemChange(); },
    themed: (value: boolean) => { themed = value; },
    typography: () => { radius = '12px'; font = 'Custom Font, serif'; },
  };
}

describe('app browser theme preload', () => {
  it('queues early requests until load, resolves only allowlisted tokens, and dedupes', () => {
    const h = harness();
    h.request(); h.flush();
    expect(h.sent).toEqual([]);
    h.load(); h.request(); h.mutate();
    expect(h.frames).toHaveLength(1);
    h.flush();
    expect(h.sent).toEqual([{ colors: h.resolved, colorScheme: 'light', radius: '8px', fontFamily: 'Inter, sans-serif' }]);
    expect(h.reads).toEqual(expect.arrayContaining(tokens.map(token => `var(--${token})`)));
    expect(h.body.children).toHaveLength(0);
    h.systemChange(); h.mutate(); h.flush();
    expect(h.sent).toHaveLength(1);
    h.request(); h.flush(); // A new host needs the unchanged theme too.
    expect(h.sent).toHaveLength(2);
    expect(h.sent[1]).toEqual(h.sent[0]);
  });

  it('follows app forced light/dark, not OS, and observes only root attributes and head', () => {
    const h = harness();
    h.load(); h.flush();
    expect(h.observations).toEqual([
      { target: h.root, config: { attributes: true, attributeFilter: ['class', 'style', 'data-palette'] } },
      { target: h.head, config: { subtree: true, childList: true, characterData: true, attributes: true } },
    ]);
    h.systemChange(); // OS now light; forced dark must still win.
    h.root.dark = true; h.mutate(); h.flush();
    expect(h.sent.at(-1)?.colorScheme).toBe('dark');
    h.systemChange(); h.flush();
    expect(h.sent).toHaveLength(2);
    h.root.dark = false; h.mutate(); h.flush();
    expect(h.sent.at(-1)?.colorScheme).toBe('light');
  });

  it('publishes custom palette, stylesheet load, typography and requested updates', () => {
    const h = harness({ loaded: true, legacyMedia: true });
    h.flush();
    h.resolved.background = 'oklch(0.8 0.1 40)';
    h.typography(); h.mutate(); h.mutate(); h.flush();
    expect(h.sent.at(-1)).toMatchObject({ colors: { background: 'oklch(0.8 0.1 40)' }, radius: '12px', fontFamily: 'Custom Font, serif' });
    h.resolved.primary = 'color(srgb 0.2 0.3 0.4)';
    h.head.dispatchEvent(new Event('load')); h.flush();
    expect(h.sent.at(-1)?.colors.primary).toBe(h.resolved.primary);
    h.resolved.border = 'rgb(1, 2, 3)'; h.request(); h.flush();
    expect(h.sent.at(-1)?.colors.border).toBe(h.resolved.border);
    h.resolved.ring = 'rgb(4, 5, 6)'; h.systemChange(); h.flush();
    expect(h.sent.at(-1)?.colors.ring).toBe(h.resolved.ring);
  });

  it('does not publish unthemed sign-in defaults, but recovers when tokens arrive', () => {
    const h = harness();
    h.themed(false); h.request(); h.load(); h.flush();
    expect(h.sent).toEqual([]);
    expect(h.body.children).toEqual([]);
    h.themed(true); h.mutate(); h.flush();
    expect(h.sent).toHaveLength(1);
  });

  it('supports older minimal preload mocks with optional browser APIs absent', () => {
    const h = harness({ missingAPIs: true });
    expect(() => { h.request(); h.load(); h.request(); }).not.toThrow();
    expect(h.sent).toEqual([]);
  });
});
