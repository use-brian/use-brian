import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

const html = readFileSync(new URL('../embedded-browser.html', import.meta.url), 'utf8');

describe('compact browser panel controls', () => {
  it('labels icon controls and preserves the visible Stop Brian label', () => {
    for (const [id, label] of Object.entries({
      collapse: 'Collapse browser panel', expand: 'Expand browser panel',
      detach: 'Detach browser window', 'rail-detach': 'Detach browser window', dock: 'Dock browser panel',
    })) {
      const button = html.match(new RegExp(`<button id="${id}"[^>]*>[\\s\\S]*?</button>`))?.[0];
      expect(button).toContain('class="icon-button"');
      expect(button).toContain(`aria-label="${label}"`);
      expect(button).toContain(`title="${label}"`);
      expect(button).toContain('aria-hidden="true"');
      expect(button).toContain('focusable="false"');
    }
    for (const id of ['stop', 'rail-stop']) {
      expect(html).toMatch(new RegExp(`<button id="${id}"[^>]*>Stop Brian</button>`));
    }
  });

  it('preserves commands and transfers focus between the toolbar and collapsed rail', () => {
    const elements = new Map<string, any>();
    const document: any = {
      activeElement: null,
      getElementById: (id: string) => {
        if (!elements.has(id)) elements.set(id, {
          hidden: false, addEventListener: vi.fn(), setAttribute: vi.fn(), replaceChildren: vi.fn(),
          contains: (active: any) => id === 'controls'
            ? ['collapse', 'detach', 'stop'].includes(active?.id)
            : id === 'rail' && ['expand', 'rail-stop', 'rail-detach'].includes(active?.id),
          id, focus: vi.fn(() => { document.activeElement = elements.get(id); }),
        });
        return elements.get(id);
      },
    };
    const window = { addEventListener: vi.fn() };
    const ipcRenderer = { send: vi.fn(), on: vi.fn() };
    runInNewContext(readFileSync(new URL('../embedded-browser-preload.cjs', import.meta.url), 'utf8'), {
      document, window, require: () => ({ ipcRenderer }),
    });
    window.addEventListener.mock.calls.find(([name]) => name === 'DOMContentLoaded')![1]();
    const update = ipcRenderer.on.mock.calls.find(([name]) => name === 'embedded-browser:state')![1];
    const present = (collapsed: boolean, mode = 'docked') => update({}, {
      tabs: [], selected: null, status: 'Manual browsing ready',
      presentation: { collapsed, mode, panelWidth: collapsed ? 56 : 480, minWidth: 360, maxWidth: 700 },
    });
    for (const [id, command] of Object.entries({ collapse: 'collapse', expand: 'expand', detach: 'detach',
      dock: 'dock', 'rail-detach': 'detach', stop: 'stop', 'rail-stop': 'stop' })) {
      elements.get(id).addEventListener.mock.calls.find(([name]: [string]) => name === 'click')[1]();
      expect(ipcRenderer.send).toHaveBeenLastCalledWith('embedded-browser:command', command, undefined);
    }
    document.activeElement = elements.get('collapse');
    present(true);
    expect(elements.get('rail').hidden).toBe(false);
    expect(elements.get('controls').hidden).toBe(true);
    expect(elements.get('separator').hidden).toBe(true);
    expect(document.activeElement.id).toBe('expand');
    present(false);
    expect(elements.get('rail').hidden).toBe(true);
    expect(elements.get('controls').hidden).toBe(false);
    expect(elements.get('separator').hidden).toBe(false);
    expect(document.activeElement.id).toBe('collapse');
    present(true);
    document.activeElement = elements.get('rail-detach');
    present(false, 'detached');
    expect(document.activeElement.id).toBe('dock');
    expect(elements.get('dock').hidden).toBe(false);
    expect(elements.get('collapse').hidden).toBe(true);
    expect(elements.get('separator').hidden).toBe(true);
  });
});
