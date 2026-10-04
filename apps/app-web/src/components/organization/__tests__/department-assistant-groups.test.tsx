// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DepartmentAssistantGroups } from '../department-assistant-groups';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { resetSurfaceCache } from '@/lib/surface-cache';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock('@/lib/api/studio', () => ({ listAssistants: mocks.list }));
vi.mock('@/lib/workspace-context', () => ({ useWorkspaceContext: () => ({ workspaceId: 'workspace', me: { id: 'viewer' } }) }));
let root: Root, host: HTMLDivElement;
const rows = [
  { id: 'one', name: 'Research helper', placementDepartmentId: 'research', placementDepartmentName: 'Research', channels: [] },
  { id: 'two', name: 'Review helper', placementDepartmentId: 'research', placementDepartmentName: 'Research', channels: [] },
  { id: 'three', name: 'General helper', placementDepartmentId: null, channels: [] },
];
beforeEach(() => { resetSurfaceCache(); mocks.list.mockReset(); mocks.list.mockResolvedValue(rows); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetSurfaceCache(); });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
async function render() { await act(async () => root.render(<I18nProvider locale="en" dict={en}><DepartmentAssistantGroups /></I18nProvider>)); await flush(); }
describe('[COMP:app-web/department-assistants] Collapsible placement groups', () => {
  it('groups by placement, shows counts and opens the selected assistant', async () => {
    await render();
    const buttons = [...host.querySelectorAll('button')];
    expect(buttons.map(b => b.textContent)).toEqual(['Entire workspace1', 'Research2']);
    expect(buttons[1].getAttribute('aria-expanded')).toBe('false');
    await act(async () => buttons[1].click());
    expect(buttons[1].getAttribute('aria-expanded')).toBe('true');
    const list = document.getElementById(buttons[1].getAttribute('aria-controls')!)!;
    expect(list.hidden).toBe(false);
    expect([...list.querySelectorAll('a')].map(a => a.textContent)).toEqual(['Research helper', 'Review helper']);
    expect(list.querySelector('a')!.getAttribute('href')).toBe('/w/workspace/studio/assistants?assistant=one');
    await act(async () => buttons[1].click());
    expect(list.hidden).toBe(true);
  });
  it('drops a group when the authorized roster no longer contains its assistants', async () => {
    await render(); mocks.list.mockResolvedValue([rows[2]]);
    await act(async () => window.dispatchEvent(new CustomEvent('brian:departments-changed', { detail: { workspaceId: 'workspace' } })));
    await flush();
    expect(host.textContent).not.toContain('Research');
    expect(host.querySelectorAll('button')).toHaveLength(1);
  });
});
