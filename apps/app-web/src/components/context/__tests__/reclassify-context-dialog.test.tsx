// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ReclassifyContextButton } from '../reclassify-context-dialog';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
const mocks = vi.hoisted(() => ({ read: vi.fn(), save: vi.fn() }));
vi.mock('@/lib/api/context-scopes', () => ({
  listContextTeams: vi.fn(async () => []), listContextProjects: vi.fn(async () => []),
  getReclassifiableContext: mocks.read, reclassifyContext: mocks.save,
}));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let root: ReturnType<typeof createRoot>;
const t = en.contextScope;
const button = (text: string) => [...document.body.querySelectorAll('button')].find(node => node.textContent === text)!;
afterEach(async () => { await act(async () => root.unmount()); document.body.innerHTML = ''; vi.resetAllMocks(); });
async function open() {
  const host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<I18nProvider locale="en" dict={en}><ReclassifyContextButton workspaceId="workspace" primitive="entity" rowId="row" /></I18nProvider>));
  await act(async () => button(t.reclassifyAction).click());
}
describe('[COMP:app-web/context-scope] reclassification recovery', () => {
  it('keeps saving disabled after failed load and allows an explicit reload', async () => {
    mocks.read.mockRejectedValue(new Error('Unavailable'));
    await open();
    const input = document.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Reason');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(button(t.saveContext).disabled).toBe(true);
    mocks.read.mockResolvedValue({ teamIds: [], projectIds: [], hasOtherCompartments: false });
    await act(async () => button(t.reclassifyRetry).click());
    expect(document.body.textContent).not.toContain('Unavailable');
    expect(document.body.textContent).toContain(t.projectAccessHint);
    expect(mocks.save).not.toHaveBeenCalled();
  });
  it('shows undisclosed protection without mislabeling it as General', async () => {
    mocks.read.mockResolvedValue({ teamIds: [], projectIds: [], hasOtherCompartments: true });
    await open();
    expect(document.body.textContent).toContain(t.restricted);
    expect(document.body.textContent).not.toContain(t.general);
  });
});
