// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CreateAssistantModal } from '../create-assistant-modal';
import { resetSurfaceCache } from '@/lib/surface-cache';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const mocks = vi.hoisted(() => ({ departments: vi.fn(), create: vi.fn() }));
vi.mock('@/components/studio/assistant-detail', () => ({ AssistantDetail: () => null }));
vi.mock('@/lib/workspace-context', () => ({ useWorkspaceContext: () => ({ me: { id: 'viewer' } }) }));
vi.mock('@/lib/api/departments', () => ({ fetchDepartments: mocks.departments, DEPARTMENTS_CHANGED_EVENT: 'brian:departments-changed' }));
vi.mock('@/lib/api/studio', () => ({ createAssistant: mocks.create }));
let root: Root, host: HTMLDivElement;
const entry = (id: string, isOwner = true) => ({ departmentId: id, name: id, status: 'active', isOwner, myClearance: 'confidential', ownerIds: [], revision: 1 });
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
async function render() {
  await act(async () => { root.render(<I18nProvider locale="en" dict={en}><CreateAssistantModal workspaceId="workspace" onClose={() => {}} onCreated={() => {}} /></I18nProvider>); });
  await flush();
}
async function name(value: string) {
  const input = host.querySelector<HTMLInputElement>('input')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}
async function select(value: string) {
  await act(async () => { host.querySelector<HTMLButtonElement>('#assistant-placement')!.click(); });
  await flush();
  const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(el => el.textContent === value)!;
  expect(option).toBeDefined();
  await act(async () => { option.click(); });
  await flush();
}
const submit = () => [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent === en.studioPage.assistants.createSubmit)!;
beforeEach(() => {
  resetSurfaceCache(); mocks.create.mockReset(); mocks.departments.mockReset();
  mocks.departments.mockResolvedValue({ departments: [entry('Research'), entry('Other', false)], homes: [] });
  mocks.create.mockResolvedValue({ id: 'assistant', name: 'Example', workspaceId: 'workspace', channels: [] });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); resetSurfaceCache(); });

describe('[COMP:app-web/studio-assistants] Assistant placement', () => {
  it('keeps workspace-wide creation as the default', async () => {
    await render(); await name('Example');
    await act(async () => submit().click());
    expect(mocks.create).toHaveBeenCalledWith('workspace', 'Example', undefined, null);
  });
  it('submits the selected department and only offers owned departments', async () => {
    await render(); await name('Example'); await select('Research');
    expect(document.body.textContent).not.toContain('Other');
    expect(host.textContent).toContain(en.studioPage.assistants.placementDepartmentHint);
    await act(async () => submit().click());
    expect(mocks.create).toHaveBeenCalledWith('workspace', 'Example', undefined, 'Research');
  });
  it('never silently falls back to workspace-wide when a selected department disappears', async () => {
    await render(); await name('Example'); await select('Research');
    mocks.departments.mockResolvedValue({ departments: [], homes: [] });
    await act(async () => window.dispatchEvent(new Event('brian:departments-changed'))); await flush();
    expect(submit().disabled).toBe(true);
    expect(mocks.create).not.toHaveBeenCalled();
    expect(host.textContent).toContain(en.studioPage.assistants.placementUnavailable);
  });
});
