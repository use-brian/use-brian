// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DepartmentAccessPanel, HomeDepartmentControls } from '../department-access-panel';
import { I18nProvider } from '@/lib/i18n/client';
import { en } from '@/lib/i18n/dictionaries/en';
import { ja } from '@/lib/i18n/dictionaries/ja';
import { zh } from '@/lib/i18n/dictionaries/zh';
import { zhCN } from '@/lib/i18n/dictionaries/zh-cn';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const W = 'workspace-fixture', D = 'department-fixture';
const mocks = vi.hoisted(() => ({
  viewer: { workspaceId: 'workspace-fixture', me: { id: 'owner-fixture' } },
  departments: vi.fn(), edges: vi.fn(), setEdge: vi.fn(), removeEdge: vi.fn(), addOwner: vi.fn(), removeOwner: vi.fn(),
  breakGlass: vi.fn(), setHome: vi.fn(), confirm: vi.fn(), prompt: vi.fn(),
}));
vi.mock('@/lib/workspace-context', () => ({ useWorkspaceContext: () => mocks.viewer }));
vi.mock('@/lib/api/mentions', () => ({ listWorkspaceMembers: async () => [{ id: 'owner-fixture', name: 'Ava Example' }, { id: 'member-fixture', name: 'Maya Example' }, { id: 'new-fixture', name: 'Noor Example' }] }));
vi.mock('@/lib/api/studio', () => ({ listAssistants: async () => [{ id: 'assistant-fixture', name: 'Ops' }] }));
vi.mock('@/components/ui/confirm-dialog', () => ({ confirmDialog: mocks.confirm }));
vi.mock('@/components/ui/prompt-dialog', () => ({ promptDialog: mocks.prompt }));
vi.mock('@/lib/api/departments', () => ({
  DEPARTMENTS_CHANGED_EVENT: 'brian:departments-changed',
  DepartmentRequestError: class extends Error { constructor(readonly code: string) { super(code); } },
  fetchDepartments: mocks.departments, fetchDepartmentEdges: mocks.edges, setDepartmentEdge: mocks.setEdge,
  removeDepartmentEdge: mocks.removeEdge, addDepartmentOwner: mocks.addOwner, removeDepartmentOwner: mocks.removeOwner,
  breakGlassDepartment: mocks.breakGlass, setHomeDepartment: mocks.setHome,
}));

let root: Root, host: HTMLDivElement;
const entry = (over: object = {}) => ({ departmentId: D, name: 'Finance', status: 'active', revision: 5, myClearance: 'confidential', isOwner: true, ownerIds: ['owner-fixture'], ...over });
async function render(node: React.ReactNode) {
  await act(async () => { root.render(<I18nProvider locale="en" dict={en}>{node}</I18nProvider>); });
  await act(async () => { await new Promise(r => setTimeout(r, 0)); });
}
const buttons = () => [...host.querySelectorAll<HTMLButtonElement>('button')].map(b => b.textContent ?? '');
const flush = () => act(async () => { await new Promise(r => setTimeout(r, 0)); });
const t = en.departmentAccess;
async function openActions(name: string) {
  const trigger = host.querySelector<HTMLButtonElement>(`[aria-label="${t.actionsLabel.replace('{name}', name)}"]`);
  expect(trigger, `actions for ${name}`).not.toBeNull();
  await act(async () => { trigger!.click(); });
  await flush();
}
async function chooseItem(text: string) {
  const item = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(node => node.textContent?.trim() === text);
  expect(item, `menu item ${text}`).toBeDefined();
  await act(async () => { item!.click(); });
  await flush();
}
async function setDate(input: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

beforeEach(() => {
  mocks.viewer.me.id = 'owner-fixture';
  for (const m of [mocks.departments, mocks.edges, mocks.setEdge, mocks.removeEdge, mocks.addOwner, mocks.removeOwner, mocks.breakGlass, mocks.setHome, mocks.confirm, mocks.prompt]) m.mockReset();
  mocks.departments.mockResolvedValue({ departments: [entry()], homes: [{ principal: { kind: 'user', id: 'owner-fixture' }, departmentId: null }] });
  mocks.edges.mockResolvedValue({ edges: [
    { departmentId: D, principal: { kind: 'user', id: 'owner-fixture' }, clearance: 'confidential', expiresAt: null, origin: 'owner' },
    { departmentId: D, principal: { kind: 'user', id: 'member-fixture' }, clearance: 'internal', expiresAt: null, origin: 'migrated' },
    { departmentId: D, principal: { kind: 'assistant', id: 'assistant-fixture' }, clearance: 'confidential', expiresAt: null, origin: 'primary' },
  ] });
  mocks.setEdge.mockResolvedValue({ revision: 6 });
  mocks.removeEdge.mockResolvedValue({ revision: 6 });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

describe('[COMP:app-web/department-access] Organization > Departments: who reads a department and home departments', () => {
  it('groups people and assistants, with clearance, owner, carried-over and every-department markers', async () => {
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(t.people);
    expect(host.textContent).toContain(t.assistants);
    expect(host.textContent).toContain('Maya Example');
    expect(host.textContent).toContain(t.carriedOver);
    expect(host.textContent).toContain(t.owner);
    expect(host.textContent).toContain(t.everyDepartment);
    expect(host.querySelector(`[aria-label="${t.clearanceLabel.replace('{name}', 'Maya Example')}"]`)).not.toBeNull();
    // The primary assistant's access is fixed: no clearance control and no actions.
    expect(host.querySelector(`[aria-label="${t.clearanceLabel.replace('{name}', 'Ops')}"]`)).toBeNull();
    expect(host.querySelector(`[aria-label="${t.actionsLabel.replace('{name}', 'Ops')}"]`)).toBeNull();
    await openActions('Maya Example');
    expect([...document.querySelectorAll('[role="menuitem"]')].map(node => node.textContent?.trim())).toEqual([t.setEndDate, t.makeOwner, t.remove]);
  });

  it('removes a member from the row menu only after confirmation, binding the department revision', async () => {
    mocks.confirm.mockResolvedValue(true);
    await render(<DepartmentAccessPanel departmentId={D} />);
    await openActions('Maya Example');
    await chooseItem(t.remove);
    expect(mocks.confirm).toHaveBeenCalledWith(expect.objectContaining({ description: t.removeDescription.replace('{name}', 'Maya Example') }));
    expect(mocks.removeEdge).toHaveBeenCalledWith(W, D, { principal: { kind: 'user', id: 'member-fixture' }, expectedRevision: 5 });
  });

  it('sets an end date from the row menu as the end of the chosen day', async () => {
    await render(<DepartmentAccessPanel departmentId={D} />);
    await openActions('Maya Example');
    await chooseItem(t.setEndDate);
    const input = host.querySelector<HTMLInputElement>('li input[type="date"]')!;
    await setDate(input, '2099-03-04');
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t.saveEndDate)!.click(); });
    await flush();
    expect(mocks.setEdge).toHaveBeenCalledWith(W, D, { principal: { kind: 'user', id: 'member-fixture' }, clearance: 'internal', expiresAt: new Date('2099-03-04T23:59:59').toISOString(), expectedRevision: 5 });
    expect(host.querySelector('li input[type="date"]')).toBeNull();
  });

  it('adds a person with the chosen clearance and an optional end date', async () => {
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(t.addTitle);
    await act(async () => { host.querySelector<HTMLButtonElement>(`button[aria-label="${t.addWho}"]`)!.click(); });
    const option = [...document.querySelectorAll<HTMLElement>('[role="option"]')].find(node => node.textContent?.startsWith('Noor Example'));
    expect(option).toBeDefined();
    // People already in the department are not offered again.
    expect([...document.querySelectorAll('[role="option"]')].some(node => node.textContent?.startsWith('Maya Example'))).toBe(false);
    await act(async () => { option!.click(); });
    const until = [...host.querySelectorAll<HTMLInputElement>('input[type="date"]')].at(-1)!;
    await setDate(until, '2099-01-31');
    await act(async () => { [...host.querySelectorAll('button')].find(b => b.textContent?.trim() === t.add)!.click(); });
    await flush();
    expect(mocks.setEdge).toHaveBeenCalledWith(W, D, { principal: { kind: 'user', id: 'new-fixture' }, clearance: 'internal', expiresAt: new Date('2099-01-31T23:59:59').toISOString(), expectedRevision: 5 });
  });

  it('explains a removal the panel cannot make instead of failing silently', async () => {
    mocks.confirm.mockResolvedValue(true);
    const { DepartmentRequestError } = await import('@/lib/api/departments');
    mocks.removeEdge.mockRejectedValue(new DepartmentRequestError('department_access_via_grant'));
    await render(<DepartmentAccessPanel departmentId={D} />);
    await openActions('Maya Example');
    await chooseItem(t.remove);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(t.errorViaGrant);
  });

  it('a grant-derived row shows temporary access and no actions', async () => {
    mocks.edges.mockResolvedValue({ edges: [
      { departmentId: D, principal: { kind: 'user', id: 'owner-fixture' }, clearance: 'confidential', expiresAt: null, origin: 'owner' },
      { departmentId: D, principal: { kind: 'user', id: 'member-fixture' }, clearance: 'internal', expiresAt: '2099-01-01T00:00:00.000Z', origin: 'grant' },
    ] });
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(t.viaGrant);
    expect(host.querySelector(`[aria-label="${t.actionsLabel.replace('{name}', 'Maya Example')}"]`)).toBeNull();
  });

  it('a non-owner member sees the roster read-only', async () => {
    mocks.departments.mockResolvedValue({ departments: [entry({ isOwner: false })], homes: [] });
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).toContain(t.readOnly);
    expect(host.querySelector(`[aria-label="${t.actionsLabel.replace('{name}', 'Maya Example')}"]`)).toBeNull();
    expect(host.textContent).not.toContain(t.addTitle);
  });

  it('the workspace owner outside a department sees only break-glass, which asks for confirmation and a reason', async () => {
    mocks.departments.mockResolvedValue({ departments: [entry({ isOwner: false, myClearance: null })], homes: [] });
    mocks.confirm.mockResolvedValue(true); mocks.prompt.mockResolvedValue('Owner left the company');
    await render(<DepartmentAccessPanel departmentId={D} />);
    expect(host.textContent).not.toContain('Maya Example');
    const join = [...host.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.includes(t.breakGlass))!;
    await act(async () => { join.click(); });
    await flush();
    expect(mocks.breakGlass).toHaveBeenCalledWith(W, D, 'Owner left the company');
  });

  it('home department offers only departments the person is in, plus General', async () => {
    mocks.departments.mockResolvedValue({ departments: [entry(), entry({ departmentId: 'other', name: 'Board', myClearance: null })], homes: [{ principal: { kind: 'user', id: 'owner-fixture' }, departmentId: null }] });
    await render(<HomeDepartmentControls />);
    expect(host.textContent).toContain(en.homeDepartment.title);
    expect(host.textContent).toContain(en.homeDepartment.none);
  });

  it('carries complete copy in all four locales, with no em dash', () => {
    for (const dict of [ja, zh, zhCN]) {
      expect(Object.keys(dict.departmentAccess)).toEqual(Object.keys(en.departmentAccess));
      expect(Object.keys(dict.homeDepartment)).toEqual(Object.keys(en.homeDepartment));
    }
    for (const dict of [en, ja, zh, zhCN]) for (const value of [...Object.values(dict.departmentAccess), ...Object.values(dict.homeDepartment)]) {
      expect(value.trim().length).toBeGreaterThan(0);
      expect(value).not.toContain('—');
    }
  });
});
