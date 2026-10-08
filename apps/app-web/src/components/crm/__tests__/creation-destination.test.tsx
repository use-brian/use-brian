// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { en } from '@/lib/i18n/dictionaries/en';
const mocks = vi.hoisted(() => ({ preview: vi.fn(), create: vi.fn() }));
vi.mock('@/lib/i18n/client', () => ({ useT: () => en }));
vi.mock('@/lib/viewport', () => ({ isPhoneViewport: () => false }));
vi.mock('@/lib/api/crm', async original => ({ ...await original<object>(), fetchCrmCreationDestination: mocks.preview, createCrmRecord: mocks.create }));
vi.mock('@/components/crm/operations/import-panel', () => ({ CrmProductionImportPanel: () => null }));
vi.mock('@base-ui/react/dialog', () => ({ Dialog: {
  Root: ({ open, children }: any) => open ? <div>{children}</div> : null,
  Portal: ({ children }: any) => <>{children}</>, Backdrop: () => null,
  Popup: ({ children }: any) => <div>{children}</div>, Title: ({ children }: any) => <h2>{children}</h2>, Description: ({ children }: any) => <p>{children}</p>,
} }));
vi.mock('@/components/ui/select', () => ({
  Select: ({ children }: any) => <div>{children}</div>, SelectTrigger: ({ children }: any) => <div>{children}</div>, SelectContent: ({ children }: any) => <div>{children}</div>, SelectValue: () => null, SelectItem: () => null,
}));
vi.mock('@/components/ui/searchable-select', () => ({ SearchableSelect: ({ value, items, onValueChange }: any) => <div><span>{items.find((item: any) => item.value === value)?.label}</span>{items.map((item: any) => <button key={item.value} data-value={item.value} onClick={() => onValueChange(item.value)}>{item.label}</button>)}</div> }));
import { CrmActions } from '../crm-actions';
let host: HTMLDivElement, root: Root;
const preview = { departments: [{ id: 'department-a', name: 'Research', clearance: 'confidential' }], generalClearance: 'internal', defaultDestination: { departmentId: 'department-a', sensitivity: 'internal' } };
beforeEach(() => { vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true); mocks.preview.mockReset().mockResolvedValue(preview); mocks.create.mockReset().mockResolvedValue({ id: 'record-a', kind: 'person' }); host = document.createElement('div'); document.body.append(host); root = createRoot(host); });
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });
async function mount() { await act(async () => root.render(<CrmActions workspaceId="workspace" section="contacts" data={null} config={null} onChanged={() => {}} onCreated={() => {}} role="member" dialogsOnly activeDialog="create" />)); }
async function name() { const input = [...host.querySelectorAll('label')].find(label => label.textContent === en.crmPage.r2.name)!.querySelector('input')!; await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Fixture contact'); input.dispatchEvent(new Event('input', { bubbles: true })); }); }
function createButton() { return [...host.querySelectorAll('button')].find(button => button.textContent === en.crmPage.r2.create)!; }
describe('[COMP:crm/creation-destination] creation preview', () => {
  it('shows the home and submits an explicitly selected General destination', async () => {
    await mount(); expect(host.textContent).toContain('Research');
    await act(async () => (host.querySelector('[data-value="__general__"]') as HTMLButtonElement).click());
    await name(); await act(async () => createButton().click());
    expect(mocks.create).toHaveBeenCalledWith('workspace', expect.objectContaining({ destination: { departmentId: null, sensitivity: 'internal' } }));
  });
  it('keeps creation disabled when destination preview fails', async () => {
    mocks.preview.mockRejectedValue(new Error('unavailable')); await mount(); await name();
    expect(createButton().disabled).toBe(true); expect(host.querySelector('[role="alert"]')).not.toBeNull();
  });
  it('rejects a late preview after department authority changes', async () => {
    let resolve!: (value: unknown) => void;
    mocks.preview.mockReturnValue(new Promise(done => { resolve = done; }));
    await mount();
    await act(async () => { window.dispatchEvent(new Event('brian:organization-changed')); resolve(preview); });
    expect(host.textContent).not.toContain('Research'); expect(createButton().disabled).toBe(true);
  });
});
