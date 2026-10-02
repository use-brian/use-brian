// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { HOME_APP_TOOL_CAPABILITIES } from '@use-brian/shared';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import type { Dictionary } from '@/lib/i18n/dictionaries';
import { authFetch } from '@/lib/auth-fetch';
import { HomeAppToolSettings } from '../home-app-tool-settings';
import { resetSurfaceCache } from '@/lib/surface-cache';
vi.mock('@/lib/auth-fetch', () => ({ authFetch: vi.fn() }));
const snapshot = vi.hoisted(() => vi.fn());
vi.mock('@/lib/api/association', () => ({ getAssociationModuleSnapshot: snapshot }));
vi.mock('@/lib/surface-prefetch', () => ({ associationModuleCacheKey: (workspaceId: string) => `association-module:${workspaceId}:viewer` }));
const fetchMock = vi.mocked(authFetch);
let root: Root;
let container: HTMLDivElement;
const response = (body: unknown, ok = true) => ({ ok, json: async () => body }) as Response;
const render = async (workspaceId?: string) => act(async () => {
  root.render(<I18nProvider locale="en" dict={en as unknown as Dictionary}><HomeAppToolSettings assistantId="assistant-one" workspaceId={workspaceId} /></I18nProvider>);
});
const button = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement('div'); document.body.append(container); root = createRoot(container);
  fetchMock.mockReset(); snapshot.mockReset(); resetSurfaceCache();
  snapshot.mockResolvedValue({ module: { workspaceId: 'w1', state: 'disabled', version: 1 }, canManage: true });
  fetchMock.mockResolvedValue(response({ grants: HOME_APP_TOOL_CAPABILITIES.map((capability) => ({ capability, enabled: true })) }));
});
afterEach(async () => { await act(async () => root.unmount()); container.remove(); });

describe('[COMP:app-web/home-app-tool-settings] per-assistant switches', () => {
  it('renders all seven apps and their tool sets, preserving child choices when the app is disabled', async () => {
    await render();
    expect(container.querySelectorAll('[role="switch"]').length).toBe(21);
    expect(button('Association: Read').getAttribute('aria-checked')).toBe('true');
    fetchMock.mockResolvedValueOnce(response({ capability: 'page', enabled: false }));
    await act(async () => button('Page').click());
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('/assistants/assistant-one/primitive-grants/page'), expect.objectContaining({ method: 'PATCH', body: '{"enabled":false}' }));
    expect(button('Page').getAttribute('aria-checked')).toBe('false');
    expect(button('Page: Read').getAttribute('aria-checked')).toBe('true');
    expect(button('Page: Read').disabled).toBe(true);
    expect(button('Office: Read').disabled).toBe(false);
  });
  it('toggles a specific set without changing its sibling or app', async () => {
    await render();
    fetchMock.mockResolvedValueOnce(response({ capability: 'home_app:office:write', enabled: false }));
    await act(async () => button('Office: Write').click());
    expect(fetchMock).toHaveBeenLastCalledWith(expect.stringContaining('home_app%3Aoffice%3Awrite'), expect.anything());
    expect(button('Office: Write').getAttribute('aria-checked')).toBe('false');
    expect(button('Office: Read').getAttribute('aria-checked')).toBe('true');
    expect(button('Office').getAttribute('aria-checked')).toBe('true');
  });
  it('retains saved state and shows failures, with retry after a load error', async () => {
    fetchMock.mockResolvedValueOnce(response({}, false));
    await render();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(en.assistant.toolsTab.homeApps.load);
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
    fetchMock.mockRejectedValueOnce(new Error('network'));
    await act(async () => button('Page').click());
    expect(button('Page').getAttribute('aria-checked')).toBe('true');
    expect(container.querySelector('[role="alert"]')?.textContent).toBe(en.assistant.toolsTab.homeApps.save);
  });
  it('shows module state as a note inside the Association card, never the module panel', async () => {
    await render('w1');
    const t = en.associationPage;
    const note = container.querySelector('[data-association-module-note]')!;
    expect(note.textContent).toBe(`${t.moduleStateLabel}: ${t.states.disabled}. ${t.savedPermissions}`);
    expect(note.closest('.rounded-xl')?.querySelector('h3')?.textContent).toBe(en.assistant.toolsTab.homeApps.association);
    expect(container.querySelector('[data-association-module]')).toBeNull();
    expect(container.textContent).not.toContain(t.moduleTitle);
    expect(container.textContent).not.toContain(t.refresh);
    expect(snapshot).toHaveBeenCalledExactlyOnceWith('w1');
    await act(async () => root.unmount()); root = createRoot(container);
    await render();
    expect(container.querySelector('[data-association-module-note]')).toBeNull();
  });
});
