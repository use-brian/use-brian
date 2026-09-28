import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('../preload.cjs', import.meta.url), 'utf8');
const channel = 'embedded-browser:dock-layout';
const layoutEvent = 'usebrian:browser-dock-layout';

// Minimal DOM with actual EventTarget dispatch, executing the entire sandboxed
// preload. CSS declarations are checked below; this is not a layout engine.
class Element {
  id = '';
  textContent = '';
  children: Element[] = [];
  attributes = new Map<string, string>();
  properties = new Map<string, string>();
  style = {
    setProperty: (key: string, value: string) => this.properties.set(key, value),
    removeProperty: (key: string) => this.properties.delete(key),
    getPropertyValue: (key: string) => this.properties.get(key) ?? '',
  };
  appendChild(child: Element) { this.children.push(child); }
  setAttribute(key: string, value: string) { this.attributes.set(key, value); }
  removeAttribute(key: string) { this.attributes.delete(key); }
}

function harness(preDOM = false) {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>();
  const root = new Element();
  const body = new Element();
  const head = new Element();
  root.appendChild(head);
  root.appendChild(body);
  const document = Object.assign(new EventTarget(), {
    documentElement: preDOM ? null as Element | null : root,
    createElement: () => new Element(),
    getElementById: (id: string) => root.children.find(child => child.id === id) ?? null,
  });
  const window = new EventTarget();
  let zoom = 1;
  let events = 0;
  let resizes = 0;
  window.addEventListener(layoutEvent, () => { events++; });
  window.addEventListener('resize', () => { resizes++; });
  runInNewContext(source, {
    require: (name: string) => {
      if (name !== 'electron') throw new Error(`Sandbox cannot require ${name}`);
      return {
        contextBridge: { exposeInMainWorld() {} },
        ipcRenderer: {
          on: (name: string, callback: (event: unknown, payload: unknown) => void) => listeners.set(name, callback),
          sendSync: () => false,
        },
        webFrame: { getZoomFactor: () => zoom },
      };
    },
    process: { platform: 'linux', argv: [] },
    document, window, CustomEvent: class extends Event {}, queueMicrotask,
  });
  return {
    root, body, head, document, window,
    send: (payload: unknown) => listeners.get(channel)!(null, payload),
    ready: () => {
      document.documentElement = root;
      document.dispatchEvent(new Event('DOMContentLoaded'));
    },
    resize: () => window.dispatchEvent(new Event('resize')),
    zoom: (factor: number) => { zoom = factor; window.dispatchEvent(new Event('resize')); },
    width: () => root.style.getPropertyValue('--native-app-width'),
    events: () => events,
    resizes: () => resizes,
  };
}

const reserve = { reservedWidth: 400, contentWidth: 1200 };

describe('app browser dock preload', () => {
  it('applies synchronously and releases only owned styles with reservation zero', () => {
    const h = harness();
    h.root.style.setProperty('color', 'red');
    h.body.style.setProperty('width', '100vw');
    h.body.style.setProperty('position', 'fixed');
    h.send(reserve);
    expect(h.width()).toBe('800px');
    expect(h.root.attributes.has('data-native-browser-docked')).toBe(true);
    expect(h.events()).toBe(1);
    expect(h.resizes()).toBe(0);
    h.send({ reservedWidth: 0, contentWidth: 1200 });
    expect(h.width()).toBe('');
    expect(h.root.attributes.has('data-native-browser-docked')).toBe(false);
    expect(h.root.style.getPropertyValue('color')).toBe('red');
    expect(h.body.style.getPropertyValue('width')).toBe('100vw');
    expect(h.body.style.getPropertyValue('position')).toBe('fixed');
    expect(h.events()).toBe(2);
    h.send({ reservedWidth: 0, contentWidth: 1200 });
    h.resize();
    expect(h.events()).toBe(2);
  });

  it.each([null, {}, '400', { reservedWidth: '400', contentWidth: 1200 },
    { reservedWidth: NaN, contentWidth: 1200 }, { reservedWidth: Infinity, contentWidth: 1200 },
    { reservedWidth: -1, contentWidth: 1200 }, { reservedWidth: 1200, contentWidth: 1200 },
    { reservedWidth: 1201, contentWidth: 1200 }, { reservedWidth: 0, contentWidth: 0 },
    { reservedWidth: 0, contentWidth: -1 }, { reservedWidth: 0, contentWidth: Infinity },
    { reservedWidth: 0, contentWidth: NaN }, { reservedWidth: 0, contentWidth: '1200' },
    { reservedWidth: 1, contentWidth: 100001 },
  ])('ignores invalid payload %j without losing the reservation', payload => {
    const h = harness();
    h.send(payload);
    expect(h.events()).toBe(0);
    expect(h.width()).toBe('');
    h.send(reserve);
    h.send(payload);
    expect(h.width()).toBe('800px');
    expect(h.events()).toBe(1);
  });

  it('retains the latest pre-DOM handshake and handles pre-DOM release', () => {
    const h = harness(true);
    h.send(reserve);
    h.send({ reservedWidth: 500, contentWidth: 1200 });
    expect(h.events()).toBe(0);
    h.ready();
    expect(h.width()).toBe('700px');
    expect(h.events()).toBe(1);
    const released = harness(true);
    released.send(reserve);
    released.send({ reservedWidth: 0, contentWidth: 1200 });
    released.ready();
    expect(released.width()).toBe('');
    expect(released.events()).toBe(0);
  });

  it.each([0.8, 1.25, 1.5])('recomputes CSS width at zoom %s on resize', zoom => {
    const h = harness();
    h.send(reserve);
    h.zoom(zoom);
    expect(h.width()).toBe(`${800 / zoom}px`);
    expect(h.events()).toBe(2);
    h.resize();
    h.send(reserve);
    expect(h.events()).toBe(2);
  });

  it('deduplicates equal widths and cannot recurse through measuring resize hooks', () => {
    const h = harness();
    h.window.addEventListener(layoutEvent, () => h.resize());
    h.send(reserve);
    h.send({ reservedWidth: 500, contentWidth: 1300 });
    expect(h.events()).toBe(1);
    h.send({ reservedWidth: 500, contentWidth: 1400 });
    expect(h.events()).toBe(2);
    expect(h.width()).toBe('900px');
  });

  it('owns fixed-body containment CSS outside head and hydration roots', () => {
    const h = harness();
    h.send(reserve);
    const style = h.document.getElementById('usebrian-native-browser-dock-style')!;
    expect(style.textContent).toContain('html[data-native-browser-docked] > body');
    for (const declaration of ['box-sizing: border-box', 'margin: 0',
      'width: var(--native-app-width)', 'min-width: 0', 'max-width: none',
      'height: 100vh', 'min-height: 0', 'contain: layout paint']) {
      expect(style.textContent).toContain(`${declaration} !important;`);
    }
    h.root.children.splice(h.root.children.indexOf(h.head), 1, new Element());
    h.body.children = [new Element()];
    h.ready();
    expect(h.root.children.filter(child => child.id === style.id)).toEqual([style]);
    expect(h.events()).toBe(1);
  });

  it('does not alter or notify unrelated windows without reservation state', () => {
    const h = harness();
    h.ready();
    h.resize();
    h.zoom(0.8);
    h.zoom(1.5);
    expect(h.events()).toBe(0);
    expect(h.root.attributes.size).toBe(0);
    expect(h.root.properties.size).toBe(0);
    expect(h.root.children).toEqual([h.head, h.body]);
  });
});
