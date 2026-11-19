// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { DesktopBrowserSettings } from '../desktop-browser-settings';
import { DesktopBrowserState } from '@/components/computer/desktop-browser-coordinator';
import type { DesktopBrowserControlMessage } from '@/lib/desktop-auth-source';

const changed = vi.hoisted(() => vi.fn());
const disabledState = vi.hoisted(() => ({ workspaceId: 'workspace', phase: 'disabled' }));
vi.mock('@/lib/automatic-desktop-browser', () => ({ automaticDesktopBrowser: { preferencesChanged: changed, subscribe: () => () => {}, snapshot: () => disabledState, serverSnapshot: () => disabledState } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let dispose: (() => Promise<void>) | undefined;
afterEach(async () => { await dispose?.(); delete window.usebrianDesktop; changed.mockClear(); });
async function mount(content = <DesktopBrowserSettings />) {
  const element = document.createElement('div'); document.body.append(element);
  const root = createRoot(element);
  await act(async () => root.render(<I18nProvider locale="en" dict={en}>{content}</I18nProvider>));
  dispose = async () => { await act(async () => root.unmount()); element.remove(); };
  return element;
}
describe('[COMP:app-web/automatic-desktop-browser] General settings opt-out', () => {
  it('shows the device opt-out on every profile card without offering Resume', async () => {
    const element = await mount(<DesktopBrowserState workspaceId="workspace" profileId="profile" />);
    expect(element.textContent).toContain(en.computer.connectBrowser.desktop.disabled);
    expect(element.querySelector('button')).toBeNull();
  });
  it('reads the native preference, saves off and restores that value on remount', async () => {
    let browserEnabled = true;
    const control = vi.fn(async (message: DesktopBrowserControlMessage) => {
      if (message.type === 'set-enabled') browserEnabled = message.enabled;
      return { ok: true, browserEnabled };
    });
    window.usebrianDesktop = { signIn: vi.fn(), browserControl: control };
    let element = await mount();
    expect(element.textContent).toContain('In-app browser');
    await act(async () => (element.querySelector('[role="checkbox"]') as HTMLElement).click());
    expect(control).toHaveBeenCalledWith({ type: 'set-enabled', enabled: false });
    expect(changed).toHaveBeenCalledOnce();
    await dispose?.(); element = await mount();
    expect(element.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('false');
  });
  it('reports a failed native save and retains the saved state', async () => {
    window.usebrianDesktop = { signIn: vi.fn(), browserControl: async message => ({ ok: message.type !== 'set-enabled', browserEnabled: true }) };
    const element = await mount();
    await act(async () => (element.querySelector('[role="checkbox"]') as HTMLElement).click());
    expect(element.querySelector('[role="alert"]')?.textContent).toBe(en.computer.connectBrowser.desktop.settingError);
    expect(element.querySelector('[role="checkbox"]')?.getAttribute('aria-checked')).toBe('true');
    expect(changed).not.toHaveBeenCalled();
  });
  it('does not offer the switch outside desktop or on an older shell', async () => {
    expect((await mount()).textContent).toBe(''); await dispose?.();
    window.usebrianDesktop = { signIn: vi.fn(), browserControl: async () => ({ ok: true }) };
    expect((await mount()).textContent).toBe('');
  });
});
